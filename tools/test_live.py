"""WebIDE, teaching live: the mirror, and what could quietly ruin a lesson.

    python3 tools/test_live.py

A live lesson is thirty people watching one row in a table. Almost everything
that can go wrong with it goes wrong SILENTLY — the page still renders, the
button still says Live, and the only symptom is a class looking at a line
their teacher fixed two minutes ago. So each of those is a check here.

WHAT IS ACTUALLY BEING GUARDED

  A student's own work is never touched.
      The page has two editors. If anything arriving from the network could
      reach the lower one, a class would lose a paragraph of their own typing
      the moment the teacher pressed a key, and nobody would use this twice.
      Checked by reading live.js: the mirror is the only editor given a value.

  A push that arrives late cannot win.
      The teacher's browser sends every 400ms. On school wifi two of those
      can overtake each other, and without a guard the OLDER text lands with
      the NEWER version number — after which nothing corrects it until the
      next keystroke. The write is conditional on a stamp that only goes up.

  A student who joins late is not left behind.
      No catch-up path, no replay: the first poll carries the whole file.

  Nothing lives in memory.
      Every one of these apps runs `gunicorn --workers 2`. A dict in a module
      is visible to one worker and invisible to the other, and which one a
      student reaches changes from poll to poll. It would pass every test on
      a laptop running a single worker and fail in front of a class.

  Only the host can type into the lesson.
      Checked against the row, not against the teacher list — a second
      teacher must not be able to write into somebody else's lesson.
"""
import json
import os
import re
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
WEBIDE = os.path.dirname(HERE)

DB = os.path.join(tempfile.mkdtemp(), "live.db")
os.environ["DATABASE_URL"] = "sqlite:///" + DB
os.environ["TEACHER_EMAILS"] = "teacher@example.org, other@example.org"
os.environ["SECRET_KEY"] = "k" * 32
os.environ.pop("ALLOWED_EMAIL_DOMAINS", None)

sys.path.insert(0, WEBIDE)
import app as W                                              # noqa: E402
import accounts                                              # noqa: E402

results = []


def check(label, condition, detail=""):
    results.append(bool(condition))
    print("  %-4s %-58s %s" % ("ok" if condition else "FAIL", label, detail))


def add_user(sub, email, name):
    db = W.SessionLocal()
    try:
        user = accounts.User(google_sub=sub, email=email, name=name)
        db.add(user)
        db.commit()
        return user.id
    finally:
        db.close()


def client(uid=None):
    c = W.app.test_client()
    if uid is not None:
        with c.session_transaction() as s:
            s["uid"] = uid
    return c


def row(code):
    db = W.SessionLocal()
    try:
        return db.query(accounts.LiveSession).filter_by(code=code).first()
    finally:
        db.close()


TEACHER = add_user("t1", "teacher@example.org", "Mr Franz")
OTHER = add_user("t2", "other@example.org", "Another Teacher")
STUDENT = add_user("s1", "kid@example.org", "A Student")
STUDENT2 = add_user("s2", "kid2@example.org", "Another Student")

teacher = client(TEACHER)
other = client(OTHER)
student = client(STUDENT)
stranger = client()                      # signed out, like most of a class


# ---------------------------------------------------------------- starting
print("\nStarting a lesson")

r = student.post("/api/live/start", json={"body": "print(1)"})
check("a student cannot start one", r.status_code == 403, r.status_code)

r = stranger.post("/api/live/start", json={"body": "print(1)"})
check("nor can somebody signed out", r.status_code == 403, r.status_code)

r = teacher.post("/api/live/start",
                 json={"body": "<h1>hello</h1>", "filename": "index.html",
                       "title": "Loops"})
check("a teacher can", r.status_code == 200, r.status_code)
CODE = r.get_json()["code"]
check("  and gets a code to read out", bool(CODE), CODE)
check("  with no look-alike characters in it",
      not set(CODE) & set("01lioIO"), CODE)

again = teacher.post("/api/live/start", json={"body": "print(2)"}).get_json()
check("pressing Go live again reuses the same lesson",
      again["code"] == CODE,
      "a second code would leave half the class on the wrong one")


# ------------------------------------------------------------------ pushing
print("\nPushing what the teacher types")

r = teacher.post("/api/live/%s/push" % CODE,
                 json={"body": "line one", "seq": 1000, "filename": "index.html"})
check("the host can push", r.status_code == 200 and not r.get_json().get("stale"),
      r.status_code)
check("  and the row holds it", row(CODE).body == "line one")
check("  at the version they sent", row(CODE).version == 1000)

r = teacher.post("/api/live/%s/push" % CODE,
                 json={"body": "line one, fixed", "seq": 1001})
check("a newer push replaces it", row(CODE).body == "line one, fixed")

# THE ONE THAT MATTERS. A push that was sent earlier but arrived later.
r = teacher.post("/api/live/%s/push" % CODE,
                 json={"body": "line one", "seq": 1000})
check("a push that arrives late is refused",
      r.get_json().get("stale") is True, r.get_json())
check("  and the newer text is still what the class sees",
      row(CODE).body == "line one, fixed",
      "stale text on the board is invisible to the teacher")
check("  and the version did not go backwards", row(CODE).version == 1001)

r = other.post("/api/live/%s/push" % CODE, json={"body": "hijacked", "seq": 9999})
check("another teacher cannot push into this lesson", r.status_code == 403,
      r.status_code)
check("  and did not change it", row(CODE).body == "line one, fixed")

r = student.post("/api/live/%s/push" % CODE, json={"body": "hijacked", "seq": 9999})
check("nor can a student", r.status_code == 403, r.status_code)

big = "x" * (W.MAX_FILE_BYTES + 1)
r = teacher.post("/api/live/%s/push" % CODE, json={"body": big, "seq": 2000})
check("an oversized file is refused", r.status_code == 413, r.status_code)
check("  and did not land", row(CODE).body == "line one, fixed")


# ------------------------------------------------------------------ polling
print("\nWhat the class sees")

r = stranger.get("/api/live/%s" % CODE)
check("a student who is not signed in can watch", r.status_code == 200,
      r.status_code)
body = r.get_json()
check("  and gets the whole file, not a diff", body["body"] == "line one, fixed")
check("  with the version to poll against", body["version"] == 1001)
check("  and who is teaching, by last name only", body["host"] == "Franz",
      body.get("host"))
check("  a one-word name as it is, and no name the email's first half",
      W._live_host_name(accounts.User(name="Franz", email="a@b.org")) == "Franz"
      and W._live_host_name(accounts.User(name="", email="sfranz@b.org"))
      == "sfranz")

r = stranger.get("/api/live/%s?v=%d" % (CODE, body["version"]))
check("polling with the version they have gets 304, not the file again",
      r.status_code == 304,
      "thirty students pulling the file every second is the whole cost")

teacher.post("/api/live/%s/push" % CODE, json={"body": "line two", "seq": 3000})
r = stranger.get("/api/live/%s?v=%d" % (CODE, body["version"]))
check("  and the next change comes straight through",
      r.status_code == 200 and r.get_json()["body"] == "line two",
      r.status_code)

# A student opening the page halfway through the lesson.
late = client()
r = late.get("/api/live/%s?v=-1" % CODE)
check("someone joining late gets the current file at once",
      r.status_code == 200 and r.get_json()["body"] == "line two",
      "no catch-up path, because the first poll IS the catch-up")

r = stranger.get("/api/live/nosuchcode")
check("an unknown code is a clean 404", r.status_code == 404, r.status_code)


# ------------------------------------------------------ the notes pane
print("\nThe project's notes")

def poll_json():
    return stranger.get("/api/live/%s?v=-1" % CODE).get_json()

base = poll_json()
r = teacher.post("/api/live/%s/push" % CODE,
                 json={"body": base.get("body"), "filename": base.get("filename"),
                       "notes": "# Today\nRoutes, [docs](https://example.org)",
                       "seq": 4200})
got = poll_json()
check("notes pushed with the open file reach the class",
      r.status_code == 200 and got.get("notes", "").startswith("# Today"),
      repr(got.get("notes")))
check("  while the open file is still what the mirror shows",
      got.get("body") == base.get("body"))

# An editor still running the old code sends no notes, and must not wipe
# the ones already there.
teacher.post("/api/live/%s/push" % CODE,
             json={"body": "typing on", "seq": 4201})
check("a push without notes leaves them in place",
      poll_json().get("notes", "").startswith("# Today"),
      repr(poll_json().get("notes")))

page = stranger.get("/live/%s" % CODE).get_data(as_text=True)
# The editor's light/dark button, on the student's page too: a room
# projecting in light had no way to put a laptop in it.
check("a student's lesson page has the light/dark button",
      'id="theme"' in page
      and re.search(r"^\s*themeSwitch\(\);", open(os.path.join(WEBIDE, "static", "live.js")).read(), re.M))
_live_js = open(os.path.join(WEBIDE, "static", "live.js")).read()
_demo_js = open(os.path.join(WEBIDE, "static", "demo.js")).read()
check("  and the New tab button",
      'id="run-tab" class="btn" type="button"' in page
      and re.search(r'^\s*if \(\$\("run-tab"\)\) \$\("run-tab"\)\.addEventListener\("click", runInNewTab\);',
                    _live_js, re.M))
check("  which hands all their own files to /play under the key /play reads",
      re.search(r'localStorage\.setItem\("webide-play", JSON\.stringify\(\{\s*files: allFiles\(\),',
                _live_js)
      and 'localStorage.getItem("webide-play")' in _demo_js
      and re.search(r'^\s*window\.open\("/play", "webide-play"\);', _live_js, re.M))
check("a student who joins now gets them in the page",
      re.search(r'^\s*notes: "# Today', page, re.M) is not None)
check("  with a pane to show them in",
      'id="live-notes-view"' in page and 'id="live-notes"' in page)

r = teacher.post("/api/live/%s/push" % CODE,
                 json={"body": "x", "notes": "#" * (W.MAX_FILE_BYTES + 1),
                       "seq": 4202})
check("oversized notes are refused", r.status_code == 413, r.status_code)

teacher.post("/api/live/%s/push" % CODE,
             json={"body": base.get("body"), "filename": base.get("filename"),
                   "notes": "", "seq": 4300})
check("a project with no notes clears them",
      poll_json().get("notes") == "", repr(poll_json().get("notes")))


# ---------------------------------------- slides, console and page
print("\nSlides, and what the teacher's Run made")

base = poll_json()
r = teacher.post("/api/live/%s/push" % CODE,
                 json={"body": base.get("body"), "filename": base.get("filename"),
                       "notes": "## Two", "slide": "2/4",
                       "output": "clicked\n", "page": "<h1>Teacher</h1>",
                       "seq": 4400})
got = poll_json()
check("the slide a push names reaches the class",
      r.status_code == 200 and got.get("slide") == "2/4", repr(got.get("slide")))
check("  and so does the teacher's console",
      got.get("output") == "clicked\n", repr(got.get("output")))
check("  and the page their Run built",
      got.get("page") == "<h1>Teacher</h1>" and got.get("page_id"),
      repr(got.get("page")))

# THE POLL LEAVES THE PAGE OUT for a student who has it: every keystroke
# moves the version, and a whole page on every one would be thirty students
# pulling it again and again for nothing.
pid = got.get("page_id")
same = stranger.get("/api/live/%s?v=-1&pg=%s" % (CODE, pid)).get_json()
check("a student who already has the page is not sent it again",
      "page" not in same and same.get("page_id") == pid, sorted(same))

teacher.post("/api/live/%s/push" % CODE,
             json={"body": "typing on", "seq": 4401})
got = poll_json()
check("a push from an older editor leaves all three alone",
      got.get("slide") == "2/4" and got.get("output") == "clicked\n"
      and got.get("page") == "<h1>Teacher</h1>",
      "an old tab would wipe them every 400ms")

teacher.post("/api/live/%s/push" % CODE,
             json={"body": "x", "slide": "<b>9</b>", "seq": 4402})
check("a slide that is not N/M is stored as none",
      poll_json().get("slide") == "", repr(poll_json().get("slide")))

# A console.log in a loop. Refusing it would take the code down with it,
# and the mirror would freeze for as long as the loop ran.
flood = "".join("line %d\n" % i for i in range(20000))
r = teacher.post("/api/live/%s/push" % CODE,
                 json={"body": "while (true) console.log(1)", "output": flood,
                       "seq": 4403})
got = poll_json()
check("a huge console is trimmed, not refused",
      r.status_code == 200 and got.get("body") == "while (true) console.log(1)",
      r.status_code)
check("  keeping the end of it, which is the part anyone reads",
      got.get("output", "").endswith("line 19999\n")
      and len(got["output"].encode()) <= W.LIVE_OUTPUT_BYTES,
      len(got.get("output", "")))

r = teacher.post("/api/live/%s/push" % CODE,
                 json={"body": "big page", "page": "x" * (W.LIVE_PAGE_BYTES + 1),
                       "seq": 4404})
# asked as a student still showing the earlier page, who must be told
got = stranger.get("/api/live/%s?v=-1&pg=%s" % (CODE, pid)).get_json()
check("an oversized page is dropped, and the code still lands",
      r.status_code == 200 and got.get("body") == "big page"
      and got.get("page") == "" and got.get("page_id") == "",
      (r.status_code, got.get("body"), len(got.get("page") or ""),
       got.get("page_id")))

teacher.post("/api/live/%s/push" % CODE,
             json={"body": "x", "slide": "3/5", "output": "hi\n",
                   "page": "<p>hi</p>", "seq": 4405})
again = teacher.post("/api/live/start", json={"body": "x"}).get_json()
check("a reload is told which slide the class is on",
      again.get("slide") == "3/5", repr(again.get("slide")))
page = stranger.get("/live/%s" % CODE).get_data(as_text=True)
check("a late joiner gets all three in the page",
      re.search(r'^\s*slide: "3/5"', page, re.M) is not None
      and re.search(r'^\s*output: "hi\\n"', page, re.M) is not None
      and re.search(r'^\s*page: "\\u003cp\\u003ehi', page, re.M) is not None
      and re.search(r'^\s*pageId: "%s"' % W._page_id("<p>hi</p>"), page, re.M)
      is not None)
check("  with a slide marker and a place for the teacher's page and console",
      'id="live-slide"' in page and 'id="teacher-preview"' in page
      and 'id="teacher-output"' in page)
_mirror_html = page[page.index('class="live-pane live-mirror"'):
                    page.index('class="live-pane live-mine"')]
_theirs_html = page[page.index('id="preview-view"'):page.index('id="live-notes-view"')]
check("  beside the teacher's code, not in the student's own panes",
      'id="teacher-preview"' in _mirror_html and 'id="teacher-output"' in _mirror_html
      and "teacher-" not in _theirs_html
      and not re.search(r'class="out-tab[" ]', _theirs_html),
      "the class had to flick between two tabs to compare the pages")
_tf = re.search(r'<iframe id="teacher-preview"[^>]*>', page)
check("  the teacher's page in a frame sandboxed like theirs",
      _tf is not None and 'sandbox="allow-scripts allow-forms"' in _tf.group(0)
      and "same-origin" not in _tf.group(0),
      _tf.group(0) if _tf else "no frame")
teacher.post("/api/live/%s/push" % CODE,
             json={"body": base.get("body"), "filename": base.get("filename"),
                   "notes": "", "slide": "", "output": "", "page": "",
                   "seq": 4500})


# ------------------------------------------------ the teacher's caret
print("\nThe teacher's caret")

teacher.post("/api/live/%s/push" % CODE,
             json={"body": "a = 1\nb = 2", "cursor": "1:3", "seq": 4600})
check("the caret a push names reaches the class",
      poll_json().get("cursor") == "1:3", repr(poll_json().get("cursor")))
teacher.post("/api/live/%s/push" % CODE,
             json={"body": "a = 1\nb = 22", "seq": 4601})
check("  a push from an older editor leaves it alone",
      poll_json().get("cursor") == "1:3", repr(poll_json().get("cursor")))
r = teacher.post("/api/live/%s/push" % CODE,
                 json={"body": "a = 1", "cursor": "<b>", "seq": 4602})
check("  one that is not line:ch is stored as none, not refused",
      r.status_code == 200 and poll_json().get("cursor") == ""
      and poll_json().get("body") == "a = 1", repr(poll_json().get("cursor")))
teacher.post("/api/live/%s/push" % CODE,
             json={"body": "a = 1\nb = 2", "cursor": "0:1-1:3", "seq": 4604})
check("a highlighted block reaches the class as anchor-head",
      poll_json().get("cursor") == "0:1-1:3", repr(poll_json().get("cursor")))
r = teacher.post("/api/live/%s/push" % CODE,
                 json={"body": "a = 1", "cursor": "123456:1-1:1", "seq": 4605})
check("  one too long for the column is stored as none, not refused",
      r.status_code == 200 and poll_json().get("cursor") == ""
      and poll_json().get("body") == "a = 1",
      "Postgres would refuse 25 characters and the push would be lost")
check("  and the longest one allowed fits the column",
      len("99999:99999-99999:99999")
      <= accounts.LiveSession.__table__.c.cursor.type.length)
teacher.post("/api/live/%s/push" % CODE,
             json={"body": "a = 1", "cursor": "0:2", "seq": 4606})
page = stranger.get("/live/%s" % CODE).get_data(as_text=True)
check("  and a late joiner gets it in the page",
      re.search(r'^\s*cursor: "0:2"', page, re.M) is not None)
teacher.post("/api/live/%s/push" % CODE,
             json={"body": base.get("body"), "filename": base.get("filename"),
                   "cursor": "", "seq": 4700})


# -------------------------------------------------------------- the pages
print("\nThe pages")

r = stranger.get("/live/%s" % CODE)
check("the live page opens for anyone with the code", r.status_code == 200,
      r.status_code)
page = r.get_data(as_text=True)
check("  and carries two editors, mirror and their own",
      'id="mirror"' in page and 'id="mine"' in page)

# LAYOUT, because the first version got this wrong in a way only a kaypy
# lesson showed: three panes stacked down the page put an 800x600 canvas in
# the middle, squeezed the student's own editor to a few lines at the
# bottom, and left Run in the header far from the code it runs.
#
# Checked as structure rather than by eye: the two editors are inside one
# left-hand column, and the output and the canvas are a sibling of that
# column, not a third row under it.
# NESTING, not order. The first version of this sliced from the left
# column's class to the string "live-right" — which is the same slice
# whether the student's editor is inside that column or has been moved out
# of it into a sibling, because both sit between those two points in the
# text. It passed a deliberately broken page.
start = page.index('class="pane live-left"')
end = page.index("</section>", start)
left = page[start:end]
check("  with both editors stacked inside the left column",
      'id="mirror"' in left and 'id="mine"' in left,
      "mirror: %s, mine: %s" % ('id="mirror"' in left, 'id="mine"' in left))
check("  and the output beside them, not under them",
      'id="output"' not in left and 'id="canvas"' not in left,
      "a game in the middle row is what squeezed the editor last time")
check("  in the same right-hand pane class the editor uses",
      'class="pane pane-right live-right"' in page,
      "so the two pages do not disagree about where output lives")
check("  with the lesson already in it, so it is not blank while it polls",
      "line two" in page)
check("  and no button that copies the teacher's code down",
      not re.search(r"copy[^<]{0,20}(mine|into|down)", page, re.I),
      "typing it is the exercise")

r = stranger.get("/live/nosuchcode")
check("a bad code goes back to the join page", r.status_code == 302
      and "/live" in r.headers.get("Location", ""),
      r.headers.get("Location", r.status_code))

check("the join page opens", stranger.get("/live").status_code == 200)

r = teacher.get("/live/%s" % CODE)
host_page = r.get_data(as_text=True)
check("the host gets their own view, not a mirror of themselves",
      'id="mirror"' not in host_page)
# A projector showing two paragraphs and a code does not need several
# megabytes of WebAssembly to do it.
check("  and is not made to load an editor to show a code",
      "runner.js" not in host_page and "codemirror.min.js" not in host_page)
check("  while a student following along does get both",
      "runner.js" in page and "codemirror.min.js" in page)

r = teacher.get("/new")
check("the editor offers Go live to a teacher", 'id="go-live"' in
      r.get_data(as_text=True))
r = student.get("/new")
check("  and does not offer it to a student", 'id="go-live"' not in
      r.get_data(as_text=True))
check("  nor a copy of what the class's notes pane shows",
      'id="class-view"' not in r.get_data(as_text=True))
r = teacher.get("/new")
check("the teacher's editor has a pane showing the slide the class is on",
      'id="class-view"' in r.get_data(as_text=True)
      and 'id="class-notes"' in r.get_data(as_text=True))

# Hide code moved off the toolbar into the dialog a teacher's Share opens.
# On the toolbar, a tick left on from an earlier demo was invisible until a
# student opened the link and found no source.
_tp = r.get_data(as_text=True)
_ask = _tp.find('id="share-ask"')
check("a teacher's Share asks first, with Hide code inside that dialog",
      _ask != -1 and _tp.find('id="hide-code"') > _ask,
      "share-ask at %d, hide-code at %d" % (_ask, _tp.find('id="hide-code"')))
_sp = student.get("/new").get_data(as_text=True)
check("  and a student gets neither", 'id="share-ask"' not in _sp
      and 'id="hide-code"' not in _sp)

# The join code on the teacher's bar is a button that copies /live/<code>.
_chip = re.search(r'<(\w+) id="live-code"', _tp)
check("the live code chip is a button", _chip and _chip.group(1) == "button",
      _chip.group(1) if _chip else "missing")
_app = open(os.path.join(HERE, "..", "static", "app.js")).read()
check("  that copies the class's whole link",
      re.search(r'liveChip\.addEventListener\("click"', _app)
      and 'location.origin + "/live/"' in _app)

# The notes panes neither grow nor shrink, so a console printing above them
# cannot take their height. The preview took it from the teacher's copy
# because its basis was `auto`, its own content.
_css = open(os.path.join(HERE, "..", "static", "style.css")).read()
for _sel in (".live-right .live-notes", ".pane-right .class-view"):
    _rule = re.search(re.escape(_sel) + r"\s*\{([^}]*)\}", _css)
    check("%s is a fixed size" % _sel,
          _rule and re.search(r"flex:\s*0 0 \d+%", _rule.group(1)),
          _rule.group(1).strip() if _rule else "no rule")
check("  and the preview beside them takes only what is left",
      re.search(r"\.pane-right #preview-view\s*\{\s*flex:\s*1 1 0;", _css))


# ------------------------------------------------ keeping their own copy
print("\nSaving their own work")

r = student.get("/live/%s" % CODE)
student_page = r.get_data(as_text=True)
check("a signed-in student is offered Save", 'id="live-save"' in student_page)
check("  and is not told their work is browser-only",
      "sign in to save it properly" not in student_page)

r = stranger.get("/live/%s" % CODE)
out_page = r.get_data(as_text=True)
check("a signed-out student is not offered Save",
      'id="live-save"' not in out_page,
      "there is nowhere for it to go, so the button would be a lie")
check("  and is told where their work is kept instead",
      "sign in to save it properly" in out_page)

# Sign in, on the lesson page itself. Save and Turn in only exist once signed
# in, so without this a student had no way to get them short of leaving the
# lesson — and nothing on the page said so. Login is off in this suite (no
# Google keys), so it is switched on just for these two requests.
_login = accounts.login_configured
accounts.login_configured = lambda: True
try:
    signin_out = stranger.get("/live/%s" % CODE).get_data(as_text=True)
    signin_in = student.get("/live/%s" % CODE).get_data(as_text=True)
finally:
    accounts.login_configured = _login
check("a signed-out student is offered Sign in on the lesson",
      "/login?next=/live/%s" % CODE in signin_out
      or "/login?next=%%2Flive%%2F%s" % CODE in signin_out)
check("  and a signed-in one is not",
      ">Sign in</a>" not in signin_in)

# Their own editor behaves like the main one. It was missing all of this
# because this page was built separately.
check("the live page loads completion and its popup",
      "complete.js" in out_page and "show-hint.min.js" in out_page
      and "show-hint.min.css" in out_page)
check("  and tab stops, and tag closing",
      "tabstops.js" in out_page and "closetag.min.js" in out_page
      and "xml-fold.min.js" in out_page)
_lj = open(os.path.join(HERE, "..", "static", "live.js")).read()
# Completed as the file being typed in, from every tab — so a class used in
# their index.html is offered in their style.css, as in the editor.
check("  and live.js offers completion on the student's own editor",
      "WebIDEComplete.show(cm, active, allFiles())" in _lj
      and re.search(r"docs\[ENTRY\] *= *mine\.getDoc\(\);", _lj) is not None)
check("  and closes tags the way the editor does",
      "autoCloseTags: { indentTags: [] }" in _lj)

# The live page saves through the editor's own endpoints, so a project made
# here is an ordinary project: it opens at /p/<slug>, lists in My projects,
# and can be turned in. Nothing about it is special-cased.
r = student.post("/api/draft", json={"files": {"index.html": "<h1>mine</h1>"}, "title": "Loops"})
check("their copy saves through the ordinary draft endpoint",
      r.status_code == 200, r.status_code)
SLUG = r.get_json()["slug"]

r = student.post("/api/draft/" + SLUG,
                 json={"files": {"index.html": "<h1>mine 2</h1>"}, "title": "Loops"})
check("  and autosaves from then on", r.status_code == 200, r.status_code)

listed = student.get("/api/my/projects").get_json()
titles = [row["title"] for row in listed.get("projects", listed if
          isinstance(listed, list) else [])]
check("  and turns up in My projects", "Loops" in titles, titles)

r = student.get("/p/" + SLUG)
check("  and opens in the full editor",
      r.status_code == 200 and "mine 2"
      in r.get_data(as_text=True), r.status_code)

r = stranger.post("/api/draft", json={"files": {"index.html": "x"}})
check("a signed-out student saving is told to sign in, not ignored",
      r.status_code == 401, r.status_code)

# A deleted project must not leave the page autosaving into nothing while
# telling the student it saved.
student.delete("/api/draft/" + SLUG)
r = student.post("/api/draft/" + SLUG, json={"files": {"index.html": "after"}})
check("autosaving into a deleted project is a clean 404, not a silent success",
      r.status_code == 404, r.status_code)
_live_js = open(os.path.join(WEBIDE, "static", "live.js")).read()
check("  and live.js turns that back into a Save button",
      "res.status === 404" in _live_js and "removeItem(SLUG_KEY)" in _live_js,
      "otherwise it says Saved for the rest of the lesson and saves nothing")


# ------------------------------------------------- handing work in
#
# THE THING THAT WAS IMPOSSIBLE.
#
# Turning work in needs a draft with an assignment on it. A live lesson had
# no assignment and the live page saved through /api/draft, which makes a
# free-standing project — so the Turn in button could not appear, on the
# live page or on reopening the saved copy. Nothing errored; the lesson
# worked, the saving worked, and handing in simply could not happen.
print("\nHanding work in")

hw = teacher.post("/api/assignment",
                  json={"files": {"index.html": "<h1>starter</h1>"},
                        "title": "Page homework"}).get_json()["slug"]

r = teacher.get("/api/live/assignment/" + hw)
check("a teacher can fetch one assignment's starter for the editor",
      r.status_code == 200 and r.get_json()["files"]["index.html"].startswith("<h1>starter"),
      r.status_code)
check("  another teacher cannot",
      other.get("/api/live/assignment/" + hw).status_code == 404)
check("  nor can a student",
      student.get("/api/live/assignment/" + hw).status_code == 403)

r = teacher.get("/api/live/assignments")
check("a teacher can list their open assignments", r.status_code == 200,
      r.status_code)
check("  and the list stays light, with no starter code in it",
      all("code" not in a for a in r.get_json()["assignments"]),
      "every starter in the chooser would be megabytes nobody reads")
check("  and the new one is in it",
      hw in [a["slug"] for a in r.get_json()["assignments"]])
check("a student cannot", student.get("/api/live/assignments").status_code == 403)

r = other.post("/api/live/start", json={"body": "x", "assignment": hw})
check("a teacher cannot attach someone else's assignment",
      r.status_code == 400, r.get_json())

# CODE is still the teacher open lesson at this point; close it so
# the next start makes a fresh one attached to the assignment.
teacher.post("/api/live/%s/stop" % CODE)
started = teacher.post("/api/live/start",
                       json={"body": "for i in range(3):", "title": "Loops",
                             "assignment": hw}).get_json()
LESSON = started["code"]
check("a lesson can be started for an assignment",
      started.get("assignment") == hw, started)

# Resuming after a page reload sends no assignment key at all.
again2 = teacher.post("/api/live/start", json={"body": "more"}).get_json()
check("  and reloading the editor does not drop it",
      again2.get("assignment") == hw,
      "the class would silently lose the ability to hand in")


def starter_of(page):
    """What the page tells live.js to start the student's editor with."""
    m = re.search(r"^\s*starter: (.*?),?$", page, re.M)
    if not m:
        return None
    try:
        return json.loads(m.group(1))
    except ValueError:
        return "<not JSON: %s>" % m.group(1)   # fail the check, don't crash

# THE STARTER, as the handout link would give it. A lesson for an assignment
# used to hand every student an empty editor, so the class retyped the
# starter the teacher had already written for them.
check("a lesson for an assignment starts the class on its index.html",
      starter_of(stranger.get("/live/%s" % LESSON).get_data(as_text=True))
      == '<h1>starter</h1>')
check("  signed in with no draft of it yet, the same",
      starter_of(student.get("/live/%s" % LESSON).get_data(as_text=True))
      == '<h1>starter</h1>')
r = stranger.get("/api/live/%s" % LESSON)
check("  and it is in the page, never on the poll",
      "starter" not in r.get_json() and '<h1>starter</h1>' not in r.get_data(as_text=True),
      "the poll is the teacher's channel; the starter is the student's")

# The assignment ships more than one file, which is the normal WebIDE case.
db = W.SessionLocal()
try:
    row = db.query(accounts.Assignment).filter_by(slug=hw).first()
    row.files = json.dumps({"index.html": "<h1>starter</h1>",
                            "extra.css": "body { color: red }"})
    db.commit()
finally:
    db.close()

r = student.post("/api/live/%s/keep" % LESSON, json={"code": "<h1>my work</h1>"})
check("a student's save lands in the assignment's own draft",
      r.status_code == 200 and r.get_json()["can_turn_in"] is True,
      r.get_json())
KEPT = r.get_json()["slug"]

# THE DRAFT, NOT THE STARTER, once they have one. Saving here overwrites the
# draft's file with the live editor, so a student who did half of it from the
# link this morning and was handed the bare starter now would lose the
# morning on their first Save.
_mine = starter_of(student.get("/live/%s" % LESSON).get_data(as_text=True))
check("a student with a draft of the assignment starts from their draft",
      _mine == '<h1>my work</h1>', repr(_mine))
check("  while everyone else still gets the starter",
      starter_of(stranger.get("/live/%s" % LESSON).get_data(as_text=True))
      == '<h1>starter</h1>')

def drafts_for(uid):
    db = W.SessionLocal()
    try:
        item = db.query(accounts.Assignment).filter_by(slug=hw).first()
        return db.query(accounts.Draft).filter_by(
            owner_id=uid, assignment_id=item.id).count()
    finally:
        db.close()


# THE DUPLICATE, EXERCISED PROPERLY.
#
# The first version of this saved once and then counted, which is one draft
# however the code behaves — it passed a deliberately broken server that made
# a fresh row every time. Two copies of one piece of work is the failure
# worth catching: the student edits one and hands in the other.
# THE STATUS, NOT JUST THE COUNT. Counting alone still passed a server that
# inserted a fresh row every time — because the table's unique constraint on
# (owner, assignment) rejected the second insert, so the count stayed at 1
# while every save after the first was a 500 the student would have seen as
# "could not save". The count was right for the wrong reason.
again_a = student.post("/api/live/%s/keep" % LESSON,
                       json={"code": "my work, further on"})
again_b = student.post("/api/live/%s/keep" % LESSON,
                       json={"code": "further still"})
check("  and saving again succeeds rather than colliding",
      again_a.status_code == 200 and again_b.status_code == 200,
      "%s then %s" % (again_a.status_code, again_b.status_code))
check("  writing to that same row, not a new one",
      drafts_for(STUDENT) == 1,
      "%d drafts for one student on one assignment" % drafts_for(STUDENT))
check("  and the latest text is what was kept",
      again_b.get_json().get("slug") == KEPT, again_b.get_json())

# The other order, which is the one that happens in a real week: they open
# the handout link in class on Monday, then join the live lesson on Tuesday.
handout_first = client(STUDENT2)
r = handout_first.get("/a/" + hw)
check("  a student who opened the handout link first has one copy",
      drafts_for(STUDENT2) == 1, drafts_for(STUDENT2))
joined = handout_first.post("/api/live/%s/keep" % LESSON,
                            json={"code": "typed along"})
check("  and saving from the live lesson succeeds",
      joined.status_code == 200, joined.status_code)
check("  finding it rather than making another",
      drafts_for(STUDENT2) == 1,
      "%d drafts — they would edit one and hand in the other"
      % drafts_for(STUDENT2))

r = student.get("/a/" + hw)
check("  so opening the handout link afterwards finds it",
      r.status_code == 302 and KEPT in r.headers.get("Location", ""),
      r.headers.get("Location", r.status_code))

kept_files = student.post("/api/live/%s/keep" % LESSON,
                          json={"code": "<h1>my work</h1>"}).get_json()["files"]
r = student.post("/api/submit", json={"draft": KEPT, "files": kept_files})
check("the student can turn it in", r.status_code == 200, r.get_json())

# THE FILE THAT NEARLY GOT DROPPED. Turning in replaces a draft's files
# with what is posted, and the live pane edits only the entry page — so a
# first version of this posted one file and would have deleted any other the
# assignment shipped, at the moment the work was handed in.
db = W.SessionLocal()
try:
    kept = db.query(accounts.Draft).filter_by(slug=KEPT).first().file_map()
finally:
    db.close()
check("  and the project's other files survived being handed in",
      "extra.css" in kept, sorted(kept))

# THE REST OF THE PROJECT, AS TABS. The live page was index.html alone, so
# a student could not see the stylesheet the lesson was about, and their
# page ran unstyled. The page is handed the same files the handout link
# would open — their draft's — and a save carries the tabs back.
def starter_files_of(page):
    m = re.search(r"^\s*starterFiles: (.*?),?$", page, re.M)
    try:
        return json.loads(m.group(1)) if m else None
    except ValueError:
        return "<not JSON: %s>" % m.group(1)


def kept_now():
    db = W.SessionLocal()
    try:
        return db.query(accounts.Draft).filter_by(slug=KEPT).first().file_map()
    finally:
        db.close()


r = student.post("/api/live/%s/keep" % LESSON,
                 json={"code": "<h1>mine</h1>",
                       "files": {"index.html": "<h1>stale</h1>",
                                 "extra.css": "body { color: blue }",
                                 "style.css": "h1 { margin: 0 }"}})
check("a save from the live page keeps what they typed in the other tabs",
      r.status_code == 200 and kept_now() == {"index.html": "<h1>mine</h1>",
                                              "extra.css": "body { color: blue }",
                                              "style.css": "h1 { margin: 0 }"},
      kept_now())
check("  index.html from `code`, whatever the map says",
      kept_now().get("index.html") == "<h1>mine</h1>", kept_now().get("index.html"))
check("  and hands back the project as saved, for Turn in",
      r.get_json().get("files") == kept_now(), r.get_json().get("files"))
# An empty map is an old editor tab from before the tabs, which sent `{}`.
# Taken literally it would strip every file but index.html.
r = student.post("/api/live/%s/keep" % LESSON,
                 json={"code": "<h1>mine</h1>", "files": {}})
check("  while an empty map leaves the other files alone",
      r.status_code == 200 and "style.css" in kept_now(), kept_now())
r = student.post("/api/live/%s/keep" % LESSON,
                 json={"code": "<h1>mine</h1>", "files": {"../x.css": "no"}})
check("  and a file name the editor would refuse is refused here too",
      r.status_code == 400 and "../x.css" not in kept_now(), r.status_code)

# Their draft's — style.css is in it now and not in the assignment — so this
# cannot pass on the assignment's files alone. index.html is not among them:
# it is `starter`, the one key a browser from before the tabs still has.
check("the live page hands the student their project's other files",
      starter_files_of(student.get("/live/%s" % LESSON).get_data(as_text=True))
      == {n: b for n, b in kept_now().items() if n != "index.html"},
      starter_files_of(student.get("/live/%s" % LESSON).get_data(as_text=True)))
check("  and a student with no draft gets the assignment's",
      starter_files_of(stranger.get("/live/%s" % LESSON).get_data(as_text=True))
      == {"extra.css": "body { color: red }"})

# The autosave goes to /api/draft/<slug>, which REPLACES the files and
# refuses a map without index.html. The live page once sent it `{}`, and
# every autosave after the first Save was a 400 nobody saw.
r = student.post("/api/draft/" + KEPT,
                 json={"files": {"index.html": "<h1>auto</h1>",
                                 "style.css": "h1 { margin: 1px }"}})
check("  and what its autosave sends is accepted",
      r.status_code == 200 and kept_now().get("style.css") == "h1 { margin: 1px }",
      r.status_code)

seen_by_teacher = teacher.get("/teacher/" + hw).get_data(as_text=True)
check("  and it reaches the teacher's dashboard",
      "A Student" in seen_by_teacher)

page = student.get("/live/%s" % LESSON).get_data(as_text=True)
check("the live page offers Turn in once there is an assignment",
      'id="live-turn-in"' in page)
check("  and says they have already handed it in",
      "Turn in again" in page)

# A lesson with no assignment still saves — it just cannot hand in, and
# says nothing misleading about it.
plain = teacher.post("/api/live/start", json={"body": "x"}).get_json()
check("  (an open lesson is reused, so this is still the same one)",
      plain["code"] == LESSON, plain["code"])

teacher.post("/api/live/%s/stop" % LESSON)
bare = teacher.post("/api/live/start",
                    json={"body": "x", "assignment": ""}).get_json()
r = student.post("/api/live/%s/keep" % bare["code"], json={"code": "notes"})
check("a lesson with no assignment still saves",
      r.status_code == 200 and r.get_json()["can_turn_in"] is False,
      r.get_json())
page = student.get("/live/%s" % bare["code"]).get_data(as_text=True)
check("  and offers no Turn in button at all",
      'id="live-turn-in"' not in page,
      "a button that cannot work reads as lost work")
check("  and starts the student's editor empty, as it always did",
      starter_of(page) == "", repr(starter_of(page)))

r = stranger.post("/api/live/%s/keep" % bare["code"], json={"code": "x"})
check("signed out, saving says to sign in", r.status_code == 401, r.status_code)


# ------------------------------------------------------------------ ending
print("\nEnding it")

r = student.post("/api/live/%s/stop" % CODE)
check("a student cannot end the lesson", r.status_code == 403, r.status_code)

r = teacher.post("/api/live/%s/stop" % CODE)
check("the host can", r.status_code == 200, r.status_code)

r = stranger.get("/api/live/%s?v=3000" % CODE)
check("a student still on the page is TOLD it ended",
      r.status_code == 200 and r.get_json()["ended"] is True,
      "a mirror that just stops moving looks like a broken page")

r = teacher.post("/api/live/%s/push" % CODE, json={"body": "after", "seq": 5000})
check("and nothing more can be pushed into it", r.status_code == 409,
      r.status_code)

after = teacher.post("/api/live/start", json={"body": "new"}).get_json()
check("starting again makes a NEW lesson, not the ended one",
      after["code"] != CODE, after["code"])


# ------------------------------------------- resuming, and signing out
print("\nResuming after a reload, and signing out")

_db = W.SessionLocal()
_db.query(accounts.LiveSession).filter_by(host_id=TEACHER, ended=0).update(
    {"host_name": "Mr Franz"})
_db.commit()
_open = _db.query(accounts.LiveSession).filter_by(host_id=TEACHER, ended=0).first()
_db.close()
if _open is not None:
    teacher.post("/api/live/start", json={"body": "x", "resume": _open.code})
    check("a lesson opened under the old name picks up the new one on reload",
          stranger.get("/api/live/%s" % _open.code).get_json()["host"] == "Franz")

def open_lessons(uid):
    db = W.SessionLocal()
    try:
        return db.query(accounts.LiveSession).filter_by(
            host_id=uid, app=W.APP_NAME, ended=0).count()
    finally:
        db.close()

r = teacher.post("/api/live/start", json={"body": "x", "resume": after["code"]})
check("a reload resumes the lesson it was broadcasting",
      r.get_json().get("code") == after["code"], r.get_json())

# THE BUG: the editor resumed by calling start like a fresh Go live, so an
# ended lesson in the browser's memory put the teacher back on the air in a
# brand-new lesson just for opening the editor — "sign in and I'm live".
teacher.post("/api/live/%s/stop" % after["code"])
r = teacher.post("/api/live/start", json={"body": "x", "resume": after["code"]})
check("resuming a lesson that has ended starts nothing",
      r.get_json().get("resumed") is False and "code" not in r.get_json(),
      r.get_json())
check("  and no lesson was opened behind the teacher's back",
      open_lessons(TEACHER) == 0, "%d open" % open_lessons(TEACHER))

fresh = teacher.post("/api/live/start", json={"body": "x"}).get_json()
r = teacher.post("/api/live/start", json={"body": "x", "resume": CODE})
check("  nor does resuming an old code while a different lesson is open",
      r.get_json().get("resumed") is False, r.get_json())
check("  and the open one is left alone",
      open_lessons(TEACHER) == 1)

teacher.get("/logout")
check("signing out ends the lesson being broadcast",
      open_lessons(TEACHER) == 0, "%d open" % open_lessons(TEACHER))
r = stranger.get("/api/live/%s" % fresh["code"])
check("  and the class is told it ended",
      r.get_json().get("ended") is True, r.get_json())
teacher = client(TEACHER)                  # signed back in for what follows


# ------------------------------------------- reopening yesterday's lesson
#
# A lesson that ended — Stop, signing out, or the overnight sweep — used to
# be gone for good: the link the class had from yesterday only ever said
# "Lesson ended". Now the teacher opens that same link and presses "Teach
# this lesson again". It is never offered anywhere else: a reopened lesson
# lands on every screen still showing its host_page, which is the "sign in and
# I'm live" bug if it ever happens without the teacher choosing it. (Go
# live once offered "your last lesson", which was whichever was most recent
# rather than the one meant, and left the editor showing whatever was open.)
print("\nReopening yesterday's lesson")

def set_row(code, **fields):
    db = W.SessionLocal()
    try:
        db.query(accounts.LiveSession).filter_by(code=code).update(fields)
        db.commit()
    finally:
        db.close()

def item_id(slug):
    db = W.SessionLocal()
    try:
        return db.query(accounts.Assignment).filter_by(slug=slug).first().id
    finally:
        db.close()


def lesson_row(code):
    db = W.SessionLocal()
    try:
        return db.query(accounts.LiveSession).filter_by(code=code).first()
    finally:
        db.close()

check("Go live offers no lesson of its own accord",
      "recent" not in teacher.get("/api/live/assignments").get_json(),
      "it offered the most recent lesson, not the one the teacher meant")

# Yesterday's lesson: for the homework, ended by the sweep a day ago.
set_row(LESSON, ended=1, updated_at=W._live_now() - W.timedelta(days=1))
host_page = teacher.get("/live/%s" % LESSON).get_data(as_text=True)
_teach = re.search(r'<a id="teach-again"[^>]*href="([^"]*)"', host_page)
check("its teacher, opening its link, can teach it again",
      _teach is not None and "Teach this lesson again" in host_page,
      "the link the class still has could never be used again")
check("  into the editor, with the lesson and its assignment's starter",
      _teach is not None and _teach.group(1).replace("&amp;", "&")
      in ("/new?teach=%s&a=%s" % (LESSON, hw), "/new?a=%s&teach=%s" % (hw, LESSON)),
      _teach.group(1) if _teach else "")
check("  and is not offered End lesson for a lesson already over",
      'id="live-stop"' not in host_page)
check("  nor a connection chip that never connects",
      'id="live-state"' not in host_page)
host_page = student.get("/live/%s" % LESSON).get_data(as_text=True)
check("a student opening the same link is offered nothing of the kind",
      'id="teach-again"' not in host_page)
host_page = other.get("/live/%s" % LESSON).get_data(as_text=True)
check("  nor is another teacher", 'id="teach-again"' not in host_page)

r = other.post("/api/live/start", json={"body": "x", "reopen": LESSON})
check("another teacher cannot reopen it", r.status_code == 404, r.status_code)
check("  and it stays ended", lesson_row(LESSON).ended == 1)

r = teacher.post("/api/live/start", json={"body": "x", "resume": LESSON})
check("a reload's resume still cannot reopen it",
      r.get_json().get("resumed") is False and lesson_row(LESSON).ended == 1,
      r.get_json())

r = teacher.post("/api/live/start", json={"body": "day two", "reopen": LESSON})
got = r.get_json()
check("the teacher can reopen it", r.status_code == 200, r.status_code)
check("  under the same code, so yesterday's link works again",
      got.get("code") == LESSON, got)
check("  still for the same assignment, so Turn in goes where it went",
      got.get("assignment") == hw, got)
check("  and it survives the sweep that ended it overnight",
      lesson_row(LESSON).ended == 0,
      "start sweeps after it commits: a stale updated_at would end it again")
r = stranger.get("/api/live/%s" % LESSON)
check("  and the class's host_page is told it is back on",
      r.get_json().get("ended") is False, r.get_json())
host_page = teacher.get("/live/%s" % LESSON).get_data(as_text=True)
check("while it is open the link still takes its teacher back in",
      "Teach this lesson</a>" in host_page.replace("\n", "").replace("  ", "")
      and 'id="live-stop"' in host_page)

other_open = teacher.post("/api/live/start", json={"body": "x"}).get_json()
check("  (pressing Go live now carries on in the reopened one)",
      other_open.get("code") == LESSON, other_open)

# Two open rows for one teacher: the newest wins every later Go live and
# reload, which is not the one the class is looking at.
set_row(LESSON, ended=1)
newer = teacher.post("/api/live/start", json={"body": "x"}).get_json()["code"]
teacher.post("/api/live/start", json={"body": "x", "reopen": LESSON})
check("reopening closes whatever else was open, leaving one",
      open_lessons(TEACHER) == 1 and lesson_row(newer).ended == 1,
      "%d open" % open_lessons(TEACHER))
teacher.post("/api/live/%s/stop" % LESSON)


# --------------------------------------------------- how it is built at all
print("\nHow it is built")

app_src = open(os.path.join(WEBIDE, "app.py")).read()
live_js = open(os.path.join(WEBIDE, "static", "live.js")).read()
app_js = open(os.path.join(WEBIDE, "static", "app.js")).read()


def code_only(js):
    """The JavaScript with its comments taken out.

    NOT a nicety. The check below for `readOnly: "nocursor"` was written
    against the raw file and passed happily while the actual option said
    `readOnly: true` — because the phrase was also sitting in the comment
    above it explaining why. A check that its own documentation satisfies is
    a check that can never fail.
    """
    out = re.sub(r"/\*.*?\*/", " ", js, flags=re.S)
    return re.sub(r"(^|[^:])//.*$", r"\1", out, flags=re.M)


live_code = code_only(live_js)

# TWO WORKERS. `gunicorn --workers 2` is in render.yaml, so any per-session
# state kept in a module-level dict is visible to one process and invisible
# to the other — and a student's poll reaches whichever one it lands on.
live_block = app_src[app_src.index("# Teaching live"):]
check("no live state is kept in module memory",
      not re.search(r"^_?live_?\w* *= *(\{\}|\[\]|dict\(|list\()",
                    live_block, re.M),
      "with two gunicorn workers, half the class would see nothing")

check("the row is what two workers agree on",
      "class LiveSession" in open(os.path.join(WEBIDE, "accounts.py")).read())

# The stamp has to be a 64-bit column: it is a millisecond clock reading,
# about 1.8e12, and Postgres INTEGER stops at 2.1e9. As a plain Integer this
# passes on SQLite and raises on the first push in production.
accounts_src = open(os.path.join(WEBIDE, "accounts.py")).read()
check("  and its version column is big enough for a clock reading",
      re.search(r"version = Column\(BigInteger", accounts_src) is not None,
      "Integer overflows on Postgres at 2.1e9; Date.now() is 1.8e12")

# THE RULE THE WHOLE PAGE EXISTS TO KEEP, asked about the argument and not
# about where the line sits. An earlier version of this check only counted
# the calls and looked for the word localStorage somewhere above — which
# passed unchanged when the call was rewritten to `mine.setValue(L.body)`,
# i.e. to fill the student's editor from the lesson. It tested position, not
# source, which is not the thing that matters.
sets = re.findall(r"(\w+)\.setValue\(", live_code)
check("live.js writes into only two editors, and knows which",
      set(sets) <= {"mirror", "mine"},
      "editors written to: %s" % sorted(set(sets)))

mine_calls = re.findall(r"mine\.setValue\(([^)]*)\)", live_code)
check("  the student's editor is written to exactly once",
      len(mine_calls) == 1, "%d times" % len(mine_calls))
arg = (mine_calls[0].strip() if mine_calls else "")
# What goes in is their own browser's copy, or — only when there is none —
# the starting point the PAGE was rendered with (L.starter: their draft or
# the assignment's starter). Traced through one variable, and nothing else
# may feed it: not the poll's data, not the mirror.
assigned = re.findall(r"\b(?:var\s+)?%s\s*=\s*([^;]+);" % re.escape(arg),
                      live_code) if arg else []
source_ok = (len(assigned) == 1
             and re.fullmatch(r"kept !== null \? kept : \(L\.starter \|\| \"\"\)",
                              assigned[0].strip()) is not None)
kept_ok = re.search(r"\bkept\s*=\s*window\.localStorage\.getItem\(DRAFT_KEY\)",
                    live_code) is not None
check("  and what goes in is their browser's copy, else the page's starter",
      source_ok and kept_ok,
      "mine.setValue(%s) = %s" % (arg or "nothing", assigned))

after_mirror = live_code[live_code.index("function showMirror"):]
# What gets saved has to be the student's editor. Saving the mirror would
# put the teacher's code in the student's projects under their name, and it
# would look completely correct on screen while doing it.
#
# ONE LEVEL OF INDIRECTION IS RESOLVED, because the first version of this
# check only matched `code: <editor>.getValue()` and the initial Save passes
# a variable — so changing that variable to read the mirror passed the suite
# untouched. A check that covers the autosave and not the Save is worse than
# none, because it reads as though both are guarded.
def editors_behind(field):
    """Which CodeMirror every `field: ...` ends up reading."""
    found = set()
    for value in re.findall(r"\b%s: *([\w.()]+)" % field, live_code):
        value = value.rstrip(",")
        direct = re.match(r"(\w+)\.getValue\(\)$", value)
        if direct:
            found.add(direct.group(1))
            continue
        if re.match(r"^\w+$", value):          # a variable: find what it holds
            for src in re.findall(
                    r"\b%s *= *(\w+)\.getValue\(\)" % re.escape(value),
                    live_code):
                found.add(src)
            else:
                if not re.search(r"\b%s *= *\w+\.getValue\(\)"
                                 % re.escape(value), live_code):
                    found.add("?" + value)     # unresolved: say so, don't pass
    return found


# `mainSource()` is index.html's document, whichever tab is showing.
# Resolved to the editor that document belongs to, so a mainSource() that
# read the mirror would fail here rather than slip past as unknown.
main_ok = (re.search(r"function mainSource\(\) \{ return docs\[ENTRY\]\.getValue\(\); \}",
                     live_code) is not None
           and re.findall(r"docs\[ENTRY\] *= *([^;]+);", live_code) == ["mine.getDoc()"])
_real_code = live_code
live_code = live_code.replace("mainSource()",
                              "mine.getValue()" if main_ok else "?mainSource()")
saved_from = editors_behind("code")
live_code = _real_code
check("  and what is saved to their projects is their editor, not the mirror",
      bool(saved_from) and saved_from == {"mine"},
      "saved from: %s" % sorted(saved_from))

# THE OTHER TABS ARE THEIRS TOO. Every one is a document made here from
# the page or their browser — never filled from the mirror or the poll.
doc_fills = re.findall(r"docs\[[^\]]+\] *= *([^;]+);", live_code)
check("  and every other tab is filled from the page or their browser",
      bool(doc_fills) and all("mirror" not in f and "data." not in f
                              for f in doc_fills),
      doc_fills)
check("  and none is ever written to afterwards",
      re.search(r"docs\[[^\]]+\]\.(setValue|replaceRange)\(", live_code) is None)
# Three saves, and the fourth is New tab's handover to /play, which carries
# every tab for the same reason: a page missing its style.css runs unstyled.
check("  every save carries every tab, never an empty map",
      "files: {}" not in live_code
      and len(re.findall(r"files: allFiles\(\)", live_code)) == 4,
      "an autosave sending {} was refused, and nothing after the first Save was kept")
run_body = live_code[live_code.index("function run()"):]
run_body = run_body[:run_body.index("\n  }\n")]
check("  and Run builds their page from every tab",
      "var files = allFiles();" in run_body
      and "assemble(files, token, ENTRY" in run_body,
      "with index.html alone the page ran without its stylesheet")
check("  with tabs on the page to switch between them",
      'id="mine-tabs"' in page and "starterFiles:" in page)

check("  and nothing in the polling path touches it at all",
      "mine.setValue(" not in after_mirror,
      "a class losing their own work is the one unforgivable bug here")

mirror_opts = live_code[live_code.index('fromTextArea($("mirror")'):]
mirror_opts = mirror_opts[:mirror_opts.index("});")]
# THE TEACHER'S CODE IS NOT LIFTABLE. Without this a student drags across
# the mirror, presses Ctrl+C, and has the whole lesson in their own editor
# in two seconds — which is why there is no copy button either.
css = open(os.path.join(WEBIDE, "static", "style.css")).read()
mirror_css = css[css.index(".live-mirror,"):]
mirror_css = mirror_css[:mirror_css.index("}")]
# ANCHORED TO THE START OF THE LINE. `"user-select: none" in block` looks
# right and is not: `-webkit-user-select: none` contains it as a substring,
# so flipping the real property to `text` left the check passing and the
# teacher's code selectable. Both of these were written the lazy way first
# and both passed a deliberately broken stylesheet.
def declares(block, prop, value):
    return re.search(r"(?m)^\s*%s:\s*%s\s*;" % (prop, value), block) is not None


check("the teacher's code cannot be selected",
      declares(mirror_css, "user-select", "none"),
      "a drag and Ctrl+C would lift the whole lesson")
check("  including on the browsers that need the prefix",
      declares(mirror_css, "-webkit-user-select", "none"))
mine_css = css[css.index(".live-mine,"):]
mine_css = mine_css[:mine_css.index("}")]
check("  while the student's own editor still can be",
      declares(mine_css, "user-select", "text"),
      "their own work has to be copyable — it is theirs")
check("  and a copy made some other way is refused",
      re.search(r'\["copy", "cut"\]', live_code) is not None
      and "preventDefault" in live_code,
      "user-select is a hint; find-on-page and extensions get round it")

# A .md FILE IS A LINK THE CLASS CAN CLICK.
#
# The teacher opens a notes tab, puts an address in it, and it renders on
# thirty screens as a real link. Without this it arrives as
# `[click here](http://…)` in grey in a code pane, which is worse than
# useless in front of a room.
check("the live page can render notes, not just code",
      'id="mirror-notes"' in page and "notes.js" in page)
check("  and switches to them on a .md filename",
      "WebIDENotes.isMarkdown(data.filename)" in live_code,
      "the filename is already on the wire; this is what reads it")
check("  rendering through the same sanitiser the editor uses",
      "WebIDENotes.render(mirrorNotes" in live_code,
      "notes.js drops scripts and forces links to a new tab")
# THE GUARD, not the variable's name. Checking that `lastNotes` appears
# somewhere passed happily when the condition it guards was replaced by
# `true` — the name was still in the file, doing nothing.
check("  and re-renders only when the text changed",
      re.search(r"data\.body\s*!==\s*lastNotes", live_code) is not None,
      "re-parsing every second replaces the link under the cursor, so a "
      "click that lands mid-poll hits a dead element")
# CodeMirror measures itself on build. Measured while display:none it
# measures zero and comes back blank — switching tabs in front of a class is
# exactly when that happens.
check("  and the code pane is refreshed on the way back",
      "mirror.refresh()" in live_code,
      "CodeMirror returns from a hidden container as an empty box")
# Verified in a real browser against these exact rules: the teacher's code
# and notes text compute to user-select none, and a link inside the notes
# computes to text. The :not(.is-authoring) rule applies because the live
# page's body is is-live.
check("  with links inside the notes still usable",
      re.search(r"(?m)^body:not\(\.is-authoring\) \.notes-body a \{", css)
      is not None and "is-live" in page,
      "unselectable notes with an unclickable link would be pointless")

# THE CLIENT HALF. The server can do all of this correctly and the feature
# still be broken, because it is live.js that chooses which endpoint to call
# — and /api/draft makes a project with no assignment, which is the thing
# that could never be turned in. Swapping the URL back passed the entire
# server-side suite untouched.
# The chooser must not read as "open this lesson" — it decides where the
# CLASS's work goes, and the first wording sent a teacher looking for code
# that never loaded.
app_code = code_only(app_js)
check("the chooser says what it actually does",
      "Where should the class turn this work in?" in app_code
      and "does not change what is in your editor" in app_code,
      "the old wording read like it was about to open the assignment")
check("  and loading the starter is a separate, confirmed step",
      "function offerStarter" in app_code
      and re.search(r"offerStarter[\s\S]{0,800}window\.confirm", app_code)
      is not None,
      "it replaces the editor, so it cannot be silent")
check("  which the reload-resume path never takes",
      re.search(r'if \(resumeCode\) startLive\(undefined, resumeCode\);',
                app_code) is not None,
      "resuming a broadcast must not wipe what is being demonstrated")

check("the live page saves through the lesson, not as a loose project",
      "/keep" in live_code and 'fetch("/api/draft"' not in live_code,
      "/api/draft makes a draft with no assignment, which cannot be handed in")
check("  and offers Turn in only once the save says it can",
      "can_turn_in" in live_code and "canTurnIn" in live_code)
# WHAT TURN IN POSTS, which the server-side checks above cannot see: they
# build the payload themselves. Posting an empty file map is accepted by the
# server and deletes every other file in the project, at the moment the work
# is handed in.
submit_call = live_code[live_code.index('"/api/submit"'):]
submit_call = submit_call[:submit_call.index("}).then")]
check("  turning in posts the whole project, not an empty map",
      "saved.files" in submit_call and "files: {}" not in submit_call,
      "an empty map wipes the assignment's own files on hand-in")
check("  having saved it first, so the two agree",
      "keep().then" in live_code,
      "otherwise what is handed in is not what was saved")

check("  handing in through the editor's own endpoint",
      '"/api/submit"' in live_code,
      "so the dashboard sees the same thing either way")

check("the mirror cannot be typed into",
      '"nocursor"' in mirror_opts,
      "a plain readOnly still takes a cursor, so it looks typeable")

check("the teacher's push carries a stamp that only goes up",
      "function nextSeq" in app_js and "Math.max(Date.now()" in app_js)
check("  and the server refuses a lower one",
      "LiveSession.version < seq" in app_src,
      "without this, late pushes overwrite newer text")

check("the poll answers 304 when nothing changed",
      'return ("", 304)' in app_src)

# The editor's own rule for game mode: the output becomes a log strip under
# the picture. Without the class the stylesheet has nothing to hook, and the
# output pane fights the canvas for the right-hand column.
# WebIDE has no Python: running is a sandboxed frame, and Stop works by
# removing the element — a page stuck in `while (true)` wedges that frame's
# process, and a wedged frame cannot navigate itself away.
check("running builds the page through the editor's own assembler",
      "WebIDERun.assemble" in live_code,
      "so the live preview and the editor's preview cannot drift apart")
check("  in a sandboxed frame with no same-origin access",
      'setAttribute("sandbox", "allow-scripts allow-forms")' in live_code,
      "the student's page must not be able to reach the lesson")
check("  and Stop replaces the frame rather than asking it to stop",
      "function stopRun" in live_code and "freshFrame()" in live_code)
check("  and only this run's frame may write to the console",
      "e.source !== frame.contentWindow" in live_code
      and "data.webide !== token" in live_code,
      "otherwise any page could post into the lesson's output")

# STOP HAS TO PUT THE TOOLBAR BACK ITSELF.
#
# Reproduced on the deployed editor: press Stop on a kaypy game and the
# canvas freezes and "— stopped —" is printed, but the await on
# `_pyide_drive_game()` never settles, so Run stays disabled on "Running…"
# with Stop showing until the page is reloaded. Leaving the reset to the
# promise's finally is leaving it to something that may never run.
# PyIDE needed a run token because its Stop waited on a Pyodide promise that
# never settled. Nothing here waits on anything: Stop removes the frame,
# which kills the page outright even mid-loop. So only the toolbar half
# applies.
stop_fn = live_code[live_code.index("function stopRun"):]
stop_fn = stop_fn[:stop_fn.index("\n  }")]
check("live.js: Stop puts the toolbar back itself",
      "setBusy(false" in stop_fn,
      "otherwise the button says Running… until the page is reloaded")
check("  and kills the frame rather than asking it to stop",
      "freshFrame()" in stop_fn,
      "a page stuck in while(true) cannot navigate itself away")

# An ended lesson used to stop the polling, and that is what left a class on
# yesterday's code: they opened the link before their teacher pressed Go
# live, saw "Lesson ended", and nothing ever asked again. It keeps asking now,
# slowly — see the poll run for real under "an ended lesson keeps checking".

# Resuming (see "Resuming after a reload" above): the editor's half.
_app_code = code_only(open(os.path.join(HERE, "..", "static", "app.js")).read())
check("the editor sends the remembered code when it resumes",
      re.search(r"startLive\(undefined, resumeCode\)", _app_code) is not None
      and "resume: resume" in _app_code)
check("  and forgets it when the server says that lesson is over",
      re.search(r"data\.resumed === false\)\s*\{[^}]*forgetLive\(\);", _app_code) is not None)
check("  and forgets it on any page with no Go live button",
      re.search(r'\}\s*else\s*\{\s*try\s*\{\s*sessionStorage\.removeItem\("webide-live-host"\);', _app_code)
      is not None)
# Only the tab that went live, on the page it went live from, rejoins. The
# marker was shared by the whole browser, so any editor the teacher opened
# while live took over the broadcast with its own file — the class watched
# an untitled default template while the teacher typed in another tab.
check("the lesson is remembered per tab, not for the whole browser",
      'sessionStorage.setItem(HOST_KEY, JSON.stringify({ code: code, path: location.pathname }));'
      in _app_code and "localStorage.setItem(HOST_KEY" not in _app_code
      and 'localStorage.setItem("webide-live-host"' not in _app_code,
      "any editor tab would take over the class's screens")
check("  and rejoined only on the page it went live from",
      'return saved && saved.path === location.pathname ? saved.code : null;' in _app_code
      and "var resumeCode = liveToResume();" in _app_code)
check("  and the old shared marker is cleared, so it can never rejoin anything",
      "try { localStorage.removeItem(HOST_KEY); }" in _app_code)

# The notes pane: the editor sends the project's first .md on every push,
# and changing only the notes still counts as something to push — otherwise
# a teacher editing the notes while another file is open would send nothing.
_push = code_only(open(os.path.join(HERE, "..", "static", "app.js")).read())
_push_fn = _push[_push.index("function pushNow"):]
_push_fn = _push_fn[:_push_fn.index("\n    }\n")]
check("the editor sends the notes with every push",
      "notes: notes" in _push_fn and "var notes = liveNotes();" in _push_fn)
check("  and a change to the notes alone is pushed",
      re.search(r"var stamp = [^;]*\bnotes\b", _push_fn) is not None,
      "editing the notes with another file open would reach nobody")
check("  and they are the project's first .md",
      re.search(r"function notesFile\(\)[\s\S]{0,200}fileNames\(\)\.filter\(window\.WebIDENotes\.isMarkdown\)[\s\S]{0,80}md\[0\]", _push) is not None
      and re.search(r"function liveNotes\(\)\s*\{\s*var md = notesFile\(\);", _push) is not None)
_mirror_fn = live_code[live_code.index("function showMirror"):]
_mirror_fn = _mirror_fn[:_mirror_fn.index("\n  }\n")]
check("the live page shows them on every update, not only the first",
      "showNotes(data);" in _mirror_fn)
check("  and on the page's first paint, before any poll",
      re.search(r"showMirror\(\{[^}]*notes: L\.notes", live_code) is not None,
      "the first poll answers 304, so a late joiner would never see them")
_notes_fn = live_code[live_code.index("function showNotes"):]
_notes_fn = _notes_fn[:_notes_fn.index("\n  }\n")]
check("  through the slide viewer, which re-renders only when the slide changes",
      "notesSlides.show(data.notes, jump);" in _notes_fn
      and "if (text === drawn) return Promise.resolve(true);"
      in open(os.path.join(HERE, "..", "static", "notes.js")).read(),
      "a re-render every second replaces the link a student is clicking")
check("  and jumps to the teacher's slide only when the teacher moves",
      re.search(r"if \(slide !== teacherSlide\) \{\s*teacherSlide = slide;", _notes_fn)
      is not None,
      "typing on the same slide would drag back every student who read ahead")

# ------------------------------------------- slides and the teacher's Run
def fn_body(js, name):
    i = js.find("function " + name + "(")
    if i < 0:
        return ""
    return js[i:js.index("\n  }\n", i)]

_tpage = fn_body(live_code, "showTeacherPage")
_tout = fn_body(live_code, "showTeacherOutput")
check("the teacher's page goes only into its own frame",
      "teacherFrame.srcdoc = data.page" in _tpage
      and not re.search(r"\bframe\.srcdoc|\bframe = ", _tpage)
      and not re.search(r"(?<!teacherFrame)\.srcdoc = data\.page", live_code.replace("teacherFrame.srcdoc = data.page", "")),
      "the student's own preview must never be given it")
check("  set only when the page itself changes",
      re.search(r"if \(id === shownPageId\) return;", _tpage) is not None,
      "re-setting it would restart the teacher's page every second")
check("  and the poll says which page it has",
      re.search(r'"&pg=" \+ encodeURIComponent\(shownPageId\)', live_code)
      is not None)
_reveal = fn_body(live_code, "revealTeacher")
check("  appearing with the teacher's first Run and then staying",
      "revealTeacher(teacherView)" in _tpage
      and "if (!el.hidden) return;" in _reveal
      and not re.search(r"teacher(View|Console)\.hidden = true", live_code),
      "an empty push mid-Run would make the code beside it jump sideways")
check("  and the mirror re-measured when it appears",
      re.search(r"el\.hidden = false;\s*(?:/\*[\s\S]*?\*/\s*)?mirror\.refresh\(\);",
                _reveal) is not None)
check("the teacher's console is written only into its own pane",
      "teacherOut.textContent = data.output" in _tout
      and not re.search(r"outputEl[^;]*data\.output|write\(data\.output",
                        live_code))
check("  and its lines alone never pull the pane over",
      "showConsoleTab(true)" not in _tout and "showTeachers(true)" not in _tout)
check("the student's own page is never hidden for the teacher's",
      not re.search(r"\bframe\.hidden\s*=|\boutputEl\.hidden\s*=", live_code),
      "nothing of the teacher's sits in the student's panes any more")
check("the teacher's console appears once it has logged something",
      re.search(r"if \(!data\.output\) return;\s*revealTeacher\(teacherConsole\)",
                _tout) is not None)
# The teacher's frame posts console messages to this window like any preview.
# The listener must drop them — they carry the teacher's token, not this
# page's, and come from a different frame.
_listen = live_code[live_code.index('addEventListener("message"'):]
_listen = _listen[:_listen.index("\n  });")]
check("messages from the teacher's frame are not written to theirs",
      "data.webide !== token" in _listen
      and "e.source !== frame.contentWindow" in _listen
      and "teacherFrame" not in _listen)

check("the editor sends its caret with every push, and moving it counts",
      "cursor: cursor, seq: nextSeq()" in _push_fn
      and re.search(r"var stamp = [^;]*\bcursor\b", _push_fn) is not None,
      "a caret moved without typing would reach nobody")
check("  but none for a notes file, which the class reads rendered",
      re.search(r"if \((docs\[name\]|editor) && !window\.\w+Notes\.isMarkdown\(name\)\)",
                _push_fn) is not None)
check("the mirror draws the caret on every update",
      re.search(r"showCaret\(typeof data\.cursor", _mirror_fn) is not None
      and re.search(r"showMirror\(\{[^}]*cursor: L\.cursor", live_code)
      is not None)
_caret_fn = fn_body(live_code, "showCaret")
check("  as a widget, so the mirror still takes no cursor",
      "setBookmark(at, { widget: mark" in _caret_fn
      and "mirror.setCursor" not in live_code
      and "mirror.setSelection" not in live_code)
check("  and follows it, unless the student has just scrolled",
      "if (Date.now() >= followAfter) mirror.scrollIntoView(show" in _caret_fn
      and re.search(r'\["wheel", "touchmove", "mousedown"\][\s\S]{0,160}'
                    r'followAfter = Date\.now\(\) \+ FOLLOW_PAUSE_MS',
                    live_code) is not None,
      "a student reading line 4 would be yanked to line 40 every keystroke")
check("the editor sends a highlighted block as anchor-head",
      re.search(r"somethingSelected\(\)\) \{\s*var from = docs\[name\]"
                r"\.getCursor\(\"anchor\"\);\s*cursor = from\.line \+ \":\" \+ "
                r"from\.ch \+ \"-\" \+ cursor;", _push_fn) is not None,
      "dragging across a block to talk about it would show nobody anything")
check("  and the mirror paints it yellow as a mark, not a selection",
      'mirror.markText(from, to, { className: "mirror-pick" })' in _caret_fn
      and ".live-mirror .mirror-pick" in _css)
check("  in order even when dragged upwards",
      "CodeMirror.cmpPos(other, at) > 0" in _caret_fn,
      "markText with from after to marks nothing")
check("  and cleared with the caret",
      "if (pickMark) { pickMark.clear(); pickMark = null; }"
      in fn_body(live_code, "clearCaret"),
      "every highlight would stay yellow forever")
check("  clearing the old caret before the text is replaced",
      re.search(r"data\.body !== mirror\.getValue\(\)\) \{\s*clearCaret\(\);",
                _mirror_fn) is not None,
      "a removed line's handle throws, and the poll would stop")

_live_html = open(os.path.join(WEBIDE, "templates", "live.html")).read()
check("the console starts folded",
      'class="subpane live-console is-folded"' in _live_html
      and re.search(r"\n  openConsole\(false\);", live_code) is not None)
check("  and an error opens it",
      'if (cls === "err") openConsole(true);' in fn_body(live_code, "write"),
      "a mistake written into a folded pane is one nobody sees")

check("the editor sends slide, console and page with every push",
      "slide: slide, output: output, page: page" in _push_fn
      and re.search(r"var stamp = [^;]*\bslide\b[^;]*\boutput\b[^;]*\bpage\b",
                    _push_fn) is not None,
      "moving a slide, or a Run, would otherwise reach nobody")
check("  the WHOLE notes go out, so students can move through the slides",
      "var notes = liveNotes();" in _push_fn
      and len(re.findall(r"(?<![\w.])notes\s*=(?!=)", _push_fn)) == 1
      and "notes: notes," in _push_fn,
      "one slide at a time, nobody could read ahead or go back to a question")
check("  and the notes tab, if open, mirrors the teacher's slide, not the file",
      "if (name === notesFile()) text = onSlide;" in _push_fn,
      "the mirror would put every slide on screen at once")
check("  and no console is sent before the first Run",
      re.search(r"function liveOutput\(\)\s*\{\s*if \(!hasRun\) return \"\";",
                _push) is not None)
check("  and the page sent is Run's, not every auto-refresh",
      "var page = sharedPage;" in _push_fn
      and re.search(r"function run\(\)\s*\{[^}]*sharedPage = lastBuilt;[^}]*hasRun = true;",
                    _push) is not None
      and "sharedPage =" not in fn_body(_push, "render"),
      "thirty panes would jump to a half-typed page on every pause")
check("  and the editor's first paint is not a Run",
      re.search(r"show something straight away[^\n]*\n(\s*//[^\n]*\n)*\s*render\(ENTRY\);",
                app_js) is not None,
      "every lesson would send the page before the teacher pressed anything")

import json
import shutil
import subprocess
notes_js = open(os.path.join(WEBIDE, "static", "notes.js")).read()
if shutil.which("node"):
    # Cut where the author drew a ---, and nowhere else. The first version
    # cut at every `## ` heading, and this sample is what it got wrong: the
    # ### slide was glued onto the one before it, the slide with two ##
    # sections was cut in half, and the --- straight under a line of text
    # did not end its slide at all.
    sample = (
        "# Looping Over a List\n\n---\n\n## for Each Item\n\n"
        "```python\n## a comment\nfor e in enemies:\n    print(e)\n```\n\n"
        "```text\n---\n```\n\n---\n\n"
        "## enumerate()\n\nPosition and item.\n\n## zip()\n\nTwo lists.\n\n---\n\n"
        "### still a slide of its own\nNo blank line before the rule.\n---\n"
        "## ✏ Mini Assignment\n\n> Extension\n")
    harness = "var window = {};\n" + notes_js + """
var N = window.WebIDENotes;
console.log(JSON.stringify({
  cut: N.slides(%s),
  none: N.slides("# Just notes\\n\\n## A section\\n\\n## Another\\n"),
  crlf: N.slides("## A\\r\\nx\\r\\n---\\r\\n## B\\r\\ny")
}));
""" % json.dumps(sample)
    res = subprocess.run(["node", "-e", harness], capture_output=True, text=True)
    try:
        got = json.loads(res.stdout)
    except ValueError:
        got = {}
    cut = got.get("cut") or []
    check("notes split into slides at each --- and nowhere else",
          len(cut) == 5 and cut[0] == "# Looping Over a List"
          and cut[1].startswith("## for Each Item")
          and cut[4].startswith("## ✏ Mini Assignment"),
          repr([c[:20] for c in cut] or res.stderr[-200:]))
    check("  a slide holding two ## sections stays one slide",
          len(cut) > 2 and cut[2].startswith("## enumerate()")
          and cut[2].endswith("Two lists."),
          repr(cut[2] if len(cut) > 2 else ""))
    check("  a slide headed by ### is its own slide",
          len(cut) > 3 and cut[3].startswith("### still a slide of its own"),
          repr(cut[3] if len(cut) > 3 else ""))
    check("  a --- straight under a line of text still ends the slide",
          len(cut) > 3 and cut[3].endswith("No blank line before the rule."),
          repr(cut[3] if len(cut) > 3 else ""))
    check("  ## and --- inside a code fence do not cut it",
          len(cut) > 1 and "## a comment" in cut[1]
          and "```text\n---\n```" in cut[1],
          "a line of output would cut a slide in half")
    check("  the --- itself is not shown on either side",
          all(not c.startswith("---") and not c.endswith("---") for c in cut),
          repr(cut[1][-12:] if len(cut) > 1 else ""))
    check("  notes with ## headings but no --- are not slides at all",
          got.get("none") == [], repr(got.get("none")))
    check("  Windows line endings split the same way",
          got.get("crlf") == ["## A\nx", "## B\ny"], repr(got.get("crlf")))
else:
    check("node is available to run the slide splitter", False,
          "brew install node")

# Show all, and the slide controls in the Class sees pane head.
r = teacher.get("/new")
_page = r.get_data(as_text=True)
_cv = _page.find('id="class-view"')
check("the slide controls sit in the Class sees pane, not the top bar",
      -1 < _cv < _page.find('id="live-slides"') < _page.find('id="class-notes"'),
      "the top bar had no room for them")
check("  and no Show all: students move through the slides themselves",
      'id="slide-whole"' not in _page and "wholeNotes" not in _push,
      "it sent the whole file as one page, which the class now always has")
_stop_fn = fn_body(_push, "stopLive")
check("  the arrows' [hidden] really hides them",
      re.search(r"\.slide-ctl \.btn\[hidden\]\s*\{\s*display:\s*none",
                open(os.path.join(HERE, "..", "static", "style.css")).read())
      is not None,
      ".btn sets display, so [hidden] alone shows them anyway")
# The teacher sees what the class's Notes pane shows, fed from what is sent.
check("the teacher sees the slide the class is sent to",
      "paintClassView(onSlide, slide);" in _push_fn
      and _push_fn.index("onSlide = cut[slideAt];")
          < _push_fn.index("paintClassView(onSlide, slide);")
          < _push_fn.index("if (stamp === lastSent) return;"),
      "fed anything but what is sent, it can show a slide the class is not on")
_class_fn = fn_body(_push, "paintClassView")
check("  re-rendered only when it changes",
      "if (notes === classShownNotes && slide === classShownSlide) return;"
      in _class_fn,
      "pushNow runs every tick; re-rendering resets the teacher's scroll")
check("  and put away when the lesson ends",
      re.search(r"function paintLive\(\)[\s\S]*?\} else \{[\s\S]*?paintClassView\(null, \"\"\);",
                _push) is not None)

# ----------------------------------------- a link to another site
# The preview asks for it with kind 'open'. The editor (app.js) always opened
# a tab; the live page had no case for it, so the URL fell through to the
# console and the link did nothing else. Driven in node: live.js's own
# message listener, receiving what runner.js's click handler sends.
_msg_at = live_js.find('window.addEventListener("message", function (e) {')
_msg_fn = live_js[_msg_at:live_js.index("\n  });\n", _msg_at) + 6] if _msg_at >= 0 else ""
_open_fn = fn_body(live_js, "openExternal")
if shutil.which("node") and _msg_fn and _open_fn:
    _harness = """
var opened = [], lines = [], listener = null, blockAll = false;
var window = {
  addEventListener: function (t, f) { if (t === "message") listener = f; },
  open: function (url, where) {
    if (blockAll) return null;
    opened.push([url, where]); return { opener: "lesson" }; }
};
var token = "t1", frame = { contentWindow: {} };
function write(text, cls) { lines.push([text, cls || ""]); }
function setBusy() {}
var outputEl = { textContent: "x" };
%s
  }
%s
function send(kind, text) {
  listener({ data: { webide: "t1", kind: kind, text: text }, source: frame.contentWindow });
}
send("open", "https://developer.mozilla.org/");
send("open", "javascript:alert(1)");
blockAll = true;
send("open", "https://example.com/");
console.log(JSON.stringify({ opened: opened, lines: lines }));
""" % (_open_fn, _msg_fn)
    _res = subprocess.run(["node", "-e", _harness], capture_output=True, text=True)
    try:
        _got = json.loads(_res.stdout)
    except ValueError:
        _got = {}
    _lines = [l[0] for l in _got.get("lines") or []]
    check("live: a link to another site opens it in a new tab",
          _got.get("opened") == [["https://developer.mozilla.org/", "_blank"]],
          repr(_got or _res.stderr[:400]))
    check("  not just printed to the console",
          _lines and "Opened in a new tab" in _lines[0]
          and not any(l.strip() == "https://developer.mozilla.org/" for l in _lines),
          repr(_lines))
    check("  a javascript: link opens nothing, and says so",
          len(_lines) > 1 and "nothing opened" in _lines[1], repr(_lines))
    check("  a blocked pop-up says so",
          len(_lines) > 2 and "blocked" in _lines[2], repr(_lines))
else:
    check("node runs the live page's link handling", False,
          "brew install node" if _msg_fn and _open_fn else "handler not found in live.js")

# ------------------------------------- reopening, as the browsers do it
print("\nReopening, in the browsers")

_app_now = code_only(open(os.path.join(WEBIDE, "static", "app.js")).read())
# This file's fn_body finds a function's end by its indent, which suits the
# top-level ones it was written for; teachAgain sits one level in.
_m_teach = re.search(r"function teachAgain\(code, slug\) \{[\s\S]*?\n    \}\n", _app_now)
_teach_fn = _m_teach.group(0) if _m_teach else ""
check("app.js reopens only from Teach this lesson again",
      'startLive(undefined, "", code);' in _teach_fn
      and len(re.findall(r'(?<!function )startLive\([^)]*,[^)]*,', _app_now)) == 1
      and "offerReopen" not in _app_now,
      "a reopen from anywhere else is the teacher back on the air unasked")
check("  and only when the link asked for it",
      re.search(r'if \(teach\) \{[\s\S]{0,200}?history\.replaceState\([\s\S]{0,120}?teachAgain\(teach, teachFor\);',
                _app_now) is not None,
      "left in the address bar, a reload would load the starter over the lesson")
check("  and the reload path never asks for one",
      'startLive(undefined, resumeCode);' in _app_now)

# What it does, run for real: the project goes into the editor BEFORE the
# lesson reopens, so the first push the class sees is the lesson's code and
# not whatever the editor happened to be showing.
if shutil.which("node") and _teach_fn:
    harness = """
var log = [], ENTRY = "index.html", docs = {"index.html": {v: "default", setValue: function (t) { this.v = t; }}};
var CodeMirror = {Doc: function (t) { return {v: t, setValue: function (x) { this.v = x; }}; }};
function modeFor() { return null; }
function loadStarter(files) { log.push("starter"); docs = {};
  Object.keys(files).forEach(function (n) { docs[n] = CodeMirror.Doc(files[n]); }); }
function switchTo(n) { log.push("switch " + n); }
function startLive(a, r, code) { log.push("live " + code + " " + (docs["index.html"] ? docs["index.html"].v : "-")
  + " " + (docs["notes.md"] ? docs["notes.md"].v : "-")); }
var replies = %s;
function fetch(url) { return Promise.resolve({json: function () {
  return Promise.resolve(replies[url.split("?")[0]]); }}); }
%s
var which = process.argv[1];
teachAgain("abc", which === "noassign" ? "" : "hw1");
setTimeout(function () { console.log(JSON.stringify(log)); }, 50);
"""
    def run_teach(which, last):
        h = harness % (json.dumps({
            "/api/live/assignment/hw1": {"title": "HW", "files": {"index.html": "starter code", "notes.md": "# notes"}},
            "/api/live/abc": last}), _teach_fn)
        res = subprocess.run(["node", "-e", h, which], capture_output=True, text=True)
        return json.loads(res.stdout) if res.returncode == 0 else [res.stderr[-200:]]
    got = run_teach("assign", {"body": "yesterday's end", "filename": "index.html"})
    check("teach again loads the starter, then yesterday's code, then goes live",
          got == ["starter", "switch index.html", "live abc yesterday's end # notes"], got)
    got = run_teach("assign", {"body": "## edited notes", "filename": "notes.md"})
    check("  a lesson that ended on the notes leaves the notes as written",
          got == ["starter", "live abc starter code # notes"], got)
    got = run_teach("noassign", {"body": "x = 1", "filename": "index.html"})
    check("  and with no assignment it still brings the code back",
          got == ["switch index.html", "live abc x = 1 -"], got)
else:
    check("node is available to run teachAgain", False, "brew install node")

_live_now_js = code_only(open(os.path.join(WEBIDE, "static", "live.js")).read())
# THE BUG: one `seen` for both the draft's version and the lesson's, so the
# first poll wrote the lesson's version over the draft's and every Save from
# a student with an earlier draft was refused as "changed in another tab".
check("live.js keeps the draft's version apart from the lesson's",
      len(re.findall(r'\bvar seen\b', _live_now_js)) == 1
      and "payload.base = draftSeen" in _live_now_js
      and re.search(r'function saw\(data\) \{[^}]*draftSeen = data\.version',
                    _live_now_js) is not None,
      "a reopened lesson would refuse every student's first Save")

# Which copy a student's editor starts from, run for real. Lifted from
# `var kept = null;` to the line that decides, and run against a stand-in
# localStorage — a reopened lesson has the same code, so the same keys, as
# yesterday.
_m = re.search(r'(  var kept = null;.*?  var start = kept !== null \? kept : '
               r'\(L\.starter \|\| ""\);)', _live_now_js, re.S)
if shutil.which("node") and _m:
    harness = """
var cases = %s, out = {};
Object.keys(cases).forEach(function (k) {
  var c = cases[k], store = Object.assign({}, c.store);
  var window = {localStorage: {
    getItem: function (n) { return n in store ? store[n] : null; },
    setItem: function (n, v) { store[n] = String(v); },
    removeItem: function (n) { delete store[n]; }}};
  var DRAFT_KEY = "pyide-live-abc", L = c.L;
  %s
  out[k] = {start: start, base: store[DRAFT_KEY + "-base"] || null,
            files: store[DRAFT_KEY + "-files"] || null};
});
console.log(JSON.stringify(out));
""" % (json.dumps({
        "homework_since": {"L": {"draftVersion": 9, "starter": "last night"},
                           "store": {"pyide-live-abc": "yesterday",
                                     "pyide-live-abc-files": "{}",
                                     "pyide-live-abc-base": "4"}},
        "nothing_since": {"L": {"draftVersion": 4, "starter": "server"},
                          "store": {"pyide-live-abc": "typed here",
                                    "pyide-live-abc-base": "4"}},
        "kept_before_this": {"L": {"draftVersion": 9, "starter": "server"},
                             "store": {"pyide-live-abc": "typed here"}},
        "signed_out": {"L": {"draftVersion": None, "starter": ""},
                       "store": {"pyide-live-abc": "typed here",
                                 "pyide-live-abc-base": "4"}},
    }), _m.group(1))
    res = subprocess.run(["node", "-e", harness], capture_output=True, text=True)
    got = json.loads(res.stdout or "{}") if res.returncode == 0 else {}
    h = got.get("homework_since", {})
    check("their draft saved elsewhere since: the draft wins, not this browser",
          h.get("start") == "last night", h or res.stderr[-300:])
    check("  and the old copy is let go, so a reload does not bring it back",
          h.get("base") == "9" and h.get("files") is None, h)
    n = got.get("nothing_since", {})
    check("nothing saved since: this browser's typing wins, as always",
          n.get("start") == "typed here", n)
    k = got.get("kept_before_this", {})
    check("a copy kept before this existed still wins",
          k.get("start") == "typed here", k)
    check("  and is stamped, so tomorrow it can be told apart",
          k.get("base") == "9", k)
    o = got.get("signed_out", {})
    check("signed out, with no draft: this browser's typing wins",
          o.get("start") == "typed here", o)
else:
    check("node is available to run the live page's start-up", bool(_m),
          "brew install node" if _m else "the block in live.js moved")

# ------------------------------------------------ the slide viewer, run
# notes.js's slideView, in node, with just enough of a DOM to hold it. It is
# what the editor, a shared link and the class's live page all show notes
# through, so how it cuts, numbers and moves is checked by running it.
print("\nThe slide viewer, run")
_notes_src = open(os.path.join(HERE, "..", "static", "notes.js")).read()
if shutil.which("node"):
    harness = r"""
function El(tag) {
  this.tag = tag; this.children = []; this.hidden = false; this.disabled = false;
  this.textContent = ""; this.className = ""; this.handlers = {}; this.scrollTop = 0;
  this._html = ""; this.renders = 0;
}
El.prototype.appendChild = function (c) { this.children.push(c); c.parentNode = this; return c; };
El.prototype.insertBefore = function (c) { this.children.push(c); c.parentNode = this; return c; };
El.prototype.setAttribute = function () {};
El.prototype.addEventListener = function (ev, fn) { this.handlers[ev] = fn; };
El.prototype.querySelectorAll = function () { return []; };
Object.defineProperty(El.prototype, "innerHTML", {
  get: function () { return this._html; },
  set: function (v) { this._html = v; this.renders++; } });
var document = { createElement: function (t) { return new El(t); } };
var window = { marked: { parse: function (s) { return s; } },
               DOMPurify: { sanitize: function (s) { return s; } } };
""" + _notes_src + r"""
var N = window.WebIDENotes;
var pane = new El("div"), body = pane.appendChild(new El("div"));
var v = N.slideView(body), bar = v.bar;
var prev = bar.children[0], pos = bar.children[1], next = bar.children[2];
var moves = [];
v.onMove(function (i) { moves.push(i); });
var deck = "# One\n\n---\n\n## Two\n\n---\n\n## Three";
var out = {};
(async function () {
  await v.show(deck);
  out.first = [body.innerHTML, pos.textContent, bar.hidden, prev.disabled];
  next.handlers.click(); await null; await null;
  out.next = [body.innerHTML, pos.textContent, moves.slice()];
  await v.show(deck, 2);
  out.snap = [body.innerHTML, moves.slice()];
  var before = body.renders;
  await v.show(deck);
  out.sameAgain = body.renders - before;
  await v.show(deck.replace("## Three", "## Three, edited"));
  out.edited = [body.innerHTML, v.at()];
  await v.show("# Just one page\n\nNo dividers.");
  out.whole = [body.innerHTML, bar.hidden];
  console.log(JSON.stringify(out));
})();
"""
    res = subprocess.run(["node", "-e", harness], capture_output=True, text=True)
    try:
        got = json.loads(res.stdout)
    except ValueError:
        got = {}
    check("notes with --- open on the first slide, with arrows under them",
          got.get("first") == ["# One", "1 / 3", False, True],
          repr(got.get("first") or res.stderr[-300:]))
    check("  ▶ moves on, and says so to whoever is listening",
          got.get("next") == ["## Two", "2 / 3", [1]], repr(got.get("next")))
    check("  being sent to a slide is not reported as the reader moving",
          got.get("snap") == ["## Three", [1]],
          "the live page would take its own snapping for a student wandering off")
    check("  the same notes again do not re-render",
          got.get("sameAgain") == 0,
          "every poll would replace the slide under the student's hand")
    check("  editing a slide keeps the reader on it",
          got.get("edited") == ["## Three, edited", 2], repr(got.get("edited")))
    check("  notes with no --- are shown whole, with no arrows",
          got.get("whole") == ["# Just one page\n\nNo dividers.", True],
          repr(got.get("whole")))
else:
    check("node is available to run the slide viewer", False, "brew install node")

# ---------------------------------------- a lesson's link, made ahead
print("\nA lesson's link, made ahead from the assignment page")
ahead = teacher.post("/api/assignment", json={
    "title": "Tomorrow",
    "files": {'index.html': '<h1>Hi</h1>\n', "notes.md": "# Tomorrow\n"}}).get_json()["slug"]
page = teacher.get("/teacher/" + ahead).get_data(as_text=True)
_ahead = re.search(r'id="live-url" type="text" readonly value="[^"]*/live/([a-z0-9]+)"', page)
check("the assignment page shows a live lesson link under the handout link",
      _ahead is not None
      and page.index("The link to hand out") < page.index("The live lesson link"))
AHEAD = _ahead.group(1) if _ahead else ""
again = re.search(r'/live/([a-z0-9]+)"', teacher.get("/teacher/" + ahead).get_data(as_text=True))
check("  the same link every time the page is opened",
      again is not None and again.group(1) == AHEAD,
      "the link posted in Classroom yesterday would no longer be the lesson")
_r = lesson_row(AHEAD)
check("  made ended and never pushed: not on anyone's screen yet",
      _r is not None and _r.ended == 1 and _r.version == 0
      and _r.assignment_id is not None)
check("  and not the teacher's open lesson, so Go live elsewhere is untouched",
      teacher.post("/api/live/start", json={"resume": AHEAD}).get_json().get("resumed") is False)
poll = stranger.get("/api/live/" + AHEAD).get_json()
check("a student opening it early is told it has not started",
      poll.get("ended") is True and poll.get("waiting") is True, repr(poll)[:120])
# (and that their page keeps checking, slowly: the poll, run for real, below)
host = teacher.get("/live/" + AHEAD).get_data(as_text=True)
check("its teacher, opening it, is offered Start this lesson",
      "Start this lesson" in host and "Ready when you are" in host)
r = teacher.get("/teacher/%s/live" % ahead)
check("Go live on the dashboard opens the editor on that lesson",
      r.status_code == 302 and ("teach=" + AHEAD) in r.headers.get("Location", "")
      and ("a=" + ahead) in r.headers.get("Location", ""),
      r.headers.get("Location", r.status_code))
check("  and the assignments list has a Go live for each assignment",
      ('/teacher/%s/live' % ahead) in teacher.get("/teacher").get_data(as_text=True))
check("  which nobody else can use",
      student.get("/teacher/%s/live" % ahead).status_code == 404
      and other.get("/teacher/%s/live" % ahead).status_code == 404)
r = teacher.post("/api/live/start", json={"reopen": AHEAD, "body": "print(1)",
                                          "filename": "main.py"})
teacher.post("/api/live/%s/push" % AHEAD, json={"body": "print(1)", "seq": 50})
poll = stranger.get("/api/live/" + AHEAD).get_json()
check("starting it puts the same code on the air",
      r.get_json().get("code") == AHEAD and poll.get("ended") is False
      and poll.get("waiting") is False, repr(poll)[:120])
teacher.post("/api/live/%s/stop" % AHEAD)
check("  and once taught, it is not 'not started' any more",
      stranger.get("/api/live/" + AHEAD).get_json().get("waiting") is False)
fresh = teacher.post("/api/live/start", json={"body": "x"}).get_json()["code"]
teacher.post("/api/live/%s/stop" % fresh)
check("a lesson ended before its first push is not 'not started' either",
      stranger.get("/api/live/" + fresh).get_json().get("waiting") is False,
      "its link would say Ready when you are, not Teach this lesson again")

# Posted ahead, then started from the editor's own Go live, not the dashboard.
ahead2 = teacher.post("/api/assignment", json={
    "title": "Thursday", "files": {'index.html': '<h1>Hi</h1>\n'}}).get_json()["slug"]
posted = re.search(r'/live/([a-z0-9]+)"',
                   teacher.get("/teacher/" + ahead2).get_data(as_text=True)).group(1)
got = teacher.post("/api/live/start", json={"body": "print('t')",
                                            "assignment": ahead2}).get_json()
check("Go live in the editor on an assignment uses the link posted ahead",
      got.get("code") == posted,
      "the class would be live under a new code while the posted link said "
      "'not started' all period")
check("  and it is on the air", stranger.get("/api/live/" + posted).get_json().get("ended") is False)
teacher.post("/api/live/%s/stop" % posted)
again = teacher.post("/api/live/start", json={"body": "print('t')",
                                              "assignment": ahead2}).get_json()
# The link is posted once — Classroom, the class page — and must last the
# unit. Going live from the editor a second time used to make a new code, and
# the class sat on the posted link reading "this lesson has ended".
check("  and a link already taught is picked up again too, not replaced",
      again.get("code") == posted, repr(again.get("code")))
check("    back on the air, under the link the class has",
      stranger.get("/api/live/" + posted).get_json().get("ended") is False)
check("    with what the editor has now, not last time's file",
      stranger.get("/api/live/" + posted).get_json().get("body") == "print('t')")
check("    and the assignment page still shows that same link",
      "/live/%s\"" % posted in teacher.get("/teacher/" + ahead2).get_data(as_text=True))
teacher.post("/api/live/%s/stop" % posted)
nothing = teacher.post("/api/live/start", json={"body": "x"}).get_json()
check("  Go live with no assignment still starts fresh",
      nothing.get("code") not in ("", None, posted), repr(nothing.get("code")))
teacher.post("/api/live/%s/stop" % nothing.get("code"))

# ------------------------------- a lesson never changes its assignment
print("\nA lesson's code always belongs to its assignment")
# The bug: Go live on assignment B while A's lesson was still open carried
# on in A's lesson, relabelled B. B's live link then said "taught" and its
# Teach again loaded B's notes with A's code.
asg_a = teacher.post("/api/assignment", json={"title": "A", "files": {"index.html": "<p>A</p>"}}).get_json()["slug"]
asg_b = teacher.post("/api/assignment", json={"title": "B", "files": {"index.html": "<p>A</p>"}}).get_json()["slug"]
la = teacher.post("/api/live/start", json={"body": "print('A')", "assignment": asg_a}).get_json()["code"]
teacher.post("/api/live/%s/push" % la, json={"body": "print('A taught')", "seq": 99})
lb = teacher.post("/api/live/start", json={"body": "print('B')", "assignment": asg_b}).get_json()["code"]
check("Go live on another assignment, with one still open, is a new lesson",
      lb != la, "it carried on in A's lesson and relabelled it B")
row_a = lesson_row(la)
check("  the old one ends, still A's, with A's code",
      row_a.ended == 1 and row_a.body == "print('A taught')"
      and row_a.assignment_id == item_id(asg_a))
check("  and B's live link is B's lesson, not A's",
      re.search(r'/live/([a-z0-9]+)"', teacher.get("/teacher/" + asg_b).get_data(as_text=True)).group(1) == lb)
same = teacher.post("/api/live/start", json={"body": "x", "assignment": asg_b}).get_json()["code"]
check("Go live again on the same assignment still carries on in its lesson", same == lb)
resumed = teacher.post("/api/live/start", json={"resume": lb}).get_json()
check("  and a reload's resume does too", resumed.get("code") == lb)
teacher.post("/api/live/%s/stop" % lb)

# The repair: forget what the lesson last had on screen, keep the link.
RESET = "/api/assignment/%s/live/reset" % asg_a
page = teacher.get("/teacher/" + asg_a).get_data(as_text=True)
check("a taught lesson's page offers Start from the starter next time", 'id="live-reset"' in page)
check("  only its teacher can", student.post(RESET).status_code == 403
      and other.post(RESET).status_code in (403, 404))
r = teacher.post(RESET)
row_a = lesson_row(la)
check("  it forgets the code, and keeps the link",
      r.status_code == 200 and row_a.body == "" and row_a.code == la
      and re.search(r'/live/([a-z0-9]+)"', teacher.get("/teacher/" + asg_a).get_data(as_text=True)).group(1) == la)
check("  so Teach again loads only the starter (nothing to lay over it)",
      stranger.get("/api/live/%s?v=-1" % la).get_json().get("body") == "")
teacher.post("/api/live/start", json={"reopen": la, "body": "x"})
check("  and is refused while the lesson is live", teacher.post(RESET).status_code == 409)
teacher.post("/api/live/%s/stop" % la)
check("a lesson made ahead and never taught does not offer it",
      'id="live-reset"' not in teacher.get("/teacher/" + teacher.post(
          "/api/assignment", json={"title": "C", "files": {"index.html": "<p>A</p>"}}).get_json()["slug"]).get_data(as_text=True))

# ------------------------------------------ whose typing a browser keeps
# One Chrome profile shared by two students in a lab: the second used to
# open the lesson to the first one's typing, and a Save made it theirs.
# live.js's choice of key, lifted and run against a stand-in localStorage.
_km = re.search(r'(  var ANON_KEY = .*?\n  \}\n)', _live_now_js, re.S)
if shutil.which("node") and _km:
    harness = """
var cases = %s, out = {};
Object.keys(cases).forEach(function (k) {
  var c = cases[k], store = Object.assign({}, c.store);
  var window = {localStorage: {
    getItem: function (n) { return n in store ? store[n] : null; },
    setItem: function (n, v) { store[n] = String(v); },
    removeItem: function (n) { delete store[n]; }}};
  var L = c.L;
  %s
  out[k] = {key: DRAFT_KEY, store: store};
});
console.log(JSON.stringify(out));
""" % (json.dumps({
        "signed_out": {"L": {"code": "abc", "me": None},
                       "store": {"webide-live-abc": "typed signed out"}},
        "signs_in": {"L": {"code": "abc", "me": 7},
                     "store": {"webide-live-abc": "typed signed out",
                               "webide-live-abc-files": "{}", "webide-live-abc-base": "3",
                               "webide-live-abc-slug": "someones"}},
        "next_student": {"L": {"code": "abc", "me": 8},
                         "store": {"webide-live-abc-u7": "student 7's work",
                                   "webide-live-abc-u7-slug": "d7"}},
        "has_own": {"L": {"code": "abc", "me": 7},
                    "store": {"webide-live-abc-u7": "mine", "webide-live-abc": "a stranger's"}},
    }), _km.group(1))
    res = subprocess.run(["node", "-e", harness], capture_output=True, text=True)
    got = json.loads(res.stdout or "{}") if res.returncode == 0 else {}
    o = got.get("signed_out", {})
    check("signed out: typing kept under the lesson's code, as before",
          o.get("key") == "webide-live-abc"
          and o.get("store") == {"webide-live-abc": "typed signed out"}, o or res.stderr[-300:])
    i = got.get("signs_in", {})
    check("signed in: under their own account",
          i.get("key") == "webide-live-abc-u7", i)
    check("  taking over what was typed before signing in",
          (i.get("store") or {}).get("webide-live-abc-u7") == "typed signed out"
          and (i.get("store") or {}).get("webide-live-abc-u7-base") == "3"
          and "webide-live-abc" not in (i.get("store") or {}), i)
    check("  but never a draft somebody else saved",
          "webide-live-abc-u7-slug" not in (i.get("store") or {}), i)
    n = got.get("next_student", {})
    check("the next student in the same browser starts clean",
          n.get("key") == "webide-live-abc-u8"
          and "webide-live-abc-u8" not in (n.get("store") or {})
          and (n.get("store") or {}).get("webide-live-abc-u7") == "student 7's work", n)
    h = got.get("has_own", {})
    check("their own kept typing wins over anything signed out",
          (h.get("store") or {}).get("webide-live-abc-u7") == "mine", h)
else:
    check("node is available to run the live page's storage key", bool(_km),
          "brew install node" if _km else "the block in live.js moved")
_lv = W.app.test_client()
with _lv.session_transaction() as _s:
    _s["uid"] = STUDENT
_html = _lv.get("/live/" + LESSON).get_data(as_text=True)
check("the page tells live.js who is signed in, by id",
      ("me: %d," % STUDENT) in _html
      and "me: null," in stranger.get("/live/" + LESSON).get_data(as_text=True))

# ------------------------------------------ an ended lesson keeps checking
# live.js's start-up mirror and its poll, lifted and run in node against
# scripted answers. What the class sees, what the chip says, and how soon it
# asks again — the three things that left a class on yesterday's code.
_pm = re.search(r'(  var everLive = !L\.ended;.*?\n  poll\(\);\n)', _live_now_js, re.S)
if shutil.which("node") and _pm:
    harness = """
var scripts = %s, out = {};
function settle() { return new Promise(function (r) { setImmediate(r); }); }
async function run(name) {
  var c = scripts[name], answers = c.answers.slice(), log = [];
  var shownPageId = "";
  var L = c.L, seen = -1, shown = [], state = "", next = null, moved = null;
  var stateChip = {get textContent() { return state; }};
  function setState(t) { state = t; }
  function showMirror(d) { shown.push(d.body); seen = d.version; }
  var location = {replace: function (u) { moved = u; }};
  function setTimeout(fn, ms) { next = {fn: fn, ms: ms}; }
  function fetch() {
    var a = answers.shift();
    if (a === 304) return Promise.resolve({status: 304, ok: false});
    return Promise.resolve({status: 200, ok: true,
                            json: function () { return Promise.resolve(a); }});
  }
  %s
  for (;;) {
    for (var i = 0; i < 6; i++) await settle();
    log.push({shown: shown.slice(), state: state, next: next ? next.ms : null,
              moved: moved});
    if (!next || !answers.length) break;
    var n = next; next = null; n.fn();
  }
  out[name] = log;
}
(async function () {
  for (var k of Object.keys(scripts)) await run(k);
  console.log(JSON.stringify(out));
})();
""" % (json.dumps({
        # Opened before the teacher went live: yesterday's row, ended.
        "early": {"L": {"ended": True, "body": "yesterday", "version": 5},
                  "answers": [{"ended": True, "waiting": False, "body": "yesterday", "version": 5},
                              {"ended": False, "body": "today", "version": 9}]},
        # Watched it live, then the teacher ended it, then taught it again.
        "watched": {"L": {"ended": False, "body": "live", "version": 5},
                    "answers": [{"ended": True, "body": "final", "version": 6},
                                {"ended": False, "body": "again", "version": 7}]},
        "made_ahead": {"L": {"ended": True, "waiting": True, "body": "", "version": 0},
                       "answers": [{"ended": True, "waiting": True, "body": "", "version": 0}]},
        "older_link": {"L": {"ended": True, "body": "old", "version": 5},
                       "answers": [{"moved": "NEW1", "ended": True}]},
    }), _pm.group(1))
    res = subprocess.run(["node", "-e", harness], capture_output=True, text=True)
    got = json.loads(res.stdout or "{}") if res.returncode == 0 else {}
    e = got.get("early", [{}, {}])
    check("opened before the teacher goes live: no leftover code on screen",
          e[0].get("shown") == [] and e[0].get("state") == "Not started yet",
          e or res.stderr[-300:])
    check("  and it keeps checking every few seconds",
          e[0].get("next") == 5000, e)
    check("  so the class gets today's code when the teacher goes live",
          len(e) > 1 and e[1].get("shown") == ["today"] and e[1].get("state") == "Live"
          and e[1].get("next") == 1000, e)
    w = got.get("watched", [{}, {}])
    check("watched it end: the last code stays on screen",
          w[0].get("shown") == ["live", "final"] and w[0].get("state") == "Lesson ended", w)
    check("  and it keeps checking, so teaching it again brings the class along",
          w[0].get("next") == 5000 and len(w) > 1
          and w[1].get("shown")[-1:] == ["again"] and w[1].get("state") == "Live", w)
    m = got.get("made_ahead", [{}])
    check("made ahead and never taught: told it has not started, checked slowly",
          m[0].get("state") == "Not started yet" and m[0].get("next") == 15000, m)
    o = got.get("older_link", [{}])
    check("an older link for the assignment goes on to its lesson, and stops asking",
          o[0].get("moved") == "/live/NEW1" and o[0].get("next") is None, o)
    # The slides page (lesson.js) polls the same way. Its poll drives the
    # slide viewer, so it is read rather than run: it must follow a moved
    # link, and keep asking after an ended lesson.
    _lj = open(os.path.join(WEBIDE, "static", "lesson.js")).read()
    check("the slides page follows an older link on, too",
          re.search(r'if \(data\.moved\) \{\s*moving = true;\s*location\.replace\("/live/"',
                    _lj) is not None)
    check("  and keeps checking after the lesson ends",
          re.search(r'if \(data\.ended\) \{[^}]*pace = ENDED_MS;[^}]*return;', _lj) is not None
          and 'throw new Error("ended")' not in _lj
          and "setTimeout(poll, pace);" in _lj)
else:
    check("node is available to run the live page's poll", bool(_pm),
          "brew install node" if _pm else "the block in live.js moved")


# ------------------------------------- one assignment, one lesson, every link
# Before Go live reused a taught lesson, teaching one again made a new code,
# so an assignment can have older lesson rows whose links are still out —
# posted in Classroom for one section. A class on one of those sat looking
# at another section's code from yesterday while the teacher taught in the
# new one. Every link for the assignment now leads to its newest lesson.
print("\nOlder links for an assignment lead to its lesson")
from urllib.parse import parse_qs, urlparse                   # noqa: E402
db = W.SessionLocal()
try:
    db.query(accounts.LiveSession).filter_by(host_id=TEACHER).update({"ended": 1})
    db.commit()
finally:
    db.close()
asg_old = teacher.post("/api/assignment", json={"title": "Lists", "files": {"index.html": "starter\n"}}).get_json()["slug"]
_go = teacher.get("/teacher/%s/live" % asg_old).headers.get("Location", "")
OLD = parse_qs(urlparse(_go).query).get("teach", [""])[0]
teacher.post("/api/live/start", json={"reopen": OLD, "body": "yesterday's code"})
teacher.post("/api/live/%s/stop" % OLD)
db = W.SessionLocal()
try:
    _o = db.query(accounts.LiveSession).filter_by(code=OLD).first()
    _new = accounts.LiveSession(
        code="newer1", app=W.APP_NAME, host_id=TEACHER, host_name="T", title="Lists",
        body="the other section's code", filename="main.py", version=50, ended=1,
        assignment_id=_o.assignment_id,
        started_at=_o.started_at + W.timedelta(hours=1))
    db.add(_new)
    db.commit()
finally:
    db.close()
r = stranger.get("/live/" + OLD)
check("an older link for the assignment opens its newest lesson",
      r.status_code == 302 and r.headers.get("Location", "").endswith("/live/newer1"),
      (r.status_code, r.headers.get("Location")))
check("  for its teacher too, so Teach again teaches where the class is",
      teacher.get("/live/" + OLD).headers.get("Location", "").endswith("/live/newer1"))
check("  the newest one opens as itself",
      stranger.get("/live/newer1").status_code == 200)
d = stranger.get("/api/live/%s?v=-1" % OLD).get_json()
check("a page already open on the older link is told where it moved",
      d.get("moved") == "newer1" and "body" not in d, d)
check("  and the newest is told nothing of the kind",
      "moved" not in stranger.get("/api/live/newer1?v=-1").get_json())
check("the assignment page's own link is the newest",
      "/live/newer1" in teacher.get("/teacher/" + asg_old).get_data(as_text=True))

# Teach again from the older link, as an old bookmark would.
r = teacher.post("/api/live/start", json={"reopen": OLD, "body": "today's code"}).get_json()
check("reopening the older one goes live in the newest instead",
      r.get("code") == "newer1" and lesson_row("newer1").ended == 0
      and lesson_row("newer1").body == "today's code" and lesson_row(OLD).ended == 1, r)
teacher.post("/api/live/newer1/stop")

# An older row left open (yesterday, never ended), then Go live on the
# assignment: the class is on the newest, so that is where it goes.
set_row(OLD, ended=0)
r = teacher.post("/api/live/start", json={"assignment": asg_old, "body": "starter\n"}).get_json()
check("Go live with an older lesson still open moves to the newest",
      r.get("code") == "newer1" and lesson_row(OLD).ended == 1
      and lesson_row("newer1").ended == 0 and lesson_row("newer1").body == "starter\n", r)
check("  leaving one open lesson, not two", open_lessons(TEACHER) == 1)
check("a resume of an ended lesson still gets nothing",
      teacher.post("/api/live/start", json={"resume": OLD}).get_json().get("resumed") is False)
teacher.post("/api/live/newer1/stop")
# The editor reloaded while an older row was the one open: carrying on there
# would be teaching where every link sends the class away from.
set_row(OLD, ended=0)
r = teacher.post("/api/live/start", json={"resume": OLD, "body": "mid-lesson"}).get_json()
check("a resume of an older open lesson carries on in the newest",
      r.get("code") == "newer1" and lesson_row(OLD).ended == 1
      and lesson_row("newer1").body == "mid-lesson", r)
teacher.post("/api/live/newer1/stop")

_plain = teacher.post("/api/live/start", json={"assignment": "", "body": "x"}).get_json()["code"]
teacher.post("/api/live/%s/stop" % _plain)
check("a lesson with no assignment opens as itself",
      stranger.get("/live/" + _plain).status_code == 200
      and "moved" not in stranger.get("/api/live/%s?v=-1" % _plain).get_json())

bad = results.count(False)
print("\n%s (%d checks, %d failed)"
      % ("SOME FAILED" if bad else "ALL PASSED", len(results), bad))
sys.exit(1 if bad else 0)
