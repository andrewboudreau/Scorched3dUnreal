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
/// restarts or after a few idle hours.
///
///   GET  /Craterfall/api/rooms?id=&name=                          -> { rooms: [...], menu: { count, names } }
///   POST /Craterfall/api/rooms                 { name, private } -> { code, seat, token }
///   POST /Craterfall/api/rooms/{code}/join     { name }          -> { seat, token }
///   POST /Craterfall/api/rooms/{code}/send     { token, msg }    -> { n }
///   GET  /Craterfall/api/rooms/{code}/events?token=&after=N      -> { entries: [{ n, seat, msg }] }
///   POST /Craterfall/api/rooms/{code}/leave    { token }         -> {}
///
/// The list shows every room that is not private and whose host is still
/// there: who is in it, and whether it can still be joined. Whoever asks with
/// an `id` counts as on the menu for a little while, under `name`.
///
/// The server adds { t: "join", seat, name } when someone joins and
/// { t: "gone", seat } when a seat stops polling (entries with seat -1).
/// Keep tools/devserver.mjs in step with this file.
/// </summary>
public static class Rooms
{
    private const int MaxRooms = 300;
    private const int MaxSeats = 6;
    private const int MaxEntries = 20000;
    private const int MaxBody = 128 * 1024;
    private static readonly TimeSpan Hold = TimeSpan.FromSeconds(20);
    private static readonly TimeSpan GoneAfter = TimeSpan.FromSeconds(45);
    private static readonly TimeSpan IdleAfter = TimeSpan.FromHours(3);
    private const string Letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";

    private static readonly ConcurrentDictionary<string, Room> All = new();
    private static readonly ConcurrentDictionary<string, Visitor> Menu = new();
    private static readonly TimeSpan MenuFor = TimeSpan.FromSeconds(20);

    private sealed record Visitor(string Name, DateTime Seen);

    private sealed class Seat
    {
        public required string Token;
        public required string Name;
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
            if (All.Count >= MaxRooms) return Results.StatusCode(503);
            for (var tries = 0; tries < 50; tries++)
            {
                var code = string.Concat(Enumerable.Range(0, 4).Select(_ => Letters[RandomNumberGenerator.GetInt32(Letters.Length)]));
                var room = new Room { Code = code, Private = body.Value.TryGetProperty("private", out var pv) && pv.ValueKind == JsonValueKind.True };
                if (!All.TryAdd(code, room)) continue;
                lock (room) return Results.Json(Join(room, NameOf(body.Value)));
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
            var token = body.Value.TryGetProperty("token", out var t) ? t.GetString() : null;
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
            lock (room)
            {
                if (room.Started) return Results.Conflict(new { error = "That game has already started." });
                if (room.Seats.Count(s => !s.Gone) >= MaxSeats) return Results.Conflict(new { error = "That room is full." });
                return Results.Json(Join(room, NameOf(body.Value)));
            }
        });

        api.MapPost("{code}/send", async (string code, HttpRequest req) =>
        {
            var body = await ReadBody(req);
            if (body is null || !body.Value.TryGetProperty("msg", out var msg) || msg.ValueKind != JsonValueKind.Object) return Results.BadRequest();
            if (!All.TryGetValue(code.ToUpperInvariant(), out var room)) return Results.NotFound();
            var token = body.Value.TryGetProperty("token", out var t) ? t.GetString() : null;
            lock (room)
            {
                var seat = room.SeatOf(token);
                if (seat < 0) return Results.StatusCode(403);
                if (room.Log.Count >= MaxEntries) return Results.StatusCode(507);
                var kind = msg.TryGetProperty("t", out var k) ? k.GetString() : null;
                if (kind is "join" or "gone") return Results.BadRequest();
                if (kind == "start")
                {
                    if (seat != 0) return Results.StatusCode(403);
                    room.Started = true;
                }
                room.Seats[seat].Seen = DateTime.UtcNow;
                room.Append(seat, msg);
                return Results.Json(new { n = room.Log.Count });
            }
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

    private static object Join(Room room, string name)
    {
        var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(16));
        room.Seats.Add(new Seat { Token = token, Name = name });
        var seat = room.Seats.Count - 1;
        room.AppendServer(new { t = "join", seat, name });
        return new { code = room.Code, seat, token };
    }

    private static string NameOf(JsonElement body)
    {
        var name = Clip(body.TryGetProperty("name", out var n) && n.ValueKind == JsonValueKind.String ? n.GetString() : null);
        return name.Length > 0 ? name : "Player";
    }

    private static string Clip(string? name)
    {
        name = (name ?? "").Trim();
        return name.Length > 14 ? name[..14] : name;
    }

    private static async Task<JsonElement?> ReadBody(HttpRequest req)
    {
        if (req.ContentLength is > MaxBody) return null;
        try
        {
            using var doc = await JsonDocument.ParseAsync(req.Body);
            return doc.RootElement.ValueKind == JsonValueKind.Object ? doc.RootElement.Clone() : null;
        }
        catch (JsonException) { return null; }
    }

    private static void Cleanup()
    {
        var now = DateTime.UtcNow;
        foreach (var (code, room) in All)
        {
            if (now - room.Active > IdleAfter) All.TryRemove(code, out _);
        }
    }
}
