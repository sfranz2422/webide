"""
WebIDE — a browser-based HTML/CSS/JS editor for a web design class.

Student pages run in a sandboxed iframe with `allow-scripts` and no
`allow-same-origin`, which gives their code a null origin: their JavaScript
executes normally, so they can learn it properly, but it cannot read this
page's cookies, storage or DOM. The server only stores and serves shared
project snapshots.
"""

import json
import os
import re
import secrets
from datetime import datetime, timezone

from flask import (
    Flask,
    abort,
    jsonify,
    render_template,
    request,
    url_for,
)
from sqlalchemy import Column, DateTime, Integer, String, Text, create_engine
from sqlalchemy.orm import declarative_base, sessionmaker

# --------------------------------------------------------------------------
# Config
# --------------------------------------------------------------------------

MAX_FILES = 16
MAX_FILE_BYTES = 200_000          # per file
MAX_FILES_TOTAL = 600_000         # all files together
ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"  # no look-alike characters
ID_LENGTH = 7

# The page the browser opens. Everything else is linked from it.
ENTRY = "index.html"

# Files the app itself provides to a game project. They are not part of the
# student's project and are never editable, but they do get bundled into a
# download so an unzipped game runs offline.
GAME_LIB = "kaplay.js"
GAME_ROOT = "static/game"

FILE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 _-]{0,50}\.[A-Za-z0-9]{1,8}$")

# Every project starts as these three, already wired together, so nobody
# spends week one wondering why their stylesheet isn't loading.
STARTER = {
    "index.html": """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>My Page</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>

  <h1>Hello!</h1>
  <p>Edit this page, then press Run.</p>
  <button id="cheer">Click me</button>

  <script src="script.js"></script>
</body>
</html>
""",
    "style.css": """body {
  font-family: system-ui, sans-serif;
  margin: 40px;
  background: #f4f6fa;
  color: #1b2130;
}

h1 {
  color: #1d4ed8;
}

button {
  font-size: 16px;
  padding: 10px 18px;
  border: 0;
  border-radius: 8px;
  background: #1d4ed8;
  color: white;
  cursor: pointer;
}
""",
    "script.js": """const button = document.getElementById("cheer");

button.addEventListener("click", function () {
  console.log("The button was clicked!");
  button.textContent = "You clicked me!";
});
""",
}


GAME_STARTER = {
    "index.html": """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>My Game</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>

  <!-- kaplay.js is the game library. Leave this line alone. -->
  <script src="kaplay.js"></script>
  <script src="script.js"></script>
</body>
</html>
""",
    "style.css": """body {
  margin: 0;
  background: #1b2130;
}

canvas {
  display: block;
}
""",
    "script.js": """// Start the game engine
kaplay({
  width: 640,
  height: 360,
  background: [120, 190, 230],
});

// Load a picture to use. There are lots more in sprites/
loadSprite("bean", "sprites/bean.png");

// Put the bean on the screen
const player = add([
  sprite("bean"),
  pos(320, 180),
  anchor("center"),
  area(),
]);

// Arrow keys move it around
const SPEED = 240;

onKeyDown("left",  () => player.move(-SPEED, 0));
onKeyDown("right", () => player.move(SPEED, 0));
onKeyDown("up",    () => player.move(0, -SPEED));
onKeyDown("down",  () => player.move(0, SPEED));

// Click it to say hello
player.onClick(() => {
  debug.log("You clicked the bean!");
});
""",
}


def _database_url() -> str:
    """Render supplies DATABASE_URL; fall back to a local SQLite file."""
    url = os.environ.get("DATABASE_URL", "")
    if not url:
        return "sqlite:///" + os.path.join(os.path.dirname(__file__), "webide.db")
    # SQLAlchemy 2.x wants the postgresql:// scheme, Render hands out postgres://
    if url.startswith("postgres://"):
        url = url.replace("postgres://", "postgresql://", 1)
    return url


# --------------------------------------------------------------------------
# Database
# --------------------------------------------------------------------------

Base = declarative_base()


class Project(Base):
    __tablename__ = "projects"

    id = Column(Integer, primary_key=True)
    slug = Column(String(16), unique=True, index=True, nullable=False)
    title = Column(String(120), nullable=False, default="Untitled")
    author = Column(String(80), nullable=False, default="")
    # every file in the project, as a JSON object of {filename: contents}
    files = Column(Text, nullable=False, default="{}")
    created_at = Column(DateTime, nullable=False,
                        default=lambda: datetime.now(timezone.utc))

    def file_map(self) -> dict:
        try:
            data = json.loads(self.files or "{}")
            return data if isinstance(data, dict) else {}
        except (ValueError, TypeError):
            return {}


engine = create_engine(
    _database_url(),
    pool_pre_ping=True,
    connect_args={"check_same_thread": False}
    if _database_url().startswith("sqlite")
    else {},
)
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)
Base.metadata.create_all(engine)


def new_slug(db) -> str:
    """Random short id, retried on the (very unlikely) collision."""
    for _ in range(12):
        slug = "".join(secrets.choice(ID_ALPHABET) for _ in range(ID_LENGTH))
        if not db.query(Project.id).filter_by(slug=slug).first():
            return slug
    raise RuntimeError("could not allocate a share id")


def clean(value, limit) -> str:
    value = re.sub(r"\s+", " ", str(value or "")).strip()
    return value[:limit]


def validate_files(raw):
    """Check an incoming {name: contents} map. Returns (files, error)."""
    if not isinstance(raw, dict) or not raw:
        return None, "There's nothing to share yet."
    if len(raw) > MAX_FILES:
        return None, "A project can hold at most %d files." % MAX_FILES

    files, total = {}, 0
    for name, body in raw.items():
        name = str(name).strip()
        # no directories, no traversal — these are plain names in one folder
        if "/" in name or "\\" in name or name in (".", ".."):
            return None, "'%s' is not a valid file name." % name
        if not FILE_NAME.match(name):
            return None, ("'%s' is not a valid file name. Use letters, digits, "
                          "dashes and underscores, and end with an extension "
                          "like .html, .css or .js." % name)
        if not isinstance(body, str):
            return None, "'%s' could not be read as text." % name
        size = len(body.encode("utf-8"))
        if size > MAX_FILE_BYTES:
            return None, "'%s' is too large to save." % name
        total += size
        if total > MAX_FILES_TOTAL:
            return None, "Those files are too large to save together."
        files[name] = body

    if ENTRY not in files:
        return None, "A project needs an %s to open." % ENTRY
    return files, None


# --------------------------------------------------------------------------
# App
# --------------------------------------------------------------------------

app = Flask(__name__)


def sprite_manifest():
    """Names and sizes of the bundled sprites, or [] if none are vendored."""
    try:
        with open(os.path.join(os.path.dirname(__file__),
                               "static", "game", "manifest.json")) as fh:
            return json.load(fh).get("sprites", [])
    except Exception:
        return []


def game_installed() -> bool:
    return os.path.exists(os.path.join(os.path.dirname(__file__),
                                       "static", "game", GAME_LIB))


@app.context_processor
def game_context():
    """Available to every template, so no render site can forget it."""
    return {"sprites": sprite_manifest(), "game_installed": game_installed()}


@app.after_request
def allow_game_assets(response):
    """Let the sandboxed preview use the bundled sprites.

    The preview runs on a null origin, so every sprite request is
    cross-origin. Kaplay loads images with crossOrigin="anonymous" (it has to,
    or WebGL refuses to make a texture out of them), and that only works if the
    server says so. Without this header a game runs but draws nothing.
    """
    if request.path.startswith("/static/game/"):
        response.headers["Access-Control-Allow-Origin"] = "*"
    return response


@app.get("/game")
def new_game():
    """A fresh game project, with the library already wired in."""
    return render_template(
        "index.html",
        files=GAME_STARTER,
        title="Untitled Game",
        author="",
        readonly=False,
        authoring=True,
        slug=None,
        shared_at=None,
    )


@app.get("/")
def index():
    return render_template(
        "index.html",
        files=STARTER,
        title="Untitled",
        author="",
        readonly=False,
        # only here can notes be written; shared snapshots and forks show them
        # rendered and never expose the markdown source
        authoring=True,
        slug=None,
        shared_at=None,
    )


@app.get("/s/<slug>")
def view_shared(slug):
    db = SessionLocal()
    try:
        proj = db.query(Project).filter_by(slug=slug).first()
        if proj is None:
            abort(404)
        return render_template(
            "index.html",
            files=proj.file_map(),
            title=proj.title,
            author=proj.author,
            readonly=True,
            authoring=False,
            slug=proj.slug,
            shared_at=proj.created_at.strftime("%b %d, %Y at %I:%M %p UTC"),
        )
    finally:
        db.close()


@app.get("/s/<slug>/fork")
def fork_shared(slug):
    """Open a shared snapshot as an editable copy."""
    db = SessionLocal()
    try:
        proj = db.query(Project).filter_by(slug=slug).first()
        if proj is None:
            abort(404)
        return render_template(
            "index.html",
            files=proj.file_map(),
            title=f"Copy of {proj.title}",
            author="",
            readonly=False,
            authoring=False,
            slug=None,
            shared_at=None,
        )
    finally:
        db.close()


@app.get("/s/<slug>/raw")
@app.get("/s/<slug>/raw/<path:name>")
def raw_shared(slug, name=None):
    """Plain text of one file, for diffing or feeding to a checker."""
    db = SessionLocal()
    try:
        proj = db.query(Project).filter_by(slug=slug).first()
        if proj is None:
            abort(404)
        files = proj.file_map()
        wanted = name or ENTRY
        if wanted not in files:
            abort(404)
        return files[wanted], 200, {"Content-Type": "text/plain; charset=utf-8"}
    finally:
        db.close()


@app.post("/api/share")
def create_share():
    data = request.get_json(silent=True) or {}
    author = clean(data.get("author"), 80)

    # a submission nobody can be identified from is no use to a teacher
    if not author:
        return jsonify(error="Put your name in before sharing.",
                       field="author"), 400

    files, file_error = validate_files(data.get("files"))
    if file_error:
        return jsonify(error=file_error), 400

    db = SessionLocal()
    try:
        proj = Project(
            slug=new_slug(db),
            title=clean(data.get("title"), 120) or "Untitled",
            author=author,
            files=json.dumps(files),
        )
        db.add(proj)
        db.commit()
        return jsonify(
            slug=proj.slug,
            url=url_for("view_shared", slug=proj.slug, _external=True),
        )
    finally:
        db.close()


@app.errorhandler(404)
def not_found(_):
    return render_template("404.html"), 404


@app.get("/healthz")
def healthz():
    return "ok"


if __name__ == "__main__":
    app.run(debug=True, port=5001)
