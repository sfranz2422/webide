/* The live lesson page.
 *
 * Two editors, stacked. The upper one mirrors whatever the teacher is typing
 * in their own PyIDE tab; the lower one is the student's, and they type the
 * lesson out themselves.
 *
 * THE ONE RULE THIS FILE EXISTS TO KEEP
 *
 *   Nothing that arrives from the network is ever written into the student's
 *   editor. Not on a poll, not on a reconnect, not when the lesson ends.
 *   `mirror` is the only CodeMirror this file ever calls setValue on, and
 *   `mine` is the only one the student types in. A class losing their own
 *   work because the teacher pressed a key is the failure that would stop
 *   anyone using this a second time, so it is arranged to be impossible
 *   rather than carefully avoided.
 *
 *   There is deliberately no button that copies the teacher's code down.
 *   Typing it is the exercise.
 *
 * WHY POLLING AND NOT A WEBSOCKET
 *
 *   WebIDE runs on `gunicorn --workers 2`. A socket lives inside one worker,
 *   so broadcasting across both would need a message broker — another Render
 *   service, another bill. A row in the Postgres that is already there costs
 *   nothing new, and the poll below asks "has the version changed?" and is
 *   answered 304 almost every time.
 */
(function () {
  "use strict";

  var L = window.WEBIDE_LIVE || {};

  // The two editors, once there are any. Declared here so the theme switch
  // below can repaint them; on the join card and the host's page they stay
  // undefined and the switch only changes the page around them.
  var mirror, mine;
  themeSwitch();

  if (!L.joined || L.isHost) {
    hostControls();
    return;
  }

  var $ = function (id) { return document.getElementById(id); };

  var outputEl = $("output");
  var runBtn = $("run");
  var runLabel = $("run-label");
  var stopBtn = $("stop");
  var stateChip = $("live-state");
  var savedNote = $("mine-saved");

  var DRAFT_KEY = "webide-live-" + L.code;

  /* Questions in the teacher's notes answer into the lesson's assignment.
     A lesson with none has nowhere to record them, and notes.js says so on
     each question instead of taking an answer it would lose. */
  window.WebIDENotes.setQuizContext({ assignment: L.assignment,
                                     signedIn: L.signedIn });

  // ------------------------------------------------------------ the editors

  function isDark() {
    var set = document.documentElement.getAttribute("data-theme");
    if (set === "dark") return true;
    if (set === "light") return false;
    return window.matchMedia
      && window.matchMedia("(prefers-color-scheme: dark)").matches;
  }

  function cmTheme() { return isDark() ? "material-darker" : "default"; }

  /* Read-only, and `readOnly: "nocursor"` rather than plain true: with a
     cursor the mirror can be focused and looks typeable, and a student who
     clicks in and starts typing finds nothing happens and assumes the page
     is broken. */
  mirror = CodeMirror.fromTextArea($("mirror"), {
    mode: "htmlmixed",
    theme: cmTheme(),
    lineNumbers: true,
    readOnly: "nocursor",
    lineWrapping: false
  });

  /* And if a selection is made anyway, it cannot be taken.
   *
   * The stylesheet stops the ordinary drag. This is the second half, because
   * user-select is a rendering hint and not a rule: a browser extension, a
   * "select all" from the browser's own menu, or find-on-page can still leave
   * text selected inside the mirror, and then Ctrl+C would lift the lesson.
   * Cancelling the event is what actually refuses.
   *
   * Only over the mirror. The student's own editor is theirs to copy from,
   * and this listener is attached to the mirror's element, not the document,
   * so there is no way for it to reach the wrong one. */
  var mirrorEl = mirror.getWrapperElement();
  ["copy", "cut"].forEach(function (kind) {
    mirrorEl.addEventListener(kind, function (e) {
      e.preventDefault();
      note("Type it out — that is the exercise");
    });
  });

  /* The same settings and keys as the main editor. This editor was once
     configured on its own and went without tab stops, tag closing and name
     completion, and indented by four where the editor indents by two — so
     a page typed here and opened in the editor came out with two different
     nestings. Nothing broke; it just behaved worse than the editor students
     already knew, in the one lesson where the whole class is copying
     nesting off the board. */
  mine = CodeMirror.fromTextArea($("mine"), {
    mode: "htmlmixed",
    theme: cmTheme(),
    lineNumbers: true,
    indentUnit: 2,
    tabSize: 2,
    indentWithTabs: false,
    matchBrackets: true,
    autoCloseBrackets: true,
    // see app.js: close every tag on the line it was opened on
    autoCloseTags: { indentTags: [] },
    extraKeys: {
      Tab: window.WebIDETabStops.indentToTabStop,
      Backspace: window.WebIDETabStops.backspaceToTabStop,
      "Shift-Tab": function (cm) { cm.indentSelection("subtract"); },
      "Ctrl-/": function (cm) { cm.toggleComment({ indent: true }); },
      "Cmd-/": function (cm) { cm.toggleComment({ indent: true }); },
      "Ctrl-Enter": function () { run(); },
      "Cmd-Enter": function () { run(); }
    }
  });

  /* Completion of the student's own names, exactly as in the editor: the
     file being typed in, completed from every file of their project — a
     class used in their index.html is offered in their style.css. Names
     come from what the student typed, never from the teacher's pane —
     suggesting the lesson's names would be the copy button by another
     route. */
  var hintTimer = null;
  mine.on("change", function (cm, change) {
    var typed = change.origin === "+input" && change.text.join("");
    if (typed && /^[A-Za-z0-9_-]$/.test(typed)) {
      clearTimeout(hintTimer);
      hintTimer = setTimeout(function () {
        if (cm.state.completionActive) return;
        window.WebIDEComplete.show(cm, active, allFiles());
      }, 140);
    }
  });

  /* The student's own work, in their browser only. There is no account
     needed to follow a lesson, so there is nowhere on the server this could
     go — and a refresh in the middle of a lesson must not cost them the
     twenty lines they have typed. Every read and write is wrapped, because
     localStorage throws outright in a private window and on a locked-down
     school laptop. */
  /* Nothing kept here, and the lesson is for an assignment: start from what
     the handout link would have opened — their own draft of it, or its
     starter (the server decides which; see live_page). What they typed in
     this browser always wins over both, so a reload never puts the starter
     back over twenty minutes of typing. `null` rather than falsy: an editor
     they emptied on purpose stays empty. */
  var kept = null;
  var keptBase = null;
  var BASE_KEY = DRAFT_KEY + "-base";
  try {
    kept = window.localStorage.getItem(DRAFT_KEY);
    keptBase = window.localStorage.getItem(BASE_KEY);
  } catch (e) { /* storage blocked: fall back to the starting point */ }

  /* UNLESS THEIR DRAFT HAS MOVED ON WITHOUT THIS BROWSER. The copy kept
     here remembers which version of their draft it grew from. If the draft
     has been saved since — homework at home last night, through the
     handout link — this browser's copy is the older work, and letting it
     win would put last night's work under it on screen and then, at the
     first Save, over it on the server. A reopened lesson is exactly when
     that happens: the same code, so the same key, a day later.

     A copy with no version beside it (kept before this existed, or never
     saved) still wins, as it always did. */
  var behind = kept !== null && keptBase !== null
    && typeof L.draftVersion === "number"
    && L.draftVersion > Number(keptBase);
  if (behind) {
    kept = null;
    try {
      window.localStorage.removeItem(DRAFT_KEY);
      window.localStorage.removeItem(DRAFT_KEY + "-files");
    } catch (e) { /* nothing kept to remove */ }
  }

  function noteBase(version) {
    try { window.localStorage.setItem(BASE_KEY, String(version)); }
    catch (e) { /* then the copy here simply wins, as before */ }
  }
  if (typeof L.draftVersion === "number" && (keptBase === null || behind)) {
    noteBase(L.draftVersion);
  }
  var start = kept !== null ? kept : (L.starter || "");
  if (start) mine.setValue(start);
  mine.clearHistory();

  /* ------------------------------------------------------------ their files
   *
   * index.html and the rest of their project, each its own CodeMirror
   * document swapped into `mine`, exactly as the editor keeps them — so
   * switching tabs keeps the caret and the undo history, and there is still
   * only the one editor a student types in. The mirror never fills any of
   * these.
   *
   * The other files are kept in this browser beside index.html, under their
   * own key, and the same rule decides where they start: what this browser
   * has wins, else the project's own files (their draft's, or the
   * assignment's). index.html's key is unchanged, so a browser that kept a
   * lesson before tabs existed still gets its typing back — with the
   * project's files beside it.
   *
   * A .md file stays out of the strip. It is the project's notes, which the
   * class already reads in the Notes pane, but it is still part of what is
   * saved: a save that left it out would delete the assignment's notes. */
  var ENTRY = window.WebIDERun.ENTRY;
  var NAME_OK = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,50}\.[A-Za-z0-9]{1,8}$/;
  var FILES_KEY = DRAFT_KEY + "-files";
  var docs = {};
  var active = ENTRY;
  var tabsEl = $("mine-tabs");
  docs[ENTRY] = mine.getDoc();

  var keptFiles = null;
  try {
    keptFiles = JSON.parse(window.localStorage.getItem(FILES_KEY) || "null");
  } catch (e) { /* blocked, or not ours to read: the project's own files */ }
  var startFiles = (keptFiles && typeof keptFiles === "object")
    ? keptFiles : (L.starterFiles || {});
  Object.keys(startFiles).forEach(function (name) {
    if (name !== ENTRY && typeof startFiles[name] === "string") {
      docs[name] = CodeMirror.Doc(startFiles[name], modeFor(name));
    }
  });

  // the same as the editor's, in app.js
  function modeFor(name) {
    if (/\.html?$/i.test(name)) return "htmlmixed";
    if (/\.css$/i.test(name)) return "css";
    if (/\.m?js$/i.test(name)) return "javascript";
    if (/\.json$/i.test(name)) return { name: "javascript", json: true };
    return null;                                  // plain text
  }

  /* The page, whichever tab is open. NOT mine.getValue(): with style.css
     showing, that is the stylesheet, and Save would put it in index.html. */
  function mainSource() { return docs[ENTRY].getValue(); }

  // Everything but index.html, which is kept under its own key.
  function otherFiles() {
    var out = {};
    Object.keys(docs).forEach(function (n) {
      if (n !== ENTRY) out[n] = docs[n].getValue();
    });
    return out;
  }

  // The whole project, index.html included: what Run builds the page from
  // and what every save sends.
  function allFiles() {
    var out = otherFiles();
    out[ENTRY] = mainSource();
    return out;
  }

  function isNotes(name) {
    return window.WebIDENotes && window.WebIDENotes.isMarkdown(name);
  }

  function renderTabs() {
    if (!tabsEl) return;
    tabsEl.textContent = "";
    var names = [ENTRY].concat(Object.keys(docs).filter(function (n) {
      return n !== ENTRY && !isNotes(n);
    }).sort());
    names.forEach(function (name) {
      var tab = document.createElement("button");
      tab.type = "button";
      tab.className = "tab" + (name === active ? " tab-on" : "");
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(name === active));
      tab.textContent = name;
      tab.addEventListener("click", function () { switchTo(name); });
      tabsEl.appendChild(tab);
    });
  }

  function switchTo(name) {
    if (!docs[name] || name === active) return;
    active = name;
    mine.swapDoc(docs[name]);
    mine.setOption("mode", modeFor(name));
    renderTabs();
    mine.focus();
  }

  function keepInBrowser() {
    try {
      window.localStorage.setItem(DRAFT_KEY, mainSource());
      window.localStorage.setItem(FILES_KEY, JSON.stringify(otherFiles()));
      return true;
    } catch (e) {
      return false;
    }
  }

  /* A file of their own, for following a teacher who makes one mid-lesson.
     Same names the editor allows, and the server checks again. No way to
     delete one here, on purpose: the server reads an empty map from this
     page as "leave the files alone" (see live_keep), which is only safe
     while nothing on this page can empty it. */
  var newFileBtn = $("mine-new-file");
  if (newFileBtn) {
    newFileBtn.addEventListener("click", function () {
      var name = window.prompt("Name the new file, for example style.css");
      if (name === null) return;
      name = name.trim();
      if (!NAME_OK.test(name) || name.toLowerCase() === ENTRY || isNotes(name)) {
        window.alert("Use letters, digits, dashes and underscores, and end " +
                     "with an extension like .css or .js.");
        return;
      }
      if (docs[name]) { switchTo(name); return; }
      docs[name] = CodeMirror.Doc("", modeFor(name));
      switchTo(name);
      changed();
    });
  }

  renderTabs();

  var saveTimer = null;
  /* Every change in any tab, and a new file, which fires no editor event. */
  function changed() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      if (keepInBrowser()) {
        note("Saved on this computer");
      } else {
        note("Could not save here — keep this tab open");
      }
      autosave();
    }, 500);
  }
  mine.on("change", changed);

  /* ------------------------------------------------- into their projects
   *
   * Signed in, the copy they type here is an ordinary PyIDE project: press
   * Save once and it autosaves from then on, exactly as the editor does. It
   * turns up in My projects, opens at /p/<slug>, and can be turned in.
   *
   * The browser copy above stays either way. It is the only thing a
   * signed-out student has, and for a signed-in one it is what survives the
   * network being down for the ten minutes the school's wifi is having a
   * moment. The two never disagree about anything important, because both
   * are written from the same editor a fraction of a second apart.
   *
   * EVERYTHING BELOW SENDS `mine`. The mirror is not theirs and must never
   * end up in their projects with their name on it.
   */
  var saveBtn = $("live-save");
  var saveState = $("live-save-state");
  var openLink = $("live-open");
  var turnInBtn = $("live-turn-in");
  var SLUG_KEY = DRAFT_KEY + "-slug";
  var draftSlug = null;
  var pendingSave = false;
  /* Whether the lesson has an assignment behind it. Trusted from the save's
     own reply rather than assumed from the page, so a lesson whose
     assignment was closed between loading the page and pressing Save does
     not leave a Turn in button that cannot work. */
  var canTurnIn = false;

  try {
    draftSlug = window.localStorage.getItem(SLUG_KEY) || null;
  } catch (e) { /* they will press Save and get a fresh one */ }

  /* TWO TABS, ONE DRAFT. Every write says which version of the draft this
     tab last saw, and which tab it is; the server refuses it if another tab
     has saved since. Without that, the Classroom link open in a forgotten
     second tab wrote its old copy over this lesson's work the moment a key
     was pressed in it. Refused, this tab stops saving and says so — the
     other tab's copy is the one to keep. See Draft.version in accounts.py.

     Unknown until the first save when the page had no draft to start from
     (a lesson with no assignment), and then nothing is claimed: the first
     reply carries the version, and the guard holds from there. */
  var TAB = Math.random().toString(36).slice(2, 14);
  /* NOT `seen`. The mirror below keeps the lesson's version in a `seen` of
     its own, and with one function around both they were the same variable:
     the first poll replaced the draft's version with the lesson's, so a
     student whose draft had last been saved anywhere else — the handout
     link, or this page yesterday — had every Save refused as "changed in
     another tab". Nothing about it showed until they pressed Save. */
  var draftSeen = typeof L.draftVersion === "number" ? L.draftVersion : null;
  var stale = false;

  function stamp(payload) {
    if (draftSeen !== null) { payload.base = draftSeen; payload.tab = TAB; }
    return payload;
  }

  function saw(data) {
    if (data && typeof data.version === "number") {
      draftSeen = data.version;
      noteBase(draftSeen);
    }
  }

  function goneStale(message) {
    if (stale) return;
    stale = true;
    if (saveState) {
      saveState.hidden = false;
      saveState.textContent = "Not saved — changed in another tab";
    }
    if (turnInBtn) turnInBtn.disabled = true;
    window.alert(message + " What you typed here is still on screen, and in "
                 + "this browser, so copy it first if you need it.");
  }

  function savedNow(text) {
    if (!saveState) return;
    saveState.hidden = false;
    saveState.textContent = text;
    if (saveBtn) saveBtn.hidden = true;
    if (openLink && draftSlug) {
      openLink.hidden = false;
      openLink.href = "/p/" + encodeURIComponent(draftSlug);
    }
    if (turnInBtn) turnInBtn.hidden = !canTurnIn;
  }

  /* A lesson for an assignment offers Turn in from the start: there is no
     Save to press first, and turnIn() makes the draft itself if the first
     keystroke has not already. */
  canTurnIn = !!L.assignment;
  if (draftSlug || L.submittedAt) {
    // Reopened mid-lesson with a copy already saved, or already turned in.
    savedNow(L.submittedAt ? "Turned in " + L.submittedAt : "Saved");
  }

  /* Handing it in. The same endpoint the editor uses, against the same
     draft, so what the teacher sees on the dashboard is identical whichever
     way the student got there. */
  function turnIn() {
    if (!canTurnIn || stale) return;
    if (!window.confirm("Turn this in to " + (L.assignmentTitle || "your teacher")
                        + "? You can keep working and turn it in again.")) {
      return;
    }
    turnInBtn.disabled = true;
    /* SAVE FIRST, THEN HAND IN WHAT WAS SAVED.
       
       A WebIDE project is its files, and turning in replaces them with what
       is posted. Keeping first writes every tab into the draft and hands
       back the whole map as the server now has it — including a file this
       page never showed — and that map is what goes in. */
    keep().then(function (saved) {
      if (!saved) {
        if (stale) return;                // goneStale has said why
        turnInBtn.disabled = false;
        window.alert("Could not save before turning in. Try again.");
        return;
      }
      // the first save of the lesson may be this one
      rememberDraft(saved.slug);
      return fetch("/api/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(stamp({ draft: draftSlug, files: saved.files || {} }))
      }).then(function (res) { return res.json(); })
        .then(function (data) {
          if (data.stale) { goneStale(data.error); return; }
          turnInBtn.disabled = false;
          if (data.error) { window.alert(data.error); return; }
          saw(data);
          turnInBtn.textContent = "Turn in again";
          savedNow("Turned in" + (data.submitted_at ? " " + data.submitted_at : ""));
        });
    }).catch(function () {
      turnInBtn.disabled = false;
      window.alert("Could not turn it in. Check your connection and try again.");
    });
  }

  /* One place that writes to the lesson's draft, used by Save, by autosave
     and by Turn in — so the three cannot disagree about what a project is. */
  function keep() {
    return fetch("/api/live/" + encodeURIComponent(L.code) + "/keep", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(stamp({ code: mainSource(), files: allFiles() }))
    }).then(function (res) { return res.json(); })
      .then(function (data) {
        if (data && data.stale) { goneStale(data.error); return null; }
        if (data && !data.error) { saw(data); return data; }
        return null;
      });
  }

  if (turnInBtn) turnInBtn.addEventListener("click", turnIn);

  function rememberDraft(slug) {
    if (!slug) return;
    draftSlug = slug;
    try { window.localStorage.setItem(SLUG_KEY, draftSlug); } catch (e) {}
  }

  /* The silent Save of an assignment lesson: the first keystroke makes the
     draft — the same row the handout link would have made — and autosave
     carries on from there. Without it a student's work would reach the
     server only when they pressed Turn in, and a closed laptop lid before
     that would leave nothing on the My work page. */
  var pendingKeep = false;
  function keepQuietly() {
    if (stale || pendingKeep || draftSlug || !L.signedIn || !L.assignment) return;
    if (!mainSource().trim()) return;
    pendingKeep = true;
    keep().then(function (saved) {
      pendingKeep = false;
      if (!saved) return;
      rememberDraft(saved.slug);
      savedNow(L.submittedAt ? "Turned in " + L.submittedAt : "Saved");
    }).catch(function () { pendingKeep = false; });
  }

  function startDraft() {
    if (!L.signedIn || pendingSave) return;
    var text = mainSource();
    if (!text.trim()) { note("Type something first"); return; }
    pendingSave = true;
    /* /api/live/<code>/keep, NOT /api/draft.
       
       /api/draft makes a free-standing project with no assignment on it, and
       a draft with no assignment can never be turned in — which is what made
       handing work in from a live lesson impossible. This route puts the
       work in the assignment's own draft when the lesson has one, so it is
       the same row the handout link would have made and Turn in appears. */
    fetch("/api/live/" + encodeURIComponent(L.code) + "/keep", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(stamp({
        code: text,                       // theirs, never the mirror's
        files: allFiles()
      }))
    }).then(function (res) { return res.json(); })
      .then(function (data) {
        pendingSave = false;
        if (data.stale) { goneStale(data.error); return; }
        if (data.error) { window.alert(data.error); return; }
        saw(data);
        rememberDraft(data.slug);
        canTurnIn = !!data.can_turn_in;
        savedNow("Saved");
      })
      .catch(function () {
        pendingSave = false;
        window.alert("Could not save. Check your connection and try again.");
      });
  }

  function autosave() {
    if (stale) return;
    if (!draftSlug) { keepQuietly(); return; }
    if (!L.signedIn) return;
    fetch("/api/draft/" + encodeURIComponent(draftSlug), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(stamp({
        code: mainSource(),               // theirs, never the mirror's
        /* Every file, index.html included, because this route REPLACES them
           and refuses a map without index.html. It was sent `{}` once, when
           the page had only one editor — and was answered 400 on every
           autosave, so after the first Save nothing a student typed reached
           their project, while the page went on saying "Saved". */
        files: allFiles(),
        title: L.title || "Live lesson"
      }))
    }).then(function (res) {
      if (res.status === 404) {
        /* The project was deleted from another tab, or from My projects.
           Forgetting the slug turns the next Save into a fresh one rather
           than leaving this page autosaving into nothing for the rest of
           the lesson and telling the student it was saved. */
        draftSlug = null;
        try { window.localStorage.removeItem(SLUG_KEY); } catch (e) {}
        if (saveBtn) saveBtn.hidden = false;
        if (saveState) saveState.hidden = true;
        if (openLink) openLink.hidden = true;
        return null;
      }
      return res.json();
    }).then(function (data) {
      if (data && data.stale) { goneStale(data.error); return; }
      saw(data);
      if (data && data.saved_at) savedNow("Saved " + data.saved_at);
    }).catch(function () {
      if (saveState) saveState.textContent = "Not saved — still in this browser";
    });
  }

  if (saveBtn) saveBtn.addEventListener("click", startDraft);

  var noteTimer = null;
  function note(text) {
    if (!savedNote) return;
    savedNote.textContent = text;
    if (noteTimer) clearTimeout(noteTimer);
    noteTimer = setTimeout(function () { savedNote.textContent = ""; }, 2500);
  }

  // -------------------------------------------------------------- the mirror

  var seen = -1;
  /* What the notes pane was last rendered from. Compared before re-rendering
     because every poll hands over the whole file, and re-parsing markdown
     once a second would throw away a link the moment anyone moved to click
     it — the element under the cursor is replaced. */
  var lastNotes = null;

  var mirrorWrap = $("mirror-wrap");
  var mirrorNotes = $("mirror-notes");

  function showMirror(data) {
    /* A .md file is class notes, not code. Rendering it is what makes a link
       the teacher puts up something the class can actually click — raw
       markdown in a code pane is just `[click here](http://…)` in grey.
       notes.js sanitises the HTML and points every link at a new tab. */
    var asNotes = data.filename
      && window.WebIDENotes && window.WebIDENotes.isMarkdown(data.filename);

    if (asNotes) {
      mirrorWrap.hidden = true;
      mirrorNotes.hidden = false;
      if (typeof data.body === "string" && data.body !== lastNotes) {
        lastNotes = data.body;
        window.WebIDENotes.render(mirrorNotes, data.body);
      }
    } else {
      mirrorNotes.hidden = true;
      var wasHidden = mirrorWrap.hidden;
      mirrorWrap.hidden = false;
      // A style.css the teacher opens is CSS, not HTML to be coloured as such.
      var mode = modeFor(data.filename || ENTRY);
      if (mirror.getOption("mode") !== mode) mirror.setOption("mode", mode);
      // The ONLY setValue on the mirror, and there is no setValue on `mine`
      // anywhere below this line.
      if (typeof data.body === "string" && data.body !== mirror.getValue()) {
        clearCaret();                // its line is about to be replaced
        var scroll = mirror.getScrollInfo();
        mirror.setValue(data.body);
        // Keep the reader where they were. Without this every keystroke from
        // the teacher throws a student who has scrolled back to look at line 4
        // straight back to the top, which makes the mirror unreadable.
        mirror.scrollTo(scroll.left, scroll.top);
      }
      /* CodeMirror measures itself when it is built. Built or updated while
         its container is display:none it measures zero, and comes back from
         the notes pane as an empty box that only fills in when something
         forces a redraw. Switching a tab in front of a class is exactly when
         that would happen, so refresh on the way back. */
      if (wasHidden) mirror.refresh();
      showCaret(typeof data.cursor === "string" ? data.cursor : "");
    }

    if (data.filename) {
      // The notes are "instructions" on every page a student sees, never
      // "instructions.md": the class meets them as a button, not a file.
      var name = document.getElementById("mirror-name");
      if (name) name.textContent = asNotes
        ? data.filename.replace(/\.(md|markdown)$/i, "") : data.filename;
    }
    seen = data.version;
    showNotes(data);
    showTeacherPage(data);
    showTeacherOutput(data);
  }

  /* ------------------------------------------------ the teacher's caret
     Where the teacher is typing, drawn as a blinking caret on a tinted line,
     and followed: when it moves off screen the mirror scrolls to it. It is a
     bookmark widget, not a selection or a real cursor, so the mirror stays
     "nocursor" and still cannot be focused or copied from.

     What the teacher has highlighted comes as "anchor-head" and is painted
     yellow with markText — again a mark, not a selection, for the same
     reason. The caret sits at the head, where the drag ended, as it does in
     the teacher's own editor; the line tint is left off then, because a
     tinted line inside a yellow block reads as a second thing to look at.

     Following is the point — a class otherwise watches line 1 while the
     teacher types on line 40 — but a student who scrolls back to read
     something must not be yanked away mid-sentence. So scrolling the
     mirror by hand pauses following for a few seconds, and only that does:
     the scroll events CodeMirror fires for its own scrolling are ignored by
     listening for the wheel, a touch and the scrollbar instead. */
  var caretMark = null;
  var caretLine = null;
  var pickMark = null;
  var followAfter = 0;
  var FOLLOW_PAUSE_MS = 5000;

  ["wheel", "touchmove", "mousedown"].forEach(function (kind) {
    mirrorEl.addEventListener(kind, function () {
      followAfter = Date.now() + FOLLOW_PAUSE_MS;
    }, { passive: true });
  });

  function clearCaret() {
    if (caretMark) { caretMark.clear(); caretMark = null; }
    if (pickMark) { pickMark.clear(); pickMark = null; }
    /* A line handle from before a setValue is detached, and removing a
       class from it throws — getLineNumber is null for exactly those. */
    if (caretLine && mirror.getLineNumber(caretLine) !== null) {
      mirror.removeLineClass(caretLine, "background", "mirror-caret-line");
    }
    caretLine = null;
  }

  // "line:ch" to a position in the mirror. Clamped: the caret and the text
  // arrive together, but a student's mirror is never trusted to be the
  // exact shape the stamp assumed.
  function mirrorPos(line, ch) {
    line = Math.min(+line, mirror.lastLine());
    return { line: line, ch: Math.min(+ch, mirror.getLine(line).length) };
  }

  function showCaret(cursor) {
    clearCaret();
    var m = /^(?:(\d+):(\d+)-)?(\d+):(\d+)$/.exec(cursor);
    if (!m) return;                  // a notes file, or an older editor
    var at = mirrorPos(m[3], m[4]);
    var mark = document.createElement("span");
    mark.className = "mirror-caret";
    caretMark = mirror.setBookmark(at, { widget: mark, insertLeft: true });
    var show = at;
    if (m[1] !== undefined) {
      var other = mirrorPos(m[1], m[2]);
      var backwards = CodeMirror.cmpPos(other, at) > 0;  // dragged upwards
      var from = backwards ? at : other, to = backwards ? other : at;
      pickMark = mirror.markText(from, to, { className: "mirror-pick" });
      show = { from: from, to: to };
    } else {
      caretLine = mirror.addLineClass(at.line, "background", "mirror-caret-line");
    }
    // Only scrolls when it is off screen, so a mirror that already shows it
    // does not twitch on every keystroke.
    if (Date.now() >= followAfter) mirror.scrollIntoView(show, 60);
  }

  /* The project's notes, in their own pane under the console, as slides when
     they have `---` in them (notes.js, slideView). The teacher's editor
     sends the WHOLE file and "3/5", the slide the teacher is on.

     A student can move through the slides on their own — read ahead, go
     back to a question — and every time the teacher moves, this jumps to
     the teacher's slide: the class is brought back together by the person
     teaching, not kept there. Only a MOVE snaps. The teacher typing on the
     same slide leaves a student who has gone ahead where they are, or they
     would be pulled back on every keystroke.

     The viewer only re-renders when what is on screen changes, because
     every poll carries the notes whole, and rendering once a second would
     replace a link — or a half-typed answer — under the student's hand. */
  var notesView = $("live-notes-view");
  var notesBody = $("live-notes");
  var notesSlides = notesBody ? window.WebIDENotes.slideView(notesBody) : null;
  var teacherSlide = null;           // the last "3/5" the teacher sent
  var teacherAt = -1;                // and that slide, from 0

  /* "Teacher: slide 3", in the pane head, and a way back to it for a
     student who has wandered off. Hidden while they are on it. */
  var slideMark = $("live-slide");

  function paintTeacherMark() {
    if (!slideMark || !notesSlides) return;
    var away = teacherAt >= 0 && notesSlides.count() > 0
      && notesSlides.at() !== teacherAt;
    slideMark.hidden = !away;
    slideMark.textContent = away ? "Back to the teacher's slide (" + (teacherAt + 1) + ")" : "";
  }

  if (notesSlides) {
    notesSlides.onMove(paintTeacherMark);
    if (slideMark) {
      slideMark.addEventListener("click", function () {
        if (teacherAt >= 0) notesSlides.go(teacherAt);
        paintTeacherMark();
      });
    }
  }

  function showNotes(data) {
    if (!notesView || !notesSlides || typeof data.notes !== "string") return;
    var slide = typeof data.slide === "string" ? data.slide : "";
    notesView.hidden = !data.notes.trim();
    if (notesView.hidden) return;
    var jump;
    if (slide !== teacherSlide) {
      teacherSlide = slide;
      var m = slide.match(/^(\d+)\/(\d+)$/);
      teacherAt = m ? parseInt(m[1], 10) - 1 : -1;
      if (teacherAt >= 0) jump = teacherAt;
    }
    notesSlides.show(data.notes, jump);
    paintTeacherMark();
  }

  // ------------------------------------------- what the teacher's Run made

  /* The teacher's page and console, beside the teacher's code and never in
     the student's own. The student's frame and console are theirs exactly
     as their editor is; these get their own elements and nothing here
     touches `frame` or `outputEl`.

     The pane appears with the teacher's first Run and then stays, even when
     a Run comes back empty — a push can land between the teacher's frame
     clearing and their page arriving, and a pane that came and went would
     make the code beside it jump sideways on every Run. The console under
     it appears the first time it has anything in it, for the same reason. */
  var teacherView = $("teacher-output-view");
  var teacherFrame = $("teacher-preview");
  var teacherConsole = $("teacher-console");
  var teacherOut = $("teacher-output");
  var shownPageId = "";
  var shownOutput = null;

  function revealTeacher(el) {
    if (!el.hidden) return;
    el.hidden = false;
    /* The mirror just got narrower, and CodeMirror only measures itself
       on a window resize — without this its scrollbar and the caret's
       follow are worked out for the old width. */
    mirror.refresh();
  }

  /* Set only when the page itself changes. The poll leaves `page` out when
     the student already has it (see live_poll), and re-setting it anyway
     would restart the teacher's page on thirty screens every second.
     Replaced as an element rather than re-pointed, like the student's own:
     a teacher's page stuck in a loop wedges its frame, and only a new one
     gets the next Run on screen. */
  function showTeacherPage(data) {
    if (!teacherFrame || typeof data.page !== "string") return;
    var id = data.page_id || "";
    if (id === shownPageId) return;
    shownPageId = id;
    var next = document.createElement("iframe");
    next.id = "teacher-preview";
    next.title = "Your teacher's page";
    next.setAttribute("sandbox", "allow-scripts allow-forms");
    teacherFrame.parentNode.replaceChild(next, teacherFrame);
    teacherFrame = next;
    if (!data.page) return;
    teacherFrame.srcdoc = data.page;
    revealTeacher(teacherView);
  }

  function showTeacherOutput(data) {
    if (!teacherOut || typeof data.output !== "string") return;
    if (data.output === shownOutput) return;
    shownOutput = data.output;
    teacherOut.textContent = data.output;
    teacherOut.scrollTop = teacherOut.scrollHeight;
    if (!data.output) return;
    revealTeacher(teacherConsole);
    revealTeacher(teacherView);
  }

  /* The console starts folded to its head, leaving the column to the page
     and the notes; the head's arrow opens it. An error opens it too — a
     mistake written into a folded pane is a mistake nobody sees, and the
     page simply looks broken. Not remembered between visits: folded is
     the state every lesson should start in. */
  var outputView = $("output-view");
  var foldBtn = $("out-fold");

  function openConsole(open) {
    if (!outputView) return;
    outputView.classList.toggle("is-folded", !open);
    if (foldBtn) {
      foldBtn.textContent = open ? "▾" : "▸";
      foldBtn.title = open ? "Fold the console away" : "Show the console";
      foldBtn.setAttribute("aria-expanded", String(open));
    }
  }

  if (foldBtn) {
    foldBtn.addEventListener("click", function () {
      openConsole(outputView.classList.contains("is-folded"));
    });
  }
  openConsole(false);


  function setState(text, kind) {
    if (!stateChip) return;
    stateChip.textContent = text;
    stateChip.className = "chip live-chip" + (kind ? " live-" + kind : "");
  }

  /* NOT ON AIR WHEN THIS PAGE OPENED: show nothing of it. What an ended
     lesson holds is where it last stopped — for a lesson taught to several
     sections, another section's code from yesterday, which a class opening
     the link before their teacher goes live took for today's. A page that
     watched the lesson end keeps its last code (poll, below). */
  var everLive = !L.ended;
  if (typeof L.body === "string" && everLive) {
    showMirror({ body: L.body, version: L.version, filename: L.filename,
                 notes: L.notes, slide: L.slide, output: L.output,
                 cursor: L.cursor,
                 page: L.page, page_id: L.pageId });
  }

  var POLL_MS = 1000;
  /* A lesson made ahead from the assignment page, whose link was posted
     before it began. Its page keeps checking — not every second, since a
     tab opened the night before would ask all night — and the lesson
     appears within a few seconds of the teacher starting it. */
  var WAITING_MS = 15000;
  /* An ended lesson keeps checking too. It used to stop, so a class that
     opened the link before their teacher pressed Go live sat on "Lesson
     ended" — and the last lesson's code — for the whole lesson, and only a
     reload brought it up. Teaching it again reopens the same link. */
  var ENDED_MS = 5000;
  var pace = POLL_MS;        // set by each answer: how soon to ask again
  var moving = false;        // sent on to another link; this page is done
  var misses = 0;


  function poll() {
    fetch("/api/live/" + encodeURIComponent(L.code) + "?v=" + seen
          + "&pg=" + encodeURIComponent(shownPageId),
          { cache: "no-store" })
      .then(function (res) {
        if (res.status === 304) {         // the usual answer: nothing new
          misses = 0;
          pace = POLL_MS;                 // only a lesson on the air says 304
          everLive = true;
          setState("Live", "on");
          return null;
        }
        if (res.status === 404) {
          setState("Lesson not found", "off");
          throw new Error("gone");
        }
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (data) {
        misses = 0;
        if (!data) return;
        // An older link for this assignment: on to its lesson (live_poll).
        if (data.moved) {
          moving = true;
          location.replace("/live/" + encodeURIComponent(data.moved));
          return;
        }
        // Made ahead and never taught, or not on air since this page
        // opened: nothing of it is shown until the teacher goes live.
        if (data.ended && (data.waiting || !everLive)) {
          pace = data.waiting ? WAITING_MS : ENDED_MS;
          setState("Not started yet", "wait");
          return;
        }
        if (data.ended) {
          pace = ENDED_MS;
          showMirror(data);
          setState("Lesson ended", "off");
          return;
        }
        pace = POLL_MS;
        everLive = true;
        showMirror(data);
        setState("Live", "on");
      })
      .catch(function (err) {
        if (err && err.message === "gone") return;
        // A dropped poll is normal on school wifi and says nothing about the
        // lesson. Only a run of them is worth telling anyone about, and the
        // next success clears it.
        misses = misses + 1;
        if (misses >= 3) setState("Reconnecting…", "wait");
      })
      .finally(function () {
        if (stateChip && stateChip.textContent === "Lesson not found") return;
        if (moving) return;
        setTimeout(poll, pace);
      });
  }

  poll();

  // ------------------------------------------------------------- their Run
  //
  // WebIDE has no Python: a project is a page, and running it means putting
  // it in a sandboxed frame. The frame is replaced rather than re-pointed,
  // for the same reason the editor replaces it — a `while (true)` wedges
  // that frame's process, and a wedged frame cannot navigate itself away.

  function write(text, cls) {
    var span = document.createElement("span");
    if (cls) span.className = cls;
    span.textContent = text;
    outputEl.appendChild(span);
    outputEl.scrollTop = outputEl.scrollHeight;
    if (cls === "err") openConsole(true);
  }

  function clearOutput() { outputEl.textContent = ""; }

  var frame = $("preview");
  var token = null;
  var running = false;

  function setBusy(on) {
    running = on;
    runBtn.hidden = on;
    stopBtn.hidden = !on;
  }

  function freshFrame() {
    var next = document.createElement("iframe");
    next.id = "preview";
    next.title = "Page preview";
    next.setAttribute("sandbox", "allow-scripts allow-forms");
    frame.parentNode.replaceChild(next, frame);
    frame = next;
    return next;
  }

  function run() {
    /* Every tab, not just index.html: the page links to style.css and
       script.js by name, and the runner can only inline what it is given.
       With index.html alone the page ran unstyled and its script never
       loaded, and nothing on screen said why. */
    var files = allFiles();                // theirs, never the mirror's
    clearOutput();
    token = "w" + Date.now() + Math.random().toString(36).slice(2, 8);
    var built = window.WebIDERun.assemble(files, token, ENTRY, null);
    setBusy(true);
    freshFrame().srcdoc = built.html;
  }

  function stopRun() {
    if (!running) return;
    /* Removing the element kills the frame outright, which is what makes
       Stop work even while the page is stuck in a loop. */
    freshFrame();
    write("\n— stopped —\n", "dim");
    setBusy(false);
    mine.focus();
  }

  /* Only the live preview may write here, and only with this run's token:
     a student's page cannot post messages into someone else's lesson. */
  window.addEventListener("message", function (e) {
    var data = e.data;
    if (!data || typeof data !== "object" || !token) return;
    if (data.webide !== token) return;
    if (e.source !== frame.contentWindow) return;

    if (data.kind === "ready") {
      setBusy(false);
      if (!outputEl.textContent.trim()) {
        write("Page loaded. console.log messages appear here.\n", "dim");
      }
      return;
    }
    if (data.kind === "error") {
      write(String(data.text) + "\n", "err");
      return;
    }
    /* Without this case the URL fell through to the line below and was
       printed as if the page had logged it — a link that did nothing but
       talk to the console. */
    if (data.kind === "open") {
      openExternal(String(data.text));
      return;
    }
    if (data.text !== undefined) write(String(data.text) + "\n");
  });

  /* A link to another site, opened on the preview's behalf — the same as
     app.js's openExternal. The frame has no allow-popups, on purpose, so it
     asks and the tab is opened from here; the click inside it is what keeps
     the browser from calling this an unprompted pop-up. The URL comes from
     student content, so the scheme is checked again rather than trusted. */
  function openExternal(url) {
    if (!/^https?:\/\//i.test(url)) {
      write("\nThat link didn't point at a web address, so nothing opened: "
            + url + "\n", "dim");
      return;
    }
    var opened = null;
    try {
      opened = window.open(url, "_blank");
      // the opened page must not be able to reach back into the lesson
      if (opened) { try { opened.opener = null; } catch (e) {} }
    } catch (e) { /* blocked; handled below */ }

    if (opened) {
      write("\nOpened in a new tab: " + url + "\n", "dim");
    } else {
      write("\nYour browser blocked a new tab for " + url +
            "\nAllow pop-ups for this site, or copy the address above.\n", "dim");
    }
  }

  runBtn.disabled = false;
  runLabel.textContent = "Run";
  runBtn.addEventListener("click", run);

  /* ------------------------------------------------ their page in a new tab
   *
   * The editor's New tab, unchanged: every one of their files goes to /play
   * through this browser's storage under the key demo.js reads, and one
   * named tab is reused. It reads their editor and never writes to it. The
   * teacher's files are not what it sends — a student who wants the
   * teacher's page in a tab has to have typed it, which is the exercise. */
  function runInNewTab() {
    try {
      localStorage.setItem("webide-play", JSON.stringify({
        files: allFiles(),
        title: L.title || "Page"
      }));
    } catch (e) {
      window.alert("This browser is blocking site storage, so the page "
                   + "cannot be handed to a new tab. Use the preview here instead.");
      return;
    }
    window.open("/play", "webide-play");
  }

  if ($("run-tab")) $("run-tab").addEventListener("click", runInNewTab);
  stopBtn.addEventListener("click", stopRun);
  $("clear").addEventListener("click", clearOutput);

  // ----------------------------------------------------------------- theme
  /* The editor's light/dark button, on the same localStorage key, so a choice
     made in either place holds in both. The <head> script has already set
     data-theme before the first paint; this only keeps the glyph, the two
     CodeMirrors and the computer's own setting in step with it. */
  function themeSwitch() {
    var THEME_KEY = "webide-theme";
    var btn = document.getElementById("theme");
    var glyph = document.getElementById("theme-glyph");
    if (!btn) return;

    function current() { return isDark() ? "dark" : "light"; }

    function apply(name, remember) {
      document.documentElement.setAttribute("data-theme", name);
      // CodeMirror carries its own colours, so it needs telling separately
      var cm = name === "light" ? "default" : "material-darker";
      [mirror, mine].forEach(function (ed) {
        if (ed) { ed.setOption("theme", cm); ed.refresh(); }
      });
      glyph.textContent = name === "light" ? "☾" : "☀";
      btn.title = name === "light"
        ? "Switch to dark (easier on the eyes up close)"
        : "Switch to light (easier to read on a projector)";
      btn.setAttribute("aria-label", btn.title);
      if (remember) {
        try { localStorage.setItem(THEME_KEY, name); } catch (e) { /* blocked */ }
      }
    }

    apply(current(), false);
    btn.addEventListener("click", function () {
      apply(current() === "light" ? "dark" : "light", true);
    });

    // Follow the computer's setting as it changes, until a choice is made.
    if (window.matchMedia) {
      var mq = window.matchMedia("(prefers-color-scheme: light)");
      var onSystemChange = function () {
        var saved = null;
        try { saved = localStorage.getItem(THEME_KEY); } catch (e) { /* blocked */ }
        if (saved !== "light" && saved !== "dark") {
          apply(mq.matches ? "light" : "dark", false);
        }
      };
      if (mq.addEventListener) mq.addEventListener("change", onSystemChange);
      else if (mq.addListener) mq.addListener(onSystemChange);
    }
  }

  // ----------------------------------------------------------- host's page

  function hostControls() {
    var stop = document.getElementById("live-stop");
    if (!stop) return;
    stop.addEventListener("click", function () {
      if (!window.confirm("End the lesson? Your class stops seeing your editor.")) {
        return;
      }
      fetch("/api/live/" + encodeURIComponent(L.code) + "/stop", { method: "POST" })
        .then(function () { stop.disabled = true; stop.textContent = "Ended"; });
    });
  }
})();
