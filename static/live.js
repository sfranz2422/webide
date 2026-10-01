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
  var mirror = CodeMirror.fromTextArea($("mirror"), {
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
  var mine = CodeMirror.fromTextArea($("mine"), {
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
  try {
    kept = window.localStorage.getItem(DRAFT_KEY);
  } catch (e) { /* storage blocked: fall back to the starting point */ }
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

  function savedNow(text) {
    if (!saveState) return;
    saveState.hidden = false;
    saveState.textContent = text;
    if (saveBtn) saveBtn.hidden = true;
    if (openLink && draftSlug) {
      openLink.hidden = false;
      openLink.href = "/p/" + encodeURIComponent(draftSlug);
    }
    if (turnInBtn) turnInBtn.hidden = !(draftSlug && canTurnIn);
  }

  if (draftSlug) {
    // Reopened mid-lesson with a copy already saved. The page knows whether
    // the lesson has an assignment, so Turn in can be offered straight away
    // rather than waiting for the next keystroke to trigger an autosave.
    canTurnIn = !!L.assignment;
    savedNow(L.submittedAt ? "Turned in " + L.submittedAt : "Saved");
  }

  /* Handing it in. The same endpoint the editor uses, against the same
     draft, so what the teacher sees on the dashboard is identical whichever
     way the student got there. */
  function turnIn() {
    if (!draftSlug || !canTurnIn) return;
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
        turnInBtn.disabled = false;
        window.alert("Could not save before turning in. Try again.");
        return;
      }
      return fetch("/api/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draft: draftSlug, files: saved.files || {} })
      }).then(function (res) { return res.json(); })
        .then(function (data) {
          turnInBtn.disabled = false;
          if (data.error) { window.alert(data.error); return; }
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
      body: JSON.stringify({ code: mainSource(), files: allFiles() })
    }).then(function (res) { return res.json(); })
      .then(function (data) { return data && !data.error ? data : null; });
  }

  if (turnInBtn) turnInBtn.addEventListener("click", turnIn);

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
      body: JSON.stringify({
        code: text,                       // theirs, never the mirror's
        files: allFiles()
      })
    }).then(function (res) { return res.json(); })
      .then(function (data) {
        pendingSave = false;
        if (data.error) { window.alert(data.error); return; }
        draftSlug = data.slug;
        canTurnIn = !!data.can_turn_in;
        try { window.localStorage.setItem(SLUG_KEY, draftSlug); } catch (e) {}
        savedNow("Saved");
      })
      .catch(function () {
        pendingSave = false;
        window.alert("Could not save. Check your connection and try again.");
      });
  }

  function autosave() {
    if (!draftSlug || !L.signedIn) return;
    fetch("/api/draft/" + encodeURIComponent(draftSlug), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: mainSource(),               // theirs, never the mirror's
        /* Every file, index.html included, because this route REPLACES them
           and refuses a map without index.html. It was sent `{}` once, when
           the page had only one editor — and was answered 400 on every
           autosave, so after the first Save nothing a student typed reached
           their project, while the page went on saying "Saved". */
        files: allFiles(),
        title: L.title || "Live lesson"
      })
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
      var name = document.getElementById("mirror-name");
      if (name) name.textContent = data.filename;
    }
    seen = data.version;
    showNotes(data);
    showTeacherPage(data, data.initial);
    showTeacherOutput(data);
  }

  /* ------------------------------------------------ the teacher's caret
     Where the teacher is typing, drawn as a blinking caret on a tinted line,
     and followed: when it moves off screen the mirror scrolls to it. It is a
     bookmark widget, not a selection or a real cursor, so the mirror stays
     "nocursor" and still cannot be focused or copied from.

     Following is the point — a class otherwise watches line 1 while the
     teacher types on line 40 — but a student who scrolls back to read
     something must not be yanked away mid-sentence. So scrolling the
     mirror by hand pauses following for a few seconds, and only that does:
     the scroll events CodeMirror fires for its own scrolling are ignored by
     listening for the wheel, a touch and the scrollbar instead. */
  var caretMark = null;
  var caretLine = null;
  var followAfter = 0;
  var FOLLOW_PAUSE_MS = 5000;

  ["wheel", "touchmove", "mousedown"].forEach(function (kind) {
    mirrorEl.addEventListener(kind, function () {
      followAfter = Date.now() + FOLLOW_PAUSE_MS;
    }, { passive: true });
  });

  function clearCaret() {
    if (caretMark) { caretMark.clear(); caretMark = null; }
    /* A line handle from before a setValue is detached, and removing a
       class from it throws — getLineNumber is null for exactly those. */
    if (caretLine && mirror.getLineNumber(caretLine) !== null) {
      mirror.removeLineClass(caretLine, "background", "mirror-caret-line");
    }
    caretLine = null;
  }

  function showCaret(cursor) {
    clearCaret();
    var m = /^(\d+):(\d+)$/.exec(cursor);
    if (!m) return;                  // a notes file, or an older editor
    // Clamped: the caret and the text arrive together, but a student's
    // mirror is never trusted to be the exact shape the stamp assumed.
    var line = Math.min(+m[1], mirror.lastLine());
    var at = { line: line, ch: Math.min(+m[2], mirror.getLine(line).length) };
    var mark = document.createElement("span");
    mark.className = "mirror-caret";
    caretMark = mirror.setBookmark(at, { widget: mark, insertLeft: true });
    caretLine = mirror.addLineClass(line, "background", "mirror-caret-line");
    // Only scrolls when the caret is off screen, so a mirror that already
    // shows it does not twitch on every keystroke.
    if (Date.now() >= followAfter) mirror.scrollIntoView(at, 60);
  }

  /* The project's notes, in their own pane under the console. Re-rendered
     only when they change, for the same reason as the mirror's notes above:
     every poll carries them whole, and re-rendering once a second would
     replace a link under the cursor just as someone clicked it. */
  var notesView = $("live-notes-view");
  var notesBody = $("live-notes");
  var shownNotes = null;

  var slideMark = $("live-slide");
  var shownSlide = null;

  /* Slides need nothing special here. When the teacher's notes are cut into
     slides, `notes` is only the current one — the editor does the cutting —
     and `slide` says where it is ("3/5"). A new slide is new notes, so it
     renders through the same path; all this adds is the marker, and going
     back to the top, because the last slide's scroll position means nothing
     on the next one and a class would start reading it halfway down. */
  function showNotes(data) {
    if (!notesView || typeof data.notes !== "string") return;
    var slide = typeof data.slide === "string" ? data.slide : "";
    if (data.notes === shownNotes && slide === shownSlide) return;
    var moved = slide !== shownSlide;
    shownNotes = data.notes;
    shownSlide = slide;
    if (slideMark) {
      var m = slide.match(/^(\d+)\/(\d+)$/);
      slideMark.textContent = m ? "Slide " + m[1] + " of " + m[2] : "";
    }
    notesView.hidden = !data.notes.trim();
    if (notesView.hidden) return;
    window.WebIDENotes.render(notesBody, data.notes).then(function () {
      if (moved) notesBody.scrollTop = 0;
    });
  }

  // ------------------------------------------- what the teacher's Run made

  /* The teacher's page and console, each beside the student's own and never
     in it. The student's frame and console are theirs exactly as their
     editor is; these get their own elements and nothing here touches
     `frame` or `outputEl`.

     NOTHING COMES TO THE FRONT BY ITSELF. A new page used to, both tabs
     with it, whenever the teacher pressed Run — and every Run in a lesson
     took thirty students away from their own page mid-thought. Now the
     tabs appear and get a dot, and the student looks when they choose to. */
  var teacherFrame = $("teacher-preview");
  var teacherOut = $("teacher-output");
  var pageMineTab = $("page-mine");
  var pageTeacherTab = $("page-teacher");
  var mineTab = $("out-mine");
  var teacherTab = $("out-teacher");
  var clearBtn = $("clear");
  var shownPageId = "";
  var shownOutput = null;

  function showTeachers(on) {
    if (!teacherFrame) return;
    teacherFrame.hidden = !on;
    frame.hidden = on;
    pageMineTab.classList.toggle("is-on", !on);
    pageTeacherTab.classList.toggle("is-on", on);
    if (on) pageTeacherTab.classList.remove("has-new");
    showConsoleTab(on);
  }

  function showConsoleTab(on) {
    if (!teacherOut) return;
    teacherOut.hidden = !on;
    outputEl.hidden = on;
    mineTab.classList.toggle("is-on", !on);
    teacherTab.classList.toggle("is-on", on);
    if (on) teacherTab.classList.remove("has-new");
    clearBtn.hidden = on;                     // Clear is for their own
  }

  /* Set only when the page itself changes. The poll leaves `page` out when
     the student already has it (see live_poll), and re-setting it anyway
     would restart the teacher's page on thirty screens every second.
     Replaced as an element rather than re-pointed, like the student's own:
     a teacher's page stuck in a loop wedges its frame, and only a new one
     gets the next Run on screen. */
  function showTeacherPage(data, quietly) {
    if (!teacherFrame || typeof data.page !== "string") return;
    var id = data.page_id || "";
    if (id === shownPageId) return;
    shownPageId = id;
    var next = document.createElement("iframe");
    next.id = "teacher-preview";
    next.title = "Your teacher's page";
    next.setAttribute("sandbox", "allow-scripts allow-forms");
    next.hidden = teacherFrame.hidden;
    teacherFrame.parentNode.replaceChild(next, teacherFrame);
    teacherFrame = next;
    if (!data.page) return;
    teacherFrame.srcdoc = data.page;
    pageTeacherTab.hidden = false;
    teacherTab.hidden = false;
    if (!quietly && teacherFrame.hidden) pageTeacherTab.classList.add("has-new");
  }

  function showTeacherOutput(data) {
    if (!teacherOut || typeof data.output !== "string") return;
    if (data.output === shownOutput) return;
    var first = shownOutput === null;
    shownOutput = data.output;
    teacherOut.textContent = data.output;
    teacherOut.scrollTop = teacherOut.scrollHeight;
    if (!data.output) return;
    teacherTab.hidden = false;
    if (!first && teacherOut.hidden) teacherTab.classList.add("has-new");
  }

  if (teacherFrame) {
    pageMineTab.addEventListener("click", function () { showTeachers(false); });
    pageTeacherTab.addEventListener("click", function () { showTeachers(true); });
    mineTab.addEventListener("click", function () {
      showConsoleTab(false); openConsole(true);
    });
    teacherTab.addEventListener("click", function () {
      showConsoleTab(true); openConsole(true);
    });
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

  if (typeof L.body === "string") {
    showMirror({ body: L.body, version: L.version, filename: L.filename,
                 notes: L.notes, slide: L.slide, output: L.output,
                 cursor: L.cursor,
                 page: L.page, page_id: L.pageId,
                 // joining mid-lesson: offer the teacher's page, but leave
                 // the student looking at their own until the teacher runs
                 initial: true });
  }

  var POLL_MS = 1000;
  var misses = 0;

  function poll() {
    fetch("/api/live/" + encodeURIComponent(L.code) + "?v=" + seen
          + "&pg=" + encodeURIComponent(shownPageId),
          { cache: "no-store" })
      .then(function (res) {
        if (res.status === 304) {         // the usual answer: nothing new
          misses = 0;
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
        if (data.ended) {
          showMirror(data);
          setState("Lesson ended", "off");
          // Stop asking. The row is not going to change again, and thirty
          // browsers politely polling a finished lesson until home time is
          // exactly the kind of traffic nobody notices they are paying for.
          throw new Error("ended");
        }
        showMirror(data);
        setState("Live", "on");
      })
      .catch(function (err) {
        if (err && (err.message === "ended" || err.message === "gone")) return;
        // A dropped poll is normal on school wifi and says nothing about the
        // lesson. Only a run of them is worth telling anyone about, and the
        // next success clears it.
        misses = misses + 1;
        if (misses >= 3) setState("Reconnecting…", "wait");
      })
      .finally(function () {
        if (stateChip && stateChip.textContent === "Lesson ended") return;
        if (stateChip && stateChip.textContent === "Lesson not found") return;
        setTimeout(poll, POLL_MS);
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
    /* Stop makes a new frame too, and it must stay behind the teacher's
       page if that is the tab in front — a fresh element is visible by
       default, and the two would stack in one pane. */
    next.hidden = frame.hidden;
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
    showTeachers(false);                   // their Run, their page
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
    if (data.text !== undefined) write(String(data.text) + "\n");
  });

  runBtn.disabled = false;
  runLabel.textContent = "Run";
  runBtn.addEventListener("click", run);
  stopBtn.addEventListener("click", stopRun);
  $("clear").addEventListener("click", clearOutput);

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
