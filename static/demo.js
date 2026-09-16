/* WebIDE — the demo page.
 *
 * What a "hide code" share link opens: Run, the finished page, and a console.
 * No editor, no tabs, no fork, no download.
 *
 * The honest limit, stated once so nobody has to guess at it: the page has to
 * reach the browser to run. This removes every ordinary way of reading the
 * source — it is never written into this document, never held by an editor,
 * and only fetched once a run is asked for — but a network panel will still
 * show the request. That is the difference between a cupboard and a safe, and
 * the cupboard is what a classroom needs.
 */

(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var outputEl = $("output");
  var runBtn = $("run");
  var runLabel = $("run-label");
  var stopBtn = $("stop");
  var frame = $("preview");
  var backBar = $("preview-trail");
  var backBtn = $("preview-back");
  var pageLabel = $("preview-page");

  var ENTRY = window.WebIDERun.ENTRY;

  // ----------------------------------------------------------------- output
  function write(text, cls) {
    var node = document.createElement("span");
    if (cls) node.className = cls;
    node.textContent = text;
    outputEl.appendChild(node);
    outputEl.scrollTop = outputEl.scrollHeight;
  }
  function clearOutput() { outputEl.textContent = ""; }
  $("clear").addEventListener("click", clearOutput);

  // ------------------------------------------------------------------ theme
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
    themeGlyph.textContent = name === "light" ? "☾" : "☀";
    themeBtn.title = name === "light"
      ? "Switch to dark (easier on the eyes up close)"
      : "Switch to light (easier to read on a projector)";
    themeBtn.setAttribute("aria-label", themeBtn.title);
    if (remember) {
      try { localStorage.setItem(THEME_KEY, name); } catch (e) { /* blocked */ }
    }
  }
  applyTheme(currentTheme(), false);
  themeBtn.addEventListener("click", function () {
    applyTheme(currentTheme() === "light" ? "dark" : "light", true);
  });

  // -------------------------------------------------------------- text size
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

  // -------------------------------------------------------------- the files
  /* Held in this closure and nowhere else — not on window, not in an editor,
     not in the markup. Fetched once and kept, so pressing Run a second time
     adds nothing new to the network log. */
  var project = null;
  var token = null;
  var offsets = {};
  var page = ENTRY;
  var trail = [];

  async function loadProject() {
    if (project) return project;
    var res = await fetch(window.WEBIDE_DEMO.sourceUrl, { cache: "no-store" });
    if (!res.ok) throw new Error("This demo link is no longer available.");
    var data = await res.json();
    project = data.files || {};
    return project;
  }

  /* Replacing the element rather than reassigning srcdoc: a runaway loop
     wedges that frame's process, and a wedged frame can't navigate itself. */
  function freshFrame() {
    var next = document.createElement("iframe");
    next.id = "preview";
    next.title = "Page preview";
    next.setAttribute("sandbox", "allow-scripts allow-forms");
    frame.parentNode.replaceChild(next, frame);
    frame = next;
    return next;
  }

  function paintTrail() {
    var away = page !== ENTRY || trail.length > 0;
    backBar.hidden = !away;
    if (away) pageLabel.textContent = page;
    backBtn.disabled = trail.length === 0;
  }

  function render(files, name, sent) {
    if (files[name] === undefined) name = ENTRY;
    page = name;
    clearOutput();
    token = "w" + Date.now() + Math.random().toString(36).slice(2, 8);
    var built = window.WebIDERun.assemble(files, token, page, sent);
    offsets = built.offsets;
    stopBtn.hidden = false;
    freshFrame().srcdoc = built.html;
    paintTrail();
  }

  async function run() {
    runBtn.disabled = true;
    runLabel.textContent = "Loading…";
    var files;
    try {
      files = await loadProject();
    } catch (e) {
      clearOutput();
      write(e.message + "\n", "err");
      runBtn.disabled = false;
      runLabel.textContent = "Run";
      return;
    }
    runBtn.disabled = false;
    runLabel.textContent = "Run";
    trail = [];
    render(files, ENTRY);
  }

  function stop() {
    freshFrame();
    token = null;
    stopBtn.hidden = true;
    write("\n— stopped —\n", "dim");
  }

  runBtn.addEventListener("click", run);
  stopBtn.addEventListener("click", stop);
  backBtn.addEventListener("click", function () {
    if (!trail.length || !project) return;
    render(project, trail.pop());
  });

  document.addEventListener("keydown", function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      run();
    }
  });

  // ------------------------------------------------- talking to the preview
  function openExternal(url) {
    if (!/^https?:\/\//i.test(url)) {
      write("\nThat link didn't point at a web address, so nothing opened: "
            + url + "\n", "dim");
      return;
    }
    var opened = null;
    try {
      opened = window.open(url, "_blank");
      if (opened) { try { opened.opener = null; } catch (e) {} }
    } catch (e) { /* blocked; handled below */ }
    write(opened ? "\nOpened in a new tab: " + url + "\n"
                 : "\nYour browser blocked a new tab for " + url + "\n", "dim");
  }

  function reportForm(data) {
    var fields = data.fields || [];
    var sent = {};
    fields.forEach(function (pair) { sent[pair[0]] = pair[1]; });
    if (data.action && project) {
      if (data.action !== page) trail.push(page);
      render(project, data.action, sent);
    }
    if (fields.length) {
      write("\nForm submitted (" + (data.method || "get") + "):\n", "dim");
      fields.forEach(function (pair) {
        write("   " + pair[0] + " = " + pair[1] + "\n");
      });
    }
  }

  window.addEventListener("message", function (e) {
    var data = e.data;
    if (!data || typeof data !== "object" || !token || data.webide !== token) return;
    if (e.source !== frame.contentWindow) return;

    if (data.kind === "ready") {
      stopBtn.hidden = true;
      if (!outputEl.textContent.trim()) {
        write("Page loaded.\n", "dim");
      }
      return;
    }
    if (data.kind === "nav") {
      if (!project) return;
      var name = String(data.text);
      if (name !== page) trail.push(page);
      render(project, name);
      return;
    }
    if (data.kind === "form") { reportForm(data); return; }
    if (data.kind === "open") { openExternal(String(data.text)); return; }
    if (data.kind === "note") { write(String(data.text) + "\n", "dim"); return; }

    var where = window.WebIDERun.locate(data.file, data.line, offsets);
    var cls = data.kind === "error" ? "err" : (data.kind === "warn" ? "warn" : "");
    write(String(data.text) + (where ? "   (" + where + ")" : "") + "\n", cls);
  });
})();
