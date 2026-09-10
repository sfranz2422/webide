# WebIDE

A browser-based HTML/CSS/JS editor for a web design class, with shareable
project links. Companion to PyIDE — same shape, same habits, different language.

Every project starts as three files, already wired together: `index.html`,
`style.css`, `script.js`. Press Run and the page appears in the preview pane
with a console underneath. **+ File** adds more pages, so a project can be a
whole site rather than one page.

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

**Write and run.** Edit any tab and the preview follows about three quarters of
a second after you stop typing — no trip to the toolbar to see a colour change.
**Run** and `Ctrl+Enter` still work, for restarting a page deliberately and for
games. `console.log` output appears in the console pane, and so do errors.

The **Auto** box beside Run controls it, and is remembered per browser.

## Multi-page sites

**+ File** and a name ending in `.html` adds a page. It arrives as a real page
— doctype, head, the stylesheet already linked and a link back home — because a
blank file is a poor place for a beginner to land, and a second page that
forgot `<link rel="stylesheet">` looks like broken CSS rather than a missing
line.

Links between pages work in the preview. Clicking `<a href="about.html">`
shows About, a **Back** bar appears above the preview, and **Run** always
returns to `index.html` — so there is one rule to remember rather than a
history to keep track of. Auto-refresh is the opposite: it re-renders whatever
page is showing, so editing About updates About.

`<a href="#section">` jumps within the page, as it should. A link to another
*site* is stopped with a note in the console rather than followed — otherwise
it would replace the student's work with someone else's page and the only way
back would be Run.

Every `href` a student can write is intercepted, including the ones that look
like they need no help. An in-page anchor especially: the preview comes from
`srcdoc` and has **no URL of its own**, so `#contact` is not same-page to it.
Left to the browser it resolves against `document.baseURI` — the editor's own
address — and the frame navigates to WebIDE and renders the whole IDE inside
its own preview pane. Measured, from the bug report that found it:

```
<a href="#contact">  unprevented ->  https://webide-…/s/ynfkun6#contact
```

So anchors scroll the preview by hand, `href="#"` goes to the top, an anchor
with no matching id says so in the console, and an empty `href` is stopped
rather than reloading the IDE into itself.

### Forms

Forms work as far as they can without a server:

- **`e.preventDefault()` in a submit handler works** — the ordinary way forms
  are taught. It didn't before: the preview was missing the `allow-forms`
  sandbox permission, so the submit event never fired at all and a correct
  handler silently did nothing. That was a real bug, found while building this.
- **A form nobody has written JavaScript for still does something.** The
  submitted fields are printed to the console, name by name, which is the part
  of a form worth looking at anyway.
- **`action="thanks.html"` moves to that page**, and the values arrive there as
  `window.formData` — `formData.hero` and so on.

`formData` is a stand-in, and worth being honest with students about: a real
server hands the values over in the query string, but a sandboxed preview has
no address to put one in. `history.replaceState` throws on an opaque origin, so
`location.search` can never be anything but empty here. It's a reasonable
bridge to the Web 2 class, where the same form posts to Flask for real.

Nothing is ever actually submitted anywhere. Every submission is caught in the
preview, so `allow-forms` grants the event, not the network.

<details>
<summary>Why the preview needs all this instead of just letting links work</summary>

The preview is a `srcdoc` document with no address of its own, so it borrows
the editor's URL as its base. Measured in Chrome:

```
document.baseURI              -> https://your-app.onrender.com/
<a href="about.html"> becomes -> https://your-app.onrender.com/about.html
click                         -> the frame navigated away
```

A student clicking their own nav link got this app's 404 and lost their page
until they pressed Run. So links and form actions are caught by the bridge
script already injected for the console, and handed to the editor, which
rebuilds the preview around the requested file. `assemble()` takes the entry
page as an argument; everything else — inlining that page's own `<link>` and
`<script>`, mapping error lines back — works the same for any page.

The one thing this can't catch is `window.location = "page.html"` set from
JavaScript. Links and form submissions are interceptable; assigning to
`location` isn't.

</details>

A pause rather than a keystroke, because re-rendering on every character would
spend most of its time displaying half-typed tags and unfinished selectors.
Three details that are easy to get wrong, all of them tested:

- **Stop means stop.** Without that, the next keystroke would start the program
  up again a moment later — worst of all for the runaway loop Stop exists to
  deal with. Auto-refresh stays off until Run is pressed again.
- **An edit that changes nothing doesn't reload**, so typing and undoing leaves
  the preview alone.
- **Games are the exception, and get their own remembered setting.** A reload
  starts a game from its first frame, which is useful while tuning a jump
  height and infuriating while playing level three, so Auto starts off for a
  game and on for a page. A student who wants it while tuning numbers can turn
  it on without changing what happens on their next ordinary page.

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
frustration — **on the line they were opened on**. The addon otherwise carries
a list of "block" tags (`h1`–`h6`, `div`, `p`, `ul`, `table` and a dozen more)
that it spreads across three lines with the cursor on a blank one in the
middle. That is a reasonable habit for someone laying out a page section, and a
bad surprise for a beginner typing `<h1>Hello</h1>` who watches their heading
and its closing tag fly apart. Void tags are untouched: `<br>` and `<img>`
still don't get a closing tag.

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

### The sprite panel

**Sprites** in the toolbar opens a searchable grid of all 60 bundled images
with their names and pixel sizes — the same panel as the Python editor. The
button only appears once a project is a game, and disappears again if the
library tag is removed.

Clicking a sprite inserts the line students actually mistype:

```js
loadSprite("bean", "sprites/bean.png");
```

The name and the path have to agree, and getting one of them wrong is the
commonest reason a sprite silently doesn't appear. The insert goes into
`script.js` (or whichever `.js` tab is open), not into the HTML.

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
