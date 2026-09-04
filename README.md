# WebIDE

A browser-based HTML/CSS/JS editor for a web design class, with shareable
project links. Companion to PyIDE — same shape, same habits, different language.

Every project is three files, already wired together: `index.html`,
`style.css`, `script.js`. Press Run and the page appears in the preview pane
with a console underneath.

---

## How student code runs, and why it's safe

The page runs in an iframe with `sandbox="allow-scripts"` and deliberately
**without** `allow-same-origin`. That combination gives the student's code a
null origin: their JavaScript executes completely normally — which is the whole
point of the course — but it cannot read this page's DOM, cookies or storage.

Verified rather than assumed. A test page that tried to break out reported:

```
parent.document   -> SecurityError
document.cookie   -> SecurityError
localStorage      -> SecurityError
```

This is the opposite approach to the markdown notes, which are *sanitized*
because they render inside the editor's own page. Here the code is meant to
run, so it's isolated instead of stripped.

**A runaway loop only freezes the preview.** Chrome runs the null-origin frame
in its own process, so `while (true)` in a student's script leaves the editor
completely responsive — measured at 10 out of 10 heartbeats during a wedged
frame. **Stop** works even then, because it discards the iframe element rather
than asking the stuck frame to navigate itself.

---

## Deploying to Render

This shares PyIDE's existing Postgres rather than provisioning a second one, so
there's no extra database charge.

1. Push **the contents of this folder** as a repo — `render.yaml` has to sit at
   the repository root or Render won't find it.
2. **New → Blueprint**, point it at the repo.
3. Render will ask for `DATABASE_URL`. Paste PyIDE's database **Internal
   Connection String** (Render dashboard → the Postgres instance → Connect).

### Why sharing the database is safe

The two apps never touch the same objects:

| | PyIDE | WebIDE |
|---|---|---|
| table | `snippets` | `projects` |
| index | `ix_snippets_slug` | `ix_projects_slug` |
| sequence | `snippets_id_seq` | `projects_id_seq` |

Each app's `create_all()` only creates its own table and each only ever queries
its own, so the two can't collide — even an identical share slug in both tables
is harmless, because they're separate namespaces reached through different
hostnames. This was verified by running both apps against one database.

Don't put this on the free tier. Free Postgres is **deleted 30 days after
creation** (14-day grace period) and takes every share link with it. Nothing in
the app expires links — slugs are permanent and never reused.

Locally, with no `DATABASE_URL`, it falls back to its own SQLite file.

```bash
pip install -r requirements.txt
python app.py       # http://localhost:5001
```

---

## How students use it

**Write and run.** Edit any tab, press **Run** or `Ctrl+Enter`. The preview
reloads and the console clears. `console.log` output appears in the console
pane, and so do errors.

**Errors point at their own file and line.** The three files get combined into
one document to run, so the browser reports errors against that combined
document — line 66 for something the student wrote on line 4. The editor maps
it back, so the console says `script.js line 4`. Where a line can't be mapped
confidently it's left off rather than shown wrong.

**Share.** Fill in the project name and their own name, press **Share**, and
every file is captured in one link. Opening it is read-only; **Edit a copy**
forks it. A name is required, enforced on the server too.

**Download** gives the whole project as a zip. Unzip it, double-click
`index.html`, and it runs with no internet — that works because the files keep
real relative links rather than being inlined. A game download also contains
`kaplay.js` and the sprite folder, so it runs offline too.

The zip is written by about eighty lines in `static/zip.js` rather than a
library. A zip is just each file's bytes with a header in front and a directory
at the end; skipping compression (the payload is PNGs, which barely compress)
avoids pulling in a deflate implementation for no gain.

### Editor keys

| Key | What it does |
|---|---|
| `Ctrl+Enter` / `Cmd+Enter` | Run |
| `Tab` | Indent two spaces, or indent the selection |
| `Shift+Tab` | Outdent |
| `Ctrl+/` / `Cmd+/` | Comment or uncomment — `<!-- -->`, `/* */` or `//` depending on the file |
| `Tab` (suggestions open) | Accept the highlighted name |
| `Esc` | Dismiss suggestions |

Tags close themselves as they're typed, which removes a lot of week-one
frustration.

### Name completion

The same rule as the Python editor: **only names the student wrote**, no
builtins and no library APIs. What it offers depends on the file:

- **`.js`** — variables, functions, parameters and classes they declared,
  found by parsing with Acorn. Handles destructuring, rest parameters, arrow
  parameters and `catch` bindings. Nothing is executed.
- **`.css`** — the classes and ids that actually exist in their HTML. Typing
  `.ca` offers `card`, `card-body`. This is aimed squarely at the commonest
  bug in the course: a rule that doesn't apply because the class name is
  misspelled in one of the two files.
- **`.html`** — class and id names already used elsewhere in the markup, so
  the second `<div class="card">` matches the first.

Half-typed code doesn't parse, so the last successful parse is kept and
suggestions don't vanish mid-keystroke.

### Light and dark, and text size

The ☀/☾ button switches themes and the **− 14 +** stepper scales the editor and
console together without touching the toolbar — both remembered per browser, so
a projector machine keeps its settings. Light mode is tuned for projection.

The preview pane always keeps a white background regardless of theme, because a
web page brings its own colours and tinting it would lie to the student about
what their page looks like.

### Class notes in a share link

A `.md` file renders in the right pane instead of opening as text, so a share
link carries the assignment with the starter code. Students see the rendered
notes and never the markdown source: only the authoring view (a new project at
`/`) gets an **Edit source** button. A shared link opens on the notes tab.

Notes are rendered with marked and sanitized with DOMPurify — `<script>`,
`onerror`, `javascript:` links, iframes and forms are all stripped. Images by
`https://` URL work.

`examples/01_profile_card/` is a complete worked assignment: the three files
plus notes.

---

## Game mode (Kaplay)

**+ Game** in the toolbar starts a project with the library already wired in.
There's no mode switch to remember: a project is a game when its `index.html`
pulls in `kaplay.js`, and the boilerplate carries that tag from the start. What
a student edits is exactly what they get in a download.

### Installing the library

Kaplay is **vendored**, not loaded from a CDN — a school network can block a CDN
without warning, and a link handed in during October should still run in May
even if the library ships a breaking change. Run this once:

```bash
python tools/vendor.py --sprites "path/to/Kaplay sprites"
```

It downloads Kaplay (pinned to 3001.0.19), copies the sprites, slices `dino`
into its nine frames, and writes `static/game/CREDITS.md` with the MIT notice.
Until you run it, the **+ Game** project still opens and edits, but Download
tells the student the library isn't installed rather than producing a zip that
won't run.

`static/game/kaplay.js` is already committed (3001.0.19; the sha256 is recorded
in `manifest.json`). Re-run the script only when you want a newer version.

**Get the classic build, not the module one.** npm ships both:
`dist/kaplay.js` defines a global, while `dist/kaplay.mjs` ends in
`export{...}`, which is a syntax error in a classic `<script>`. The failure is
unhelpful — the browser hides errors from cross-origin scripts, so you get a
bare `Script error.` followed by `kaplay is not defined` pointing at the
student's file rather than the real cause. `vendor.py` now detects the module
build and adapts it, and refuses to install anything that still carries an ES
export. The preview also loads the library with `crossorigin="anonymous"` so
any future library error shows its real message, and says plainly when the
library failed to define itself.

### How sprites reach the preview

Two details that are easy to get wrong, both settled by testing rather than
assumption:

- The preview has a **null origin**, so a relative URL has nothing to resolve
  against. The assembled document gets a `<base href>` pointing at this app,
  which fixes `kaplay.js` and every `sprites/…` path in one line — and because
  it lives in the assembled document rather than the student's file, the same
  markup still resolves against the local folder once unzipped.
- Kaplay is a **WebGL** renderer and loads images with
  `crossOrigin="anonymous"` (it has to — WebGL refuses to build a texture from
  a cross-origin image otherwise). That only works if the server agrees, so
  `/static/game/` is served with `Access-Control-Allow-Origin: *`. Without that
  header a game runs and draws nothing, with a `SecurityError` at texture
  upload.

### Still to do

CodeMirror, Acorn, marked and DOMPurify still come from cdnjs, so a blocked
domain doesn't just break games — it stops the editor loading at all. Vendoring
those four is an afternoon and would leave the app depending on nothing but its
own Render instance.

### Notes on the download

Decided:

- **Game mode's boilerplate carries the `<script src="kaplay.js">` tag from the
  start.** The zip never rewrites anyone's markup, so what a student edits is
  exactly what they get in the download — no surprises when they open it at
  home and the file doesn't match what was on screen.
- **Ship the whole sprite pack in the zip.** It's ~300 KB, and scanning for
  `loadSprite("name")` would quietly miss any sprite chosen at runtime — a
  variable, a random pick from a list, a name built by string concatenation.
  Better a slightly bigger zip than a game that runs in class and breaks at
  home.

Done: written directly in `static/zip.js`, no library.

---

## Files

```
app.py                  Flask app: pages, share API, database
tools/vendor.py         Fetches Kaplay and the sprite pack into static/game/
render.yaml             Render blueprint (web service; reuses PyIDE's database)
templates/
  index.html            The editor page
  404.html              Bad share link
static/
  app.js                Editor, tabs, run/stop, sharing
  runner.js             Document assembly, sandbox bridge, error mapping
  complete.js           Name completion (Acorn for JS, DOM for markup)
  notes.js              Markdown notes: render, sanitize
  zip.js                Dependency-free ZIP writer
  style.css             All styling
  game/                 Vendored Kaplay + sprites (run tools/vendor.py)
examples/               A worked assignment with notes
```
