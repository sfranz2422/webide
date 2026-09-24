#!/usr/bin/env python3
"""Tab and Backspace land on tab stops, and only inside the indentation.

    python3 tools/test_tabstops.py

The unit here is TWO, not four — this editor writes HTML — so these cases
are not PyIDE's with the numbers changed. They are the reason the handlers
read indentUnit from the editor instead of writing a number down.

WHY THIS IS TESTED AND NOT JUST EYEBALLED

HTML and JavaScript do not care about indentation, which is exactly why it
goes wrong here and stays wrong: a drifted file still renders, so nothing
ever tells a student about it, and by thirty lines the nesting is
unreadable. Reading your own markup is most of what debugging it is.

And the ways of getting this wrong are all invisible in a screenshot:

  * Backspace eating four characters of a WORD rather than of an indent
  * a stop computed from cm.getCursor().ch while a pasted literal tab makes
    the column and the character offset different numbers
  * Tab moving a fixed four from column 2, so the file is still misaligned
    and now nobody can see by how much

The two handlers are pulled out of the shipped app.js and run here against
a small stand-in editor. Retyping them would be testing a copy that happens
to agree with the original today.
"""
from __future__ import annotations

import json
import pathlib
import re
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
APPJS = ROOT / "static" / "app.js"

results = []


def check(label, ok, detail=""):
    results.append(bool(ok))
    print("  %-4s %-58s %s" % ("ok" if ok else "FAIL", label, detail))


def done():
    bad = results.count(False)
    print("\n%s (%d checks, %d failed)"
          % ("SOME FAILED" if bad else "ALL PASSED", len(results), bad))
    sys.exit(1 if bad else 0)


app = APPJS.read_text()


def lift(name):
    """The named function, exactly as it ships, brace-matched out of app.js."""
    start = app.find("function %s(cm) {" % name)
    if start < 0:
        return ""
    depth, i = 0, app.index("{", start)
    while i < len(app):
        if app[i] == "{":
            depth += 1
        elif app[i] == "}":
            depth -= 1
            if depth == 0:
                return app[start:i + 1]
        i += 1
    return ""


tab_fn = lift("indentToTabStop")
back_fn = lift("backspaceToTabStop")
spaces_fn = lift("spaces").replace("function spaces(cm)", "function spaces(n)")
if not spaces_fn:
    m = re.search(r"function spaces\(n\) \{.*?\n  \}", app, re.S)
    spaces_fn = m.group(0) if m else ""

check("indentToTabStop was found in app.js", len(tab_fn) > 100, "%d chars" % len(tab_fn))
check("backspaceToTabStop was found in app.js", len(back_fn) > 100,
      "%d chars" % len(back_fn))
check("  and the helper it uses", "new Array(n + 1).join" in spaces_fn)
check("both are actually bound to the keys", "Tab: indentToTabStop" in app
      and "Backspace: backspaceToTabStop" in app)

# A stand-in editor: one line, one caret, the options the real editor uses.
HARNESS = r"""
const PASS = Symbol("pass");
const CodeMirror = {
  Pass: PASS,
  countColumn: function (line, end, tabSize) {
    let col = 0;
    for (let i = 0; i < end; i++) {
      col += line[i] === "\t" ? tabSize - (col %% tabSize) : 1;
    }
    return col;
  }
};

%s
%s
%s

function editorWith(line, ch, carets) {
  return {
    line: line,
    ch: ch,
    getOption: function (k) { return k === "indentUnit" ? 2 : 2; },
    getLine: function () { return this.line; },
    getCursor: function () { return { line: 0, ch: this.ch }; },
    somethingSelected: function () { return false; },
    listSelections: function () { return new Array(carets || 1).fill({}); },
    replaceSelection: function (text) {
      this.line = this.line.slice(0, this.ch) + text + this.line.slice(this.ch);
      this.ch += text.length;
    },
    replaceRange: function (text, from, to) {
      this.line = this.line.slice(0, from.ch) + text + this.line.slice(to.ch);
      this.ch = from.ch;
    }
  };
}

const out = [];
for (const c of %s) {
  const cm = editorWith(c.line, c.ch, c.carets);
  const fn = c.key === "tab" ? indentToTabStop : backspaceToTabStop;
  const r = fn(cm);
  out.push({ passed: r === PASS, line: cm.line, ch: cm.ch });
}
console.log(JSON.stringify(out));
"""

CASES = [
    # ---- Tab: always forward, always onto a stop -------------------------
    ("tab", "", 0, None, "  ", 2, False,
     "Tab at the start of an empty line goes to 2"),
    ("tab", "  ", 2, None, "    ", 4, False,
     "  and from a stop, a whole step further"),
    ("tab", " ", 1, None, "  ", 2, False,
     "  from column 1 it moves 1, not 2"),
    ("tab", "   ", 3, None, "    ", 4, False,
     "  from column 3 it moves 1"),
    # Column 5, so the next stop is 6 and it moves 1 — not a full unit.
    ("tab", "<h1>H", 5, None, "<h1>H ", 6, False,
     "  mid-line it still lands on a stop"),
    ("tab", "<p>", 3, None, "<p> ", 4, False,
     "  after an odd number of characters it moves 1"),

    # ---- Backspace inside the indentation --------------------------------
    ("back", "  ", 2, None, "", 0, False,
     "Backspace at column 2 clears the whole indent"),
    ("back", "    ", 4, None, "  ", 2, False,
     "  at column 4 it goes back to 2"),
    ("back", "   ", 3, None, "  ", 2, False,
     "  from column 3 it goes to 2, the nearest stop"),
    ("back", " ", 1, None, "", 0, False,
     "  from column 1 it goes to 0"),
    ("back", "  <p>Hi</p>", 2, None, "<p>Hi</p>", 0, False,
     "  it works with markup after the caret"),
    ("back", "     <p>", 5, None, "    <p>", 4, False,
     "  and lands on the stop, not two characters back"),

    # ---- Backspace everywhere else: one character, handled by CodeMirror --
    ("back", "<div>", 5, None, "<div>", 5, True,
     "Backspace in a TAG NAME is left to CodeMirror"),
    ("back", "let x = 1", 9, None, "let x = 1", 9, True,
     "  and after code"),
    ("back", "  <p", 4, None, "  <p", 4, True,
     "  and just past the indentation"),
    ("back", "", 0, None, "", 0, True,
     "  at the very start of a line, so lines still join"),
    ("back", "\t\t", 2, None, "\t\t", 2, True,
     "  and in a pasted literal tab, where a stop is ambiguous"),
    ("back", " \t ", 3, None, " \t ", 3, True,
     "  and in mixed spaces and tabs"),

    # ---- more than one caret --------------------------------------------
    ("tab", " ", 1, 3, "   ", 3, False,
     "Tab with several carets falls back to a whole unit"),
    ("back", "  ", 2, 3, "  ", 2, True,
     "  and Backspace hands those to CodeMirror"),
]

probe = HARNESS % (
    spaces_fn, tab_fn, back_fn,
    json.dumps([{"key": k, "line": line, "ch": ch, "carets": carets}
                for k, line, ch, carets, _, _, _, _ in CASES]),
)

proc = subprocess.run(["node", "-e", probe], capture_output=True, text=True)
if proc.returncode != 0:
    check("the handlers run at all", False, proc.stderr.strip()[-300:])
    done()

got = json.loads(proc.stdout)
for (key, line, ch, carets, want_line, want_ch, want_pass, label), g in zip(CASES, got):
    ok = (g["passed"] == want_pass
          and (want_pass or (g["line"] == want_line and g["ch"] == want_ch)))
    detail = "" if ok else "got %r ch=%d passed=%s" % (g["line"], g["ch"], g["passed"])
    check(label, ok, detail)

done()
