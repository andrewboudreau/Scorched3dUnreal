using System.Text.Json;

using Microsoft.AspNetCore.Http;

namespace Craterfall;

/// <summary>Reading a request's JSON body with a size limit.</summary>
internal static class Body
{
    /// <summary>
    /// The body as a JSON object and its size in bytes, or null when it is not a
    /// JSON object or is longer than <paramref name="max"/> bytes. The limit is
    /// checked as the body is read, not only against Content-Length, so a chunked
    /// body without one cannot run past it.
    /// </summary>
    public static async Task<(JsonElement Value, int Length)?> ReadObject(HttpRequest req, int max)
    {
        if (req.ContentLength is long declared && declared > max) return null;
        using var buffer = new MemoryStream();
        var chunk = new byte[16 * 1024];
        int n;
        while ((n = await req.Body.ReadAsync(chunk, req.HttpContext.RequestAborted)) > 0)
        {
            if (buffer.Length + n > max) return null;
            buffer.Write(chunk, 0, n);
        }
        try
        {
            using var doc = JsonDocument.Parse(buffer.GetBuffer().AsMemory(0, (int)buffer.Length));
            return doc.RootElement.ValueKind == JsonValueKind.Object ? (doc.RootElement.Clone(), (int)buffer.Length) : null;
        }
        catch (JsonException) { return null; }
    }
}
