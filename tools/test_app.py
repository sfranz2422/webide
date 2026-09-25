#!/usr/bin/env python3
"""The editor's own wiring, checked without a browser.

    python3 tools/test_app.py

WHY THIS FILE EXISTS

It was written the day game mode was removed. Taking a feature out of an app
touches the server, the template, two scripts and the stylesheet, and every
way of getting it wrong is silent:

  * a `$("sprites-toggle")` left behind reaches for an element that is gone,
    `addEventListener` is never called, and the button it was meant to wire
    up is simply dead. No error anywhere.
  * a `url_for('new_game')` left in the template is a BuildError — that one
    at least shouts, but only on the page that renders it.
  * a script the page loads that no longer exists is a 404, and the page
    renders perfectly with half its behaviour missing.
  * a deleted route that something still links to is a 404 for a student
    holding a worksheet.

None of that is caught by opening the page and glancing at it, because the
parts that break are the parts you are not looking at.
"""
from __future__ import annotations

import os
import pathlib
import re
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT))

# SQLite in a temp dir: the repo folder may be on a filesystem that cannot
# take the locks SQLite wants, and a test that fails for that reason teaches
# nothing.
_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_db.close()
os.environ["DATABASE_URL"] = "sqlite:///" + _db.name

import app as A                                                   # noqa: E402

results = []


def check(label, ok, detail=""):
    results.append(bool(ok))
    print("  %-4s %-58s %s" % ("ok" if ok else "FAIL", label, detail))


def done():
    bad = results.count(False)
    print("\n%s (%d checks, %d failed)"
          % ("SOME FAILED" if bad else "ALL PASSED", len(results), bad))
    os.unlink(_db.name)
    sys.exit(1 if bad else 0)


client = A.app.test_client()

# ---------------------------------------------------------------- the page
r = client.get("/")
check("the editor loads", r.status_code == 200, "%d bytes" % len(r.data))
page = r.data.decode()

for want, why in [
    ("window.WEBIDE", "the config the editor reads"),
    ("app.js", "the editor"),
    ("runner.js", "document assembly and the sandbox bridge"),
    ("index.html", "the starter's entry file"),
]:
    check("  serves %s" % why, want in page, want)

r = client.get("/healthz")
check("there is a health check for Render", r.status_code == 200)

# ------------------------------------------------------------- the starter
#
# Not "is it there" — is it a project. A starter that does not run is the
# first thing every student sees, and they will assume they broke it.
check("the starter has an %s" % A.ENTRY, A.ENTRY in A.STARTER)
files, err = A.validate_files(A.STARTER)
check("  and passes the project rules it is shipped under", err is None, err or "")

entry = A.STARTER[A.ENTRY]
linked = re.findall(r'(?:src|href)="([^"]+)"', entry)
local = [x for x in linked if not x.startswith(("http", "//", "#"))]
absent = [x for x in local if x not in A.STARTER]
check("  and every file it references is in the starter", not absent, str(absent))
check("  (and it references some)", len(local) >= 2, str(local))

# --------------------------------------------------------------- game mode
#
# Removed deliberately; PyIDE is where games live now. These checks are not
# about taste — a half-removal is what leaves dead buttons and 404s, and the
# way back in is always a well-meaning copy from PyIDE.
GONE = ["kaplay", "sprite", "GAME_LIB", "GAME_ROOT", "gameInstalled",
        "GAME_STARTER", "isGame", "newgame"]


def code_only(text, suffix):
    """The file with its prose removed.

    Comments and docstrings explain why something was taken out, so they name
    the thing on purpose — `/game`'s docstring says it used to be a Kaplay
    mode, and should. Scanning them for banned words means the honest
    explanation trips the check, which is how a guard ends up being deleted
    for being annoying rather than for being wrong.

    A first attempt skipped lines CONTAINING a triple quote, which missed
    every line inside a docstring. This tracks the state instead.
    """
    out, in_block = [], False
    for line in text.splitlines():
        stripped = line.strip()
        if suffix == ".py":
            if in_block:
                if '"""' in line or "\'\'\'" in line:
                    in_block = False
                continue
            if stripped.startswith("#"):
                continue
            opens = stripped.count('"""') + stripped.count("\'\'\'")
            if opens == 1:
                in_block = True
                line = line.split('"""')[0].split("\'\'\'")[0]
        else:
            if in_block:
                if "*/" in line or "-->" in line:
                    in_block = False
                    line = line.split("*/")[-1].split("-->")[-1]
                else:
                    continue
            if stripped.startswith("//"):
                continue
            for opener, closer in (("/*", "*/"), ("<!--", "-->")):
                if opener in line and closer not in line.split(opener, 1)[1]:
                    in_block = True
                    line = line.split(opener)[0]
                    break
        out.append(line)
    return "\n".join(out)


sources = (list(ROOT.glob("*.py")) + list((ROOT / "static").glob("*"))
           + list((ROOT / "templates").glob("*.html")))
offenders = []
for path in sources:
    if path.is_dir() or path.suffix not in (".py", ".js", ".css", ".html"):
        continue
    body = code_only(path.read_text(errors="replace"), path.suffix)
    for word in GONE:
        for line in body.splitlines():
            if word.lower() in line.lower():
                offenders.append("%s: %s (%s)"
                                 % (path.name, word, line.strip()[:38]))
                break
check("no game-mode code survives anywhere", not offenders,
      "; ".join(offenders[:3]))

check("the vendored library and sprites are gone",
      not (ROOT / "static" / "game").exists())

r = client.get("/game")
check("an old /game link redirects instead of 404ing",
      r.status_code in (301, 302), "%d" % r.status_code)
check("  to the editor", r.headers.get("Location", "").endswith("/"),
      r.headers.get("Location"))

# --------------------------------------------------------- the editor wiring
#
# THE DEAD BUTTON. Every `$("id")` in the JavaScript is a bet that the element
# survived whatever last changed the template. A missed one does not error:
# addEventListener is never reached and the control does nothing at all.
#
# The TEMPLATE is read rather than the rendered page, because half these
# elements only appear for a teacher or a signed-in student, and rendering
# anonymously would report them all missing.
template = (ROOT / "templates" / "index.html").read_text()
ids = set(re.findall(r'id="([^"]+)"', template))

dangling = []
for name in ("app.js", "account.js", "notes.js"):
    text = (ROOT / "static" / name).read_text()
    for wanted in set(re.findall(r'\$\(\s*"([^"]+)"\s*\)', text)):
        if wanted not in ids:
            dangling.append("%s wants #%s" % (name, wanted))
check("every element the editor's JavaScript reaches for exists",
      not dangling, "; ".join(sorted(dangling)[:3]))
check("  (and the scan found something to scan)",
      len(ids) > 15 and "run" in ids, "%d ids in the template" % len(ids))

# The reverse: a script the page loads that is not in the repo is a 404 and a
# dead editor, and the page still renders perfectly.
for src in re.findall(r"filename='([^']+)'", template):
    check("  static/%s exists" % src, (ROOT / "static" / src).is_file())

# Nothing may call into WebIDERun that it no longer exports.
runner = (ROOT / "static" / "runner.js").read_text()
exported = set(re.findall(r"^\s{4}(\w+):", runner, re.M))
used = set()
for name in ("app.js", "demo.js"):
    used |= set(re.findall(r"WebIDERun\.(\w+)", (ROOT / "static" / name).read_text()))
check("every WebIDERun.x the editor calls is actually exported",
      used <= exported, str(sorted(used - exported)))
check("  (and it calls some)", len(used) >= 3, str(sorted(used)))

# ------------------------------------------- publish edits what it published
#
# Publish used to POST a new assignment every single press, so a teacher
# revising a task ended up with three links and no way to tell which one the
# class was holding. Nothing errored — it did exactly what it was told, three
# times. Wanting a second, separate assignment has a better path: share the
# project to yourself and publish the copy, which arrives named "Copy of ...".
#
# PyIDE and this editor share a teacher and a workflow but not a file, so the
# fix had to be made twice. That is the reason for the check: the next person
# to change one of them will not think to look at the other.
account = (ROOT / "static" / "account.js").read_text()

check("publishing twice updates rather than duplicating",
      "if (cfg.editingAssignment)" in account
      and "updateAssignment(btn, read, say)" in account)
check("  and the button says so afterwards",
      'btn.textContent = "Update assignment"' in account)
check("  remembering what it just published",
      "cfg.editingAssignment = out.data.slug" in account)
check("  with one shared update function",
      account.count("function updateAssignment(") == 1
      and account.count('/api/assignment/" + encodeURIComponent') == 1)

check("this editor's table is its own, not PyIDE's",
      A.Project.__tablename__ == "projects", A.Project.__tablename__)
check("and it books into the shared account tables under its own name",
      A.APP_NAME == "webide", A.APP_NAME)

# ------------------------------------------------- find and replace is wired
#
# Ctrl-F / Cmd-F comes from CodeMirror's own addons, which means the whole
# feature is four files in the template and nothing else. Three ways that
# goes wrong, none of which raises:
#
#   * search.js without searchcursor.js — search.js USES it and does not
#     fetch it, so Ctrl-F throws inside CodeMirror and the key does nothing.
#   * search.js without dialog.js — same, for the prompt.
#   * everything but dialog.min.css — and this is the nasty one. The feature
#     WORKS. Find, next, replace, all of it. The bar asking for the search
#     term is just an unstyled input floating over the code, so it ships.
template_text = (ROOT / "templates" / "index.html").read_text()
for addon in ("addon/dialog/dialog.min.js",
              "addon/search/searchcursor.min.js",
              "addon/search/search.min.js",
              "addon/dialog/dialog.min.css"):
    check("the editor loads %s" % addon.split("/")[-1],
          addon in template_text)

# Order matters: search.js reads CodeMirror.fromTextArea's searchcursor at
# call time, but registers against the API that searchcursor installs.
check("  and searchcursor is loaded before search",
      template_text.find("searchcursor.min.js") <
      template_text.find("addon/search/search.min.js"))

# The bar CodeMirror builds is about 130px wide for the search term, which
# is four or five characters of it. Sized here rather than left alone.
style_text = (ROOT / "static" / "style.css").read_text()
EDITOR_SCRIPT = "app.js"
# THE ADDONS MUST LOAD BEFORE THE EDITOR IS BUILT.
#
# search.js calls CodeMirror.defineOption("search", {bottom: false}), and a
# default set by defineOption only reaches editors made AFTER it runs. An
# editor built first has options.search undefined, and search.js then reads
# `cm.options.search.bottom` with no guard:
#
#     TypeError: Cannot read properties of undefined (reading 'bottom')
#
# Found by loading the addons into the deployed editor by hand, where the
# editor already existed: Ctrl-F threw that, which names neither the addon
# nor the option nor anything a person would search for. In the page the
# order is right; this is here so it stays right.
check("  and the addons load before %s builds the editor" % EDITOR_SCRIPT,
      template_text.find("addon/search/search.min.js")
      < template_text.find(EDITOR_SCRIPT),
      "search.js at %d, %s at %d"
      % (template_text.find("addon/search/search.min.js"), EDITOR_SCRIPT,
         template_text.find(EDITOR_SCRIPT)))

check("  and the search bar is given a usable width",
      ".CodeMirror-dialog input" in style_text)

done()
