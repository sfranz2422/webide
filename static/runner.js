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
  var GAME_LIB = "kaplay.js";
  var GAME_ROOT = "/static/game/";      // kaplay.js and sprites/ live here

  /* A game project is one whose page pulls in the library. Nothing else to
     track: the boilerplate carries the tag, so what the student edits is
     exactly what they get in a download. */
  function isGame(files) {
    var html = files[ENTRY] || "";
    return new RegExp("<script[^>]*\\bsrc\\s*=\\s*[\"'][^\"']*" +
                      GAME_LIB + "[\"']", "i").test(html);
  }

  /* The preview has no server behind it and a null origin, so a relative URL
     has nothing to resolve against. A <base> pointing at this app fixes both
     kaplay.js and every sprites/… path in one line, and — because it lives in
     the assembled document rather than the student's file — the same markup
     still resolves against the local folder once the project is unzipped. */
  function baseTag() {
    return '<base href="' + location.origin + GAME_ROOT + '">';
  }

  /* Sent into the page ahead of the student's own code. Mirrors console output
     and errors back to the editor. Kept in its own <script> element so the
     student's line numbers still start at 1 in their own file. */
  function bridge(token) {
    return [
      "(function () {",
      "  var TOKEN = " + JSON.stringify(token) + ";",
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
      "  window.addEventListener('load', function () { send('ready', ''); });",
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

  /* Build the complete document. The bridge goes first so it captures errors
     thrown by the student's own scripts. */
  function assemble(files, token) {
    var html = files[ENTRY] || "";
    // <base> must come before anything that uses a URL, so it goes in first
    var head = (isGame(files) ? baseTag() + "\n" : "") +
               "<script>" + bridge(token) + "\n</script>";
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

  /* What a download needs beyond the student's own files, so the unzipped
     folder runs with no internet: the library, plus every sprite. The whole
     pack goes in rather than only the ones we can see referenced — a sprite
     name built at runtime (a variable, a random pick, string concatenation)
     is invisible to any scan, and a game that works in class but breaks at
     home is the worst possible outcome. */
  function extras(files) {
    if (!isGame(files)) return [];
    var list = [{ name: GAME_LIB, url: GAME_ROOT + GAME_LIB }];
    var manifest = window.WEBIDE && window.WEBIDE.sprites;
    (manifest || []).forEach(function (s) {
      list.push({
        name: "sprites/" + s.name + ".png",
        url: GAME_ROOT + "sprites/" + s.name + ".png"
      });
    });
    return list;
  }

  return {
    ENTRY: ENTRY,
    GAME_LIB: GAME_LIB,
    GAME_ROOT: GAME_ROOT,
    isGame: isGame,
    extras: extras,
    assemble: assemble,
    inline: inline,
    locate: locate
  };
})();
