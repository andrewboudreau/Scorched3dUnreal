using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text.Json;

using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;

namespace Craterfall;

/// <summary>
/// Online rooms: each one is an ordered log of JSON messages that every player
/// in it reads in the same order (the game logic is all in the browsers, see
/// src/core/netplay.js). Players long-poll for new entries, which works through
/// any proxy without WebSockets. Rooms live in memory and go when the host
/// restarts (every deploy), when nobody has polled them for half an hour, or
/// after a few idle hours.
///
/// Limits, so one room or a flood of them cannot take the host's memory: a
/// message is at most 128 KB (a larger send gets 400), a room's log at most
/// 20000 entries and 8 MB (a send past these gets 507, and the server adds one
/// { t: "stop", why } so every screen ends the match at once instead of
/// waiting on a message that will never come), all rooms together at most
/// 64 MB (503: busy, worth sending again later), and 300 rooms (when full,
/// rooms not started whose seats all stopped polling make way; else 503). A
/// room plays one match: a second `start` gets 409. Refusals carry { error }.
///
/// Each room keeps to one version of the messages (`v` on create and join,
/// 1 when missing, as old clients send none; see PROTOCOL in netplay.js):
/// joining a room of another version gets 409 and a message to reload.
///
///   GET  /Craterfall/api/rooms?id=&name=                          -> { rooms: [...], menu: { count, names } }
///   POST /Craterfall/api/rooms                 { name, private, tab, v } -> { code, seat, token }
///   POST /Craterfall/api/rooms/{code}/join     { name, tab, v }  -> { seat, token, rejoin? }
///   POST /Craterfall/api/rooms/{code}/send     { token, msg }    -> { n }
///   GET  /Craterfall/api/rooms/{code}/events?token=&after=N      -> { entries: [{ n, seat, msg }] }
///   POST /Craterfall/api/rooms/{code}/leave    { token }         -> {}
///   POST /Craterfall/api/rooms/{code}/result   { token, winner } -> {}
///
/// Seats belong to a player id (the craterfall_id cookie, see Players.cs) and
/// a tab key (`tab`, kept in the tab's sessionStorage). Joining a room where
/// that id and tab still have a seat (one that has not gone) gives the seat
/// back with a fresh token and `rejoin: true`, even once the match has started
/// or the room is full, and the old token stops working: one id and tab never
/// hold two seats. Another tab of the same browser has its own key, so two tabs
/// can play each other as two seats; the second one's name gets a " 2" if the
/// first already has it. A seat that has gone is let go, so joining again takes
/// a new seat as before. Without the cookie or a tab key (old clients) every
/// join takes a new seat, as it always did.
///
/// `result` is the host's report of a finished match (`winner` is a seat, or
/// null): it counts a match played for every id seated at the start and a win
/// for the winner's, once per room. Clients are trusted for now.
///
/// The list shows every room that is not private and whose host is still
/// there: who is in it, and whether it can still be joined. Whoever asks with
/// an `id` counts as on the menu for a little while, under `name`.
///
/// The server adds { t: "join", seat, name } when someone joins,
/// { t: "gone", seat } when a seat stops polling and { t: "stop", why } when
/// the log is full (entries with seat -1).
/// Keep tools/devserver.mjs in step with this file.
/// </summary>
public static class Rooms
{
    private const int MaxRooms = 300;
    private const int MaxSeats = 6;
    private const int MaxEntries = 20000;
    private const int MaxBody = 128 * 1024;
    private const long MaxRoomBytes = 8L * 1024 * 1024;    // a long 6-player match logs a few MB
    private const long MaxAllBytes = 64L * 1024 * 1024;    // the module host's container has 384 MB in all
    private static long AllBytes;   // message bytes held by every room's log
    private static readonly TimeSpan Hold = TimeSpan.FromSeconds(20);
    private static readonly TimeSpan GoneAfter = TimeSpan.FromSeconds(45);
    private static readonly TimeSpan IdleAfter = TimeSpan.FromHours(3);
    private static readonly TimeSpan AbandonedAfter = TimeSpan.FromMinutes(30);
    private const string Letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";

    private static readonly ConcurrentDictionary<string, Room> All = new();
    private static readonly ConcurrentDictionary<string, Visitor> Menu = new();
    private static readonly TimeSpan MenuFor = TimeSpan.FromSeconds(20);

    private sealed record Visitor(string Name, DateTime Seen);

    private sealed class Seat
    {
        public required string Token;
        public required string Name;
        public string? Pid;            // the player's id; null for clients without the cookie
        public string? Tab;            // the tab's key; null for old clients
        public DateTime Seen = DateTime.UtcNow;
        public bool Gone;
    }

    private sealed record Entry(int n, int seat, JsonElement msg);

    private sealed class Room
    {
        public required string Code;
        public readonly List<Seat> Seats = new();
        public readonly List<Entry> Log = new();
        public bool Started;
        public bool Private;
        public Dictionary<int, string>? MatchIds;   // seat -> player id, as the match started
        public bool Reported;
        public bool Closed;      // removed from All; refuses sends
        public bool Full;        // the log is full; the stop entry is in it
        public int Version = 1;  // of the messages (see VersionOf)
        public long Bytes;       // message bytes in Log
        public readonly DateTime Created = DateTime.UtcNow;
        public DateTime Active = DateTime.UtcNow;
        public TaskCompletionSource Signal = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public void Append(int seat, JsonElement msg)
        {
            Log.Add(new Entry(Log.Count + 1, seat, msg.Clone()));
            Active = DateTime.UtcNow;
            var old = Signal;
            Signal = new(TaskCreationOptions.RunContinuationsAsynchronously);
            old.TrySetResult();
        }

        public void AppendServer(object msg) => Append(-1, JsonSerializer.SerializeToElement(msg));

        // Seats that stopped polling are announced once.
        public void Sweep()
        {
            var now = DateTime.UtcNow;
            for (var i = 0; i < Seats.Count; i++)
            {
                if (Seats[i].Gone || now - Seats[i].Seen < GoneAfter) continue;
                Seats[i].Gone = true;
                AppendServer(new { t = "gone", seat = i });
            }
        }

        public int SeatOf(string? token) => token is null ? -1 : Seats.FindIndex(s => s.Token == token);
    }

    public static void Map(WebApplication app, string prefix)
    {
        var api = app.MapGroup($"{prefix}/api/rooms");

        api.MapPost("", async (HttpRequest req) =>
        {
            var body = await ReadBody(req);
            if (body is null) return Results.BadRequest();
            Cleanup();
            if (All.Count >= MaxRooms) Cleanup(full: true);
            if (All.Count >= MaxRooms) return Results.StatusCode(503);
            var pid = Players.IdOf(req);
            if (pid is not null) Players.Seen(pid);
            for (var tries = 0; tries < 50; tries++)
            {
                var code = string.Concat(Enumerable.Range(0, 4).Select(_ => Letters[RandomNumberGenerator.GetInt32(Letters.Length)]));
                var room = new Room { Code = code, Private = body.Value.TryGetProperty("private", out var pv) && pv.ValueKind == JsonValueKind.True, Version = VersionOf(body.Value) };
                if (!All.TryAdd(code, room)) continue;
                lock (room) return Results.Json(Join(room, NameOf(body.Value, pid), pid, TabOf(body.Value)));
            }
            return Results.StatusCode(503);
        });

        api.MapGet("", (string? id, string? name) =>
        {
            Cleanup();
            var now = DateTime.UtcNow;
            foreach (var (key, v) in Menu) if (now - v.Seen > MenuFor) Menu.TryRemove(key, out _);
            if (id is { Length: > 0 and <= 40 } && Menu.Count < 2000) Menu[id] = new Visitor(Clip(name), now);
            var rooms = new List<(bool open, DateTime created, object row)>();
            foreach (var room in All.Values)
            {
                lock (room)
                {
                    if (room.Private) continue;
                    var live = room.Seats.Where(s => !s.Gone && now - s.Seen < GoneAfter).ToList();
                    if (room.Seats.Count == 0 || !live.Contains(room.Seats[0])) continue;   // no host, no room
                    var open = !room.Started && live.Count < MaxSeats;
                    rooms.Add((open, room.Created, new { code = room.Code, host = room.Seats[0].Name, players = live.Select(s => s.Name).ToList(), open, started = room.Started }));
                }
            }
            var others = Menu.Where(kv => kv.Key != id).Select(kv => kv.Value.Name).ToList();
            return Results.Json(new
            {
                rooms = rooms.OrderByDescending(r => r.open).ThenByDescending(r => r.created).Take(30).Select(r => r.row),
                menu = new { count = others.Count, names = others.Where(n => n.Length > 0).Take(20) },
            });
        });

        api.MapPost("{code}/leave", async (string code, HttpRequest req) =>
        {
            var body = await ReadBody(req);
            if (body is null) return Results.BadRequest();
            if (!All.TryGetValue(code.ToUpperInvariant(), out var room)) return Results.NotFound();
            var token = body.Value.TryGetProperty("token", out var t) && t.ValueKind == JsonValueKind.String ? t.GetString() : null;
            lock (room)
            {
                var seat = room.SeatOf(token);
                if (seat < 0) return Results.StatusCode(403);
                if (!room.Seats[seat].Gone)
                {
                    room.Seats[seat].Gone = true;
                    room.AppendServer(new { t = "gone", seat });
                }
                return Results.Json(new { });
            }
        });

        api.MapPost("{code}/join", async (string code, HttpRequest req) =>
        {
            var body = await ReadBody(req);
            if (body is null) return Results.BadRequest();
            if (!All.TryGetValue(code.ToUpperInvariant(), out var room)) return Results.NotFound(new { error = "No room with that code." });
            var pid = Players.IdOf(req);
            var tab = TabOf(body.Value);
            object result;
            lock (room)
            {
                if (VersionOf(body.Value) != room.Version) return Results.Conflict(new { error = OtherVersion });
                // This id and tab's seat is still here: hand it back, with a fresh token.
                var mine = pid is null || tab is null ? -1 : room.Seats.FindIndex(s => s.Pid == pid && s.Tab == tab && !s.Gone);
                if (mine >= 0)
                {
                    var s = room.Seats[mine];
                    s.Token = NewToken();
                    s.Seen = DateTime.UtcNow;
                    room.Active = DateTime.UtcNow;
                    result = new { code = room.Code, seat = mine, token = s.Token, rejoin = true };
                }
                else
                {
                    if (room.Started) return Results.Conflict(new { error = "That game has already started." });
                    if (room.Seats.Count(s => !s.Gone) >= MaxSeats) return Results.Conflict(new { error = "That room is full." });
                    if (tab is not null) foreach (var s in room.Seats) if (s.Pid == pid && s.Tab == tab) s.Tab = null;   // a gone seat: let go
                    result = Join(room, NameOf(body.Value, pid), pid, tab);
                }
            }
            if (pid is not null) Players.Seen(pid);
            return Results.Json(result);
        });

        api.MapPost("{code}/send", async (string code, HttpRequest req) =>
        {
            var read = await Body.ReadObject(req, MaxBody);
            if (read is not { } got || !got.Value.TryGetProperty("msg", out var msg) || msg.ValueKind != JsonValueKind.Object)
                return Results.BadRequest(new { error = "The message was too large (over 128 KB) or not a JSON object." });
            var body = got.Value;
            if (!All.TryGetValue(code.ToUpperInvariant(), out var room)) return Results.NotFound();
            var token = body.TryGetProperty("token", out var t) && t.ValueKind == JsonValueKind.String ? t.GetString() : null;
            lock (room)
            {
                if (room.Closed) return Results.NotFound();
                var seat = room.SeatOf(token);
                if (seat < 0) return Results.StatusCode(403);
                var kind = msg.TryGetProperty("t", out var k) && k.ValueKind == JsonValueKind.String ? k.GetString() : null;
                if (kind is "join" or "gone") return Results.BadRequest(new { error = "Only the server sends that." });
                if (kind == "start" && seat != 0) return Results.StatusCode(403);
                if (kind == "start" && room.Started) return Results.Conflict(new { error = "The match has already started." });

                // Room for it: in this room's log, then in all rooms' together.
                var size = got.Length;
                if (room.Log.Count >= MaxEntries || room.Bytes + size > MaxRoomBytes)
                {
                    if (!room.Full)
                    {
                        room.Full = true;
                        room.AppendServer(new { t = "stop", why = "the room's log is full." });
                    }
                    return Results.Json(new { error = "The room's log is full." }, statusCode: 507);
                }
                if (Interlocked.Add(ref AllBytes, size) > MaxAllBytes)
                {
                    Interlocked.Add(ref AllBytes, -size);
                    return Results.Json(new { error = "The server is busy." }, statusCode: 503);
                }
                room.Bytes += size;

                if (kind == "start")
                {
                    room.Started = true;
                    room.MatchIds = room.Seats.Select((s, i) => (s, i)).Where(x => !x.s.Gone && x.s.Pid is not null).ToDictionary(x => x.i, x => x.s.Pid!);
                }
                room.Seats[seat].Seen = DateTime.UtcNow;
                room.Append(seat, msg);
                return Results.Json(new { n = room.Log.Count });
            }
        });

        // The host's screen reports the match's end. Trusted as it is, like every
        // client for now: these numbers are only as honest as the host.
        api.MapPost("{code}/result", async (string code, HttpRequest req) =>
        {
            var body = await ReadBody(req);
            if (body is null) return Results.BadRequest();
            if (!All.TryGetValue(code.ToUpperInvariant(), out var room)) return Results.NotFound();
            var token = body.Value.TryGetProperty("token", out var t) && t.ValueKind == JsonValueKind.String ? t.GetString() : null;
            int? winner = body.Value.TryGetProperty("winner", out var w) && w.ValueKind == JsonValueKind.Number && w.TryGetInt32(out var wi) ? wi : null;
            List<(string, bool)> players;
            lock (room)
            {
                if (room.SeatOf(token) != 0) return Results.StatusCode(403);
                if (!room.Started || room.MatchIds is null) return Results.Conflict();
                if (room.Reported) return Results.Json(new { });
                room.Reported = true;
                // One match per player, even with two tabs (two seats) in it.
                players = room.MatchIds.GroupBy(kv => kv.Value).Select(g => (g.Key, g.Any(kv => kv.Key == winner))).ToList();
            }
            Players.RecordMatch(players);
            return Results.Json(new { });
        });

        api.MapGet("{code}/events", async (string code, string? token, int? after, HttpContext http) =>
        {
            if (!All.TryGetValue(code.ToUpperInvariant(), out var room)) return Results.NotFound();
            var from = Math.Max(0, after ?? 0);
            Task wait;
            lock (room)
            {
                var seat = room.SeatOf(token);
                if (seat < 0) return Results.StatusCode(403);
                room.Seats[seat].Seen = DateTime.UtcNow;
                room.Sweep();
                if (room.Log.Count > from) return Results.Json(new { entries = room.Log.Skip(from).Take(500).ToList() });
                wait = room.Signal.Task;
            }
            try { await wait.WaitAsync(Hold, http.RequestAborted); }
            catch (TimeoutException) { }
            catch (OperationCanceledException) { return Results.Empty; }
            lock (room)
            {
                var seat = room.SeatOf(token);
                if (seat >= 0) room.Seats[seat].Seen = DateTime.UtcNow;
                return Results.Json(new { entries = room.Log.Skip(from).Take(500).ToList() });
            }
        });
    }

    private const string OtherVersion = "That room is on another version of Craterfall. Reload the page (everyone in the room) and try again.";

    // The version of the messages a client speaks: `v`, else 1 (old clients).
    private static int VersionOf(JsonElement body) =>
        body.TryGetProperty("v", out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var n) ? n : 1;

    private static string NewToken() => Convert.ToHexString(RandomNumberGenerator.GetBytes(16));

    private static object Join(Room room, string name, string? pid, string? tab)
    {
        // Two tabs of one browser: tell them apart ("Ana", "Ana 2").
        if (pid is not null)
        {
            var taken = room.Seats.Where(s => s.Pid == pid && !s.Gone).Select(s => s.Name).ToHashSet(StringComparer.OrdinalIgnoreCase);
            for (var k = 2; taken.Contains(name) && k <= MaxSeats + 1; k++)
            {
                var tail = $" {k}";
                var cut = Math.Min(name.Length, Players.NameMax - tail.Length);
                if (cut < name.Length && char.IsHighSurrogate(name[cut - 1])) cut--;
                var stem = name[..cut].TrimEnd();
                if (!taken.Contains(stem + tail)) { name = stem + tail; break; }
            }
        }
        var token = NewToken();
        room.Seats.Add(new Seat { Token = token, Name = name, Pid = pid, Tab = tab });
        var seat = room.Seats.Count - 1;
        room.AppendServer(new { t = "join", seat, name });
        return new { code = room.Code, seat, token };
    }

    // A tab key: short and URL-safe, else none.
    private static string? TabOf(JsonElement body) =>
        body.TryGetProperty("tab", out var t) && t.ValueKind == JsonValueKind.String && t.GetString() is { Length: >= 8 and <= 40 } k
            && k.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_') ? k : null;

    // The name sent, else the player's saved name, else "Player".
    private static string NameOf(JsonElement body, string? pid)
    {
        var name = Clip(body.TryGetProperty("name", out var n) && n.ValueKind == JsonValueKind.String ? n.GetString() : null);
        if (name.Length == 0) name = Players.NameOf(pid);
        return name.Length > 0 ? name : "Player";
    }

    private static string Clip(string? name) => Players.CleanName(name);

    private static async Task<JsonElement?> ReadBody(HttpRequest req) =>
        await Body.ReadObject(req, MaxBody) is { } read ? read.Value : null;

    // Drops rooms idle for hours or that nobody has polled for half an hour.
    // With `full`, also rooms not started whose seats have all stopped polling,
    // to make way for new ones.
    private static void Cleanup(bool full = false)
    {
        var now = DateTime.UtcNow;
        foreach (var (code, room) in All)
        {
            lock (room)
            {
                if (room.Closed) continue;
                var polled = room.Seats.Count == 0 ? room.Created : room.Seats.Max(s => s.Seen);
                var drop = now - room.Active > IdleAfter
                    || now - polled > AbandonedAfter
                    || (full && !room.Started && now - polled > GoneAfter);
                if (!drop) continue;
                room.Closed = true;
                Interlocked.Add(ref AllBytes, -room.Bytes);
            }
            All.TryRemove(code, out _);
        }
    }
}
