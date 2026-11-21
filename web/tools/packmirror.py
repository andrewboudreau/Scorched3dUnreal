"""Copy the shareable resource packs into web/packmirror/, small enough to deploy.

The live game can't reach the asset library on the NAS, so for reviewing on a
phone (blogfor.net/Craterfall/?packs) the packs marked redistributable are
mirrored here and published at /Craterfall/packs/. The module host takes zips
of at most 50 MB, so:
  - skies keep only their 1k HDR (and preview),
  - materials drop the displacement map and are scaled to 512 px,
  - sounds are copied as they are.
packmirror/index.json is the same shape as the dev server's /api/packs.

    python tools/packmirror.py [library]      (default: the NAS library)
"""
import json
import os
import shutil
import sys

from PIL import Image

LIB = sys.argv[1] if len(sys.argv) > 1 else r"<pack library>"
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "packmirror")
MAT_PX = 512


def copy(pack_dir, rel, out_dir):
    src = os.path.join(pack_dir, rel)
    dst = os.path.join(out_dir, rel)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.copyfile(src, dst)
    return os.path.getsize(dst)


def shrink(pack_dir, rel, out_dir):
    src = os.path.join(pack_dir, rel)
    dst = os.path.join(out_dir, rel)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    with Image.open(src) as im:
        if max(im.size) > MAT_PX:
            im = im.resize((MAT_PX, MAT_PX * im.size[1] // im.size[0]), Image.LANCZOS)
        if im.mode not in ("RGB", "L"):
            im = im.convert("RGB")
        im.save(dst, "JPEG", quality=85, optimize=True)
    return os.path.getsize(dst)


def main():
    if os.path.isdir(OUT):
        shutil.rmtree(OUT)
    os.makedirs(OUT)
    packs = []
    total = 0
    for name in sorted(os.listdir(LIB)):
        pack_dir = os.path.join(LIB, name)
        try:
            with open(os.path.join(pack_dir, "pack.json"), encoding="utf-8") as f:
                pack = json.load(f)
        except (OSError, ValueError):
            continue
        if pack.get("redistributable") is not True:
            print(f"skip {name}: not redistributable")
            continue
        out_dir = os.path.join(OUT, name)
        size = 0
        items = []
        for item in pack.get("items", []):
            item = dict(item)
            if item.get("preview"):
                size += copy(pack_dir, item["preview"], out_dir)
            kind = item.get("type")
            if kind == "hdri":
                one = (item.get("files") or {}).get("1k")
                if not one:
                    continue
                item["files"] = {"1k": one}
                size += copy(pack_dir, one, out_dir)
            elif kind == "material":
                maps = {k: v for k, v in (item.get("maps") or {}).items() if k != "displacement"}
                for rel in maps.values():
                    size += shrink(pack_dir, rel, out_dir)
                item["maps"] = maps
                item["resolution"] = f"{MAT_PX} px (phone mirror)"
            else:
                for key in ("file", "fallback"):
                    if item.get(key):
                        size += copy(pack_dir, item[key], out_dir)
            item.pop("bytes", None)
            items.append(item)
        pack["items"] = items
        pack["dir"] = name
        packs.append(pack)
        total += size
        print(f"{name}: {len(items)} items, {size / 1e6:.1f} MB")
    with open(os.path.join(OUT, "index.json"), "w", encoding="utf-8") as f:
        json.dump({"root": "mirror", "static": True, "packs": packs, "picks": None}, f)
    print(f"total {total / 1e6:.1f} MB in {OUT}")


if __name__ == "__main__":
    main()
