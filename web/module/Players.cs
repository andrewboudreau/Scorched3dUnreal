using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Craterfall;

/// <summary>
/// Who is playing (stage 1 of "Players and accounts" in docs/design-guide.md):
/// a random player id in a long-lived cookie, and a small record per id.
///
///   GET  /Craterfall/api/me            -> { id, name, played, won }   (issues the cookie on first visit)
///   POST /Craterfall/api/me  { name }  -> { id, name, played, won }
///
/// The id is an identifier, not a secret: 128 random bits nobody can guess, so
/// holding the cookie is the whole of the "authorization" for now. There is no
/// password and no email. A later email sign-in (a one-time link) will claim
/// an existing id, so a player keeps their record when they move device.
///
/// A record holds a name, first and last seen, and matches played and won;
/// nothing else is stored. A visit alone stores nothing: a record is made only
/// when a player sets a name or finishes an online match, so the file holds
/// players rather than every page load. Records are kept as JSON in a data folder
/// with atomic writes, or only in memory when no folder is writable. The folder
/// is the first writable one of: CRATERFALL_DATA (or config Craterfall:DataPath);
/// on a module-drops host (modules.blogfor.net), _data/{module folder} beside the
/// drops, which the loader skips and uploads leave alone; the host's
/// App_Data/Craterfall; else data/ next to the module, which the next upload
/// moves aside, so records there last only until then.
/// Rooms.cs reads the id to tie seats to players. Keep tools/devserver.mjs in step.
/// </summary>
public static class Players
{
    public const string Cookie = "craterfall_id";
    public const int NameMax = 14;
    private const int MaxRecords = 20000;
    private const int MaxBody = 4 * 1024;
    private static readonly TimeSpan CookieFor = TimeSpan.FromDays(365);
    private static readonly TimeSpan SaveEvery = TimeSpan.FromSeconds(5);

    public sealed class Record
    {
        public string Name { get; set; } = "";
        public DateTime FirstSeen { get; set; }
        public DateTime LastSeen { get; set; }
        public int Played { get; set; }
        public int Won { get; set; }
    }

    private static readonly object Gate = new();
    private static Dictionary<string, Record> All = new(StringComparer.Ordinal);
    private static string? File_;
    private static bool Dirty;
    private static Timer? Saver;
    private static ILogger? Log;
    private static readonly JsonSerializerOptions Json = new() { WriteIndented = false };

    public static void Map(WebApplication app, string prefix)
    {
        Log = app.Services.GetService(typeof(ILoggerFactory)) is ILoggerFactory f ? f.CreateLogger("Craterfall.Players") : null;
        Open(app.Configuration, app.Environment.ContentRootPath);
        if (File_ is not null)
        {
            Saver = new Timer(_ => Save(), null, SaveEvery, SaveEvery);
            app.Lifetime.ApplicationStopping.Register(Save);
        }

        app.MapGet($"{prefix}/api/me", (HttpContext http) =>
        {
            var id = Identify(http, prefix);
            lock (Gate) return Results.Json(View(id, Known(id) ?? new Record()));
        });

        app.MapPost($"{prefix}/api/me", async (HttpContext http) =>
        {
            if (await Body.ReadObject(http.Request, MaxBody) is not { } read) return Results.BadRequest();
            var body = read.Value;
            var id = Identify(http, prefix);
            var name = body.TryGetProperty("name", out var n) && n.ValueKind == JsonValueKind.String ? CleanName(n.GetString()) : null;
            lock (Gate)
            {
                // Setting a name is what makes a record; an empty one alone does not.
                var r = Known(id) ?? (string.IsNullOrEmpty(name) ? new Record() : Touch(id));
                if (name is not null && All.ContainsKey(id)) { r.Name = name; Dirty = true; }
                return Results.Json(View(id, r));
            }
        });
    }

    private static object View(string id, Record r) => new { id, name = r.Name, played = r.Played, won = r.Won };

    // ---- ids and the cookie

    /// <summary>The player id from the request's cookie, or null when it has none (an old client).</summary>
    public static string? IdOf(HttpRequest req) =>
        req.Cookies.TryGetValue(Cookie, out var v) && IsId(v) ? v : null;

    public static bool IsId(string? s) =>
        s is { Length: 22 } && s.All(c => c is >= 'a' and <= 'z' or >= 'A' and <= 'Z' or >= '0' and <= '9' or '-' or '_');

    // 128 random bits, base64url without padding: 22 characters.
    private static string NewId() =>
        Convert.ToBase64String(RandomNumberGenerator.GetBytes(16)).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    // The caller's id, issuing one if it has none. The cookie is set again every
    // time so it stays a year past the last visit.
    private static string Identify(HttpContext http, string prefix)
    {
        var id = IdOf(http.Request) ?? NewId();
        var https = http.Request.IsHttps
            || string.Equals(http.Request.Headers["X-Forwarded-Proto"].ToString(), "https", StringComparison.OrdinalIgnoreCase);
        http.Response.Cookies.Append(Cookie, id, new CookieOptions
        {
            HttpOnly = true,
            Secure = https,
            SameSite = SameSiteMode.Lax,
            Path = prefix,
            MaxAge = CookieFor,
            IsEssential = true,
        });
        http.Response.Headers.CacheControl = "no-store";
        return id;
    }

    // ---- names

    /// <summary>
    /// A name as shown to others: control and invisible formatting characters
    /// dropped, trimmed, at most 14 characters (never splitting a surrogate pair).
    /// </summary>
    public static string CleanName(string? name)
    {
        var sb = new StringBuilder();
        foreach (var c in name ?? "")
        {
            var cat = char.GetUnicodeCategory(c);
            if (cat is UnicodeCategory.Control or UnicodeCategory.Format or UnicodeCategory.LineSeparator or UnicodeCategory.ParagraphSeparator) continue;
            sb.Append(c);
        }
        var s = sb.ToString().Trim();
        if (s.Length > NameMax) s = s[..(char.IsHighSurrogate(s[NameMax - 1]) ? NameMax - 1 : NameMax)].TrimEnd();
        return s;
    }

    // ---- records (callers outside this file need not hold the lock)

    // The id's record, seen now, or null when it has none. Caller holds Gate.
    private static Record? Known(string id)
    {
        if (!All.TryGetValue(id, out var r)) return null;
        r.LastSeen = DateTime.UtcNow;
        Dirty = true;
        return r;
    }

    // The id's record, made if it has none. Caller holds Gate.
    private static Record Touch(string id)
    {
        var now = DateTime.UtcNow;
        if (!All.TryGetValue(id, out var r))
        {
            // An id this host has not seen (new, or from before an in-memory restart)
            // gets a fresh record: the id is only a name for the record, not a secret.
            if (All.Count >= MaxRecords) Evict();
            r = new Record { FirstSeen = now };
            All[id] = r;
        }
        r.LastSeen = now;
        Dirty = true;
        return r;
    }

    // Full: drop one record, preferring ones that never set a name or played,
    // then the one seen longest ago.
    private static void Evict()
    {
        string? worst = null;
        Record? w = null;
        foreach (var (id, r) in All)
        {
            if (w is null || Rank(r).CompareTo(Rank(w)) < 0) { worst = id; w = r; }
        }
        if (worst is not null) All.Remove(worst);
        static (bool, DateTime) Rank(Record r) => (r.Name.Length > 0 || r.Played > 0, r.LastSeen);
    }

    /// <summary>The player was seen (created or joined a room); a player with no record still has none.</summary>
    public static void Seen(string id)
    {
        lock (Gate) Known(id);
    }

    /// <summary>The saved name for an id, or "" if it has none.</summary>
    public static string NameOf(string? id)
    {
        if (id is null) return "";
        lock (Gate) return All.TryGetValue(id, out var r) ? r.Name : "";
    }

    /// <summary>
    /// One finished match: every player id that started it, and whether it won.
    /// The result comes from the host's screen and is trusted as it is: clients
    /// are trusted for now, so these numbers are only as honest as the host.
    /// </summary>
    public static void RecordMatch(IEnumerable<(string id, bool won)> players)
    {
        lock (Gate)
        {
            foreach (var (id, won) in players)
            {
                var r = Touch(id);
                r.Played++;
                if (won) r.Won++;
            }
        }
    }

    // ---- storage

    private static void Open(IConfiguration config, string contentRoot)
    {
        var candidates = new List<string>();
        var configured = Environment.GetEnvironmentVariable("CRATERFALL_DATA") ?? config["CRATERFALL_DATA"] ?? config["Craterfall:DataPath"];
        if (!string.IsNullOrWhiteSpace(configured)) candidates.Add(configured);
        // The host's App_Data is a mounted volume that outlives module uploads.
        // A drops host keeps every module in {root}/{id}/ and its own state in {root}/_status/.
        // An upload moves {id}/ to {id}.prev/ (and deletes the older one), so data must live outside it.
        var here = Path.GetDirectoryName(typeof(Players).Assembly.Location);
        var dropsRoot = string.IsNullOrEmpty(here) ? null : Path.GetDirectoryName(here);
        string? beside = null;
        if (dropsRoot is not null && Directory.Exists(Path.Combine(dropsRoot, "_status")))
        {
            beside = Path.Combine(dropsRoot, "_data", Path.GetFileName(here!));
            candidates.Add(beside);
        }
        var appData = Path.Combine(contentRoot, "App_Data");
        if (Directory.Exists(appData)) candidates.Add(Path.Combine(appData, "Craterfall"));
        if (!string.IsNullOrEmpty(here)) candidates.Add(Path.Combine(here, "data"));

        foreach (var dir in candidates)
        {
            try
            {
                Directory.CreateDirectory(dir);
                var probe = Path.Combine(dir, $".probe-{Guid.NewGuid():N}");
                File.WriteAllText(probe, "");
                File.Delete(probe);
                File_ = Path.Combine(dir, "players.json");
                break;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or NotSupportedException or ArgumentException)
            {
                Log?.LogWarning("Craterfall: player data folder {Dir} is not writable ({Error}).", dir, ex.Message);
            }
        }

        if (File_ is null)
        {
            Log?.LogWarning("Craterfall: no writable data folder (set CRATERFALL_DATA); player records are kept in memory only and go when the host restarts.");
            return;
        }
        Log?.LogInformation("Craterfall: player records in {File}.", File_);
        // Before records lived beside the drops they were in data/ inside the drop, which the
        // last upload moved to {id}.prev/: carry the newest such file over, once.
        if (beside is not null && File_ == Path.Combine(beside, "players.json") && !File.Exists(File_))
        {
            foreach (var old in new[] { Path.Combine(here!, "data", "players.json"), Path.Combine(here + ".prev", "data", "players.json") })
            {
                try
                {
                    if (!File.Exists(old)) continue;
                    File.Copy(old, File_);
                    Log?.LogInformation("Craterfall: carried player records over from {Old}.", old);
                    break;
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
            }
        }
        try
        {
            if (File.Exists(File_))
            {
                var loaded = JsonSerializer.Deserialize<Dictionary<string, Record>>(File.ReadAllText(File_), Json);
                if (loaded is not null)
                {
                    lock (Gate)
                    {
                        All = new Dictionary<string, Record>(StringComparer.Ordinal);
                        foreach (var (id, r) in loaded)
                        {
                            if (!IsId(id) || r is null) continue;
                            r.Name = CleanName(r.Name);
                            All[id] = r;
                        }
                        while (All.Count > MaxRecords) Evict();
                    }
                }
            }
        }
        catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException)
        {
            // Keep the unreadable file for a person to look at; start empty.
            Log?.LogError("Craterfall: could not read {File} ({Error}); starting with no player records.", File_, ex.Message);
            try { File.Copy(File_, File_ + ".bad", overwrite: true); } catch (Exception) { }
        }
    }

    // Write to a temp file, then move it over the old one, so a crash mid-write
    // never leaves a half-written file behind.
    private static void Save()
    {
        if (File_ is null) return;
        lock (Saving)
        {
            string text;
            lock (Gate)
            {
                if (!Dirty) return;
                text = JsonSerializer.Serialize(All, Json);
                Dirty = false;
            }
            try
            {
                var tmp = File_ + ".tmp";
                File.WriteAllText(tmp, text);
                File.Move(tmp, File_, overwrite: true);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                lock (Gate) Dirty = true;   // try again next time
                Log?.LogWarning("Craterfall: could not save player records ({Error}).", ex.Message);
            }
        }
    }

    private static readonly object Saving = new();
}
