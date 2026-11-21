using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.StaticFiles;

using SharedTools.Web.Modules;

namespace Craterfall;

/// <summary>
/// Serves the Craterfall browser game. The page loads its scripts by relative path
/// (./src/main.js, ./vendor/three/...), so the whole published wwwroot is served
/// under /Craterfall/ rather than the host's /_content/Craterfall/.
/// </summary>
public class CraterfallModule : IApplicationPartModule
{
    public string Name => "Craterfall";

    private static readonly FileExtensionContentTypeProvider ContentTypes = new();

    public void Configure(WebApplication app)
    {
        // Online rooms (Rooms.cs). Their literal routes win over the file route below.
        Rooms.Map(app, $"/{Name}");

        // "{**path}" also matches the bare /Craterfall, which needs the trailing slash
        // added so the page's relative script paths resolve under it.
        app.MapGet($"/{Name}/{{**path}}", (HttpContext http, string? path) =>
        {
            if (string.IsNullOrEmpty(path))
            {
                return http.Request.Path.Value!.EndsWith('/')
                    ? Serve(http, "index.html")
                    : Results.Redirect($"{http.Request.PathBase}{http.Request.Path}/{http.Request.QueryString}");
            }
            return Serve(http, path);
        });
    }

    private IResult Serve(HttpContext http, string relative)
    {
        var root = Path.GetFullPath(this.WebRoot());
        var full = Path.GetFullPath(Path.Combine(root, relative));
        if (!full.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.Ordinal) || !File.Exists(full))
            return Results.NotFound();

        if (!ContentTypes.TryGetContentType(full, out var type)) return Results.NotFound();
        if (full.EndsWith(".js", StringComparison.OrdinalIgnoreCase)) type = "text/javascript; charset=utf-8";
        else if (full.EndsWith(".html", StringComparison.OrdinalIgnoreCase)) type = "text/html; charset=utf-8";

        // Revalidate every load so a new drop shows up without a hard refresh.
        // Without this the browser may cache by heuristic and keep running old scripts.
        http.Response.Headers.CacheControl = "no-cache";
        return Results.File(full, type, lastModified: File.GetLastWriteTimeUtc(full));
    }
}
