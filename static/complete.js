/* WebIDE — completion for names the student has written themselves.
 *
 * The same idea as the Python editor: no builtins, no library APIs, no
 * signature help. Just the names they created, so a typo doesn't cost twenty
 * minutes. What counts as "their name" depends on the file:
 *
 *   .js    variables, functions, parameters and classes they declared,
 *          found by parsing with Acorn — nothing is executed
 *   .css   the classes and ids that actually exist in their HTML, which is
 *          where the classic "why isn't my rule applying" typo lives
 *   .html  classes and ids already used elsewhere in the markup, so a second
 *          <div class="card"> matches the first
 */

window.WebIDEComplete = (function () {
  "use strict";

  var lastJs = {};    // per-file, kept from the last parse that succeeded

  function isJs(name)   { return /\.m?js$/i.test(name); }
  function isCss(name)  { return /\.css$/i.test(name); }
  function isHtml(name) { return /\.html?$/i.test(name); }

  // ---------------------------------------------------------------- JavaScript
  function walk(node, visit) {
    if (!node || typeof node.type !== "string") return;
    visit(node);
    for (var key in node) {
      if (key === "type" || key === "start" || key === "end" ||
          key === "loc" || key === "range") continue;
      var child = node[key];
      if (Array.isArray(child)) {
        for (var i = 0; i < child.length; i++) {
          if (child[i] && typeof child[i].type === "string") walk(child[i], visit);
        }
      } else if (child && typeof child.type === "string") {
        walk(child, visit);
      }
    }
  }

  /* Destructuring means a declaration's name isn't always a plain identifier:
     const {a, b} = obj  and  const [x, y] = list  both declare two names. */
  function namesFromPattern(node, add) {
    if (!node) return;
    if (node.type === "Identifier") add(node.name);
    else if (node.type === "ObjectPattern") {
      node.properties.forEach(function (p) {
        namesFromPattern(p.value || p.argument, add);
      });
    } else if (node.type === "ArrayPattern") {
      node.elements.forEach(function (el) { namesFromPattern(el, add); });
    } else if (node.type === "AssignmentPattern") namesFromPattern(node.left, add);
    else if (node.type === "RestElement") namesFromPattern(node.argument, add);
  }

  function jsNames(source, fileName) {
    if (!window.acorn) return lastJs[fileName] || [];
    var tree;
    try {
      tree = window.acorn.parse(source, {
        ecmaVersion: "latest", sourceType: "script", allowReturnOutsideFunction: true
      });
    } catch (e) {
      // half-typed code doesn't parse; keep the previous list rather than
      // having suggestions vanish exactly while typing
      return lastJs[fileName] || [];
    }

    var found = {};
    function add(n) { if (n && !/^_/.test(n)) found[n] = true; }

    walk(tree, function (node) {
      switch (node.type) {
        case "VariableDeclarator":
          namesFromPattern(node.id, add); break;
        case "FunctionDeclaration":
        case "FunctionExpression":
        case "ArrowFunctionExpression":
          if (node.id) add(node.id.name);
          (node.params || []).forEach(function (p) { namesFromPattern(p, add); });
          break;
        case "ClassDeclaration":
        case "ClassExpression":
          if (node.id) add(node.id.name); break;
        case "CatchClause":
          namesFromPattern(node.param, add); break;
        case "LabeledStatement":
          add(node.label.name); break;
      }
    });

    var list = Object.keys(found).sort();
    lastJs[fileName] = list;
    return list;
  }

  // ------------------------------------------------------------ HTML classes
  /* DOMParser builds a detached document: nothing runs, nothing is fetched. */
  function markupNames(files) {
    var classes = {}, ids = {};
    Object.keys(files).forEach(function (name) {
      if (!isHtml(name)) return;
      var doc;
      try {
        doc = new DOMParser().parseFromString(files[name], "text/html");
      } catch (e) { return; }
      Array.prototype.forEach.call(doc.querySelectorAll("[class]"), function (el) {
        String(el.getAttribute("class")).split(/\s+/).forEach(function (c) {
          if (c) classes[c] = true;
        });
      });
      Array.prototype.forEach.call(doc.querySelectorAll("[id]"), function (el) {
        var v = el.getAttribute("id");
        if (v) ids[v] = true;
      });
    });
    return { classes: Object.keys(classes).sort(), ids: Object.keys(ids).sort() };
  }

  // ------------------------------------------------------------------- hint
  function hint(cm, fileName, files) {
    var cur = cm.getCursor();
    var line = cm.getLine(cur.line);
    var start = cur.ch;
    while (start > 0 && /[A-Za-z0-9_-]/.test(line.charAt(start - 1))) start--;
    var word = line.slice(start, cur.ch);
    var prefix = start > 0 ? line.charAt(start - 1) : "";

    var pool = [];

    if (isJs(fileName)) {
      var type = cm.getTokenTypeAt(cur);
      if (type === "string" || type === "comment") return null;
      if (prefix === ".") return null;               // a property, not a name
      pool = jsNames(cm.getValue(), fileName);
    } else if (isCss(fileName)) {
      var m = markupNames(files);
      // "." wants a class, "#" wants an id; otherwise offer both
      if (prefix === ".") pool = m.classes;
      else if (prefix === "#") pool = m.ids;
      else pool = m.classes.concat(m.ids);
    } else if (isHtml(fileName)) {
      var mm = markupNames(files);
      pool = mm.classes.concat(mm.ids);
    } else {
      return null;
    }

    if (word.length < 2 || !pool.length) return null;

    var lower = word.toLowerCase();
    var list = pool.filter(function (n) {
      return n !== word && n.toLowerCase().indexOf(lower) === 0;
    });
    if (!list.length) return null;

    return {
      list: list,
      from: CodeMirror.Pos(cur.line, start),
      to: CodeMirror.Pos(cur.line, cur.ch)
    };
  }

  /* Enter is deliberately not a pick key: pressing Enter for a new line must
     give a new line, never a surprise completion. Tab picks. */
  var KEYS = {
    Up: function (cm, h) { h.moveFocus(-1); },
    Down: function (cm, h) { h.moveFocus(1); },
    Tab: function (cm, h) { h.pick(); },
    Esc: function (cm, h) { h.close(); }
  };

  function show(cm, fileName, files) {
    cm.showHint({
      hint: function (editor) { return hint(editor, fileName, files); },
      completeSingle: false,
      customKeys: KEYS
    });
  }

  return { show: show, hint: hint, jsNames: jsNames, markupNames: markupNames };
})();
