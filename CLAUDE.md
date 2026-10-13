# WebIDE

A browser-based HTML/CSS/JavaScript editor for intro classes, built from
PyIDE. A project is a set of files with `index.html` as its entry, and
running it means assembling those files into one document and putting it in
a sandboxed iframe. There is no Python and no Pyodide here.

## Running it

```
pip install -r requirements.txt
python3 app.py                 # http://localhost:5001
```

Sign-in is optional exactly as in PyIDE: without `GOOGLE_CLIENT_ID` and
`GOOGLE_CLIENT_SECRET` the editor works anonymously, and signing in only ever
adds abilities. `TEACHER_EMAILS` decides who gets the dashboard.

## Tests

```
for t in tools/test_*.py; do
  printf "%-26s " "$(basename "$t")"
  python3 "$t" >/tmp/out.$$ 2>&1 && tail -1 /tmp/out.$$ \
    || { echo "FAILED"; tail -20 /tmp/out.$$; }
done
```

Each suite prints `ok`/`FAIL` per check and exits non-zero on failure. The
loop above keeps the last line of a passing run and shows the tail of a
failing one, so a red suite cannot scroll past unnoticed — a bare
`for ... do python3 "$t"; done` will let it.

**`node` is required** by `test_quiz.py`, `test_rescue.py` and
`test_tabstops.py`: they load this repo's own JavaScript and drive it, rather
than grepping it — which is the only way those get checked at all.
`brew install node` if it is missing.

`test_rescue.py` loads `static/rescue.js` into a stubbed browser and
drives its branches for real, because grepping for branch names passes
happily on code where none of them can be reached.

**Every check must have been watched to fail.** Break the thing it guards,
confirm it fails, restore. Checks that were written and never falsified have
turned out to be dead more than once in this codebase.

## Things that are invisible from the code

**`accounts.py` is byte-identical across PyIDE, WebIDE and FlaskIDE.** Change
it in one and copy it to the other two. The account tables are shared, which
is why rows carry an `app` column; this app owns `projects`, PyIDE owns
`snippets`, FlaskIDE owns `flask_projects`.

**It shares PyIDE's Postgres** rather than provisioning a second one. See the
comment at the top of `render.yaml`.

**`gunicorn --workers 2`** — two processes, no shared memory. Per-session
state in a module-level dict is visible to one worker and invisible to the
other. That is why live sessions are a table and the class polls it.

**A project lives in `files`, and `code` is always `""`.** Anything that
writes a draft has to respect that; PyIDE is the other way round and code
ported from there will silently save nothing.

**Turning in replaces a draft's files with what is posted.** A pane that
edits one file must therefore save first and submit the *whole* project —
otherwise handing work in deletes every other file in it, at the worst
possible moment and without a word. `live.js`'s `turnIn` does this; there is
a check on it.

## Features worth knowing about

**Teaching live** (`/live`, `static/live.js`). Same shape as PyIDE: the
teacher's file mirrored above, the student's own editor below, and this app's
sandboxed preview on the right instead of a console. It builds the page
through `WebIDERun.assemble`, the same function the editor uses, so the two
previews cannot drift apart.

Stop replaces the iframe element rather than asking the page to stop, which
is what makes it work while a student's `while (true)` has that frame's
process wedged. A wedged frame cannot navigate itself away.

The student's editor is never written to from the network, and the teacher's
pane is `user-select: none` with copy and cut refused. There is deliberately
no button that copies the teacher's code down.

**A lesson for an assignment starts the student's editor** where
`/a/<slug>` would: their own draft of it if they have one, else the
assignment's copy of the file the live Save writes back to. It is rendered
into the page (`starter`), never sent on the poll, and anything already
typed in that browser for the lesson wins. The draft matters more than it
looks — the live Save overwrites that file in the draft, so starting from
the bare starter would erase earlier work on the first Save.

**The project's notes** (its first `.md` file) go out with every live push
whichever file is open, and show in a pane under the console on the
student's page. A push that sends no `notes` key leaves them alone, so an
old editor tab cannot wipe them.

**Slides, and links made ahead.** Notes with `---` are always shown as
slides (`notes.js`, `slideView`), in the editor and on the class's page. A
live push sends the whole notes file and the teacher's slide (`"3/5"`);
each student moves through the slides freely and is jumped to the teacher's
slide only when the teacher *moves* — typing on the same slide must not drag
back a student who has read ahead. The assignment page makes the lesson's
link ahead of time (`_lesson_for`) so it can be posted in Classroom the day
before: an ended lesson with `version` 0 is "not started yet" (`_waiting`),
which is why a lesson started normally begins at `version` 1.

**Lessons** (`kind = "lesson"` on an assignment; `lesson.html`, `lesson.js`,
`lesson_teacher.html`, `lesson_teacher.js`; "Lessons" in `app.py`). Notes
with questions and no code, for non-programming classes, made with Create
lesson on the dashboard. The notes are `lesson.md` in the assignment's
`files`, so answer keys, marking, Classroom and the live link work unchanged.
Students get the slides full screen: at their own pace from the assignment
link, following the teacher's slide from the live link — the only
difference. No draft; Turn in makes a Submission with an empty
`snippet_slug`, and the results page lists answers where code would have an
Open link. Anything that builds a `view_shared` link from a submission must
allow for that empty slug.

**Questions in the notes** (`quiz.py`, identical in all three apps;
`notes.js`'s `parseQuiz`/`buildQuiz`; `/api/quiz/*`). A ```` ```quiz ````
block in an assignment's notes is a question: `- [x]` choices, or `answer:`
lines for short answer, `points:` (default 1). One try, marked at once; the
points are added to the teacher's score and Sync sends the total. **The notes
go to students whole, so the key is taken out at every exit** —
`quiz.redact_files` wherever an assignment's files reach a student,
`quiz.redact` on every live push — and kept in `quiz_questions`. A new route
that hands out an assignment's files must redact too, and needs a line in
`test_quiz.py`'s leak section: a missed exit leaks the answers with no
visible sign.

**The rescue** (`static/rescue.js`, identical in all three apps). Work typed
while signed out is kept in the browser and restored after signing in —
silently when the saved draft is still the untouched starter, with a prompt
when it is not.

## Style

Comments explain *why*, and especially name the failures that are silent.
This editor's whole job is to make a beginner's mistake visible; the code
should hold itself to the same standard.
