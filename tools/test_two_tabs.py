#!/usr/bin/env python3
"""Two tabs on one draft: the forgotten one must not save over the other.

    python3 tools/test_two_tabs.py

THE BUG

A student has the assignment open twice — the live lesson in one tab, the
Classroom link (which opens the editor) in another. Both autosave to the same
draft. They type in the lesson for twenty minutes, then press one key in the
forgotten tab, and its copy from twenty minutes ago is saved over everything.
Nothing errors; the work is simply gone, and Turn in from that tab hands in
the old copy too.

THE GUARD

Every write says which version of the draft its tab last saw, and which tab
it is. The server refuses a write when the draft has moved on since AND the
move was made by another tab. A tab's own overlapping saves — an autosave in
flight when Turn in is pressed — never refuse each other. A page loaded before
the guard existed sends neither, and is let through as before.

WebIDE keeps a project entirely in `files`, with index.html as the page, so
that is what is saved and compared here. The server half is checked through
Flask. The editor's half is account.js
itself, loaded into node with a stubbed browser and driven, because what
matters is that a refused tab actually STOPS saving — and that is behaviour,
not a string to grep for. (live.js does the same, in the same words; its
server half is checked here through /keep and /api/submit.)
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
WEBIDE = os.path.dirname(HERE)

DB = os.path.join(tempfile.mkdtemp(), "tabs.db")
os.environ["DATABASE_URL"] = "sqlite:///" + DB
os.environ["TEACHER_EMAILS"] = "teacher@example.org"
os.environ["SECRET_KEY"] = "k" * 32
os.environ.pop("ALLOWED_EMAIL_DOMAINS", None)

sys.path.insert(0, WEBIDE)
import app as P                                              # noqa: E402
import accounts                                              # noqa: E402

results = []


def check(label, condition, detail=""):
    results.append(bool(condition))
    print("  %-4s %-58s %s" % ("ok" if condition else "FAIL", label, detail))


def add_user(sub, email, name):
    db = P.SessionLocal()
    try:
        user = accounts.User(google_sub=sub, email=email, name=name)
        db.add(user)
        db.commit()
        return user.id
    finally:
        db.close()


def client(uid=None):
    c = P.app.test_client()
    if uid is not None:
        with c.session_transaction() as s:
            s["uid"] = uid
    return c


TEACHER = add_user("t1", "teacher@example.org", "Mr Franz")
STUDENT = add_user("s1", "kid@example.org", "A Student")
teacher = client(TEACHER)
student = client(STUDENT)

hw = teacher.post("/api/assignment", json={
    "files": {"index.html": "<h1>starter</h1>"}, "title": "Loops"}).get_json()["slug"]
student.get("/a/%s" % hw)


def draft():
    db = P.SessionLocal()
    try:
        return db.query(accounts.Draft).filter_by(owner_id=STUDENT).first()
    finally:
        db.close()


SLUG = draft().slug
SAVE = "/api/draft/%s" % SLUG


def page_of(d):
    """WebIDE keeps a project entirely in files; index.html is the page."""
    return d.file_map().get("index.html")


def save(code, base=None, tab=None):
    body = {"files": {"index.html": code}}
    if base is not None:
        body["base"] = base
    if tab is not None:
        body["tab"] = tab
    return student.post(SAVE, json=body)


# ------------------------------------------------------------------ server
print("\nThe server")

page = student.get("/p/%s" % SLUG).get_data(as_text=True)
check("the editor page tells the tab where it starts",
      "draftVersion: 0," in page, page[page.find("draftVersion"):][:30])

r = save("lesson v1", base=0, tab="LESSON")
check("the lesson tab saves", r.status_code == 200
      and r.get_json().get("version") == 1, r.get_data(as_text=True)[:80])
r = save("lesson v2", base=0, tab="LESSON")
check("  and its own overlapping save is not refused",
      r.status_code == 200 and page_of(draft()) == "lesson v2", r.status_code)

r = save("the old copy", base=0, tab="CLASSROOM")
check("the forgotten tab, behind, is refused",
      r.status_code == 409 and r.get_json().get("stale") is True, r.status_code)
check("  and the lesson's work is untouched", page_of(draft()) == "lesson v2")
check("  and it is told why, in words",
      "another tab" in (r.get_json() or {}).get("error", ""))

r = save("classroom, reloaded", base=draft().version, tab="CLASSROOM")
check("reloaded, the same tab may save again",
      r.status_code == 200 and page_of(draft()) == "classroom, reloaded")
r = save("lesson, now behind", base=2, tab="LESSON")
check("  and now it is the lesson tab that is behind",
      r.status_code == 409 and page_of(draft()) == "classroom, reloaded")

before = draft()
r = student.post("/api/submit", json={"draft": SLUG,
                                      "files": {"index.html": "stale hand-in"},
                                      "base": 2, "tab": "LESSON"})
db = P.SessionLocal()
handed = db.query(accounts.Submission).filter_by(student_id=STUDENT).first()
db.close()
check("Turn in from a tab that is behind is refused", r.status_code == 409)
check("  hands nothing in", handed is None)
check("  and leaves the draft alone",
      page_of(draft()) == page_of(before) and draft().version == before.version)
r = student.post("/api/submit", json={"draft": SLUG,
                                      "files": {"index.html": "good hand-in"},
                                      "base": draft().version, "tab": "CLASSROOM"})
check("Turn in from the tab that is up to date goes through",
      r.status_code == 200 and page_of(draft()) == "good hand-in")
check("  and says the new version, so the tab keeps up",
      r.get_json().get("version") == draft().version)

code = teacher.post("/api/live/start", json={"body": "x", "assignment": hw}).get_json()["code"]
page = student.get("/live/%s" % code).get_data(as_text=True)
check("the live page tells its tab where it starts",
      "draftVersion: %d," % draft().version in page,
      page[page.find("draftVersion"):][:30])
KEEP = "/api/live/%s/keep" % code
r = student.post(KEEP, json={"code": "lesson keep",
                             "files": {"index.html": "lesson keep"},
                             "base": 1, "tab": "LESSON"})
check("a live save from a tab that is behind is refused",
      r.status_code == 409 and page_of(draft()) == "good hand-in", r.status_code)
r = student.post(KEEP, json={"code": "lesson keep",
                             "files": {"index.html": "lesson keep"},
                             "base": draft().version, "tab": "LESSON2"})
check("  and one that is up to date goes through, with its version",
      r.status_code == 200 and page_of(draft()) == "lesson keep"
      and r.get_json().get("version") == draft().version)

r = save("from a tab opened before the update")
check("a page from before the guard (no version) still saves",
      r.status_code == 200 and page_of(draft()) == "from a tab opened before the update")
r = save("behind that one", base=draft().version - 1, tab="LESSON2")
check("  and counts as another tab for whoever is behind it",
      r.status_code == 409)


# ------------------------------------------------- an earlier database
print("\nA database from before the guard")

import sqlalchemy                                            # noqa: E402
old = sqlalchemy.create_engine("sqlite:///" + os.path.join(tempfile.mkdtemp(), "old.db"))
with old.begin() as c:
    c.execute(sqlalchemy.text(
        "CREATE TABLE drafts (id INTEGER PRIMARY KEY, slug VARCHAR(16) NOT NULL, "
        "owner_id INTEGER NOT NULL, assignment_id INTEGER, app VARCHAR(16) NOT NULL, "
        "title VARCHAR(200) NOT NULL, code TEXT NOT NULL, files TEXT NOT NULL, "
        "created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL)"))
    c.execute(sqlalchemy.text(
        "INSERT INTO drafts VALUES (1, 'd', 1, NULL, 'webide', 'T', '', '{}', "
        "'2026-09-01', '2026-09-01')"))
accounts.create_all(old)
with old.begin() as c:
    row = c.execute(sqlalchemy.text("SELECT version, writer FROM drafts")).fetchone()
check("an old drafts table gets the columns, and old rows read as unclaimed",
      tuple(row) == (0, ""), tuple(row))


# --------------------------------------------------- the editor, in node
print("\nThe editor's own code (account.js, run in node)")

if not shutil.which("node"):
    sys.exit("node is needed to run account.js; brew install node")

HARNESS = r"""
const fs = require("fs"), vm = require("vm");
const [file] = process.argv.slice(2);
const els = {};
function el(id) {
  return els[id] || (els[id] = { id, textContent: "", className: "", disabled: false,
    handlers: {}, addEventListener(t, f) { this.handlers[t] = f; } });
}
const sent = [], alerts = [], said = [];
let replies = [];
const window = {
  WEBIDE: { draftSlug: "abc", draftVersion: 3 },
  addEventListener() {},
  alert(m) { alerts.push(m); },
};
const ctx = {
  window, console,
  document: { getElementById: (id) => (id === "save-state" || id === "turn-in") ? el(id) : null,
              addEventListener() {} },
  setTimeout: (f) => 0, clearTimeout() {},
  fetch: (url, opts) => {
    sent.push({ url, body: JSON.parse(opts.body) });
    const [status, data] = replies.shift() || [200, {}];
    return Promise.resolve({ ok: status === 200, status, json: () => Promise.resolve(data) });
  },
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(file, "utf8"), ctx);
const tick = () => new Promise((r) => setImmediate(r));
(async () => {
  let n = 0;
  const acct = window.WebIDEAccount.attach({
    read: () => ({ files: { "index.html": "<p>" + (n++) + "</p>" } }),
    say: (t) => said.push(t),
  });
  const out = {};
  replies = [[200, { saved_at: "1:00", version: 4 }]];
  acct.saveNow(); await tick(); await tick();
  out.first = sent[0] && sent[0].body;
  replies = [[200, { saved_at: "1:01", version: 5 }]];
  acct.saveNow(); await tick(); await tick();
  out.second = sent[1] && sent[1].body;
  replies = [[409, { stale: true, error: "Changed in another tab." }]];
  acct.saveNow(); await tick(); await tick();
  out.state = els["save-state"].textContent;
  out.alerts = alerts.length;
  out.said = said.join(" ");
  const before = sent.length;
  acct.saveNow(); await tick(); await tick();
  out.savedAfter = sent.length - before;
  els["turn-in"].handlers.click && els["turn-in"].handlers.click();
  await tick(); await tick();
  out.turnInAfter = sent.length - before;
  out.alertsAfter = alerts.length;
  console.log(JSON.stringify(out));
})();
"""
harness = os.path.join(tempfile.mkdtemp(), "tabs.js")
open(harness, "w").write(HARNESS)
proc = subprocess.run(["node", harness, os.path.join(WEBIDE, "static", "account.js")],
                      capture_output=True, text=True)
try:
    out = json.loads(proc.stdout.strip().splitlines()[-1])
except Exception:
    out = {}
    print(proc.stdout, proc.stderr)

first, second = out.get("first") or {}, out.get("second") or {}
check("a save says the version the page started at, and the tab",
      first.get("base") == 3 and len(first.get("tab", "")) >= 8, first)
check("  the next one says the version the server answered with",
      second.get("base") == 4 and second.get("tab") == first.get("tab"), second)
check("refused, the tab says so where the student is looking",
      "another tab" in out.get("state", ""), out.get("state"))
check("  and in the output, with a word about copying their text",
      "copy it" in out.get("said", ""))
check("  and in an alert, once", out.get("alerts") == 1, out.get("alerts"))
check("  and then STOPS saving", out.get("savedAfter") == 0, out.get("savedAfter"))
check("  and will not turn in either",
      out.get("turnInAfter") == 0 and out.get("alertsAfter") == 2, out)

bad = results.count(False)
print("\n%s (%d checks, %d failed)"
      % ("SOME FAILED" if bad else "ALL PASSED", len(results), bad))
sys.exit(1 if bad else 0)
