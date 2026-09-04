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
    autoCloseTags: true,
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
      addFile(name, "");
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
    next.setAttribute("sandbox", "allow-scripts");
    old.parentNode.replaceChild(next, old);
    frame = next;
    return next;
  }

  function run() {
    var files = allFiles();
    if (!files[ENTRY]) {
      write("\nThere's no " + ENTRY + " to open.\n", "err");
      return;
    }
    showPreview();
    clearOutput();

    token = "w" + Date.now() + Math.random().toString(36).slice(2, 8);
    var built = window.WebIDERun.assemble(files, token);
    offsets = built.offsets;

    setBusy(true);
    freshFrame().srcdoc = built.html;
    relayout();
  }

  function stop() {
    freshFrame();          // tears down timers, listeners, sound and any loop
    token = null;
    setBusy(false);
    write("\n— stopped —\n", "dim");
  }

  runBtn.addEventListener("click", run);
  stopBtn.addEventListener("click", stop);

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
