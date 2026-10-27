/* Tests in an assignment's notes: reading them, and running them — WebIDE's.
 *
 * autograde.py has the format and the reasons. This reads a ```tests block
 * exactly as autograde.parse does — test_autograde.py holds the two to each
 * other — and runs the tests in the browser: on the student's page for
 * Check my work, on the teacher's for Check all. Nothing here runs on the
 * server.
 *
 * Each page the tests look at is built the way the preview builds it
 * (runner.js, assemble) and loaded in a hidden frame with the preview's own
 * sandbox — scripts, no same origin — with a checker script put in after the
 * bridge and before the student's code, so it sees every console.log. The
 * checker runs the checks once the page has loaded and posts the results
 * back with a token, the way the bridge does. A page that never finishes
 * fails its checks after TIME_LIMIT_MS instead of leaving Check waiting.
 *
 * Code checks (uses, avoids, defines) read the JavaScript itself and need no
 * page.
 */
window.WebIDETests = (function () {
  "use strict";

  var FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
  var POINTS = /\s*\((\d{1,4}(?:\.\d{1,2})?)\s*points?\)\s*$/i;
  var PAGE = /^([\w./-]+\.html?):\s+(.+)$/i;
  var CLICK = /^click\s+(.+?)\s*->\s*(.+)$/i;
  var COUNT = /^has\s+(exactly\s+)?(?:(\d{1,4})\s+)?(.+)$/i;
  var LINKS = /^links\s+to\s+(.+)$/i;
  var LOGS = /^logs\s+(.+)$/i;
  var CODE = /^(uses|avoids|defines)\s+(.+?)\s*$/i;
  var ATTR = /^(.+?)\s+has\s+([A-Za-z_:][-A-Za-z0-9_:.]*)$/i;
  var COMMENT = /^#(\s|$)/;   // "#" and a space; "#named ..." is a test (autograde.py)
  var STYLE = /^(.+?)\s+([A-Za-z-]+)\s+is\s+(.+)$/i;
  var TIME_LIMIT_MS = 8000;

  function blocks(md) {
    var out = [], lines = String(md || "").split("\n"), i = 0;
    while (i < lines.length) {
      var f = FENCE.exec(lines[i]);
      if (f && f[2].trim().toLowerCase() === "tests") {
        var fence = f[1], body = [];
        i++;
        while (i < lines.length) {
          var g = FENCE.exec(lines[i]);
          if (g && g[1][0] === fence[0] && g[1].length >= fence.length && !g[2].trim()) break;
          body.push(lines[i]);
          i++;
        }
        out.push(body.join("\n"));
      }
      i++;
    }
    return out;
  }

  function check(line) {
    var m;
    if ((m = COUNT.exec(line))) {
      var exact = !!m[1];
      if (exact && !m[2]) return null;
      return { kind: "count", exact: exact, n: m[2] ? parseInt(m[2], 10) : 1, selector: m[3].trim() };
    }
    if ((m = LINKS.exec(line))) return { kind: "links", href: m[1].trim() };
    if ((m = LOGS.exec(line))) return { kind: "logs", text: m[1].trim() };
    var at = line.indexOf(" contains ");
    if (at >= 0) {
      return { kind: "contains", selector: line.slice(0, at).trim(), text: line.slice(at + 10).trim() };
    }
    if ((m = ATTR.exec(line))) return { kind: "attr", selector: m[1].trim(), attr: m[2] };
    if ((m = STYLE.exec(line))) {
      return { kind: "style", selector: m[1].trim(), prop: m[2].toLowerCase(), value: m[3].trim() };
    }
    return null;
  }

  function label(t) {
    var said;
    switch (t.kind) {
      case "count":
        said = t.exact ? "Has exactly " + t.n + " " + t.selector
             : t.n === 1 ? "Has " + t.selector : "Has at least " + t.n + " " + t.selector;
        break;
      case "contains": said = t.selector + " contains " + t.text; break;
      case "attr": said = "Every " + t.selector + " has " + t.attr; break;
      case "links": said = "Links to " + t.href; break;
      case "style": said = t.selector + " " + t.prop + " is " + t.value; break;
      case "logs": said = "Logs " + t.text; break;
      case "uses": said = "Uses " + t.name; break;
      case "avoids": said = "Doesn't use " + t.name; break;
      default: said = "Defines " + t.name + "()";
    }
    if (t.click) said = "After clicking " + t.click + ": " + said;
    if (t.page) said = t.page + ": " + said;
    return said;
  }

  function parseBlock(body) {
    var tests = [], errors = [];
    String(body || "").split("\n").forEach(function (raw, idx) {
      var line = raw.trim();
      if (!line || COMMENT.test(line)) return;
      var whole = line, points = 1, m = POINTS.exec(line), t = null, page = "";
      if (m) {
        points = parseFloat(m[1]);
        line = line.slice(0, m.index).replace(/\s+$/, "");
      }
      if ((m = PAGE.exec(line))) { page = m[1]; line = m[2].trim(); }
      m = CODE.exec(line);
      if (m && !page) {
        var name = m[2].trim();
        if (name.slice(-2) === "()") name = name.slice(0, -2);
        t = { kind: m[1].toLowerCase(), name: name };
      }
      if (!t) {
        if ((m = CLICK.exec(line))) {
          t = check(m[2].trim());
          if (t) t.click = m[1].trim();
        } else {
          t = check(line);
        }
      }
      if (!t) {
        errors.push("Line " + (idx + 1) + " of the tests isn't a test: " + whole);
        return;
      }
      if (t.click === undefined) t.click = "";
      t.page = page;
      t.points = points;
      t.label = label(t);
      tests.push(t);
    });
    return { tests: tests, errors: errors };
  }

  function parse(md) {
    var tests = [], errors = [];
    blocks(md).forEach(function (b) {
      var got = parseBlock(b);
      tests = tests.concat(got.tests);
      errors = errors.concat(got.errors);
    });
    return { tests: tests, errors: errors };
  }

  function fromFiles(files) {
    var tests = [], errors = [];
    Object.keys(files || {}).sort().forEach(function (name) {
      if (/\.md$/i.test(name)) {
        var got = parse(files[name]);
        tests = tests.concat(got.tests);
        errors = errors.concat(got.errors);
      }
    });
    return { tests: tests, errors: errors };
  }

  /* Which slide each of fromFiles(files)'s tests is written on, in the same
     order: [{slide, title}] (slide from 1, as the slide counter shows it;
     title the slide's first heading), null for a test in notes with no
     slides. Check my work heads its results with these, so a student told
     "check after every step" sees the step they are on, not one long list.

     The notes are cut by `Notes` (notes.js's slides()), the viewer's own
     cutter, so the numbers can't differ from the ones on screen. If the
     count comes out different from fromFiles' anyway, it returns null and
     the results are shown as one list — an unheaded list beats headings
     over the wrong tests. */
  /* A slide's first heading, skipping fenced code: "# a comment" in a
     Python example is not the slide's title. */
  function heading(text) {
    var fence = null, lines = text.split("\n");
    for (var i = 0; i < lines.length; i++) {
      var f = /^ {0,3}(`{3,}|~{3,})/.exec(lines[i]);
      if (f) {
        if (fence === null) fence = f[1];
        else if (f[1].charAt(0) === fence.charAt(0) && f[1].length >= fence.length) fence = null;
        continue;
      }
      var h = fence === null && /^ {0,3}#{1,6}[ \t]+(.+?)[ \t#]*$/.exec(lines[i]);
      if (h) return h[1];
    }
    return "";
  }

  function places(files, Notes) {
    if (!Notes || !Notes.slides) return null;
    var out = [];
    Object.keys(files || {}).sort().forEach(function (name) {
      if (!/\.md$/i.test(name)) return;
      var cut = Notes.slides(files[name]);
      if (!cut.length) {
        parse(files[name]).tests.forEach(function () { out.push(null); });
        return;
      }
      cut.forEach(function (text, i) {
        var where = { slide: i + 1, title: heading(text) };
        parse(text).tests.forEach(function () { out.push(where); });
      });
    });
    return out.length === fromFiles(files).tests.length ? out : null;
  }

  // ------------------------------------------------------------ code checks

  /* All the project's JavaScript: its .js files and every inline <script>. */
  function scriptText(files) {
    var parts = [];
    Object.keys(files).forEach(function (name) {
      var text = String(files[name] || "");
      if (/\.js$/i.test(name)) parts.push(text);
      if (/\.html?$/i.test(name)) {
        var re = /<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi, m;
        while ((m = re.exec(text))) parts.push(m[1]);
      }
    });
    return parts.join("\n");
  }

  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

  function codeCheck(t, js) {
    var w = escapeRe(t.name);
    if (t.kind === "defines") {
      var ok = new RegExp("\\bfunction\\s+" + w + "\\s*\\(").test(js) ||
               new RegExp("\\b(?:const|let|var)\\s+" + w + "\\s*=\\s*(?:async\\s+)?(?:function\\b|\\(|[A-Za-z_$][\\w$]*\\s*=>)").test(js);
      return { ok: ok, detail: ok ? "" : "There's no function " + t.name + " in the JavaScript." };
    }
    var used = new RegExp("(^|[^\\w$])" + w + "(?![\\w$])").test(js);
    if (t.kind === "uses") return { ok: used, detail: used ? "" : "It isn't in the JavaScript yet." };
    return { ok: !used, detail: used ? "The JavaScript uses it." : "" };
  }

  // ------------------------------------------------------- the page checks

  /* Runs inside the page's frame, after the bridge and before the student's
     scripts. Its own source is sent as text, so it may use nothing from this
     file's scope: TOKEN and TESTS are filled in. */
  function checker(TOKEN, TESTS) {
    var logs = [];
    ["log", "info", "warn", "error", "debug"].forEach(function (name) {
      var original = console[name];
      console[name] = function () {
        try { logs.push(Array.prototype.map.call(arguments, String).join(" ")); } catch (e) {}
        if (original) return original.apply(console, arguments);
      };
    });
    function norm(s) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim().toLowerCase(); }
    function short(s) { s = String(s).replace(/\s+/g, " ").trim(); return s.length > 120 ? s.slice(0, 120) + "…" : s; }
    function all(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
    function computed(prop, value) {
      var d = document.createElement("div");
      d.style.setProperty(prop, value);
      if (!d.style.getPropertyValue(prop)) return null;
      (document.body || document.documentElement).appendChild(d);
      var got = getComputedStyle(d).getPropertyValue(prop);
      d.parentNode.removeChild(d);
      return got;
    }
    function one(t) {
      var els;
      if (t.kind === "logs") {
        var ok = norm(logs.join("\n")).indexOf(norm(t.text)) >= 0;
        return { ok: ok, detail: ok ? "" : "It logged: " + (short(logs.join(" | ")) || "(nothing)") };
      }
      if (t.kind === "links") {
        var want = t.href.replace(/^\.\//, "").toLowerCase();
        var hrefs = all("a[href]").map(function (a) { return a.getAttribute("href").replace(/^\.\//, "").toLowerCase(); });
        var found = hrefs.some(function (h) { return h === want || h.split(/[?#]/)[0] === want; });
        return { ok: found, detail: found ? "" : (hrefs.length ? "Its links go to: " + short(hrefs.join(", ")) : "It has no links.") };
      }
      try { els = all(t.selector); } catch (e) {
        return { ok: false, detail: "“" + t.selector + "” isn't something the page can be searched for." };
      }
      if (t.kind === "count") {
        var n = els.length;
        var good = t.exact ? n === t.n : n >= t.n;
        return { ok: good, detail: good ? "" : "It has " + n + "." };
      }
      if (!els.length) return { ok: false, detail: "There's no " + t.selector + " on the page." };
      if (t.kind === "contains") {
        // A form field's text is its value; anything else's, what it shows.
        var el = els[0], text = /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) ? el.value : el.textContent;
        var has = norm(text).indexOf(norm(t.text)) >= 0;
        return { ok: has, detail: has ? "" : "It says: " + (short(text) || "(nothing)") };
      }
      if (t.kind === "attr") {
        var without = els.filter(function (e) { return !e.hasAttribute(t.attr); }).length;
        return { ok: !without, detail: without ? without + " of " + els.length + " don't." : "" };
      }
      if (t.kind === "style") {
        var wanted = computed(t.prop, t.value);
        if (wanted === null) return { ok: false, detail: "“" + t.value + "” isn't a value " + t.prop + " can have." };
        var actual = getComputedStyle(els[0]).getPropertyValue(t.prop);
        return { ok: actual === wanted, detail: actual === wanted ? "" : "It's " + actual + "." };
      }
      return { ok: false, detail: "" };
    }
    function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    async function go() {
      await wait(200);
      var out = {};
      // Checks first, clicks after: a click changes the page the others see.
      var order = TESTS.filter(function (t) { return !t.click; })
                       .concat(TESTS.filter(function (t) { return t.click; }));
      for (var i = 0; i < order.length; i++) {
        var t = order[i], r;
        try {
          if (t.click) {
            var target = null;
            try { target = document.querySelector(t.click); } catch (e) {}
            if (!target) {
              r = { ok: false, detail: "There's no " + t.click + " to click." };
            } else {
              target.click();
              await wait(300);
              r = one(t);
            }
          } else {
            r = one(t);
          }
        } catch (e) {
          r = { ok: false, detail: String(e && e.message || e) };
        }
        out[t.i] = r;
      }
      parent.postMessage({ webide: TOKEN, kind: "autograde", results: out }, "*");
    }
    if (document.readyState === "complete") go();
    else window.addEventListener("load", go);
  }

  /* Load one page of `files` in a hidden sandboxed frame and run `tests`
     (each with its index `i`) in it. Resolves {i: {ok, detail}}. */
  function runPage(files, page, tests) {
    return new Promise(function (resolve) {
      var token = "t" + Date.now() + Math.random().toString(36).slice(2, 10);
      var built = window.WebIDERun.assemble(files, token, page || window.WebIDERun.ENTRY, null);
      var payload = JSON.stringify(tests).replace(/</g, "\\u003c");
      var script = "<script>(" + checker.toString() + ")(" + JSON.stringify(token) + ", " +
                   payload + ");\n</script>";
      var cut = built.html.indexOf("</script>");
      var html = cut >= 0 ? built.html.slice(0, cut + 9) + "\n" + script + built.html.slice(cut + 9)
                          : script + built.html;
      var frame = document.createElement("iframe");
      frame.setAttribute("sandbox", "allow-scripts allow-forms");
      frame.setAttribute("aria-hidden", "true");
      frame.style.cssText = "position:fixed;left:-10000px;top:0;width:1024px;height:768px;border:0;";
      var done = false;
      function finish(results) {
        if (done) return;
        done = true;
        window.removeEventListener("message", listen);
        clearTimeout(timer);
        if (frame.parentNode) frame.parentNode.removeChild(frame);
        resolve(results);
      }
      function listen(e) {
        var d = e.data;
        if (e.source !== frame.contentWindow || !d || d.webide !== token || d.kind !== "autograde") return;
        finish(d.results || {});
      }
      var timer = setTimeout(function () {
        var out = {};
        tests.forEach(function (t) {
          out[t.i] = { ok: false, detail: "The page didn't finish within " + TIME_LIMIT_MS / 1000 +
                       " seconds. Is there a loop that never ends?" };
        });
        finish(out);
      }, TIME_LIMIT_MS);
      window.addEventListener("message", listen);
      document.body.appendChild(frame);
      frame.srcdoc = html;
    });
  }

  /* Run `tests` against `files` (name → text). Resolves
     {results: [{label, ok, detail, points}], earned, possible}. */
  async function run(files, tests) {
    var found = {}, js = scriptText(files), byPage = {};
    tests.forEach(function (t, i) {
      if (t.kind === "uses" || t.kind === "avoids" || t.kind === "defines") {
        found[i] = codeCheck(t, js);
        return;
      }
      var page = t.page || window.WebIDERun.ENTRY;
      (byPage[page] = byPage[page] || []).push(Object.assign({ i: i }, t));
    });
    for (var page in byPage) {
      if (files[page] === undefined) {
        byPage[page].forEach(function (t) { found[t.i] = { ok: false, detail: "There's no " + page + " in the project." }; });
        continue;
      }
      var got = await runPage(files, page, byPage[page]);
      byPage[page].forEach(function (t) { found[t.i] = got[t.i] || { ok: false, detail: "" }; });
    }
    var results = tests.map(function (t, i) {
      var r = found[i] || { ok: false, detail: "" };
      return { label: t.label, ok: !!r.ok, detail: r.ok ? "" : String(r.detail || ""), points: t.points };
    });
    var earned = 0, possible = 0;
    results.forEach(function (r) { possible += r.points; if (r.ok) earned += r.points; });
    return { results: results, earned: Math.round(earned * 100) / 100,
             possible: Math.round(possible * 100) / 100 };
  }

  /* A ```tests block in rendered notes, as a list a student can read. */
  function renderBlocks(root) {
    Array.prototype.forEach.call(root.querySelectorAll("pre > code.language-tests"), function (code) {
      var got = parseBlock(code.textContent);
      if (!got.tests.length) return;
      // With checks_in_notes.js on the page, a card the student checks their
      // work from, results and all; without it, the list of what's checked.
      if (window.IDENotesChecks) {
        code.parentNode.replaceWith(window.IDENotesChecks.card(got.tests, "✔ Tests your page will be checked against"));
        return;
      }
      var box = document.createElement("div");
      box.className = "tests-card";
      var head = document.createElement("div");
      head.className = "tests-head";
      head.textContent = "✔ Tests your page will be checked against";
      box.appendChild(head);
      var list = document.createElement("ul");
      got.tests.forEach(function (t) {
        var li = document.createElement("li");
        li.textContent = t.label + (t.points !== 1 ? "  (" + t.points + " points)" : "");
        list.appendChild(li);
      });
      box.appendChild(list);
      code.parentNode.replaceWith(box);
    });
  }

  return { parse: parse, parseBlock: parseBlock, fromFiles: fromFiles, places: places, run: run,
           renderBlocks: renderBlocks, TIME_LIMIT_MS: TIME_LIMIT_MS };
})();
