#!/usr/bin/env python3
"""Tests in an assignment's notes: Check my work and Check all — WebIDE's
(autograde.py, static/autograde.js, "Tests" in app.py).

    python3 tools/test_autograde.py

WHY THIS FILE EXISTS

A test that passes a wrong page, or fails a right one, is a wrong grade —
and once the teacher presses Check all, it is the grade that goes to
Classroom. So this pins:

  * the format: what each line is, its points, its page, and a line that
    isn't a test being said rather than quietly skipped;
  * autograde.js reads every block exactly as autograde.py does (node);
  * the checks, run in a real browser (headless Chrome), pass the right site
    and fail each wrong one for the right reason — a colour, a missing alt,
    a button that does nothing, a count, a page that never finishes, a page
    that isn't there;
  * the server: a student's own check is kept and counts for nothing; only
    the teacher's verified result is added to the grade; it can complete a
    quest; a verified result older than the work is marked stale; a page
    can't claim more points than the lines it sent; only the teacher can
    fetch the work or post a verified result; the help's example parses.

Needs node, Chrome, and the `ws` package (from ../pyide/node_modules).
"""
import html as _html
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
AUTOGRADE = os.path.join(ROOT, "static", "autograde.js")
RUNNER = os.path.join(ROOT, "static", "runner.js")
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
WS = os.path.join(os.path.dirname(ROOT), "pyide", "node_modules", "ws")

DB = os.path.join(tempfile.mkdtemp(), "ag.db")
os.environ["DATABASE_URL"] = "sqlite:///" + DB
os.environ["TEACHER_EMAILS"] = "teacher@school.org, other@school.org"
os.environ["SECRET_KEY"] = "k" * 32
os.environ.pop("ALLOWED_EMAIL_DOMAINS", None)
sys.path.insert(0, ROOT)
import autograde                                             # noqa: E402

results = []


def check(label, ok, detail=""):
    results.append(bool(ok))
    print("  %-4s %-64s %s" % ("ok" if ok else "FAIL", label, detail))


NOTES = """# My site

Make a home page and an about page.

```tests
# a comment
has h1
has 3 li
has exactly 2 img
h1 contains welcome
img has alt
links to about.html
h1 color is red
click #btn -> #out contains 1        (2 points)
logs Hello
uses addEventListener
avoids innerHTML
defines greet
about.html: has h2
```
"""

# ------------------------------------------------------------- the format
print("\nThe format")
tests, errors = autograde.parse(NOTES)
kinds = [t["kind"] for t in tests]
check("thirteen tests, comment skipped",
      kinds == ["count", "count", "count", "contains", "attr", "links", "style",
                "contains", "logs", "uses", "avoids", "defines", "count"], kinds)
check("has counts at least one, a number, or exactly",
      (tests[0]["n"], tests[0]["exact"], tests[1]["n"], tests[2]["exact"], tests[2]["n"])
      == (1, False, 3, True, 2))
check("contains splits on the first ' contains '",
      tests[3]["selector"] == "h1" and tests[3]["text"] == "welcome")
check("a style check is selector, property, value",
      (tests[6]["selector"], tests[6]["prop"], tests[6]["value"]) == ("h1", "color", "red"))
check("a click names what to click and what to check after",
      tests[7]["click"] == "#btn" and tests[7]["selector"] == "#out" and tests[7]["points"] == 2)
check("a page prefix sends the line to that page",
      tests[12]["page"] == "about.html" and tests[12]["selector"] == "h2"
      and all(t["page"] == "" for t in tests[:12]))
check("labels read as sentences",
      [t["label"] for t in tests] == [
          "Has h1", "Has at least 3 li", "Has exactly 2 img", "h1 contains welcome",
          "Every img has alt", "Links to about.html", "h1 color is red",
          "After clicking #btn: #out contains 1", "Logs Hello", "Uses addEventListener",
          "Doesn't use innerHTML", "Defines greet()", "about.html: Has h2"],
      [t["label"] for t in tests])
_, errs = autograde.parse("```tests\nmake it pretty\nhas exactly li\n```")
check("a line that isn't a test is an error, not skipped",
      len(errs) == 2 and all("isn't a test" in e for e in errs), errs)
check("possible points add up", autograde.possible({"notes.md": NOTES}) == 14)

# ------------------------------------------------- the same in JavaScript
node = shutil.which("node")
if not node:
    check("node is here", False, "brew install node")
    sys.exit(1)
check("#id starts a test; only # and a space is a comment",
      [t["selector"] for t in autograde.parse("```tests\n#named color is red\n#\n#  note\n```")[0]]
      == ["#named"])
samples = [NOTES, "```tests\n#named background-color is rgb(255, 99, 71)  (2 points)\n# note\nnav a background-color is #333\nul > li contains  Milk  (3 points)\n```",
           "```tests\nmake it pretty\nabout.html: uses fetch\nhas exactly li\n```", "no block here",
           "```tests\nclick button.go -> has 4 li\nform has action  (1 point)\n```"]
script = ("global.window={};eval(require('fs').readFileSync(%s,'utf8'));"
          "process.stdout.write(JSON.stringify(%s.map(s=>window.WebIDETests.parse(s))))"
          % (json.dumps(AUTOGRADE), json.dumps(samples)))
out = subprocess.run([node, "-e", script], capture_output=True, text=True)
try:
    js = json.loads(out.stdout)
except ValueError:
    js = []
check("node read autograde.js", len(js) == len(samples), out.stderr[-300:])
for i, (s, j) in enumerate(zip(samples, js)):
    py = autograde.parse(s)
    same = j["tests"] == py[0] and j["errors"] == py[1]
    check("  sample %d reads the same in both" % (i + 1), same,
          "" if same else "js=%r py=%r" % (j, py))

# ------------------------------------------ the checks, in a real browser
print("\nRunning the checks (headless Chrome)")
RIGHT = {
    "index.html": """<!doctype html><html><head><link rel="stylesheet" href="style.css"></head>
<body><h1>Welcome to   my SITE</h1>
<ul><li>a</li><li>b</li><li>c</li></ul>
<img src="a.png" alt="A"><img src="b.png" alt="B">
<a href="about.html">About</a>
<button id="btn">Go</button><p id="out">0</p>
<script src="script.js"></script></body></html>""",
    "style.css": "h1 { color: red; }",
    "script.js": "function greet() { return 'hi'; }\n"
                 "document.getElementById('btn').addEventListener('click', function () {\n"
                 "  document.getElementById('out').textContent = '1';\n});\n"
                 "console.log('Hello there');\n",
    "about.html": "<h2>About me</h2>",
}


def variant(**changes):
    files = dict(RIGHT)
    for name, (old, new) in changes.items():
        assert old in files[name], (name, old)
        files[name] = files[name].replace(old, new)
    return files


SITES = {
    "right": RIGHT,
    "blue": variant(**{"style.css": ("red", "blue")}),
    "no_alt": variant(**{"index.html": ('alt="B"', "")}),
    "dead_button": variant(**{"script.js": ("addEventListener('click'", "onclick = (")}),
    "three_img": variant(**{"index.html": ('<a href', '<img src="c.png" alt="C"><a href')}),
    "inner": variant(**{"script.js": ("textContent = '1'", "innerHTML = '1'")}),
    "no_about": {k: v for k, v in RIGHT.items() if k != "about.html"},
    "endless": variant(**{"script.js": ("console.log('Hello there');", "while (true) {}")}),
}
if not os.path.exists(CHROME) or not os.path.isdir(WS):
    check("Chrome and ../pyide/node_modules/ws are here", False)
    sys.exit(1)
work = tempfile.mkdtemp()
page = os.path.join(work, "run.html")
with open(page, "w") as f:
    f.write('<!doctype html><html><body><script src="file://%s"></script>'
            '<script src="file://%s"></script></body></html>' % (RUNNER, AUTOGRADE))
driver = r"""
const { spawn } = require("child_process");
const WebSocket = require(process.env.WS);
const [chromePath, page, sitesFile, notes] = process.argv.slice(2);
const sites = JSON.parse(require("fs").readFileSync(sitesFile, "utf8"));
const port = 9400 + Math.floor(Math.random() * 400);
const chrome = spawn(chromePath, ["--headless=new", "--remote-debugging-port=" + port,
  "--allow-file-access-from-files", "--user-data-dir=" + require("os").tmpdir() + "/agw" + Date.now(),
  "about:blank"]);
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  let list;
  for (let i = 0; i < 80 && !list; i++) {
    try { list = await (await fetch("http://127.0.0.1:" + port + "/json")).json(); } catch (e) { await sleep(250); }
  }
  const ws = new WebSocket(list.find(t => t.type === "page").webSocketDebuggerUrl);
  await new Promise(r => ws.on("open", r));
  let id = 0; const wait = {};
  ws.on("message", m => { const d = JSON.parse(m); if (d.id && wait[d.id]) { wait[d.id](d.result); delete wait[d.id]; } });
  const send = (method, params) => new Promise(r => { const n = ++id; wait[n] = r; ws.send(JSON.stringify({ id: n, method, params })); });
  const js = async e => { const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }); return r.result ? r.result.value : null; };
  await send("Page.navigate", { url: "file://" + page });
  await sleep(1500);
  const out = {};
  for (const name of Object.keys(sites)) {
    const t0 = Date.now();
    out[name] = await js("window.WebIDETests.run(" + JSON.stringify(sites[name]) + ", window.WebIDETests.parse("
                         + JSON.stringify(notes) + ").tests)");
    if (out[name]) out[name].ms = Date.now() - t0;
  }
  process.stdout.write(JSON.stringify(out));
  chrome.kill(); process.exit(0);
})();
"""
dpath = os.path.join(work, "driver.js")
spath = os.path.join(work, "sites.json")
with open(dpath, "w") as f:
    f.write(driver)
with open(spath, "w") as f:
    json.dump(SITES, f)
env = dict(os.environ, WS=WS)
try:
    out = subprocess.run([node, dpath, CHROME, page, spath, NOTES], capture_output=True,
                         text=True, timeout=300, env=env)
    ran = json.loads(out.stdout or "{}")
except (subprocess.TimeoutExpired, ValueError) as e:
    ran = {}
check("Chrome ran every site", all(ran.get(n) for n in SITES),
      sorted(n for n in SITES if not ran.get(n)))


def lines(name):
    return {r["label"]: r for r in (ran.get(name) or {}).get("results", [])}


r = ran.get("right") or {}
check("the right site passes everything: 14 of 14",
      r.get("earned") == 14 and r.get("possible") == 14,
      [(x["label"], x["detail"]) for x in r.get("results", []) if not x["ok"]])
L = lines("blue")
check("a blue h1 fails only the colour, saying what it is",
      not L["h1 color is red"]["ok"] and "rgb(0, 0, 255)" in L["h1 color is red"]["detail"]
      and ran["blue"]["earned"] == 13, L.get("h1 color is red"))
L = lines("no_alt")
check("an img without alt fails 'Every img has alt', saying how many",
      not L["Every img has alt"]["ok"] and "1 of 2" in L["Every img has alt"]["detail"])
L = lines("dead_button")
check("a button that does nothing fails the click, saying what #out says",
      not L["After clicking #btn: #out contains 1"]["ok"]
      and "It says: 0" in L["After clicking #btn: #out contains 1"]["detail"]
      and not L["Uses addEventListener"]["ok"])
L = lines("three_img")
check("three imgs fails 'exactly 2', saying it has 3",
      not L["Has exactly 2 img"]["ok"] and "It has 3" in L["Has exactly 2 img"]["detail"]
      and L["Every img has alt"]["ok"])
L = lines("inner")
check("avoids catches innerHTML", not L["Doesn't use innerHTML"]["ok"]
      and L["After clicking #btn: #out contains 1"]["ok"])
L = lines("no_about")
check("a missing page says so", not L["about.html: Has h2"]["ok"]
      and "There's no about.html" in L["about.html: Has h2"]["detail"])
L = lines("endless")
check("a page that never finishes fails, with a reason, instead of hanging",
      bool(L) and not L["Has h1"]["ok"] and "didn't finish" in L["Has h1"]["detail"]
      and L["Uses addEventListener"]["ok"], (L.get("Has h1"), (ran.get("endless") or {}).get("ms")))
check("contains and logs ignore case and spacing",
      lines("right")["h1 contains welcome"]["ok"] and lines("right")["Logs Hello"]["ok"]
      and lines("blue")["Logs Hello"]["ok"])

# ---------------------------------------------------------------- server
print("\nThe server")
import app as P                                              # noqa: E402
import accounts                                              # noqa: E402
import xp                                                    # noqa: E402


def add_user(sub, email, name):
    db = P.SessionLocal()
    try:
        u = accounts.User(google_sub=sub, email=email, name=name)
        db.add(u)
        db.commit()
        return u.id
    finally:
        db.close()


def client(uid=None):
    c = P.app.test_client()
    if uid is not None:
        with c.session_transaction() as s:
            s["uid"] = uid
    return c


TEACHER = add_user("t", "teacher@school.org", "Mr Franz")
OTHER = add_user("o", "other@school.org", "Ms Other")
AMY = add_user("a", "amy@school.org", "Amy Adams")
BEN = add_user("b", "ben@school.org", "Ben Brown")
teacher, other, amy, ben = client(TEACHER), client(OTHER), client(AMY), client(BEN)

CLASS = teacher.post("/api/class", json={"name": "P4"}).get_json()["id"]
_db = P.SessionLocal()
for email in ("amy@school.org", "ben@school.org"):
    _db.add(accounts.Enrollment(class_id=CLASS, email=email, name=email))
_db.commit()
_db.close()
SLUG = teacher.post("/api/class/%d/new" % CLASS, json={"title": "My site"}).get_json()["slug"]
teacher.post("/api/assignment/%s" % SLUG, json={"title": "My site",
                                                "files": dict(RIGHT, **{"notes.md": NOTES})})
teacher.post("/api/assignment/%s/out-of" % SLUG, json={"out_of": 14})


def turn_in(c, files):
    draft = c.get("/a/" + SLUG).headers["Location"].rsplit("/", 1)[1]
    r = c.post("/api/submit", json={"draft": draft, "files": dict(files, **{"notes.md": NOTES})})
    return draft, r


DRAFTS = {}
for uid, c, files in ((AMY, amy, RIGHT), (BEN, ben, SITES["blue"])):
    DRAFTS[uid], r = turn_in(c, files)


def sub_of(uid):
    db = P.SessionLocal()
    try:
        return db.query(accounts.Submission).filter_by(student_id=uid).first()
    finally:
        db.close()


check("both turned in", sub_of(AMY) is not None and sub_of(BEN) is not None)
ALL_RIGHT = [{"label": x["label"], "ok": True, "detail": "", "points": x["points"]}
             for x in (ran.get("right") or {}).get("results", [])] or \
            [{"label": t["label"], "ok": True, "detail": "", "points": t["points"]} for t in tests]
r = amy.post("/api/tests/self", json={"assignment": SLUG, "results": ALL_RIGHT})
check("a student's own check is kept", r.status_code == 200 and r.get_json()["earned"] == 14)
page = teacher.get("/teacher/" + SLUG).get_data(as_text=True)
check("  and counts for nothing: no grade from it", "Tests not checked" in page
      and "(their check 14 / 14)" in page)
check("  not on the class page either",
      "badge-grade" not in amy.get("/class/%d" % CLASS).get_data(as_text=True))
r = teacher.get("/api/assignment/%s/tests/work" % SLUG)
got_work = {w["student"]: w for w in r.get_json().get("work", [])}
check("the teacher fetches what each student turned in, every file but notes",
      set(got_work) == {AMY, BEN} and got_work[AMY]["files"].get("style.css") == RIGHT["style.css"]
      and "notes.md" not in got_work[AMY]["files"], sorted(got_work.get(AMY, {}).get("files", {})))
check("  nobody else can", other.get("/api/assignment/%s/tests/work" % SLUG).status_code == 404
      and amy.get("/api/assignment/%s/tests/work" % SLUG).status_code == 403)
r = teacher.post("/api/assignment/%s/tests/verify" % SLUG, json={"student": AMY, "results": ALL_RIGHT})
check("the teacher's check counts: 14 / 14 is the total", r.status_code == 200
      and r.get_json()["total"] == "14", r.get_json())


def test_xp(uid):
    db = P.SessionLocal()
    try:
        return sum(a.xp for a in db.query(accounts.XpAward).filter(
            accounts.XpAward.user_id == uid, accounts.XpAward.source.like("test:%")))
    finally:
        db.close()


check("  and pays XP_PER_POINT a point for the tests that pass",
      test_xp(AMY) == 14 * xp.XP_PER_POINT, test_xp(AMY))
teacher.post("/api/assignment/%s/tests/verify" % SLUG, json={"student": AMY, "results": ALL_RIGHT})
check("  checking again pays nothing twice", test_xp(AMY) == 14 * xp.XP_PER_POINT, test_xp(AMY))
BLUE = (ran.get("blue") or {}).get("results") or [dict(x, ok=x["label"] != "h1 color is red")
                                                   for x in ALL_RIGHT]
r = teacher.post("/api/assignment/%s/tests/verify" % SLUG,
                 json={"student": BEN, "results": BLUE, "earned": 999})
check("a wrong page gets its points only, from the lines, not a claimed sum",
      r.get_json()["earned"] == 13 and r.get_json()["total"] == "13", r.get_json())
check("a student can't post a verified result",
      amy.post("/api/assignment/%s/tests/verify" % SLUG,
               json={"student": AMY, "results": ALL_RIGHT}).status_code == 403)
check("  nor another teacher",
      other.post("/api/assignment/%s/tests/verify" % SLUG,
                 json={"student": AMY, "results": ALL_RIGHT}).status_code == 404)
page = teacher.get("/teacher/" + SLUG).get_data(as_text=True)
check("the results page has Check all, and each student's tests",
      "tests-check-all" in page and "Tests 14 / 14" in page and "✗ h1 color is red" in page)
check("  and says how many tests the notes have", "13 tests" in page and "14 points" in page)
mine = amy.get("/my").get_data(as_text=True)
check("My work shows the grade with the tests in it",
      "Score: <strong>14 / 14</strong>" in mine and "14 from the questions and tests" in mine)
cls = amy.get("/class/%d" % CLASS).get_data(as_text=True)
check("so does the class page", '<span class="badge badge-grade">14 / 14</span>' in cls)
time.sleep(1.1)
turn_in(amy, dict(RIGHT, **{"about.html": "<h2>About me!</h2>"}))
page = teacher.get("/teacher/" + SLUG).get_data(as_text=True)
check("work turned in again after the check is marked stale", "is-stale" in page and "⟳" in page)
teacher.post("/api/assignment/%s/xp-bonus" % SLUG, json={"xp": 25})
db = P.SessionLocal()
paid = {a.user_id for a in db.query(accounts.XpAward).filter(accounts.XpAward.source.like("bonus:%"))}
db.close()
check("full marks from the tests completes the quest", AMY in paid and BEN not in paid, paid)
helppage = client().get("/help/questions").get_data(as_text=True)
example = _html.unescape(re.search(r'id="tests-example">(.*?)</pre>', helppage, re.S).group(1))
bare = "\n".join(re.split(r"\s{3,}", ln)[0] for ln in example.split("\n"))
got, bad = autograde.parse(bare)
check("the help page's example is all tests", len(got) == 12 and not bad, (len(got), bad))
authoring = teacher.get("/teacher/%s/edit" % SLUG).get_data(as_text=True)
check("the teacher's edit page links to how to write tests",
      'href="/help/questions#tests"' in authoring)
editor = amy.get("/p/" + DRAFTS[AMY]).get_data(as_text=True)
check("the editor has Check my work and loads autograde.js",
      'id="check"' in editor and "autograde.js" in editor)

# Ben fixes his work: the next check pays the tests that now pass, only.
before = test_xp(BEN)
teacher.post("/api/assignment/%s/tests/verify" % SLUG, json={"student": BEN, "results": ALL_RIGHT})
check("fixed work is paid for the tests that now pass, and only those",
      0 < before < 14 * xp.XP_PER_POINT and test_xp(BEN) == 14 * xp.XP_PER_POINT,
      (before, test_xp(BEN)))

print()
failed = results.count(False)
print("%d checks, %s" % (len(results), "all ok" if not failed else "%d FAILED" % failed))
sys.exit(1 if failed else 0)
