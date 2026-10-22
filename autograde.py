"""
Tests in an assignment's notes, for Check my work and Check all — WebIDE's.

A ```tests block in the notes is the assignment's tests, one per line,
checked against the student's page as a browser shows it:

    has h1                          at least one <h1>
    has 3 li                        at least three
    has exactly 2 img               exactly two
    h1 contains Welcome             the first h1's text contains it
                                    (case and spacing ignored)
    img has alt                     every img has an alt attribute
    links to about.html             an <a href> going there
    h1 color is red                 the computed style, compared as the
                                    browser computes "red"
    click #btn -> #out contains 1   click the first #btn, then check
    logs Hello                      console.log printed it
    uses addEventListener           the page's JavaScript (script tags and
                                    .js files) has that word
    avoids innerHTML                ... doesn't
    defines greet                   a function greet in the JavaScript
    about.html: has h2              any line, on another page instead of
                                    index.html
    #named color is red             an id is a selector like any other
    # a comment                     ignored: # and then a space

Each is worth 1 point, or "(2 points)" at the end of its line says so.

THE TESTS RUN IN A BROWSER, NEVER ON THE SERVER — the server never runs a
student's code (CLAUDE.md). A student's Check my work runs them in their own
browser and is feedback, and a determined student could fake it; it is kept
only so the teacher can see it. What counts toward the grade is the
teacher's Check all, which runs every turned-in project in the TEACHER's
browser and posts the result from there (app.py, "Tests").

PyIDE has the same feature for Python programs, with its own autograde.py;
the routes and the table (accounts.TestResult) are the same in both.

static/autograde.js reads a block exactly as parse() here does, and runs
it; test_autograde.py holds the two to each other.
"""

import re

FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})(.*)$")
POINTS = re.compile(r"\s*\((\d{1,4}(?:\.\d{1,2})?)\s*points?\)\s*$", re.I)
PAGE = re.compile(r"^([\w./-]+\.html?):\s+(.+)$", re.I)
CLICK = re.compile(r"^click\s+(.+?)\s*->\s*(.+)$", re.I)
COUNT = re.compile(r"^has\s+(exactly\s+)?(?:(\d{1,4})\s+)?(.+)$", re.I)
LINKS = re.compile(r"^links\s+to\s+(.+)$", re.I)
LOGS = re.compile(r"^logs\s+(.+)$", re.I)
CODE = re.compile(r"^(uses|avoids|defines)\s+(.+?)\s*$", re.I)
ATTR = re.compile(r"^(.+?)\s+has\s+([A-Za-z_:][-A-Za-z0-9_:.]*)$", re.I)
# A comment is "#" and a space (or "#" alone). "#" alone at the start was the
# rule once, and it silently threw away every test written for an id —
# "#named background-color is tomato" became a comment, no error, one test
# fewer, and the block still looked fine to the teacher who wrote it.
COMMENT = re.compile(r"^#(\s|$)")
STYLE = re.compile(r"^(.+?)\s+([A-Za-z-]+)\s+is\s+(.+)$", re.I)


def _blocks(md):
    """The text of every ```tests block, in order."""
    out, lines, i = [], (md or "").split("\n"), 0
    while i < len(lines):
        f = FENCE.match(lines[i])
        if f and f.group(2).strip().lower() == "tests":
            fence, body, i = f.group(1), [], i + 1
            while i < len(lines):
                g = FENCE.match(lines[i])
                if g and g.group(1)[0] == fence[0] and len(g.group(1)) >= len(fence) \
                        and not g.group(2).strip():
                    break
                body.append(lines[i])
                i += 1
            out.append("\n".join(body))
        i += 1
    return out


def _check(line):
    """One check that looks at the page (no page prefix, no click), or None."""
    m = COUNT.match(line)
    if m:
        exact, n = bool(m.group(1)), int(m.group(2)) if m.group(2) else 1
        if exact and not m.group(2):
            return None
        return {"kind": "count", "exact": exact, "n": n, "selector": m.group(3).strip()}
    m = LINKS.match(line)
    if m:
        return {"kind": "links", "href": m.group(1).strip()}
    m = LOGS.match(line)
    if m:
        return {"kind": "logs", "text": m.group(1).strip()}
    if " contains " in line:
        sel, text = line.split(" contains ", 1)
        return {"kind": "contains", "selector": sel.strip(), "text": text.strip()}
    m = ATTR.match(line)
    if m:
        return {"kind": "attr", "selector": m.group(1).strip(), "attr": m.group(2)}
    m = STYLE.match(line)
    if m:
        return {"kind": "style", "selector": m.group(1).strip(),
                "prop": m.group(2).lower(), "value": m.group(3).strip()}
    return None


def _label(t):
    k = t["kind"]
    if k == "count":
        if t["exact"]:
            said = "Has exactly %d %s" % (t["n"], t["selector"])
        elif t["n"] == 1:
            said = "Has %s" % t["selector"]
        else:
            said = "Has at least %d %s" % (t["n"], t["selector"])
    elif k == "contains":
        said = "%s contains %s" % (t["selector"], t["text"])
    elif k == "attr":
        said = "Every %s has %s" % (t["selector"], t["attr"])
    elif k == "links":
        said = "Links to %s" % t["href"]
    elif k == "style":
        said = "%s %s is %s" % (t["selector"], t["prop"], t["value"])
    elif k == "logs":
        said = "Logs %s" % t["text"]
    elif k == "uses":
        said = "Uses %s" % t["name"]
    elif k == "avoids":
        said = "Doesn't use %s" % t["name"]
    else:
        said = "Defines %s()" % t["name"]
    if t.get("click"):
        said = "After clicking %s: %s" % (t["click"], said)
    if t.get("page"):
        said = "%s: %s" % (t["page"], said)
    return said


def parse_block(body):
    """(tests, errors) for one block's text. An error is a line the teacher
    wrote that isn't a test — said, not skipped, or a typo silently becomes
    a test nobody can fail."""
    tests, errors = [], []
    for n, raw in enumerate((body or "").split("\n"), 1):
        line = raw.strip()
        if not line or COMMENT.match(line):
            continue
        whole = line
        points = 1.0
        m = POINTS.search(line)
        if m:
            points = float(m.group(1))
            line = line[:m.start()].rstrip()
        page = ""
        m = PAGE.match(line)
        if m:
            page, line = m.group(1), m.group(2).strip()
        t = None
        m = CODE.match(line)
        if m and not page:
            name = m.group(2).strip()
            if name.endswith("()"):
                name = name[:-2]
            t = {"kind": m.group(1).lower(), "name": name}
        if t is None:
            m = CLICK.match(line)
            if m:
                t = _check(m.group(2).strip())
                if t is not None:
                    t["click"] = m.group(1).strip()
            else:
                t = _check(line)
        if t is None:
            errors.append("Line %d of the tests isn't a test: %s" % (n, whole))
            continue
        t.setdefault("click", "")
        t["page"] = page
        t["points"] = points
        t["label"] = _label(t)
        tests.append(t)
    return tests, errors


def parse(md):
    """Every test in a notes file, and every line that isn't one."""
    tests, errors = [], []
    for body in _blocks(md):
        got, bad = parse_block(body)
        tests += got
        errors += bad
    return tests, errors


def file_tests(files):
    """The tests in an assignment's notes (every .md), and the errors."""
    tests, errors = [], []
    for name in sorted(files or {}):
        if name.lower().endswith(".md") and isinstance(files[name], str):
            got, bad = parse(files[name])
            tests += got
            errors += bad
    return tests, errors


def possible(files):
    return round(sum(t["points"] for t in file_tests(files)[0]), 2)
