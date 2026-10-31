/* WebIDE — editor, preview, sharing */

(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var outputEl = $("output");
  var runBtn = $("run");
  var stopBtn = $("stop");
  var authorField = $("author");
  var previewView = $("preview-view");
  var notesView = $("notes-view");
  var notesBody = $("notes-body");
  var notesName = $("notes-name");
  var notesEditBtn = $("notes-edit");     // only while authoring

  /* Questions in the notes answer into this assignment. On a project that
     is not one, or the teacher's own copy, there is nowhere to record an
     answer, and notes.js says so on the question rather than taking one. */
  window.WebIDENotes.setQuizContext({ assignment: window.WEBIDE.assignmentSlug,
                                      signedIn: window.WEBIDE.signedIn,
                                      viewOnly: window.WEBIDE.viewOnly });
  var frame = $("preview");
  var tabsEl = $("file-tabs");

  var ENTRY = window.WebIDERun.ENTRY;     // index.html

  // ------------------------------------------------------------- tab stops
  // Shared with the live-lesson editor, so it lives in tabstops.js.
  var indentToTabStop = window.WebIDETabStops.indentToTabStop;
  var backspaceToTabStop = window.WebIDETabStops.backspaceToTabStop;

  // ---------------------------------------------------------------- editor
  var editor = CodeMirror.fromTextArea($("editor"), {
    mode: "htmlmixed",
    theme: "material-darker",
    lineNumbers: true,
    indentUnit: 2,
    tabSize: 2,
    indentWithTabs: false,
    matchBrackets: true,
    autoCloseBrackets: true,
    /* Close every tag on the line it was opened on.
       The addon otherwise carries a list of "block" tags — h1 to h6, div, p,
       ul, table and a dozen more — that it expands across three lines with the
       cursor on a blank one in the middle. That is a reasonable habit for
       someone writing a page section, and a bad surprise for a beginner typing
       <h1>Hello</h1>, who watches their heading and its closing tag fly apart.
       An empty list is still a list, so the addon uses it and indents nothing;
       leaving dontCloseTags unset keeps <br> and <img> closing themselves. */
    autoCloseTags: { indentTags: [] },
    readOnly: window.WEBIDE.readonly ? "nocursor" : false,
    extraKeys: {
      "Ctrl-Enter": function () { run(); },
      "Cmd-Enter": function () { run(); },
      Tab: indentToTabStop,
      Backspace: backspaceToTabStop,
      "Shift-Tab": function (cm) { cm.indentSelection("subtract"); },
      // indent:true keeps the comment marker at the code's own indentation
      "Ctrl-/": function (cm) { cm.toggleComment({ indent: true }); },
      "Cmd-/": function (cm) { cm.toggleComment({ indent: true }); }
    }
  });
  editor.setSize("100%", "100%");

  /* CodeMirror caches its width and only rechecks on a window resize. Showing
     the notes pane or resizing the text changes the editor's size with no
     resize event, leaving clicks landing on the wrong characters. A timeout
     rather than requestAnimationFrame, because rAF is paused in a background
     tab. */
  function relayout() {
    setTimeout(function () { editor.refresh(); }, 0);
  }

  // ----------------------------------------------------------------- theme
  var THEME_KEY = "webide-theme";
  var themeBtn = $("theme");
  var themeGlyph = $("theme-glyph");

  function systemPrefersLight() {
    return window.matchMedia &&
           window.matchMedia("(prefers-color-scheme: light)").matches;
  }

  function currentTheme() {
    var set = document.documentElement.getAttribute("data-theme");
    if (set === "light" || set === "dark") return set;
    return systemPrefersLight() ? "light" : "dark";
  }

  function applyTheme(name, remember) {
    document.documentElement.setAttribute("data-theme", name);
    editor.setOption("theme", name === "light" ? "default" : "material-darker");
    themeGlyph.textContent = name === "light" ? "☾" : "☀";
    themeBtn.title = name === "light"
      ? "Switch to dark (easier on the eyes up close)"
      : "Switch to light (easier to read on a projector)";
    themeBtn.setAttribute("aria-label", themeBtn.title);
    if (remember) {
      try { localStorage.setItem(THEME_KEY, name); } catch (e) { /* blocked */ }
    }
    relayout();
  }

  /* A theme bought in the shop (xp.js namedTheme): its own CodeMirror
     colours, and the button offers the way back to light/dark. */
  var named = window.PyIDEXP ? window.PyIDEXP.namedTheme() : "";
  function showNamed() {
    editor.setOption("theme", "pyide-" + named);
    themeGlyph.textContent = "🎨";
    themeBtn.title = "Your theme — click for light, then dark, then back";
    themeBtn.setAttribute("aria-label", themeBtn.title);
  }
  // In dark, the next click brings their theme back (xp.js), so say so.
  function hintBack() {
    if (named || currentTheme() !== "dark" || !window.PyIDEXP || !window.PyIDEXP.lastTheme()) return;
    themeGlyph.textContent = "🎨";
    themeBtn.title = "Back to your theme";
    themeBtn.setAttribute("aria-label", themeBtn.title);
  }
  if (named) {
    showNamed();
  } else {
    applyTheme(currentTheme(), false);
    hintBack();
  }
  themeBtn.addEventListener("click", function () {
    if (named) {
      named = "";
      window.PyIDEXP.clearTheme();
      applyTheme("light", true);
      return;
    }
    if (currentTheme() === "dark" && window.PyIDEXP && window.PyIDEXP.lastTheme()) {
      window.PyIDEXP.restoreTheme().then(function (t) {
        if (t) { named = t; showNamed(); relayout(); }
        else applyTheme("light", true);
      });
      return;
    }
    applyTheme(currentTheme() === "light" ? "dark" : "light", true);
    hintBack();
  });

  if (window.matchMedia) {
    var mq = window.matchMedia("(prefers-color-scheme: light)");
    var onSystemChange = function () {
      if (named) return;                      // a bought theme stays put
      var saved = null;
      try { saved = localStorage.getItem(THEME_KEY); } catch (e) {}
      if (saved !== "light" && saved !== "dark") {
        applyTheme(systemPrefersLight() ? "light" : "dark", false);
      }
    };
    if (mq.addEventListener) mq.addEventListener("change", onSystemChange);
    else if (mq.addListener) mq.addListener(onSystemChange);
  }

  // ------------------------------------------------------------- text size
  var SIZE_KEY = "webide-code-size";
  var SIZES = [11, 12, 13, 14, 16, 18, 20, 22, 24, 28, 32];
  var sizeLabel = $("font-size");
  var sizeDown = $("font-down");
  var sizeUp = $("font-up");

  function readSize() {
    var n = parseInt(getComputedStyle(document.documentElement)
      .getPropertyValue("--code-size"), 10);
    return isNaN(n) ? 14 : n;
  }
  function nearestIndex(px) {
    var best = 0;
    for (var i = 1; i < SIZES.length; i++) {
      if (Math.abs(SIZES[i] - px) < Math.abs(SIZES[best] - px)) best = i;
    }
    return best;
  }
  var sizeIndex = nearestIndex(readSize());

  function applySize(remember) {
    var px = SIZES[sizeIndex];
    document.documentElement.style.setProperty("--code-size", px + "px");
    sizeLabel.textContent = String(px);
    sizeDown.disabled = sizeIndex === 0;
    sizeUp.disabled = sizeIndex === SIZES.length - 1;
    relayout();
    if (remember) {
      try { localStorage.setItem(SIZE_KEY, String(px)); } catch (e) {}
    }
  }
  function stepSize(by) {
    var next = Math.min(SIZES.length - 1, Math.max(0, sizeIndex + by));
    if (next === sizeIndex) return;
    sizeIndex = next;
    applySize(true);
  }
  sizeDown.addEventListener("click", function () { stepSize(-1); });
  sizeUp.addEventListener("click", function () { stepSize(1); });
  applySize(false);

  // ----------------------------------------------------------------- files
  var NAME_OK = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,50}\.[A-Za-z0-9]{1,8}$/;

  var account = null;      // assigned further down, once the editor exists
  var docs = {};
  var active = ENTRY;
  var lastCodeFile = ENTRY;
  var mdSourceOpen = false;

  function modeFor(name) {
    if (/\.html?$/i.test(name)) return "htmlmixed";
    if (/\.css$/i.test(name)) return "css";
    if (/\.m?js$/i.test(name)) return "javascript";
    if (/\.json$/i.test(name)) return { name: "javascript", json: true };
    return null;                                  // plain text
  }

  var startFiles = window.WEBIDE.files || {};
  Object.keys(startFiles).forEach(function (name) {
    docs[name] = CodeMirror.Doc(startFiles[name], modeFor(name));
  });
  if (!docs[ENTRY]) docs[ENTRY] = CodeMirror.Doc("", "htmlmixed");
  editor.swapDoc(docs[ENTRY]);
  editor.setOption("mode", "htmlmixed");

  function allFiles() {
    var out = {};
    Object.keys(docs).forEach(function (n) { out[n] = docs[n].getValue(); });
    return out;
  }
  /* ------------------------------------------------ the page in a new tab
   *
   * The files go to /play through this browser's storage, not the server:
   * nothing is saved or shared by it, and a signed-out student can use it
   * as freely as Run. /play is the demo page's player (demo.js), which reads
   * them from there and shows the page at once.
   *
   * One named tab, reused: pressing it again after an edit reloads that tab
   * with the new files instead of opening another one per press. */
  function runInNewTab() {
    try {
      localStorage.setItem("webide-play", JSON.stringify({
        files: allFiles(),
        title: ($("title") && $("title").value) || "Page"
      }));
    } catch (e) {
      window.alert("This browser is blocking site storage, so the page "
                   + "cannot be handed to a new tab. Use the preview here instead.");
      return;
    }
    window.open("/play", "webide-play");
  }

  if ($("run-tab")) $("run-tab").addEventListener("click", runInNewTab);


  /* index.html first, then the rest alphabetically — the entry point should
     always be the leftmost tab. */
  function fileNames() {
    return [ENTRY].concat(
      Object.keys(docs).filter(function (n) { return n !== ENTRY; }).sort()
    );
  }

  /* A STUDENT SEES BOTH: the page and the notes, the notes under it, as on
     the live page. They took turns, and a student told to check after every
     step lost the step's slide each time they pressed Run or Check my work,
     and lost the results each time they went back to the slide. The notes
     button shows and hides the pane instead. Whoever is writing the notes
     keeps the turns: their .md opens in the editor (Edit source), and the
     teacher's editor has "Class sees" under it while live. */
  function notesBeside() { return !window.WEBIDE.authoring; }
  var notesOpen = "";        // which notes are up, while notesBeside()

  /* The notes are a column of their own now (index.html), so showing them
     never hides the page and Run never hides them: both stay up until the
     notes' Hide, or their button, puts them away. */
  function hideNotes() {
    notesView.hidden = true;
    notesOpen = "";
    // The author's .md tab stops being the lit one with its notes away —
    // unless its source is open in the editor, which is what they're editing.
    if (window.WebIDENotes.isMarkdown(active) && !mdSourceOpen) active = lastCodeFile;
    renderTabs();
    relayout();
  }
  var notesClose = $("notes-close");
  if (notesClose) notesClose.addEventListener("click", hideNotes);

  function showPreview() {
    previewView.hidden = false;
  }

  /* Always as slides when the notes have `---` in them, with ◀ ▶ under
     them (notes.js, slideView) — here, on a shared link, and on the class's
     page in a live lesson alike. */
  // `animate:` notes play a section at a time (notes.js, slideView): for a
  // student reading them, and for whoever is writing them, who gets Skip to
  // get past a part, or a slide, while they edit. Never while teaching live:
  // the projector shows the slide whole. Asked each time the notes are
  // shown, since going live and ending a lesson both change the answer.
  var notesSlides = window.WebIDENotes.slideView(notesBody, {
    animate: function () { return !window.WEBIDE.readonly && !liveCode; },
    skip: function () { return !!window.WEBIDE.authoring; },
    key: (window.WEBIDE.authoring ? "author:" : "") + (window.WEBIDE.assignmentSlug || location.pathname),
    // `locked: yes` holds the next slide until its checks pass — for a
    // student working, never the teacher writing them, nor while live.
    locked: function () { return !window.WEBIDE.authoring && !window.WEBIDE.readonly && !liveCode; }
  });

  function showNotes(name) {
    notesName.textContent = name;
    notesView.hidden = false;
    notesSlides.show(docs[name].getValue());
  }

  /* Which file the editor is actually editing.
     Deliberately different from `active`: selecting a .md tab makes it active
     but leaves the editor on the last code file, because notes render on the
     right rather than opening to be edited. So anything asking "what am I
     typing into?" has to ask this instead of `active`.

     That gap is worth a name because it has caused the same bug twice. A fork
     of a shared project opens on its notes tab, so `active` is the .md from
     the first moment — and every check written against `active` silently
     switched itself off for exactly the students following an assignment. */
  function editingFile() {
    if (window.WebIDENotes.isMarkdown(active)) {
      return mdSourceOpen ? active : lastCodeFile;
    }
    return active;
  }

  /* docs[] holds the Doc objects themselves and swapDoc doesn't change their
     identity, so there is nothing to write back when switching away. */
  function showEditorDoc(name) {
    if (editor.getDoc() !== docs[name]) editor.swapDoc(docs[name]);
    editor.setOption("mode", modeFor(name));
    editor.setOption("readOnly", window.WEBIDE.readonly ? "nocursor" : false);
  }

  function switchTo(name) {
    if (!docs[name]) return;

    if (window.WebIDENotes.isMarkdown(name) && notesBeside()) {
      notesOpen = name;      // the editor and `active` stay on the code
      showNotes(name);
      renderTabs();
      relayout();
      return;
    }

    if (window.WebIDENotes.isMarkdown(name)) {
      active = name;
      mdSourceOpen = false;
      showEditorDoc(lastCodeFile);      // editor stays on the code
      showNotes(name);
      renderTabs();
      relayout();
      return;
    }

    if (name === active && !mdSourceOpen) return;
    active = name;
    lastCodeFile = name;
    mdSourceOpen = false;
    showEditorDoc(name);
    showPreview();
    renderTabs();
    relayout();
    editor.focus();
  }

  /* NOTES ARE A BUTTON, NOT A TAB, for anyone reading notes they did not
     write — a student on an assignment, a shared link. They never edit the
     .md, so a tab beside index.html read as another file to type in, and
     once they went back to the page nothing said where the instructions had
     gone. A button in the top bar, named for the file (instructions.md is
     "instructions"), shows them and stays there to show them again.

     Whoever owns the notes — the teacher on their assignment, a student in
     their own project — keeps the tab, because that is where Edit source is.

     EXCEPT WHILE TEACHING LIVE. The teacher's editor is on the projector
     then, and a class whose own page has the notes as a button was being
     shown them as a tab. So live, the teacher gets the button too; Edit
     source is still in the notes pane it opens. A function, not a flag,
     because going live and ending a lesson both change the answer. */
  function notesAsButtons() { return !window.WEBIDE.authoring || !!liveCode; }
  var notesBar = $("notes-buttons");

  function renderNotesButtons() {
    if (!notesBar) return;
    notesBar.textContent = "";
    if (!notesAsButtons()) return;
    fileNames().filter(window.WebIDENotes.isMarkdown).forEach(function (name) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "btn notes-btn";
      var on = !notesView.hidden && (notesBeside() ? notesOpen === name : name === active);
      b.setAttribute("aria-pressed", String(on));
      b.textContent = name.replace(/\.(md|markdown)$/i, "");
      b.title = on ? "Hide " + name : "Show " + name;
      b.addEventListener("click", function () {
        // A second press hides them.
        if (on) hideNotes();
        else switchTo(name);
      });
      notesBar.appendChild(b);
    });
  }

  function renderTabs() {
    tabsEl.textContent = "";
    renderNotesButtons();
    fileNames().filter(function (name) {
      return !(notesAsButtons() && window.WebIDENotes.isMarkdown(name));
    }).forEach(function (name) {
      var tab = document.createElement("button");
      tab.type = "button";
      // With the notes up from their button, the editor still holds the
      // code file, so that tab stays lit rather than none at all.
      var on = name === active || (notesAsButtons() && name === lastCodeFile
                                   && window.WebIDENotes.isMarkdown(active));
      tab.className = "tab" + (on ? " tab-on" : "");
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(on));

      var label = document.createElement("span");
      label.textContent = name;
      tab.appendChild(label);
      tab.addEventListener("click", function () { switchTo(name); });

      // index.html is the page itself; notes belong to whoever set the work
      var removable = name !== ENTRY && !window.WEBIDE.readonly &&
        (!window.WebIDENotes.isMarkdown(name) || window.WEBIDE.authoring);
      if (removable) {
        var x = document.createElement("span");
        x.className = "tab-x";
        x.textContent = "×";
        x.title = "Remove " + name;
        x.addEventListener("click", function (e) {
          e.stopPropagation();
          removeFile(name);
        });
        tab.appendChild(x);
      }
      tabsEl.appendChild(tab);
    });
  }

  function addFile(name, text) {
    docs[name] = CodeMirror.Doc(text || "", modeFor(name));
    renderTabs();
    // adding a file is a change, but fires no editor change event
    if (account) account.noteEdit();
  }

  function removeFile(name) {
    if (name === ENTRY) return;
    if (!window.confirm("Remove " + name + " from this project?")) return;
    if (active === name) {
      active = ENTRY;
      lastCodeFile = ENTRY;
      showEditorDoc(ENTRY);
      showPreview();
    }
    delete docs[name];
    renderTabs();
    relayout();
    if (account) account.noteEdit();
  }

  /* A new page starts as a real page rather than an empty file. A blank .html
     is a poor place for a beginner to land — they need the doctype and head
     they were given on day one, and the stylesheet link is the thing most
     often forgotten on a second page, so the new page looks unstyled and the
     student concludes their CSS is broken. The link home comes with it,
     because that is the whole point of adding a second page.

     No <script src="script.js"> though, deliberately. Shared JavaScript
     usually reaches for elements that only exist on the page it was written
     for — the starter script.js grabs #cheer, which lives on index.html — so
     including it here would greet every new page with a null reference on
     line 3. The comment says how to add it for anyone who wants it. */
  function starterFor(name) {
    if (!/\.html?$/i.test(name)) return "";
    var title = name.replace(/\.html?$/i, "").replace(/[-_]+/g, " ").trim();
    title = title.charAt(0).toUpperCase() + title.slice(1);
    return '<!DOCTYPE html>\n' +
      '<html lang="en">\n' +
      '<head>\n' +
      '  <meta charset="utf-8">\n' +
      '  <title>' + title + '</title>\n' +
      '  <link rel="stylesheet" href="style.css">\n' +
      '</head>\n' +
      '<body>\n' +
      '  <h1>' + title + '</h1>\n' +
      '  <p><a href="' + ENTRY + '">Back to home</a></p>\n' +
      '\n' +
      '  <!-- This page has no JavaScript yet. To give it some, add:\n' +
      '       <script src="script.js"><' + '/script> -->\n' +
      '</body>\n' +
      '</html>\n';
  }

  var newFileBtn = $("new-file");
  if (newFileBtn) {
    newFileBtn.addEventListener("click", function () {
      var name = (window.prompt(
        "Name for the new file, with an extension:", "about.html") || "").trim();
      if (!name) return;
      if (!NAME_OK.test(name)) {
        write("\n'" + name + "' won't work as a file name. Use letters, digits," +
              " dashes and underscores, ending in something like .html, .css" +
              " or .js.\n", "err");
        return;
      }
      if (docs[name]) { switchTo(name); return; }
      addFile(name, starterFor(name));
      switchTo(name);
    });
  }

  if (notesEditBtn) {
    notesEditBtn.addEventListener("click", function () {
      if (!window.WebIDENotes.isMarkdown(active)) return;
      mdSourceOpen = !mdSourceOpen;
      notesEditBtn.textContent = mdSourceOpen ? "Done" : "Edit source";
      showEditorDoc(mdSourceOpen ? active : lastCodeFile);
      relayout();
      if (mdSourceOpen) editor.focus();
    });
  }

  /* PICTURES IN THE NOTES, for a teacher (pictures.js; the server refuses
     anyone else). Add picture opens the source first, so the teacher sees
     where it lands; paste and drop work only while the .md source is in the
     editor — the same CodeMirror holds index.html, and a picture dropped on
     code is left to the browser as it always was. */
  var notesPicBtn = $("notes-pic");
  if (notesPicBtn && notesEditBtn) {
    window.WebIDEPictures.attach(editor, function () {
      return mdSourceOpen && window.WebIDENotes.isMarkdown(active);
    });
    notesPicBtn.addEventListener("click", function () {
      if (!window.WebIDENotes.isMarkdown(active)) return;
      if (!mdSourceOpen) notesEditBtn.click();
      var doc = docs[active];
      window.WebIDEPictures.choose(function (files) {
        window.WebIDEPictures.insertInto(doc, files);
        editor.focus();
      });
    });
  }

  renderTabs();

  /* A shared assignment should open on the notes, not on the markup. */
  (function openNotesForViewers() {
    if (window.WEBIDE.authoring) return;
    var md = fileNames().filter(window.WebIDENotes.isMarkdown);
    if (md.length) switchTo(md[0]);
  })();

  // --------------------------------------------------------------- console
  function write(text, cls) {
    var node = document.createElement("span");
    if (cls) node.className = cls;
    node.textContent = text;
    outputEl.appendChild(node);
    outputEl.scrollTop = outputEl.scrollHeight;
  }
  function clearOutput() { outputEl.textContent = ""; }
  $("clear").addEventListener("click", clearOutput);

  // ------------------------------------------------------------------- run
  var token = null;        // identifies messages from the current preview
  var offsets = {};        // maps document lines back to the student's files
  var running = false;
  var backBar = $("preview-trail");
  var backBtn = $("preview-back");
  var pageLabel = $("preview-page");

  function setBusy(state) {
    running = state;
    stopBtn.hidden = !state;
  }

  /* Throw the old preview away and put a clean one in its place.
     Replacing the element rather than reassigning srcdoc matters: a student's
     `while (true)` wedges that frame's process, and a wedged frame can't
     navigate itself. Removing the element kills it outright, which is why
     Stop still works during an infinite loop. The editor stays responsive
     throughout because the null-origin frame runs in its own process. */
  function freshFrame() {
    var old = frame;
    var next = document.createElement("iframe");
    next.id = "preview";
    next.title = "Page preview";
    next.setAttribute("sandbox", "allow-scripts allow-forms");
    old.parentNode.replaceChild(next, old);
    frame = next;
    return next;
  }

  /* Which of the student's pages the preview is showing, and how it got
     there. A project is usually one page and this stays empty; a site with a
     nav bar walks through it. */
  var page = ENTRY;
  var trail = [];

  /* Render one page. `sent` carries what a form on the previous page
     submitted, so the page it lands on can say something about it. */
  function render(name, sent) {
    var files = allFiles();
    lastBuilt = "";
    if (!files[ENTRY]) {
      write("\nThere's no " + ENTRY + " to open.\n", "err");
      return;
    }
    if (files[name] === undefined) name = ENTRY;
    page = name;

    /* Not over the notes. The page draws itself on load and again on every
       pause in typing, and switching the pane each time hid the notes a
       student was reading — on load the editor opened on the notes and this
       covered them at once, with their tab (now their button) still lit.
       The page still builds underneath; Run is what brings it into view. */
    if (!window.WebIDENotes.isMarkdown(active)) showPreview();
    clearOutput();

    token = "w" + Date.now() + Math.random().toString(36).slice(2, 8);
    var built = window.WebIDERun.assemble(files, token, page, sent);
    offsets = built.offsets;
    lastBuilt = built.html;

    lastRun = signature(files);
    // Running again is how a student says "carry on" after a Stop.
    autoPaused = false;

    setBusy(true);
    freshFrame().srcdoc = built.html;
    paintTrail();
    relayout();
  }

  /* Run always goes home. A student who has clicked three pages deep and
     wants a clean start shouldn't have to find their way back first — and
     "Run shows me my homepage" is one less rule to remember. Auto-refresh is
     the opposite: it updates whatever is on screen, because being thrown back
     to the homepage every time you edit your About page would be unusable. */
  /* What a live lesson shows the class of this page. `lastBuilt` is every
     render — auto-refresh and clicking through pages included — and
     `sharedPage` is only what Run made. The class is sent the second: the
     preview re-renders on every pause in typing, and each of those pulling
     thirty students' panes over to a half-typed page would be a lesson
     nobody could follow. Pressing Run is the teacher saying "look".

     `hasRun` likewise: until Run is pressed, the console holds only "Page
     loaded" and nothing is sent at all. That is also why the page's own
     first paint, below, is a render and not a run. */
  var lastBuilt = "";
  var sharedPage = "";
  var hasRun = false;

  function run() {
    // Run shows the page, so with the notes up it goes back to the code —
    // through switchTo, which lights the right tab and button as it goes.
    if (window.WebIDENotes.isMarkdown(active)) switchTo(lastCodeFile);
    trail = [];
    render(ENTRY);
    sharedPage = lastBuilt;
    hasRun = true;
    xpWatch = { token: token, failed: false };
  }

  /* XP for a page that worked (xp.js). A page has no "finished": it counts
     when Run is pressed — not the redraw on every pause in typing — the page
     loads, and no error comes back from it in the next moment and a half.
     The server decides whether it pays; this only says it worked. */
  var xpWatch = null;
  var XP_CODE = /\.(html?|css|js)$/i;
  function xpLoaded() {
    var w = xpWatch;
    if (!w || w.token !== token) return;
    setTimeout(function () {
      if (xpWatch === w && !w.failed && token === w.token) reportRun();
      if (xpWatch === w) xpWatch = null;
    }, 1500);
  }
  function reportRun() {
    if (!window.WEBIDE.signedIn || window.WEBIDE.viewOnly || window.WEBIDE.readonly ||
        window.WEBIDE.isTeacher || !window.PyIDEXP) return;
    window.PyIDEXP.ran(allFiles(), XP_CODE);
  }

  /* Follow a link or a form's action to another of the student's pages. */
  function goToPage(name, sent) {
    if (name !== page) trail.push(page);
    render(name, sent);
  }

  function goBack() {
    if (!trail.length) return;
    render(trail.pop());
  }

  function paintTrail() {
    if (!backBar) return;
    var away = page !== ENTRY || trail.length > 0;
    backBar.hidden = !away;
    if (away) pageLabel.textContent = page;
    backBtn.disabled = trail.length === 0;
  }

  function stop() {
    freshFrame();          // tears down timers, listeners, sound and any loop
    token = null;
    setBusy(false);
    /* Stop has to mean stop. Without this the next keystroke would start the
       program up again a moment later, which reads as a broken button —
       especially for the runaway loop Stop exists to deal with. */
    autoPaused = true;
    write("\n— stopped —\n", "dim");
  }

  runBtn.addEventListener("click", run);
  stopBtn.addEventListener("click", stop);

  /* Check my work: the tests in the notes (autograde.js), run here on the
     page as it is in the editor now, as often as the student likes. It is
     feedback: the result is kept for the teacher to see, but what counts is
     the teacher's Check all on what was turned in — a check run in this
     browser could be faked. Only from the ✔ on the notes' tests cards
     (checks_in_notes.js): the button at the top came out, so students
     check beside the step. The cards' runner was once registered only when
     that button was there, which would now leave them nothing to run. */
  var checking = false;

  function testsHere() {
    return window.WebIDETests ? window.WebIDETests.fromFiles(allFiles()).tests : [];
  }

  /* The run itself: every test in the notes, on the page as it is now
     (in a frame of its own; autograde.js). The notes' tests cards
     (checks_in_notes.js) show the results; the student's result is kept
     for the teacher here. Null when it can't run now. */
  async function runChecks() {
    if (checking) return null;
    var files = allFiles(), tests = testsHere();
    if (!tests.length) return null;
    checking = true;
    try {
      var got = await window.WebIDETests.run(files, tests);
      if (window.WEBIDE.signedIn && window.WEBIDE.assignmentSlug && !window.WEBIDE.viewOnly) {
        fetch("/api/tests/self", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ assignment: window.WEBIDE.assignmentSlug, results: got.results })
        }).then(function (r) { return r.ok ? r.json() : null; })
          .then(function (d) {
            // A little XP for each test passing for the first time (app.py, _self_tests_xp).
            if (d && d.xp > 0 && window.PyIDEXP) {
              window.PyIDEXP.toast("+" + d.xp + " XP · new tests passing");
            }
          })
          .catch(function () {});
      }
      return got;
    } finally {
      checking = false;
    }
  }
  // The notes' own ✔ Check my work, on each tests card.
  if (window.IDENotesChecks) window.IDENotesChecks.setRunner(runChecks);

  if (backBtn) backBtn.addEventListener("click", goBack);

  /* A link to another site, opened on the preview's behalf.
     The preview can't do this itself — no allow-popups in its sandbox, on
     purpose — so it asks, and the tab is opened from here. The click that
     started it also gives this window transient activation, which is what
     keeps the browser from treating the new tab as an unprompted pop-up.

     The URL arrives from student content, so it is checked again here rather
     than trusted: only http and https, whatever the frame claimed to send. */
  function openExternal(url) {
    if (!/^https?:\/\//i.test(url)) {
      write("\nThat link didn't point at a web address, so nothing opened: "
            + url + "\n", "dim");
      return;
    }
    var opened = null;
    try {
      opened = window.open(url, "_blank");
      // the opened page must not be able to reach back into the editor
      if (opened) { try { opened.opener = null; } catch (e) {} }
    } catch (e) { /* blocked; handled below */ }

    if (opened) {
      write("\nOpened in a new tab: " + url + "\n", "dim");
    } else {
      write("\nYour browser blocked a new tab for " + url +
            "\nAllow pop-ups for this site, or copy the address above.\n", "dim");
    }
  }

  /* What the preview reports when a form is submitted and the student hasn't
     written a handler for it. There is no server to post to, so the next best
     thing is showing them exactly what their form produced — which is the
     part of a form that's worth looking at anyway. */
  function reportForm(data) {
    var fields = data.fields || [];
    var sent = {};
    fields.forEach(function (pair) { sent[pair[0]] = pair[1]; });

    /* Move first, then report: rendering a page clears the console, so a
       summary written before the navigation would be wiped by it. */
    if (data.action) goToPage(data.action, sent);

    if (!fields.length) {
      write("\nForm submitted, but no field had a name attribute — that is "
            + "what a form sends, so give each input a name and the values "
            + "will show up here.\n", "dim");
    } else {
      write("\nForm submitted (" + (data.method || "get") + "):\n", "dim");
      fields.forEach(function (pair) {
        write("   " + pair[0] + " = " + pair[1] + "\n");
      });
    }

    if (!data.action) {
      write("It didn't go anywhere: sending a form somewhere real needs a "
            + "server. Point the form's action at another page in this "
            + "project to move there.\n", "dim");
    }
  }

  // ---------------------------------------------------------- auto refresh
  /* The preview follows the typing, so changing a colour doesn't need a trip
     to the toolbar. Pressing Run stays useful — for restarting a page on
     purpose — but nobody has to press it to see their own edit.
     A pause rather than a keystroke: re-rendering on every character would
     spend most of its time showing half-typed tags and unfinished selectors.
     700ms is long enough for a tag to be finished and short enough to still
     feel like a consequence of what was typed. */
  var AUTO_DELAY = 700;
  var autoTimer = null;
  var autoPaused = false;   // set by Stop, cleared by Run
  var lastRun = null;       // what was on screen last, so a no-op edit is free
  var autoBox = $("auto-run");

  function signature(files) {
    return JSON.stringify(files);
  }

  function autoKey() {
    return "webide-autorun";
  }

  /* Held in memory as well as in storage. A browser with site data blocked
     would otherwise revert the box on the next keystroke, because paintAuto
     re-reads the answer and would find nothing saved. */
  var autoChoice = {};

  function autoWanted() {
    var key = autoKey();
    if (key in autoChoice) return autoChoice[key];
    try {
      var saved = localStorage.getItem(key);
      if (saved === "on" || saved === "off") {
        autoChoice[key] = saved === "on";
        return autoChoice[key];
      }
    } catch (e) { /* storage blocked; fall through to the default */ }
    return true;
  }

  function paintAuto() {
    if (!autoBox) return;
    autoBox.checked = autoWanted();
    autoBox.parentNode.title =
      "Update the preview when you stop typing, without pressing Run.";
  }

  function scheduleAuto() {
    clearTimeout(autoTimer);
    if (!autoBox || !autoBox.checked || autoPaused) return;
    if (window.WEBIDE.readonly) return;
    /* Editing the assignment notes changes nothing the preview shows — but
       ask what the editor holds, not which tab is lit. A fork opens on its
       notes tab while the editor is on index.html, and asking `active` here
       meant auto-refresh never fired for anyone working from an assignment. */
    if (window.WebIDENotes.isMarkdown(editingFile())) return;

    autoTimer = setTimeout(function () {
      if (!autoBox.checked || autoPaused) return;
      var files = allFiles();
      // typed and then undone, or a change in a file the page doesn't use
      if (signature(files) === lastRun) return;
      /* render, not run: a student editing about.html should see about.html
         update, not be thrown back to the homepage on every pause. */
      render(page);
    }, AUTO_DELAY);
  }

  if (autoBox) {
    paintAuto();
    autoBox.addEventListener("change", function () {
      var key = autoKey();
      autoChoice[key] = autoBox.checked;
      try {
        localStorage.setItem(key, autoBox.checked ? "on" : "off");
      } catch (e) { /* blocked; the choice lasts for this page only */ }
      if (autoBox.checked) scheduleAuto();
      else clearTimeout(autoTimer);
    });
  }

  window.addEventListener("message", function (e) {
    var data = e.data;
    if (!data || typeof data !== "object" || !token || data.webide !== token) return;
    // only the live preview may write to the console
    if (e.source !== frame.contentWindow) return;

    if (data.kind === "error" && xpWatch) xpWatch.failed = true;
    if (data.kind === "ready") {
      setBusy(false);
      if (!outputEl.textContent.trim()) {
        write("Page loaded. console.log messages appear here.\n", "dim");
      }
      xpLoaded();
      return;
    }

    /* A link to another of the student's pages. The preview can't navigate
       there itself — it has no address — so it asks, and we rebuild. */
    if (data.kind === "nav") {
      goToPage(String(data.text));
      return;
    }
    if (data.kind === "form") {
      reportForm(data);
      return;
    }
    if (data.kind === "open") {
      openExternal(String(data.text));
      return;
    }
    if (data.kind === "note") {
      write(String(data.text) + "\n", "dim");
      return;
    }

    var where = window.WebIDERun.locate(data.file, data.line, offsets);
    var cls = data.kind === "error" ? "err" : (data.kind === "warn" ? "warn" : "");
    write(String(data.text) + (where ? "   (" + where + ")" : "") + "\n", cls);
  });

  document.addEventListener("keydown", function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      run();
    }
  });

  // ---------------------------------------------------------- completion
  var hintTimer = null;
  editor.on("change", function (cm, change) {
    if (window.WEBIDE.readonly) return;

    // markdown open for editing: keep the rendered notes in step, suggest
    // nothing — prose has no names to complete
    if (mdSourceOpen && window.WebIDENotes.isMarkdown(active)) {
      notesSlides.show(docs[active].getValue());
      return;
    }

    // the file being typed into, which is not the lit tab when notes are shown
    var file = editingFile();
    if (window.WebIDENotes.isMarkdown(file)) return;

    var typed = change.origin === "+input" && change.text.join("");
    if (typed && /^[A-Za-z0-9_-]$/.test(typed)) {
      clearTimeout(hintTimer);
      hintTimer = setTimeout(function () {
        if (!cm.state.completionActive) {
          window.WebIDEComplete.show(cm, file, allFiles());
        }
      }, 140);
    }
  });

  editor.on("change", function (cm, change) {
    paintAuto();
    scheduleAuto();
    rescue.noteEdit();
    // Typed, pasted or dropped — not a starter or a file put in by the page.
    if (change.origin !== "setValue") typedHere = true;
  });

  /* THE LOGO GOES TO THE FRONT DOOR — a student's classes, a teacher's
     dashboard. A saved project has lost nothing by leaving: it autosaves,
     and pagehide sends whatever is pending (account.js). A project with
     nowhere to save to — the blank editor, before Save — is the one case
     where a click on the logo would throw typing away without a word, so
     that one asks. */
  var typedHere = false;
  // Update assignment (or Publish) saved what's here: nothing to lose now.
  // Without this the teacher's own edit page, which has no draft, warned
  // "isn't saved" right after a successful update.
  document.addEventListener("webide:assignmentsaved", function () { typedHere = false; });
  var homeLink = document.getElementById("home-link");
  if (homeLink) {
    homeLink.addEventListener("click", function (e) {
      if (window.WEBIDE.readonly || window.WEBIDE.draftSlug || !typedHere) return;
      if (!window.confirm("Leave this page? What you've typed here isn't saved.")) {
        e.preventDefault();
      }
    });
  }

  /* The handles between the panes (split.js), the same ones the class's live
     page has. The editor is told, because CodeMirror measures itself only
     on a window resize. The preview is an iframe at 100% of its pane and
     follows by itself. */
  window.WebIDESplit.attachAll(document, {
    wide: window.matchMedia ? window.matchMedia("(min-width: 861px)") : null,
    onResize: function () { editor.refresh(); }
  });

  // ----------------------------------------------------- saving and turn-in
  /* Dormant unless somebody is signed in and this is a saved project. */
  /* The safety net for anyone not signed in — attached before the account
     module, so a rescued project is in the editor before autosave forms an
     opinion about what the project is. */
  var rescue = window.IDERescue.attach({
    app: "webide",
    cfg: {
      signedIn: window.WEBIDE.signedIn,
      assignmentSlug: window.WEBIDE.assignmentSlug,
      draftSlug: window.WEBIDE.draftSlug,
      draftFresh: window.WEBIDE.draftFresh
    },
    readAll: allFiles,
    writeAll: function (incoming) {
      Object.keys(docs).forEach(function (name) { delete docs[name]; });
      Object.keys(incoming).forEach(function (name) {
        docs[name] = CodeMirror.Doc(incoming[name], modeFor(name));
      });
      // A WebIDE project is its entry page; without one there are no tabs
      // and nothing to run.
      if (!docs[ENTRY]) docs[ENTRY] = CodeMirror.Doc("", "htmlmixed");
      active = ENTRY;
      showEditorDoc(ENTRY);
      renderTabs();
      relayout();
    },
    onRestored: function () { if (account) account.noteEdit(); }
  });

  account = window.WebIDEAccount.attach({
    read: function () {
      return { files: allFiles(), title: $("title").value };
    },
    say: write
  });

  editor.on("change", function () { account.noteEdit(); });


  // ----------------------------------------------------------------- share
  var shareBtn = $("share");
  var hideCode = $("hide-code");   // a teacher's, in the share-ask dialog

  /* Two kinds of link come out of one button, so the dialog has to say which
     one it just produced — an accidental tick is otherwise invisible until a
     student opens the link and finds no code. */
  function describeShare(hidden) {
    $("modal-title").textContent = hidden ? "Demo link ready" : "Project shared";
    $("modal-sub").textContent = hidden
      ? "This link shows the finished page. The source is not on it."
      : "Anyone with this link can open and run this snapshot.";
    $("modal-note").textContent = hidden
      ? "Nobody can read, fork or download the source from this link — "
        + "including you, so keep your own copy. Recovering it would take the "
        + "browser's developer tools, which is a fair barrier for a class but "
        + "not a lock."
      : "The link captures every file exactly as it is right now. "
        + "If you keep working, share again to create an updated link.";
  }

  function flagAuthor(message) {
    authorField.classList.add("field-bad");
    authorField.setAttribute("aria-invalid", "true");
    authorField.focus();
    write("\n" + message + "\n", "err");
  }

  if (authorField) {
    authorField.addEventListener("input", function () {
      authorField.classList.remove("field-bad");
      authorField.removeAttribute("aria-invalid");
    });
  }

  /* A teacher's Share opens share-ask first, to choose between a plain link
     and a demo link; a student's goes straight to sharing. The box is
     unticked every time the dialog opens, so a demo link is always a choice
     made just now and never one left over from the last share. */
  async function doShare(hidden) {
    if (!authorField.value.trim()) {
      flagAuthor("Put your name in the box at the top before sharing.");
      return;
    }
    // Pressed from the account menu there is no Share on the bar to show
    // "Sharing…" on, and a stand-in keeps the lines below from caring.
    var btn = shareBtn || document.createElement("button");
    btn.disabled = true;
    var original = btn.textContent;
    btn.textContent = "Sharing…";
    try {
      var res = await fetch(window.WEBIDE.shareUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: $("title").value,
          author: authorField.value,
          files: allFiles(),
          hidden: !!hidden
        })
      });
      var data = await res.json();
      if (!res.ok) {
        if (data.field === "author") { flagAuthor(data.error); return; }
        throw new Error(data.error || "Could not share this project.");
      }
      // the server decides, not the checkbox — they agree, but only one of
      // them knows what actually got written
      describeShare(!!data.hidden);
      $("share-url").value = data.url;
      $("modal").hidden = false;
      $("share-url").select();
    } catch (e) {
      write("\nShare failed: " + e.message + "\n", "err");
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  }

  var shareAsk = $("share-ask");
  if (shareBtn) {
    shareBtn.addEventListener("click", function () {
      if (!shareAsk) { doShare(false); return; }
      if (hideCode) hideCode.checked = false;
      shareAsk.hidden = false;
      $("share-go").focus();
    });
  }
  // A signed-in student's Share, out of the way in the account menu: they
  // have Save or Turn in on the bar, and that is the one thing to press.
  if ($("share-menu")) {
    $("share-menu").addEventListener("click", function () { doShare(false); });
  }
  if (shareAsk) {
    $("share-go").addEventListener("click", function () {
      shareAsk.hidden = true;
      doShare(!!(hideCode && hideCode.checked));
    });
    $("share-cancel").addEventListener("click", function () { shareAsk.hidden = true; });
    shareAsk.addEventListener("click", function (e) {
      if (e.target === shareAsk) shareAsk.hidden = true;
    });
  }

  $("copy").addEventListener("click", function () {
    var field = $("share-url");
    field.select();
    navigator.clipboard.writeText(field.value).then(function () {
      $("copy").textContent = "Copied";
      setTimeout(function () { $("copy").textContent = "Copy"; }, 1500);
    }, function () { document.execCommand("copy"); });
  });

  $("close-modal").addEventListener("click", function () { $("modal").hidden = true; });
  $("modal").addEventListener("click", function (e) {
    if (e.target === $("modal")) $("modal").hidden = true;
  });

  // -------------------------------------------------------------- download
  /* The whole project as a zip, so a student can unzip it, double-click
     index.html and have it run with no internet. That works because the files
     keep real relative links rather than being inlined, so
     <link href="style.css"> resolves against the folder just as it resolved
     against this server in the preview. */
  /* Download sits in the account menu for a signed-in student, in the
     dialog Share opens for a signed-out one, and on the bar only when there
     is no sign-in at all — so bind every one that is actually on the page. */

  function projectFileName() {
    var base = ($("title").value || "project")
      .replace(/[^\w -]+/g, "").trim().replace(/\s+/g, "-").toLowerCase();
    return (base || "project") + ".zip";
  }

  ["download", "download-menu", "download-share"].forEach(function (id) {
    var downloadBtn = $(id);
    if (downloadBtn) downloadBtn.addEventListener("click", function () {
      var files = allFiles();
      var entries = Object.keys(files).sort().map(function (name) {
        return { name: name, data: files[name] };
      });

      var original = downloadBtn.textContent;
      downloadBtn.disabled = true;

      try {
        window.WebIDEZip.download(projectFileName(), entries);
      } catch (e) {
        write("\nCould not build the download: " + e.message + "\n", "err");
      } finally {
        downloadBtn.disabled = false;
        downloadBtn.textContent = original;
      }
    });
  });

  // show something straight away rather than an empty white rectangle —
  // render, not run: nobody has pressed Run yet (see sharedPage)
  render(ENTRY);
  // ------------------------------------------------------------ teach live
  //
  // Go live and carry on working. Whatever file is open here is what the
  // class sees at /live/<code>; switching tabs switches what they are
  // watching, which is what a teacher means by "look at this bit".
  //
  // The file is sent WHOLE, every time, rather than as a diff. A diff stream
  // is smaller and needs every update to arrive, in order — which polling
  // cannot promise. Sending the whole file means a student whose wifi drops
  // ten updates is correct again on the eleventh, and a student who joins in
  // the middle needs no catch-up path at all.

  var liveBtn = $("go-live");
  var liveChip = $("live-code");

  if (liveBtn) {
    var liveCode = null;

    /* WHICH TAB IS ON THE AIR. A reload of the tab teaching must carry on
       broadcasting, so the lesson is remembered — but per TAB
       (sessionStorage), with the page it was on. It was remembered for the
       whole browser, so ANY editor the teacher opened while live — a new
       tab, the logo, New project, Student view — rejoined the lesson and
       sent the class its own file: the class watched an untitled default
       template while the teacher typed in another tab, and a Go live there
       then ended the real lesson under them. Now only that tab, on that
       page, picks the lesson back up. */
    var HOST_KEY = "webide-live-host";
    try { localStorage.removeItem(HOST_KEY); } catch (e) { /* the old, shared marker */ }
    var rememberLive = function (code, slug) {
      try {
        sessionStorage.setItem(HOST_KEY, JSON.stringify({ code: code, path: location.pathname,
                                                          slug: slug || "" }));
      } catch (e) { /* storage blocked: a reload will need Go live again */ }
    };
    var forgetLive = function () {
      try {
        sessionStorage.removeItem(HOST_KEY);
        sessionStorage.removeItem(FILES_KEY);
      } catch (e) {}
    };

    /* WHAT WAS ON SCREEN, for a reload mid-lesson. Go live from the class
       page teaches on /new, the editor's blank page, and clears the lesson
       out of the address bar — so a reload there came back as the default
       template, resumed the broadcast, and sent that template to the class
       over the lesson's last code. The teacher's work was gone from the
       editor AND from the server, with nothing saying so (found in PyIDE,
       mid-lesson). Now the tab keeps its files as it unloads
       (sessionStorage: this tab only, gone when it closes) and a reload puts
       them back before it goes back on the air. Written on pagehide rather
       than every push: data files can be large, and a reload is the only
       thing this is for. */
    var FILES_KEY = "webide-live-files";
    window.addEventListener("pagehide", function () {
      if (!liveCode) return;
      var all = allFiles();
      try {
        sessionStorage.setItem(FILES_KEY, JSON.stringify({
          code: liveCode, path: location.pathname, files: all, active: active,
          title: ($("title") && $("title").value) || ""
        }));
      } catch (e) {
        // Too big for storage: the reload falls back on the lesson's last file.
        try { sessionStorage.removeItem(FILES_KEY); } catch (e2) {}
      }
    });
    var keptFiles = function (code) {
      try {
        var kept = JSON.parse(sessionStorage.getItem(FILES_KEY) || "null");
        return kept && kept.code === code && kept.path === location.pathname
          && kept.files && typeof kept.files === "object" ? kept : null;
      } catch (e) { return null; }
    };
    var liveSlug = function () {
      try { return (JSON.parse(sessionStorage.getItem(HOST_KEY) || "null") || {}).slug || ""; }
      catch (e) { return ""; }
    };
    var liveToResume = function () {
      try {
        var saved = JSON.parse(sessionStorage.getItem(HOST_KEY) || "null");
        return saved && saved.path === location.pathname ? saved.code : null;
      } catch (e) { return null; }
    };
    var liveTimer = null;
    var lastSent = null;
    var lastVersion = 0;
    var liveFor = "";           // assignment title, for the chip's tooltip
    var PUSH_MS = 400;

    /* A stamp that only ever goes up, and the server refuses anything lower
       than the row already has. Two pushes overtaking each other on a slow
       connection would otherwise leave the OLDER text on screen with the
       newer version number, and the class would sit looking at a line that
       had already been fixed.

       Date.now() rather than a counter starting at 1, so that reloading this
       page mid-lesson does not start numbering below what the row has
       reached — which would get every push after the reload rejected, with
       the mirror silently frozen and the button still saying Live. The
       max() covers a machine whose clock is behind the one that started it. */
    function nextSeq() {
      lastVersion = Math.max(Date.now(), lastVersion + 1);
      return lastVersion;
    }

    /* The project's notes: its first .md, the same one a student opening the assignment link is shown first. Sent on every push so the class keeps
       them beside the lesson whichever tab is open here — before this, they
       reached the class only while the .md tab was selected. */
    function notesFile() {
      var md = fileNames().filter(window.WebIDENotes.isMarkdown);
      return md.length ? md[0] : null;
    }

    function liveNotes() {
      var md = notesFile();
      return md ? docs[md].getValue() : "";
    }

    /* ------------------------------------------------------------ slides
       Notes with `---` dividers are slides. The class is sent the WHOLE
       file and "3/5", the slide this teacher is on: every student can move
       through the slides on their own (notes.js, slideView), and each time
       the teacher moves, every screen jumps to the teacher's slide. Sending
       one slide at a time, as this did first, made reading ahead or going
       back to an earlier question impossible.

       `slideAt` is an index that survives editing the notes mid-lesson, and
       is clamped when slides are deleted out from under it. Two slides at
       least, or it is not slides: a file whose one `---` leaves only one
       slide with anything on it goes whole.

       There was a Show all button that sent the whole file as one page.
       With students free to move through the slides it had nothing left
       to do, and it went. */
    var slideAt = 0;
    var slideCtl = $("live-slides");
    var slideLabel = $("slide-at");

    function currentSlides() {
      var cut = window.WebIDENotes.slides(liveNotes());
      return cut.length >= 2 ? cut : null;
    }

    function paintSlides(cut) {
      if (!slideCtl) return;
      slideCtl.hidden = !(liveCode && cut);
      if (slideCtl.hidden) return;
      slideLabel.textContent = (slideAt + 1) + " / " + cut.length;
      $("slide-prev").disabled = slideAt <= 0;
      $("slide-next").disabled = slideAt >= cut.length - 1;
    }

    function moveSlide(by) {
      var cut = currentSlides();
      if (!liveCode || !cut) return;
      slideAt = Math.max(0, Math.min(cut.length - 1, slideAt + by));
      pushNow();                 // now, not on the next tick
    }

    if (slideCtl) {
      $("slide-prev").addEventListener("click", function () { moveSlide(-1); });
      $("slide-next").addEventListener("click", function () { moveSlide(1); });
    }

    /* The slide the class is on, shown here under the preview — or the whole
       notes when they are not slides. Fed by pushNow from the very cut and
       `slide` it sends, so it cannot disagree with the class about which
       slide that is — a copy worked out separately from slideAt could.

       Re-rendered only when they change. pushNow runs on every tick, and
       rendering markdown that often would reset the scroll under the
       teacher's hand. */
    var classView = $("class-view");
    var classNotes = $("class-notes");
    var classShownNotes = null, classShownSlide = null;

    /* `theme` is the deck's (notes.js, takeTheme). One slide on its own no
       longer has the theme: line, which sits above the first slide, and
       rendered without it this pane showed the deck plain while the class
       saw it themed. Part of what is compared, so changing only the theme
       line redraws. */
    var classShownTheme = null;
    function paintClassView(notes, slide, theme) {
      if (!classView) return;
      if (notes === classShownNotes && slide === classShownSlide
          && theme === classShownTheme) return;
      classShownTheme = theme;
      var moved = slide !== classShownSlide;
      classShownNotes = notes;
      classShownSlide = slide;
      classView.hidden = !(notes && notes.trim());
      if (classView.hidden) return;
      window.WebIDENotes.render(classNotes, notes,
                                 slide ? { theme: theme } : undefined).then(function () {
        if (moved) classNotes.scrollTop = 0;
      });
    }

    // ------------------------------------------------ the laser pointer
    /* Hold Alt and point (static/laser.js has how, and why it is not a
       push). Over the code, the open file's line and character — not for a
       markdown file, which the class reads rendered, so its lines are
       nowhere on their screen. Over the notes here, the "Class sees" pane
       or the popped-out slides, a place on that slide: each says which
       slide it is showing, and a student on another one sees no dot. */
    function sendPointer(pointer, path) {
      if (!liveCode) return;
      fetch("/api/live/" + encodeURIComponent(liveCode) + "/point", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pointer: pointer, path: path || "", seq: nextSeq() })
      }).catch(function () {
        // A dropped one is fine: the next move, or the beat, sends it again.
      });
    }
    window.LiveLaser.teacher({
      active: function () { return !!liveCode; },
      send: sendPointer,
      surfaces: function () {
        var L = window.LiveLaser, list = [];
        if (!window.WebIDENotes.isMarkdown(active)) {
          list.push({ el: editor.getWrapperElement(),
                      point: function (x, y) { return L.pointAtCode(editor, x, y); } });
        }
        if (!notesView.hidden) {
          list.push({ el: notesBody,
                      point: function (x, y) { return L.pointAtSlide(notesBody, notesSlides.at(), x, y); } });
        }
        if (classView && !classView.hidden) {
          list.push({ el: classNotes,
                      point: function (x, y) {
                        return L.pointAtSlide(classNotes, currentSlides() ? slideAt : 0, x, y);
                      } });
        }
        return list;
      }
    });

    /* The tail of the console, once Run has been pressed. Trimmed here as
       well as on the server, to keep a console.log in a loop from sending
       200 KB every 400ms to thirty polls. */
    var OUTPUT_CHARS = 16000;
    function liveOutput() {
      if (!hasRun) return "";
      var text = outputEl.textContent || "";
      return text.length > OUTPUT_CHARS ? text.slice(-OUTPUT_CHARS) : text;
    }

    function pushNow() {
      if (!liveCode) return;
      var name = active;
      var text = docs[name] ? docs[name].getValue() : "";
      var notes = liveNotes();          // whole: students cut it themselves
      var slide = "";
      var onSlide = notes;              // what "Class sees" shows
      var cut = currentSlides();
      if (cut) {
        slideAt = Math.min(slideAt, cut.length - 1);
        onSlide = cut[slideAt];
        slide = (slideAt + 1) + "/" + cut.length;
        /* With the notes tab open, the mirror shows that file too — whole,
           which would put every slide on screen at once in a pane that has
           no arrows. It gets the teacher's slide. */
        if (name === notesFile()) text = onSlide;
      }
      /* Where the caret is, so the class sees it blink in the mirror and
         the mirror scrolls to follow it. In the stamp below, so moving it
         without typing still goes out — pointing at a line is half of
         teaching from the editor. None for a notes file: the class reads
         that rendered, where a line and column point at nothing.

         A highlighted block goes as "anchor-head", and the class sees it
         in yellow: dragging across a loop to talk about it is pointing
         at more than one line. Only the main selection — a second one
         made with Ctrl-click is rare, and the class would not know which
         one the teacher meant. */
      var cursor = "";
      if (docs[name] && !window.WebIDENotes.isMarkdown(name)) {
        var at = docs[name].getCursor("head");
        cursor = at.line + ":" + at.ch;
        if (docs[name].somethingSelected()) {
          var from = docs[name].getCursor("anchor");
          cursor = from.line + ":" + from.ch + "-" + cursor;
        }
      }
      paintSlides(cut);
      paintClassView(onSlide, slide, window.WebIDENotes.takeTheme(notes).name);
      var output = liveOutput();
      var page = sharedPage;
      var stamp = [name, text, notes, slide, output, page, cursor].join("\u0000");
      if (stamp === lastSent) return;      // nothing typed since last time
      lastSent = stamp;
      fetch("/api/live/" + encodeURIComponent(liveCode) + "/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: text, filename: name, notes: notes,
                               slide: slide, output: output, page: page,
                               cursor: cursor, seq: nextSeq() })
      }).then(function (res) {
        if (res.status === 403 || res.status === 409) { stopLive(true); return; }
        return res.json().then(function (data) {
          /* Lost the race — most likely to a snippet sent a moment later,
             which moves the same version. Without forgetting what was sent,
             the check above would call this file "already pushed" and the
             class would sit on the old one until the next keystroke. */
          if (data && data.stale) lastSent = null;
        });
      }).catch(function () {
        // A dropped push is fine: the next one carries the whole file.
      });
    }

    // ------------------------------------------------ send to students
    /* Highlight, right-click, Send to students. The class gets a card above
       their own editor with an Insert button — for THIS code only. The mirror
       still cannot be copied, because typing the lesson is the exercise; this
       is for the bits that are not (a data list, a helper the lesson uses).

       Only while live and only with something selected. Any other
       right-click is left entirely to the browser, so the menu a teacher
       knows is still there the rest of the time. */
    var sentChip = $("live-sent");
    var ctxMenu = null;

    function paintSent(out) {
      if (sentChip) sentChip.hidden = !(liveCode && out);
    }

    function sendSnippet(text, tries) {
      if (!liveCode) return;
      tries = tries || 0;
      fetch("/api/live/" + encodeURIComponent(liveCode) + "/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ snippet: text, seq: nextSeq() })
      }).then(function (res) {
        if (res.status === 403 || res.status === 409) { stopLive(true); return; }
        return res.json().then(function (data) {
          if (data.error) { window.alert(data.error); return; }
          /* A push overtook it. Silently dropping it would leave the teacher
             believing the class had the code; the new stamp is higher than
             anything already sent, so one more try goes through. */
          if (data.stale) {
            if (tries < 3) sendSnippet(text, tries + 1);
            else window.alert("Could not send that. Try again.");
            return;
          }
          paintSent(!!text);
        });
      }).catch(function () {
        window.alert("Could not send that. Check your connection.");
      });
    }

    function closeCtxMenu() {
      if (ctxMenu) ctxMenu.hidden = true;
    }

    function openCtxMenu(x, y, text) {
      if (!ctxMenu) {
        ctxMenu = document.createElement("div");
        ctxMenu.className = "menu ctx-menu";
        ctxMenu.setAttribute("role", "menu");
        var item = document.createElement("button");
        item.className = "menu-item";
        item.textContent = "Send to students";
        item.addEventListener("click", function () {
          closeCtxMenu();
          sendSnippet(ctxMenu.dataset.text || "");
        });
        ctxMenu.appendChild(item);
        document.body.appendChild(ctxMenu);
        document.addEventListener("mousedown", function (e) {
          if (!ctxMenu.contains(e.target)) closeCtxMenu();
        });
        document.addEventListener("keydown", function (e) {
          if (e.key === "Escape") closeCtxMenu();
        });
        window.addEventListener("blur", closeCtxMenu);
        window.addEventListener("resize", closeCtxMenu);
      }
      ctxMenu.dataset.text = text;
      ctxMenu.hidden = false;
      // Kept on screen: opened near the right or bottom edge it would
      // otherwise hang off it, half unclickable.
      var w = ctxMenu.offsetWidth, h = ctxMenu.offsetHeight;
      ctxMenu.style.left = Math.min(x, window.innerWidth - w - 8) + "px";
      ctxMenu.style.top = Math.min(y, window.innerHeight - h - 8) + "px";
    }

    /* CodeMirror's own "contextmenu" event: preventDefault there is what
       stops both the browser's menu and CodeMirror's handling of the click.
       The selection survives a right-click in CodeMirror 5, which is what
       makes highlight-then-right-click work at all. */
    editor.on("contextmenu", function (cm, e) {
      if (!liveCode || !cm.somethingSelected()) return;
      var text = cm.getSelection();
      if (!text.trim()) return;
      e.preventDefault();
      openCtxMenu(e.clientX, e.clientY, text);
    });
    editor.on("scroll", closeCtxMenu);

    if (sentChip) {
      sentChip.addEventListener("click", function () { sendSnippet(""); });
    }

    function liveLink() {
      return location.origin + "/live/" + encodeURIComponent(liveCode);
    }

    /* The chip still reads as the code, which is what a teacher says out
       loud; clicking it copies the whole address for the class's chat. The
       label flashes "Link copied" and then goes back to the code — unless the
       lesson ended in the meantime, when paintLive has already moved on. */
    liveChip.addEventListener("click", function () {
      if (!liveCode) return;
      var link = liveLink();
      function flash(text) {
        var code = liveCode;
        liveChip.textContent = text;
        setTimeout(function () {
          if (liveCode === code) liveChip.textContent = code;
        }, 1500);
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(link).then(function () {
          flash("Link copied");
        }, function () { window.prompt("Copy this link for your class:", link); });
      } else {
        window.prompt("Copy this link for your class:", link);
      }
    });

    function paintLive() {
      renderTabs();          // live, the notes are a button (notesAsButtons)
      // Live, the notes show whole (no playing a part at a time); after, they play again.
      if (!notesView.hidden && notesName.textContent && docs[notesName.textContent]) {
        notesSlides.show(docs[notesName.textContent].getValue());
      }
      if (liveCode) {
        liveBtn.textContent = "End lesson";
        liveBtn.classList.add("btn-live-on");
        liveChip.hidden = false;
        liveChip.textContent = liveCode;
        liveChip.title = "Click to copy the class's link: " + liveLink()
          + "\n(or they go to /live and type " + liveCode + ")"
          + (liveFor ? "\nThey can turn in to: " + liveFor
                     : "\nNo assignment, so they cannot turn work in.");
      } else {
        liveBtn.textContent = "Go live";
        liveBtn.classList.remove("btn-live-on");
        liveChip.hidden = true;
        paintSent(false);
        paintSlides(null);
        paintClassView(null, "");
        closeCtxMenu();
      }
    }

    function stopLive(quietly) {
      var code = liveCode;
      liveCode = null;
      if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
      lastSent = null;
      paintLive();
      forgetLive();
      if (code && !quietly) {
        fetch("/api/live/" + encodeURIComponent(code) + "/stop", { method: "POST" });
      }
    }

    /* Which assignment this lesson is for, asked once when Go live is
       pressed.

       IT IS NOT A NICETY. Turning work in needs a draft with an assignment
       on it, so a lesson with none is a lesson the class cannot hand
       anything in from — and nothing about that is visible while it is
       happening. Asking here is the one moment the teacher is thinking
       about the lesson anyway. */
    function chooseAssignment(data) {
      var list = (data && data.assignments) || [];
      if (!list.length) return "";       // nothing published yet
      /* WORDED AS WHAT IT DOES. "Which assignment is this lesson for?"
         read like it was about to open the assignment, and it is not —
         it decides where the CLASS's work goes when they press Save.
         Loading the starter is offered separately below, because that
         one does replace what is on screen. */
      var lines = ["Where should the class turn this work in?",
                   "(This does not change what is in your editor.)", "",
                   "0 — nowhere (they can still save, but not turn in)"];
      list.forEach(function (a, i) {
        lines.push((i + 1) + " — " + a.title);
      });
      var pick = window.prompt(lines.join("\n"), "1");
      if (pick === null) return null;    // cancelled: do not go live
      var n = parseInt(pick, 10);
      if (!n || n < 1 || n > list.length) return "";
      return list[n - 1].slug;
    }

    /* Open an assignment's starter in the editor.
     *
     * ASKED, NEVER SILENT. This replaces everything open, so a teacher who
     * pressed Go live in the middle of a lesson to resume a broadcast would
     * otherwise lose what they were demonstrating. It is offered only when
     * an assignment was actually chosen, and only on a fresh Go live — the
     * reload-resume path never reaches here.
     */
    function offerStarter(slug) {
      if (!slug) return Promise.resolve();
      return fetch("/api/live/assignment/" + encodeURIComponent(slug))
        .then(function (res) { return res.json(); })
        .then(function (data) {
          if (data.error) return;
          if (!window.confirm(
                "Open the starter for \u201c" + data.title + "\u201d?\n\n"
                + "This replaces what is in your editor now.")) {
            return;
          }
          loadStarter(data.files);
        })
        .catch(function () { /* the lesson still goes live without it */ });
    }

    function loadStarter(files) {
      files = files || {};
      Object.keys(docs).forEach(function (name) { delete docs[name]; });
      Object.keys(files).forEach(function (name) {
        docs[name] = CodeMirror.Doc(files[name], modeFor(name));
      });
      // A WebIDE project is its entry page; a starter without one would
      // leave an editor with no tabs and nothing to run.
      if (!docs[ENTRY]) docs[ENTRY] = CodeMirror.Doc("", "htmlmixed");
      active = ENTRY;
      showEditorDoc(ENTRY);
      renderTabs();
      relayout();
      if (account) account.noteEdit();
    }

    function startLive(assignment, resume, reopen) {
      var name = active;
      var text = docs[name] ? docs[name].getValue() : "";
      fetch("/api/live/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(assignment === undefined
          ? { body: text, filename: name, resume: resume || "",
              reopen: reopen || "",
              title: ($("title") && $("title").value) || "Live lesson" }
          /* `assignment` present — even as "" — is what tells the server this
             was a deliberate choice. Left out, a resumed session keeps the
             assignment it already had rather than silently losing it on a
             page reload, which would leave the class unable to hand in with
             nothing on screen to say why. */
          : { body: text, filename: name, assignment: assignment,
              title: ($("title") && $("title").value) || "Live lesson" })
      }).then(function (res) { return res.json(); })
        .then(function (data) {
          if (resume && data.error) return;   // no alert for a quiet resume
          if (data.error) { window.alert(data.error); return; }
          if (data.resumed === false) {
            // That lesson is over. Forget it, and stay off the air.
            forgetLive();
            return;
          }
          liveCode = data.code;
          liveFor = data.assignment_title || "";
          lastVersion = data.version || 0;
          // Back on the slide the class is looking at, after a reload. A
          // fresh lesson has none and starts at the beginning.
          var at = /^(\d+)\//.exec(data.slide || "");
          slideAt = at ? Math.max(0, parseInt(at[1], 10) - 1) : 0;
          lastSent = null;
          rememberLive(liveCode, data.assignment);
          paintLive();
          paintSent(!!data.snippet_out);
          pushNow();
          liveTimer = setInterval(pushNow, PUSH_MS);
        })
        .catch(function () {
          if (resume) return;
          window.alert("Could not start the live lesson. Check your connection.");
        });
    }

    /* "Teach this lesson again", from the lesson's own link.

       THE LINK IS THE LESSON. A teacher who wants yesterday's lesson back
       opens the link the class already has, and its page (live.html, as
       the host) sends them here with ?teach=<code>. Go live used to offer
       "your last lesson" instead, which was whichever one happened to be
       most recent — not the one they meant — and it left the editor as it
       was, so the class's screens filled with whatever happened to be open.

       So this opens the project first: the assignment's starter, with the
       lesson's last file laid over its namesake so the teacher carries on
       from where the class saw them stop. Only then does it reopen the
       lesson, so the very first push is the lesson's own code. Arrived at
       from a link, on the editor's home page, which never keeps unsaved
       work — so replacing what is on screen costs nothing and is not asked.
       A reload never comes back here; see the address bar cleared below. */
    function teachAgain(code, slug, resuming) {
      function json(res) { return res.json(); }
      var starter = slug
        ? fetch("/api/live/assignment/" + encodeURIComponent(slug))
            .then(json).catch(function () { return null; })
        : Promise.resolve(null);
      var last = fetch("/api/live/" + encodeURIComponent(code) + "?v=-1")
        .then(json).catch(function () { return null; });
      Promise.all([starter, last]).then(function (got) {
        var s = got[0], l = got[1];
        if (s && !s.error) loadStarter(s.files);
        // The notes travel separately (see pushNow), so only code is laid
        // over: a lesson that ended on the notes tab leaves them as written.
        if (l && !l.error && l.body && l.filename
            && !/\.md$/i.test(l.filename)) {
          if (!docs[l.filename]) {
            docs[l.filename] = CodeMirror.Doc("", modeFor(l.filename));
          }
          docs[l.filename].setValue(l.body);
          switchTo(l.filename);           // and so the first push sends it
        }
        if (resuming) startLive(undefined, code);
        else startLive(undefined, "", code);
      });
    }

    /* Back from a reload mid-lesson: the tab's own files if it kept them
       (see FILES_KEY), else the lesson rebuilt as Teach again builds it —
       which only /new needs, since any other page loaded its own project. */
    function resumeLive(code) {
      var kept = keptFiles(code);
      if (kept) {
        loadStarter(kept.files);
        if (kept.active && docs[kept.active]) switchTo(kept.active);
        if ($("title") && kept.title) $("title").value = kept.title;
        startLive(undefined, code);
      } else if (location.pathname === "/new") {
        teachAgain(code, liveSlug(), true);
      } else {
        startLive(undefined, code);
      }
    }

    liveBtn.addEventListener("click", function () {
      if (liveCode) {
        if (window.confirm("End the lesson? Your class stops seeing this editor.")) {
          stopLive(false);
        }
      } else {
        fetch("/api/live/assignments")
          .then(function (res) { return res.json(); })
          .catch(function () { return {}; })
          .then(function (data) {
            var slug = chooseAssignment(data);
            if (slug === null) return;      // they cancelled the chooser
            // Offer the starter first, so the file that goes out on the very
            // first push is the one they are about to teach from.
            offerStarter(slug).then(function () { startLive(slug); });
          });
      }
    });

    /* Reloading the editor mid-lesson must not silently stop the broadcast.
       The session is still open server-side — /api/live/start hands back the
       one already running rather than inventing a second code — so this puts
       the button back into its Live state and resumes pushing. */
    var teach = null, teachFor = "";
    try {
      var q = new URLSearchParams(location.search);
      teach = q.get("teach");
      teachFor = q.get("a") || "";
    } catch (e) { /* no URLSearchParams: an old browser, not a teacher's */ }

    if (teach) {
      // Off the address bar at once, so a reload resumes the broadcast the
      // ordinary way instead of loading the starter over the lesson again.
      try { history.replaceState(null, "", location.pathname); } catch (e) {}
      teachAgain(teach, teachFor);
    } else {
      try {
        // Resuming after a reload: no assignment argument at all, so the
        // server keeps whatever the session already had. The code is sent so
        // the server can refuse anything but that same lesson — see live_start.
        var resumeCode = liveToResume();
        if (resumeCode) resumeLive(resumeCode);
      } catch (e) { /* storage blocked: press Go live again */ }
    }

    // ------------------------------------------------- notes, popped out
    /* Pop out: the notes as big slides in a tab of their own
       (templates/notes_present.html, static/present.js), for the projector
       while this tab stays on the teacher's laptop.

       THIS TAB STAYS IN CHARGE. Everything the class is sent still goes
       out from pushNow here; the pop-out has no lesson code and never
       talks to the server. It asks this tab to move ("go"), and this tab
       tells it what to show ("state") — the notes, the slide, whether it
       is live. When live, a move there is a move of slideAt, the very one
       the ◀ ▶ under "Class sees" make, so the class follows exactly as if
       those had been pressed. When not live it moves this page's own
       notes, which is only presenting.

       A BroadcastChannel, named by an id made when the button is pressed,
       so two editors open on two lessons each drive only their own. Same
       browser only: it is a channel between tabs, which is also why the
       pop-out says so the moment this tab goes quiet (closed, reloaded,
       crashed) rather than freezing on a slide that looks live. */
    var popChan = null, popId = null, popSent = null;
    // This page's own notes viewer (the one the pop-out moves when not
    // live). A function, because FlaskIDE makes its viewer on first use.
    function popNotes() { return notesSlides; }

    function popState() {
      var cut = currentSlides();
      var live = !!(liveCode && cut);
      return { type: "state", notes: liveNotes(), live: !!liveCode,
               slide: live ? Math.min(slideAt, cut.length - 1)
                           : (popNotes() ? popNotes().at() : 0),
               title: ($("title") && $("title").value) || document.title };
    }

    /* Sent when anything in it changed. Checked twice a second rather than
       hooked into every way the notes or the slide can change (typing in
       the .md, either set of arrows, a push, Teach again): a hook missed
       would be a projector quietly showing the wrong slide. */
    function tellPopout(force) {
      if (!popChan) return;
      var state = popState();
      var stamp = JSON.stringify(state);
      if (!force && stamp === popSent) return;
      popSent = stamp;
      popChan.postMessage(state);
    }

    function popoutGo(i) {
      var cut = currentSlides();
      if (liveCode && cut) {
        slideAt = Math.max(0, Math.min(cut.length - 1, i));
        pushNow();                     // the class moves now, not next tick
      } else if (popNotes()) {
        popNotes().go(i);
      }
      tellPopout(true);
    }

    function openPopout() {
      if (!popChan) {
        popId = Math.random().toString(36).slice(2, 10);
        popChan = new BroadcastChannel("webide-notes-" + popId);
        popChan.onmessage = function (e) {
          var d = e.data || {};
          if (d.type === "go" && typeof d.slide === "number") popoutGo(d.slide);
          // The laser, pointed in the pop-out: sent from here, like all else.
          else if (d.type === "point" && typeof d.pointer === "string") sendPointer(d.pointer, d.path);
          else if (d.type === "hello") tellPopout(true);
        };
        setInterval(function () { tellPopout(false); }, 500);
        window.addEventListener("pagehide", function () {
          popChan.postMessage({ type: "bye" });
        });
      }
      // The same name each time, so pressing it again brings that tab
      // forward instead of opening another.
      window.open("/notes/present?ch=" + popId, "webide-notes-" + popId);
    }

    // No BroadcastChannel (Safari before 15.4): no button, rather than a
    // pop-out that would never hear from this tab. The click is listened
    // for on the document, so a button that is not on the page yet when
    // this runs still works when it is.
    function hidePopoutButtons() {
      if ("BroadcastChannel" in window) return;
      document.querySelectorAll(".js-popout").forEach(function (b) { b.hidden = true; });
    }
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", hidePopoutButtons);
    } else {
      hidePopoutButtons();
    }
    document.addEventListener("click", function (e) {
      var b = e.target && e.target.closest && e.target.closest(".js-popout");
      if (b && "BroadcastChannel" in window) openPopout();
    });

    // ---------------------------------------------------- answers, counted
    /* While live, each question card in the teacher's notes and in "Class
       sees" shows how many of the students here have answered it: "18 / 22
       answered". The server counts (/api/live/<code>/answers, which says
       what "here" means); this asks every few seconds while there is a
       question in the notes, and puts the count on the card for it.

       The teacher's cards are their own copy, answer key and all, with no
       question id in them, so a card is found by its prompt — with the
       blanks emptied, as the class's copy has them.

       The cards are rebuilt whenever the notes are drawn again (a keystroke
       in the .md, the class moving on), which takes the count off them. A
       MutationObserver puts it back from the last answer at once rather
       than at the next ask. paintCounts only writes what differs, or the
       observer would see its own writes and never stop. */
    var counts = null;
    var ANSWERS_MS = 3000;
    // Where the cards are. A function, because FlaskIDE's notes pane is
    // made after this runs.
    function countRoots() { return [classNotes, notesBody]; }

    function samePrompt(t) { return String(t || "").replace(/\[\[[^\[\]\n]*\]\]/g, "[[]]").trim(); }

    function countText(hit) {
      if (!hit) return "";
      return counts.here === null || counts.here === undefined
        ? hit.answered + " answered"
        : hit.answered + " / " + counts.here + " answered";
    }

    function paintCounts() {
      countRoots().forEach(function (root) {
        if (!root) return;
        root.querySelectorAll(".quiz").forEach(function (box) {
          var hit = null;
          if (counts && box.quizPrompt !== undefined) {
            var want = samePrompt(box.quizPrompt);
            hit = counts.questions.filter(function (q) { return q.prompt === want; })[0] || null;
          }
          var badge = box.querySelector(".quiz-count");
          if (!hit) {
            if (badge) badge.remove();
            return;
          }
          if (!badge) {
            badge = document.createElement("span");
            badge.className = "quiz-count";
            var head = box.querySelector(".quiz-head");
            (head || box).appendChild(badge);
          }
          var text = countText(hit);
          if (badge.textContent !== text) badge.textContent = text;
          var all = counts.here > 0 && hit.answered >= counts.here;
          if (badge.classList.contains("all-in") !== all) badge.classList.toggle("all-in", all);
        });
      });
    }

    function askCounts() {
      watchCards();
      // Nothing to count: not live, or no question in the notes.
      if (!liveCode || !/^ {0,3}(`{3,}|~{3,})\s*quiz\s*$/m.test(liveNotes())) {
        if (counts) { counts = null; paintCounts(); }
        return;
      }
      fetch("/api/live/" + encodeURIComponent(liveCode) + "/answers")
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          if (d && d.questions) { counts = d; paintCounts(); }
        })
        .catch(function () { /* the next ask will do */ });
    }
    var recount = "MutationObserver" in window
      ? new MutationObserver(function () { if (counts) paintCounts(); }) : null;
    var watched = [];
    function watchCards() {
      if (!recount) return;
      countRoots().forEach(function (root) {
        if (!root || watched.indexOf(root) >= 0) return;
        watched.push(root);
        recount.observe(root, { childList: true, subtree: true });
      });
    }
    watchCards();
    setInterval(askCounts, ANSWERS_MS);
  } else {
    /* No Go live button: signed out, or not a teacher. Whatever lesson this
       browser remembers is not one this person can resume, so forget it
       here rather than let it wait for the next teacher to sign in. */
    try {
      sessionStorage.removeItem("webide-live-host");
      sessionStorage.removeItem("webide-live-files");
      localStorage.removeItem("webide-live-host");      // the old, shared marker
    } catch (e) {}
  }
})();
