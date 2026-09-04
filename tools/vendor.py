"""
Fetch Kaplay and the sprite pack into static/game/.

Run this once, and again whenever you want to move to a newer Kaplay:

    python tools/vendor.py --sprites "~/Documents/.../Kaplay sprites"

Everything ends up committed to the repo on purpose. A CDN is one more thing
that can be blocked by a school network or go down mid-lesson, and a share link
handed in during October should still run in May even if the library ships a
breaking change. Pin the version here, not in a URL that can drift.
"""

import argparse
import json
import os
import re
import shutil
import struct
import sys
import urllib.request

KAPLAY_VERSION = "3001.0.19"
KAPLAY_URL = "https://unpkg.com/kaplay@%s/dist/kaplay.js" % KAPLAY_VERSION

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GAME_DIR = os.path.join(HERE, "static", "game")
SPRITE_DIR = os.path.join(GAME_DIR, "sprites")
MANIFEST = os.path.join(GAME_DIR, "manifest.json")

# name -> frames, for strips that hold an animation rather than one picture
SHEETS = {"dino": 9}


def png_size(path):
    with open(path, "rb") as fh:
        head = fh.read(24)
    if head[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    return struct.unpack(">II", head[16:24])


ESM_EXPORT = re.compile(r"export\s*\{[^}]*\};?")


def adapt_if_module(text):
    """Turn the ES module build into something a classic <script> can load.

    npm ships two builds. `dist/kaplay.js` defines a global; `dist/kaplay.mjs`
    ends in `export{...}`, which is a syntax error in a classic script — the
    page then fails with a bare cross-origin "Script error." and every later
    line dies with "kaplay is not defined", pointing at the student's file
    rather than the real cause. If we somehow end up with the module build,
    adapt it rather than shipping something broken.

    Returns (text, adapted).
    """
    m = ESM_EXPORT.search(text)
    if not m:
        return text, False
    # `var hw=ic` immediately precedes the export: hw is the entry point, and a
    # top-level var in a classic script is already a global.
    alias = re.search(r"var\s+(\w+)\s*=\s*\w+;\s*$", text[:m.start()])
    if not alias:
        return text, False
    name = alias.group(1)
    shim = ("\n/* Adapted from the ES module build so a classic <script> tag can "
            "use it. */\nwindow.kaplay = %s;\nwindow.kaplay.default = %s;\n"
            % (name, name))
    out = text[:m.start()] + shim + text[m.end():]
    out = re.sub(r"//# sourceMappingURL=\S*\s*$", "", out)
    return out, True


def fetch_kaplay():
    os.makedirs(GAME_DIR, exist_ok=True)
    target = os.path.join(GAME_DIR, "kaplay.js")
    print("downloading kaplay %s …" % KAPLAY_VERSION)
    req = urllib.request.Request(KAPLAY_URL, headers={"User-Agent": "webide-vendor"})
    with urllib.request.urlopen(req, timeout=60) as r:
        body = r.read()
    if len(body) < 50_000 or b"kaplay" not in body[:20_000].lower():
        print("  that download doesn't look like kaplay; leaving the old file alone",
              file=sys.stderr)
        return None

    text = body.decode("utf-8")
    text, adapted = adapt_if_module(text)
    if adapted:
        print("  got the ES module build; adapted it for a classic <script>")

    if ESM_EXPORT.search(text):
        print("  still contains an ES export — refusing to install a file that "
              "would not load", file=sys.stderr)
        return None
    if "window.kaplay" not in text and not re.search(r"\bkaplay\s*=", text):
        print("  warning: nothing in this file appears to define a kaplay global",
              file=sys.stderr)

    with open(target, "w", encoding="utf-8") as fh:
        fh.write(text)
    print("  kaplay.js  %d KB" % (len(text.encode("utf-8")) // 1024))
    return len(text)


def copy_sprites(src_dir):
    os.makedirs(SPRITE_DIR, exist_ok=True)
    sprites, skipped = [], []
    for fname in sorted(os.listdir(src_dir)):
        if not fname.lower().endswith(".png") or fname.startswith("."):
            continue
        name = fname[:-4]
        src = os.path.join(src_dir, fname)

        if name in SHEETS:
            try:
                from PIL import Image
            except ImportError:
                skipped.append("%s (needs Pillow to slice into frames)" % fname)
                continue
            sheet = Image.open(src).convert("RGBA")
            frames = SHEETS[name]
            fw = sheet.width // frames
            for i in range(frames):
                sheet.crop((i * fw, 0, (i + 1) * fw, sheet.height)).save(
                    os.path.join(SPRITE_DIR, "%s_%d.png" % (name, i)))
                sprites.append({"name": "%s_%d" % (name, i), "w": fw, "h": sheet.height})
            sheet.crop((0, 0, fw, sheet.height)).save(
                os.path.join(SPRITE_DIR, name + ".png"))
            sprites.append({"name": name, "w": fw, "h": sheet.height})
            continue

        shutil.copy2(src, os.path.join(SPRITE_DIR, fname))
        size = png_size(src) or (0, 0)
        sprites.append({"name": name, "w": size[0], "h": size[1]})

    sprites.sort(key=lambda s: s["name"])
    return sprites, skipped


CREDITS = """# Bundled game assets

## Kaplay

`kaplay.js` is the KAPLAY game library, version %s, vendored from npm rather
than loaded from a CDN. MIT licensed — the notice below travels with it.

Project: https://github.com/kaplayjs/kaplay

```
MIT License

Copyright (c) 2025 KAPLAY Team

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Sprites

`sprites/` holds the KAPLAY sprite pack, also MIT under the same notice.
`dino` is a nine-frame walk cycle in the original artwork, so it is sliced into
`dino_0` … `dino_8`; `dino` itself is frame 0.

Regenerate everything with:

```
python tools/vendor.py --sprites "path/to/sprites"
```
"""


def main(argv=None):
    ap = argparse.ArgumentParser(description="Vendor Kaplay and the sprite pack.")
    ap.add_argument("--sprites", metavar="FOLDER",
                    help="folder of sprite PNGs to bundle")
    ap.add_argument("--skip-download", action="store_true",
                    help="only refresh the sprites")
    args = ap.parse_args(argv)

    os.makedirs(GAME_DIR, exist_ok=True)

    if not args.skip_download:
        try:
            fetch_kaplay()
        except Exception as e:
            print("could not download kaplay: %s" % e, file=sys.stderr)
            print("(the app will tell students game mode isn't installed)",
                  file=sys.stderr)

    sprites = []
    if args.sprites:
        folder = os.path.expanduser(args.sprites)
        if not os.path.isdir(folder):
            print("--sprites: no folder at %s" % folder, file=sys.stderr)
            return 1
        sprites, skipped = copy_sprites(folder)
        print("sprites:   %d" % len(sprites))
        for line in skipped:
            print("  skipped %s" % line)
    else:
        # keep whatever is already bundled
        try:
            sprites = json.load(open(MANIFEST)).get("sprites", [])
            print("sprites:   %d (unchanged)" % len(sprites))
        except Exception:
            print("sprites:   0  (pass --sprites to add them)")

    with open(MANIFEST, "w") as fh:
        json.dump({"kaplayVersion": KAPLAY_VERSION, "sprites": sprites}, fh, indent=1)
    with open(os.path.join(GAME_DIR, "CREDITS.md"), "w") as fh:
        fh.write(CREDITS % KAPLAY_VERSION)

    total = 0
    for root, _, names in os.walk(GAME_DIR):
        for n in names:
            total += os.path.getsize(os.path.join(root, n))
    print("bundle:    %.1f MB in static/game/" % (total / 1_000_000))
    print("manifest:  %s" % MANIFEST)
    return 0


if __name__ == "__main__":
    sys.exit(main())
