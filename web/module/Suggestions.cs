using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Craterfall;

/// <summary>
/// The suggestion box: anyone playing can send a note from Settings > Suggest,
/// tagged with where they were (game, match builder, settings ...) and a little
/// context the page adds itself. The owner (and their agents) read them back
/// with a review key.
///
///   POST /Craterfall/api/suggestions  { text, area, context }  -> { id }
///   GET  /Craterfall/api/suggestions?status=new|done|all       -> [ suggestion, ... ] newest first   (review key)
///   POST /Craterfall/api/suggestions/{id}  { status, note }    -> suggestion                        (review key)
///
/// The review key goes in an X-Review-Key header (or "Authorization: Bearer").
/// The host never holds the key itself, only its SHA-256 in hex: from
/// CRATERFALL_REVIEW_KEY_SHA256 (environment or config), else the file
/// review-key.sha256 beside this assembly, which deploy.ps1 writes into the
/// drop from the local key. With neither, reading is off (404) and sending
/// still works. The key only reads and marks suggestions; it is not the upload key.
///
/// Limits: text 3 to 2000 characters, area 24, context 2 KB of JSON; 12 sends an
/// hour per player id (or address, with no cookie); 5000 kept, the oldest done
/// ones dropped first. Saved as suggestions.json in Players.DataDir with atomic
/// writes, or kept in memory when there is no data folder.
/// Keep tools/devserver.mjs in step.
/// </summary>
public static class Suggestions
{
    public const int TextMin = 3, TextMax = 2000, AreaMax = 24, NoteMax = 500;
    private const int ContextMax = 2048, MaxBody = 8 * 1024, MaxKept = 5000, PerHour = 12;
    private static readonly TimeSpan SaveEvery = TimeSpan.FromSeconds(5);

    public sealed class Suggestion
    {
        public string Id { get; set; } = "";
        public DateTime At { get; set; }
        public string Area { get; set; } = "";
        public string Text { get; set; } = "";
        public string Player { get; set; } = "";     // the player id, if the cookie was there
        public string Name { get; set; } = "";       // their name then, if they had set one
        public JsonElement? Context { get; set; }
        public string Status { get; set; } = "new";  // new | done
        public string Note { get; set; } = "";       // the reviewer's
    }

    private static readonly object Gate = new(), Saving = new();
    private static List<Suggestion> All = new();
    private static readonly ConcurrentDictionary<string, Queue<DateTime>> Recent = new();
    private static string? File_;
    private static byte[]? KeyHash;
    private static bool Dirty;
    private static Timer? Saver;
    private static ILogger? Log;
    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    public static void Map(WebApplication app, string prefix)
    {
        Log = app.Services.GetService(typeof(ILoggerFactory)) is ILoggerFactory f ? f.CreateLogger("Craterfall.Suggestions") : null;
        KeyHash = ReadKeyHash(app.Configuration);
        Open();
        if (File_ is not null)
        {
            Saver = new Timer(_ => Save(), null, SaveEvery, SaveEvery);
            app.Lifetime.ApplicationStopping.Register(Save);
        }

        app.MapPost($"{prefix}/api/suggestions", async (HttpContext http) =>
        {
            if (await Body.ReadObject(http.Request, MaxBody) is not { } read) return Results.BadRequest();
            var b = read.Value;
            var text = Clean(Str(b, "text"), TextMax, keepLines: true);
            if (text.Length < TextMin) return Results.BadRequest(new { error = "Say a little more." });
            var area = Clean(Str(b, "area"), AreaMax, keepLines: false).ToLowerInvariant();
            JsonElement? context = null;
            if (b.TryGetProperty("context", out var c) && c.ValueKind == JsonValueKind.Object && c.GetRawText().Length <= ContextMax) context = c;

            var player = Players.IdOf(http.Request);
            var who = player ?? $"ip:{http.Connection.RemoteIpAddress}";
            if (!Allow(who)) return Results.StatusCode(StatusCodes.Status429TooManyRequests);

            var s = new Suggestion
            {
                Id = NewId(), At = DateTime.UtcNow, Area = area.Length > 0 ? area : "other", Text = text,
                Player = player ?? "", Name = Players.NameOf(player), Context = context,
            };
            lock (Gate)
            {
                All.Add(s);
                Trim();
                Dirty = true;
            }
            Log?.LogInformation("Craterfall: suggestion {Id} ({Area}, {Length} chars).", s.Id, s.Area, s.Text.Length);
            return Results.Json(new { id = s.Id });
        });

        app.MapGet($"{prefix}/api/suggestions", (HttpContext http, string? status) =>
        {
            if (Denied(http) is { } no) return no;
            status = status is "done" or "all" ? status : "new";
            lock (Gate)
            {
                var list = All.Where(s => status == "all" || s.Status == status).OrderByDescending(s => s.At).ToList();
                return Results.Json(list, Json);
            }
        });

        app.MapPost($"{prefix}/api/suggestions/{{id}}", async (HttpContext http, string id) =>
        {
            if (Denied(http) is { } no) return no;
            if (await Body.ReadObject(http.Request, MaxBody) is not { } read) return Results.BadRequest();
            var b = read.Value;
            lock (Gate)
            {
                var s = All.FirstOrDefault(x => x.Id == id);
                if (s is null) return Results.NotFound();
                if (Str(b, "status") is "new" or "done") s.Status = Str(b, "status")!;
                if (b.TryGetProperty("note", out _)) s.Note = Clean(Str(b, "note"), NoteMax, keepLines: true);
                Dirty = true;
                return Results.Json(s, Json);
            }
        });
    }

    // ---- the review key

    private static byte[]? ReadKeyHash(IConfiguration config)
    {
        var hex = Environment.GetEnvironmentVariable("CRATERFALL_REVIEW_KEY_SHA256") ?? config["CRATERFALL_REVIEW_KEY_SHA256"];
        if (string.IsNullOrWhiteSpace(hex))
        {
            var here = Path.GetDirectoryName(typeof(Suggestions).Assembly.Location);
            var file = string.IsNullOrEmpty(here) ? null : Path.Combine(here, "review-key.sha256");
            if (file is not null && File.Exists(file)) hex = File.ReadAllText(file);
        }
        hex = hex?.Trim();
        if (string.IsNullOrEmpty(hex)) { Log?.LogInformation("Craterfall: no review key; suggestions can be sent but not read."); return null; }
        try
        {
            var bytes = Convert.FromHexString(hex);
            return bytes.Length == 32 ? bytes : null;
        }
        catch (FormatException) { Log?.LogWarning("Craterfall: the review key hash is not hex; reading suggestions is off."); return null; }
    }

    // Null when the request carries the review key, else the reply to send.
    private static IResult? Denied(HttpContext http)
    {
        http.Response.Headers.CacheControl = "no-store";
        if (KeyHash is null) return Results.NotFound();
        var given = http.Request.Headers["X-Review-Key"].ToString();
        if (string.IsNullOrEmpty(given))
        {
            var auth = http.Request.Headers.Authorization.ToString();
            if (auth.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase)) given = auth[7..].Trim();
        }
        if (string.IsNullOrEmpty(given)) return Results.Unauthorized();
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(given));
        return CryptographicOperations.FixedTimeEquals(hash, KeyHash) ? null : Results.Unauthorized();
    }

    // ---- helpers

    private static string? Str(JsonElement b, string name) =>
        b.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    // Control and invisible formatting characters dropped (new lines kept in
    // text), trimmed, cut to `max` without splitting a surrogate pair.
    public static string Clean(string? s, int max, bool keepLines)
    {
        var sb = new StringBuilder();
        foreach (var ch in s ?? "")
        {
            if (keepLines && ch == '\n') { sb.Append(ch); continue; }
            var cat = char.GetUnicodeCategory(ch);
            if (cat is System.Globalization.UnicodeCategory.Control or System.Globalization.UnicodeCategory.Format
                or System.Globalization.UnicodeCategory.LineSeparator or System.Globalization.UnicodeCategory.ParagraphSeparator) continue;
            sb.Append(ch);
        }
        var t = sb.ToString().Trim();
        if (t.Length > max) t = t[..(char.IsHighSurrogate(t[max - 1]) ? max - 1 : max)].TrimEnd();
        return t;
    }

    private static string NewId() =>
        Convert.ToBase64String(RandomNumberGenerator.GetBytes(6)).Replace('+', '-').Replace('/', '_');

    private static bool Allow(string who)
    {
        var q = Recent.GetOrAdd(who, _ => new Queue<DateTime>());
        lock (q)
        {
            var now = DateTime.UtcNow;
            while (q.Count > 0 && now - q.Peek() > TimeSpan.FromHours(1)) q.Dequeue();
            if (q.Count >= PerHour) return false;
            q.Enqueue(now);
        }
        if (Recent.Count > 10000) Recent.Clear();   // a flood of addresses: start over rather than grow
        return true;
    }

    // Over the cap: drop the oldest done ones first, then the oldest. Caller holds Gate.
    private static void Trim()
    {
        while (All.Count > MaxKept)
        {
            var i = All.FindIndex(s => s.Status == "done");
            All.RemoveAt(i >= 0 ? i : 0);
        }
    }

    // ---- storage (beside players.json)

    private static void Open()
    {
        if (Players.DataDir is not { } dir)
        {
            Log?.LogWarning("Craterfall: no data folder; suggestions are kept in memory only.");
            return;
        }
        File_ = Path.Combine(dir, "suggestions.json");
        try
        {
            if (File.Exists(File_))
            {
                var loaded = JsonSerializer.Deserialize<List<Suggestion>>(File.ReadAllText(File_), Json);
                if (loaded is not null) lock (Gate) All = loaded;
            }
        }
        catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException)
        {
            Log?.LogError("Craterfall: could not read {File} ({Error}); starting with no suggestions.", File_, ex.Message);
            try { File.Copy(File_, File_ + ".bad", overwrite: true); } catch (Exception) { }
        }
    }

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
                lock (Gate) Dirty = true;
                Log?.LogError("Craterfall: could not save suggestions ({Error}).", ex.Message);
            }
        }
    }
}
