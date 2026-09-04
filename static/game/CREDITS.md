# Bundled game assets

## Kaplay

`kaplay.js` is the KAPLAY game library, version 3001.0.19, vendored from npm rather
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
