// The code editor, built from CodeMirror 6 with an explicit list of features.
//
// The build bundles this module together with CodeMirror. The editor deliberately has no autocompletion,
// snippets or templates.
import { EditorState } from '@codemirror/state';
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
  bracketMatching,
  defaultHighlightStyle,
  foldGutter,
  foldKeymap,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from '@codemirror/language';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { lintGutter, setDiagnostics } from '@codemirror/lint';
import { cpp } from '@codemirror/lang-cpp';
import { python } from '@codemirror/lang-python';

const languages = { cpp, py: python };

/**
 * Create the editor view.
 * @param {HTMLElement} parent
 * @param {EditorState} state  The first buffer to show, from newState.
 * @returns {EditorView}
 */
export function createView(parent, state) {
  return new EditorView({ parent, state });
}

/**
 * Create the state of one buffer: its text, cursor and undo history.
 *
 * The IDE keeps one state per tab and language. The single view switches between them.
 * @param {string} text  The initial text.
 * @param {'cpp'|'py'} lang
 * @param {() => void} onChange  Called after every edit.
 * @returns {EditorState}
 */
export function newState(text, lang, onChange) {
  return EditorState.create({
    doc: text,
    extensions: [
      // Display
      lineNumbers(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      highlightSelectionMatches(),
      syntaxHighlighting(defaultHighlightStyle),
      languages[lang](),
      foldGutter(),
      lintGutter(),

      // Editing
      history(),
      drawSelection(),
      rectangularSelection(),
      indentOnInput(),
      indentUnit.of('    '),
      bracketMatching(),
      closeBrackets(),
      search({ top: true }),

      // Keys. Ctrl+F finds and replaces, Ctrl+Alt+G goes to a line, Ctrl+/ toggles a comment, and Tab
      // indents.
      keymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...foldKeymap,
        indentWithTab,
      ]),

      EditorView.updateListener.of((update) => {
        if (update.docChanged) onChange();
      }),
    ],
  });
}

/**
 * Mark compiler errors and warnings in the editor.
 * @param {EditorView} view
 * @param {{line: number, col: number, severity: 'error'|'warning', message: string}[]} diagnostics
 *   Lines and columns count from 1.
 */
export function showDiagnostics(view, diagnostics) {
  const doc = view.state.doc;
  const marks = diagnostics
    .filter((d) => d.line <= doc.lines)
    .map((d) => {
      const line = doc.line(d.line);
      const from = Math.min(line.from + Math.max(d.col - 1, 0), line.to);
      return { from, to: Math.max(from, line.to), severity: d.severity, message: d.message };
    });
  view.dispatch(setDiagnostics(view.state, marks));
}
