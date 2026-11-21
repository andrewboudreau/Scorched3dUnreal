using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.StaticFiles;

using SharedTools.Web.Modules;

namespace CraterfallPacks;

/// <summary>
/// Serves the mirrored resource packs at /Craterfall/packs/, under the game's own path so the
/// page fetches them relatively. This literal route outranks the game module's /Craterfall/{**path}.
/// </summary>
public class CraterfallPacksModule : IApplicationPartModule
{
    public string Name => "CraterfallPacks";

    // .hdr: the sky HDRIs.
    private static readonly FileExtensionContentTypeProvider ContentTypes = new() { Mappings = { [".hdr"] = "application/octet-stream" } };

    public void Configure(WebApplication app)
    {
        app.MapGet("/Craterfall/packs/{**path}", (HttpContext http, string? path) =>
        {
            var root = Path.GetFullPath(this.WebRoot());
            var full = Path.GetFullPath(Path.Combine(root, path ?? ""));
            if (!full.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.Ordinal) || !File.Exists(full))
                return Results.NotFound();
            if (!ContentTypes.TryGetContentType(full, out var type)) return Results.NotFound();
            http.Response.Headers.CacheControl = "no-cache";
            return Results.File(full, type, lastModified: File.GetLastWriteTimeUtc(full), enableRangeProcessing: true);
        });
    }
}
