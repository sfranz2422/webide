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
  var frame = $("preview");
  var tabsEl = $("file-tabs");

  var ENTRY = window.WebIDERun.ENTRY;     // index.html

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
      Tab: function (cm) {
        if (cm.somethingSelected()) cm.indentSelection("add");
        else cm.replaceSelection("  ", "end");
      },
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

  applyTheme(currentTheme(), false);
  themeBtn.addEventListener("click", function () {
    applyTheme(currentTheme() === "light" ? "dark" : "light", true);
  });

  if (window.matchMedia) {
    var mq = window.matchMedia("(prefers-color-scheme: light)");
    var onSystemChange = function () {
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

  /* index.html first, then the rest alphabetically — the entry point should
     always be the leftmost tab. */
  function fileNames() {
    return [ENTRY].concat(
      Object.keys(docs).filter(function (n) { return n !== ENTRY; }).sort()
    );
  }

  function showPreview() {
    notesView.hidden = true;
    previewView.hidden = false;
  }

  function showNotes(name) {
    notesName.textContent = name;
    previewView.hidden = true;
    notesView.hidden = false;
    window.WebIDENotes.render(notesBody, docs[name].getValue());
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

  function renderTabs() {
    tabsEl.textContent = "";
    fileNames().forEach(function (name) {
      var tab = document.createElement("button");
      tab.type = "button";
      tab.className = "tab" + (name === active ? " tab-on" : "");
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(name === active));

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
    if (!files[ENTRY]) {
      write("\nThere's no " + ENTRY + " to open.\n", "err");
      return;
    }
    if (files[name] === undefined) name = ENTRY;
    page = name;

    showPreview();
    clearOutput();

    token = "w" + Date.now() + Math.random().toString(36).slice(2, 8);
    var built = window.WebIDERun.assemble(files, token, page, sent);
    offsets = built.offsets;

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
  function run() {
    trail = [];
    render(ENTRY);
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
  if (backBtn) backBtn.addEventListener("click", goBack);

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
     to the toolbar. Pressing Run stays useful — for games, and for restarting
     a page on purpose — but nobody has to press it to see their own edit.
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

  /* A game and a page want opposite defaults, so the answer is remembered
     under its own key for each. A game restarts from its first frame on every
     reload, which is useful while tuning a jump height and infuriating while
     playing level three — off to begin with, and a student tuning numbers can
     turn it on without changing what happens on their next ordinary page. */
  function autoKey() {
    return window.WebIDERun.isGame(allFiles())
      ? "webide-autorun-game" : "webide-autorun";
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
    return !window.WebIDERun.isGame(allFiles());
  }

  /* Called whenever the project might have become a game or stopped being
     one, so the box always shows the answer for what is actually open. */
  function paintAuto() {
    if (!autoBox) return;
    var isGame = window.WebIDERun.isGame(allFiles());
    autoBox.checked = autoWanted();
    autoBox.parentNode.title = isGame
      ? "Reload the game when you stop typing. Off by default: a reload starts "
        + "the game over."
      : "Update the preview when you stop typing, without pressing Run.";
  }

  function scheduleAuto() {
    clearTimeout(autoTimer);
    if (!autoBox || !autoBox.checked || autoPaused) return;
    if (window.WEBIDE.readonly) return;
    // editing the assignment notes changes nothing the preview shows
    if (window.WebIDENotes.isMarkdown(active)) return;

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

    if (data.kind === "ready") {
      setBusy(false);
      if (!outputEl.textContent.trim()) {
        write("Page loaded. console.log messages appear here.\n", "dim");
      }
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
    if (window.WebIDENotes.isMarkdown(active) && !mdSourceOpen) return;

    if (mdSourceOpen && window.WebIDENotes.isMarkdown(active)) {
      window.WebIDENotes.render(notesBody, docs[active].getValue());
      return;
    }
    var typed = change.origin === "+input" && change.text.join("");
    if (typed && /^[A-Za-z0-9_-]$/.test(typed)) {
      clearTimeout(hintTimer);
      hintTimer = setTimeout(function () {
        if (!cm.state.completionActive) {
          window.WebIDEComplete.show(cm, active, allFiles());
        }
      }, 140);
    }
  });

  // --------------------------------------------------------- sprite panel
  /* Only useful once a project is a game, so the button appears with one —
     the same rule the Python editor uses. */
  var spritesToggle = $("sprites-toggle");
  var spritePanel = $("sprites");
  var spriteGrid = $("sprite-grid");
  var spritesFilled = false;

  function closeSprites() {
    spritePanel.hidden = true;
    spritesToggle.setAttribute("aria-expanded", "false");
    relayout();
  }

  function fillSprites() {
    if (spritesFilled) return;
    spritesFilled = true;
    var list = window.WEBIDE.sprites || [];
    spriteGrid.textContent = "";
    list.forEach(function (s) {
      var cell = document.createElement("button");
      cell.type = "button";
      cell.className = "sprite";
      cell.dataset.name = s.name;
      cell.title = s.name + " — " + s.w + "×" + s.h + " — click to load it";
      cell.innerHTML =
        '<span class="sprite-img"><img src="' +
        window.WebIDERun.GAME_ROOT + "sprites/" + s.name +
        '.png" alt="" loading="lazy"></span>' +
        '<span class="sprite-name"></span>';
      cell.querySelector(".sprite-name").textContent = s.name;
      cell.addEventListener("click", function () {
        insertLoadSprite(s.name);
      });
      spriteGrid.appendChild(cell);
    });
  }

  /* The line a student actually needs, and the one they mistype: the name and
     the path have to agree. Dropped into script.js wherever the caret is. */
  function insertLoadSprite(name) {
    if (window.WEBIDE.readonly) return;
    var target = /\.m?js$/i.test(active) ? active : "script.js";
    if (!docs[target]) target = active;
    if (active !== target) switchTo(target);
    editor.replaceSelection(
      'loadSprite("' + name + '", "sprites/' + name + '.png");\n', "end");
    editor.focus();
  }

  spritesToggle.addEventListener("click", function () {
    var open = spritePanel.hidden;
    if (open) { fillSprites(); spritePanel.hidden = false; }
    else spritePanel.hidden = true;
    spritesToggle.setAttribute("aria-expanded", String(open));
    relayout();
  });
  $("sprites-close").addEventListener("click", closeSprites);

  $("sprite-search").addEventListener("input", function (e) {
    var q = e.target.value.trim().toLowerCase();
    var shown = 0;
    Array.prototype.forEach.call(spriteGrid.children, function (cell) {
      var hit = !q || cell.dataset.name.indexOf(q) >= 0;
      cell.hidden = !hit;
      if (hit) shown++;
    });
    $("sprite-empty").hidden = shown > 0;
  });

  /* Follows the project: add the library tag and the button appears, remove it
     and the panel goes away. */
  function refreshSpriteButton() {
    var isGame = window.WebIDERun.isGame(allFiles()) &&
                 (window.WEBIDE.sprites || []).length > 0;
    spritesToggle.hidden = !isGame;
    if (!isGame && !spritePanel.hidden) closeSprites();
  }

  /* Both of these follow the same fact — whether the project is a game — so
     they are answered together, on the one event that can change it. */
  editor.on("change", function () {
    refreshSpriteButton();
    paintAuto();
    scheduleAuto();
  });
  refreshSpriteButton();

  // ----------------------------------------------------------------- share
  var shareBtn = $("share");

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

  if (shareBtn) {
    shareBtn.addEventListener("click", async function () {
      if (!authorField.value.trim()) {
        flagAuthor("Put your name in the box at the top before sharing.");
        return;
      }
      shareBtn.disabled = true;
      var original = shareBtn.textContent;
      shareBtn.textContent = "Sharing…";
      try {
        var res = await fetch(window.WEBIDE.shareUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: $("title").value,
            author: authorField.value,
            files: allFiles()
          })
        });
        var data = await res.json();
        if (!res.ok) {
          if (data.field === "author") { flagAuthor(data.error); return; }
          throw new Error(data.error || "Could not share this project.");
        }
        $("share-url").value = data.url;
        $("modal").hidden = false;
        $("share-url").select();
      } catch (e) {
        write("\nShare failed: " + e.message + "\n", "err");
      } finally {
        shareBtn.disabled = false;
        shareBtn.textContent = original;
      }
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
     keep real relative links rather than being inlined — a game's
     <script src="kaplay.js"> resolves against the folder just as it resolved
     against this server in the preview. */
  var downloadBtn = $("download");

  function projectFileName() {
    var base = ($("title").value || "project")
      .replace(/[^\w -]+/g, "").trim().replace(/\s+/g, "-").toLowerCase();
    return (base || "project") + ".zip";
  }

  async function fetchBinary(url) {
    var res = await fetch(url);
    if (!res.ok) throw new Error(url.split("/").pop() + " (" + res.status + ")");
    return new Uint8Array(await res.arrayBuffer());
  }

  downloadBtn.addEventListener("click", async function () {
    var files = allFiles();
    var entries = Object.keys(files).sort().map(function (name) {
      return { name: name, data: files[name] };
    });

    var extras = window.WebIDERun.extras(files);
    if (extras.length && !window.WEBIDE.gameInstalled) {
      write("\nThe game library isn't installed on the server, so the download" +
            " would not run offline. Ask your teacher to run tools/vendor.py.\n",
            "err");
      return;
    }

    var original = downloadBtn.textContent;
    downloadBtn.disabled = true;
    if (extras.length) downloadBtn.textContent = "Zipping…";

    try {
      // fetched in parallel; these are same-origin so no CORS dance
      var fetched = await Promise.all(extras.map(function (e) {
        return fetchBinary(e.url).then(function (bytes) {
          return { name: e.name, data: bytes };
        });
      }));
      window.WebIDEZip.download(projectFileName(), entries.concat(fetched));
    } catch (e) {
      write("\nCould not build the download: " + e.message + "\n", "err");
    } finally {
      downloadBtn.disabled = false;
      downloadBtn.textContent = original;
    }
  });

  // show something straight away rather than an empty white rectangle
  run();
})();
