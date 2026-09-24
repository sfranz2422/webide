/* WebIDE — running the student's page.
 *
 * The page runs in an iframe with sandbox="allow-scripts" and deliberately
 * WITHOUT allow-same-origin. That combination gives the student's code a null
 * origin: their JavaScript runs completely normally — which is the whole point
 * of the class — but it cannot reach this page's DOM, cookies or storage, and
 * it cannot call back into the editor.
 *
 * Because the iframe has no server behind it, <link href="style.css"> and
 * <script src="script.js"> have nothing to fetch. The linked files are inlined
 * into the document before it is handed over, so students still write ordinary
 * relative links and learn the real markup.
 */

window.WebIDERun = (function () {
  "use strict";

  var ENTRY = "index.html";
  /* Sent into the page ahead of the student's own code. Mirrors console output
     and errors back to the editor. Kept in its own <script> element so the
     student's line numbers still start at 1 in their own file. */
  function bridge(token, pages, sent) {
    return [
      "(function () {",
      "  var TOKEN = " + JSON.stringify(token) + ";",
      "  var PAGES = " + JSON.stringify(pages || []) + ";",
      /* What a form on the previous page submitted. A real server would hand
         this over in the query string, but a sandboxed preview has no address
         to put one in — history.replaceState throws on an opaque origin, so
         location.search can never be anything but empty. This is the stand-in:
         a plain object, empty when nobody submitted anything. */
      "  window.formData = " + JSON.stringify(sent || {}) + ";",
      "  function send(kind, text, where) {",
      "    try {",
      "      parent.postMessage({ webide: TOKEN, kind: kind, text: text,",
      "                           where: where || '' }, '*');",
      "    } catch (e) {}",
      "  }",
      "  function show(value) {",
      "    if (typeof value === 'string') return value;",
      "    if (value instanceof Error) return value.name + ': ' + value.message;",
      "    if (typeof value === 'function') return '[function ' + (value.name || 'anonymous') + ']';",
      "    if (value === undefined) return 'undefined';",
      "    if (value === null) return 'null';",
      "    try {",
      "      var seen = [];",
      "      return JSON.stringify(value, function (k, v) {",
      "        if (typeof v === 'object' && v !== null) {",
      "          if (seen.indexOf(v) >= 0) return '[circular]';",
      "          seen.push(v);",
      "        }",
      "        if (v && v.nodeType === 1) return '<' + v.tagName.toLowerCase() + '>';",
      "        return v;",
      "      });",
      "    } catch (e) { return String(value); }",
      "  }",
      "  function line(args) {",
      "    return Array.prototype.map.call(args, show).join(' ');",
      "  }",
      "  ['log', 'info', 'warn', 'error', 'debug'].forEach(function (name) {",
      "    var original = console[name];",
      "    console[name] = function () {",
      "      send(name === 'debug' ? 'log' : name, line(arguments));",
      "      if (original) original.apply(console, arguments);",
      "    };",
      "  });",
      "  window.addEventListener('error', function (e) {",
      "    if (e.message) {",
      "      try {",
      "        parent.postMessage({ webide: TOKEN, kind: 'error', text: e.message,",
      "          file: e.filename || '', line: e.lineno || 0 }, '*');",
      "      } catch (err) {}",
      "    }",
      "  });",
      "  window.addEventListener('unhandledrejection', function (e) {",
      "    send('error', 'Uncaught (in promise) ' + show(e.reason));",
      "  });",
      /* ---- moving between the student's pages ----------------------------
         The preview is a srcdoc document with no address of its own, so it
         borrows the editor's URL as its base: <a href='about.html'> resolves
         against this app and clicking it would navigate the preview to a 404,
         taking the student's page with it. Measured, not assumed.

         So links are caught here and handed to the editor, which rebuilds the
         preview around that file. An in-page #anchor is left alone — that is
         real behaviour a student should see working. */
      "  function pageNamed(url) {",
      "    var name = String(url).split(/[?#]/)[0].split('/').pop();",
      "    for (var i = 0; i < PAGES.length; i++) {",
      "      if (PAGES[i].toLowerCase() === name.toLowerCase()) return PAGES[i];",
      "    }",
      "    return null;",
      "  }",
      "  document.addEventListener('click', function (e) {",
      "    var a = e.target && e.target.closest && e.target.closest('a[href]');",
      "    if (!a || e.defaultPrevented || e.button) return;",
      "    var raw = a.getAttribute('href') || '';",
      /* An in-page anchor has to be handled here rather than left to the
         browser. This document came from srcdoc and has no URL of its own, so
         '#contact' is not same-page to it: it resolves against baseURI, which
         is the editor's address, and the frame cheerfully navigates to the IDE
         and renders it inside its own preview. Same for an empty href. */
      "    if (raw.charAt(0) === '#') {",
      "      e.preventDefault();",
      "      var id = raw.slice(1);",
      "      if (!id || id.toLowerCase() === 'top') {",
      "        window.scrollTo(0, 0);",
      "        return;",
      "      }",
      "      var target = null;",
      "      try {",
      "        target = document.getElementById(id) ||",
      "                 document.getElementsByName(id)[0] || null;",
      "      } catch (err) {}",
      "      if (target && target.scrollIntoView) {",
      "        target.scrollIntoView({ block: 'start' });",
      "      } else {",
      "        send('note', 'Nothing on this page has id=\"' + id + '\", so the'",
      "          + ' link had nowhere to jump to.');",
      "      }",
      "      return;",
      "    }",
      "    if (!raw) {",
      "      e.preventDefault();",
      "      send('note', 'That link has an empty href, so it has no"
      + " destination yet.');",
      "      return;",
      "    }",
      "    var page = pageNamed(a.href);",
      "    if (page) {",
      "      e.preventDefault();",
      "      send('nav', page);",
      "      return;",
      "    }",
      /* Another site. Never followed *here* — that would replace the student's
         work with someone else's page — but a link to MDN in an assignment
         should still go somewhere, so it is handed to the editor to open in a
         new tab. This frame can't do that itself: its sandbox has no
         allow-popups, and granting that would let any student script spawn
         tabs. Only http(s) is passed on; a javascript: or data: href is
         reported and goes nowhere. */
      "    e.preventDefault();",
      "    if (a.protocol === 'http:' || a.protocol === 'https:') {",
      "      send('open', a.href);",
      "    } else {",
      "      send('note', 'The preview did not follow that link: ' + raw);",
      "    }",
      "  });",
      "",
      /* ---- forms ----------------------------------------------------------
         allow-forms is on, so the submit event fires and a student's own
         preventDefault handler works — the usual way forms are taught. This
         listener is on the document and therefore runs after theirs: if they
         already handled it, nothing happens here. Otherwise the submission is
         stopped (there is no server to post to) and reported, so a form that
         nobody has written JavaScript for still visibly does something. */
      "  document.addEventListener('submit', function (e) {",
      "    if (e.defaultPrevented) return;              // their handler won",
      "    var form = e.target;",
      "    e.preventDefault();",
      "    var fields = [];",
      "    try {",
      "      new FormData(form).forEach(function (value, key) {",
      "        fields.push([key, typeof value === 'string' ? value : '(file)']);",
      "      });",
      "    } catch (err) {}",
      "    var action = form.getAttribute('action') || '';",
      "    try {",
      "      parent.postMessage({ webide: TOKEN, kind: 'form', text: '',",
      "        fields: fields, action: pageNamed(action) || '',",
      "        method: (form.getAttribute('method') || 'get').toLowerCase() }, '*');",
      "    } catch (err) {}",
      "  });",
      "",
      "  window.addEventListener('load', function () {",
      "    send('ready', '');",
      "  });",
      "})();"
    ].join("\n");
  }

  function escapeForScriptTag(code) {
    // a literal </script> inside student JS would close the tag early
    return String(code).replace(/<\/(script)/gi, "<\\/$1");
  }

  /* Replace <link rel=stylesheet href="x.css"> and <script src="x.js"> with the
     contents of those files, so relative links work with no server. Anything
     that doesn't match a project file (a CDN URL, say) is left alone. */
  function inline(html, files) {
    var out = String(html);

    out = out.replace(
      /<link\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi,
      function (tag, href) {
        if (!/stylesheet/i.test(tag)) return tag;
        var name = href.replace(/^\.\//, "").split(/[?#]/)[0];
        if (!Object.prototype.hasOwnProperty.call(files, name)) return tag;
        return "<style>\n" + files[name] + "\n</style>";
      }
    );

    out = out.replace(
      /<script\b([^>]*)\bsrc\s*=\s*["']([^"']+)["']([^>]*)><\/script\s*>/gi,
      function (tag, before, src, after) {
        var name = src.replace(/^\.\//, "").split(/[?#]/)[0];
        if (!Object.prototype.hasOwnProperty.call(files, name)) return tag;
        var attrs = (before + " " + after).replace(/\s+/g, " ").trim();
        var keep = attrs ? " " + attrs.replace(/\bsrc\s*=\s*["'][^"']*["']/i, "").trim() : "";
        /* The marker sits on the same line as the opening tag, so the file's
           line 1 always lands on the very next line of the assembled
           document — a fixed offset we can find again afterwards and use to
           report errors against the student's own line numbers.
           sourceURL additionally makes the browser name the file in the
           error and in devtools. */
        return "<script" + keep + ">" + marker(name) + "\n" +
               escapeForScriptTag(files[name]) +
               "\n//# sourceURL=" + name + "\n</script>";
      }
    );

    return out;
  }

  function marker(name) { return "/*@webide:" + name + "*/"; }

  /* Where does each inlined file's line 1 sit in the assembled document?
     Returns { "script.js": offset } such that
     studentLine = documentLine - offset. */
  function lineOffsets(html, files) {
    var offsets = {};
    Object.keys(files).forEach(function (name) {
      var at = html.indexOf(marker(name));
      if (at < 0) return;
      // lines before the marker; the marker's own line is the <script> line
      var markerLine = html.slice(0, at).split("\n").length;
      offsets[name] = markerLine;
    });
    return offsets;
  }

  /* Every .html file in the project — the set a link is allowed to reach. */
  function pages(files) {
    return Object.keys(files).filter(function (n) {
      return /\.html?$/i.test(n);
    }).sort();
  }

  /* Build the complete document. The bridge goes first so it captures errors
     thrown by the student's own scripts.

     `entry` is which of the student's pages to show — index.html unless a link
     or a form has moved the preview somewhere else. `sent` is what a form on
     the previous page submitted, if anything. */
  function assemble(files, token, entry, sent) {
    var start = entry && files[entry] !== undefined ? entry : ENTRY;
    var html = files[start] || "";
    var head = "<script>" + bridge(token, pages(files), sent) + "\n</script>";
    var withBridge;

    if (/<head[^>]*>/i.test(html)) {
      withBridge = html.replace(/<head([^>]*)>/i, "<head$1>\n" + head);
    } else if (/<html[^>]*>/i.test(html)) {
      withBridge = html.replace(/<html([^>]*)>/i, "<html$1>\n" + head);
    } else {
      withBridge = head + "\n" + html;
    }
    var doc = inline(withBridge, files);
    return { html: doc, offsets: lineOffsets(doc, files) };
  }

  /* Turn a raw browser error location into one the student can act on.
     Anything we can't place confidently comes back without a line number
     rather than with a wrong one. */
  function locate(file, line, offsets) {
    if (!file || !line) return "";
    var name = String(file).split("/").pop();
    if (Object.prototype.hasOwnProperty.call(offsets, name)) {
      var own = line - offsets[name];
      if (own >= 1) return name + " line " + own;
      return name;
    }
    return "";
  }

  return {
    ENTRY: ENTRY,
    pages: pages,
    assemble: assemble,
    inline: inline,
    locate: locate
  };
})();
