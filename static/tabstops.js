/* WebIDE — Tab and Backspace that move between tab stops.
 *
 * Used by both editors a student types into: the main one (app.js) and
 * their own copy during a live lesson (live.js). It was once written inside
 * app.js alone, and the live editor, built separately, quietly went without
 * it — Tab did nothing useful and Backspace took one space at a time, in
 * exactly the lesson where a whole class is copying nesting off the board.
 * One file means an editor either has it or visibly does not bind it.
 */

window.WebIDETabStops = (function () {
  "use strict";

  /* Indentation that moves in whole steps, the way a ruler does.
   *
   * Tab used to insert two spaces wherever the caret was, so a line that had
   * drifted to column 1 went to 3 — still wrong, and now wrong by a number
   * nobody can see. Backspace deleted one space at a time, so leaving a
   * block took two presses and stopping after one left a half-indent.
   *
   * HTML and JS do not care, which is exactly why this matters here: a
   * misaligned file still runs, so nothing ever tells a student it drifted,
   * and by the time a page is thirty lines long the nesting is unreadable.
   * Reading your own markup is most of what debugging it is.
   *
   * The unit is read from the editor, not written down: this file says two
   * and PyIDE's says four, and a hard-coded number here would be wrong the
   * first time either changed.
   */
  function spaces(n) {
    return new Array(n + 1).join(" ");
  }

  function indentToTabStop(cm) {
    if (cm.somethingSelected()) {
      cm.indentSelection("add");
      return;
    }
    var unit = cm.getOption("indentUnit");
    // More than one caret: no single column to align to, so fall back to a
    // whole unit at each. Rare enough not to be worth a wrong answer.
    if (cm.listSelections().length > 1) {
      cm.replaceSelection(spaces(unit), "end");
      return;
    }
    var head = cm.getCursor();
    var col = CodeMirror.countColumn(cm.getLine(head.line), head.ch,
                                     cm.getOption("tabSize"));
    // Never 0 and never more than a full unit: at a stop it moves a whole
    // one, off a stop it moves just enough to land on the next.
    cm.replaceSelection(spaces(unit - (col % unit)), "end");
  }

  function backspaceToTabStop(cm) {
    if (cm.somethingSelected() || cm.listSelections().length > 1) {
      return CodeMirror.Pass;
    }
    var head = cm.getCursor();
    var before = cm.getLine(head.line).slice(0, head.ch);

    /* ONLY IN THE INDENTATION, AND ONLY SPACES.
     *
     * With anything but spaces to the left, this is ordinary typing and one
     * press must delete one character — a Backspace that swallowed a whole
     * tag name would be unusable. A literal tab (from a paste, which is how
     * most HTML arrives) is excluded too: one tab is one character but
     * several columns, so "delete back to the stop" has two different right
     * answers and the wrong one eats markup. Both fall through to
     * CodeMirror. */
    if (before.length === 0 || !/^ +$/.test(before)) {
      return CodeMirror.Pass;
    }

    var unit = cm.getOption("indentUnit");
    var col = before.length;
    var target = (col % unit === 0) ? col - unit : col - (col % unit);
    if (target < 0) target = 0;
    cm.replaceRange("", { line: head.line, ch: target }, head, "+delete");
  }

  return {
    indentToTabStop: indentToTabStop,
    backspaceToTabStop: backspaceToTabStop
  };
})();
