// The IDE page.
//
// This module connects the page to the other modules: state.js holds the tabs and saves them, editor.js
// provides the code editor, tests.js draws the test cases, and run.js compiles and runs the code.
//
// When the page is opened with ?demo in a demo build, the tabs hold the demo tasks instead of being empty.
import { registerSW } from './lib.js';
import { createView, newState, showDiagnostics } from './editor.js';
import { loadTabs, saveTabs, newTab, newTest } from './state.js';
import { renderTests } from './tests.js';
import { runTab } from './run.js';

/** @typedef {import('./state.js').Tab} Tab */

const $ = (id) => document.getElementById(id);
const here = (path) => new URL(path, import.meta.url);

/**
 * Show a one-line status message.
 * @param {string} text
 */
function status(text) {
  $('status').textContent = text;
}

const isDemo = new URLSearchParams(location.search).has('demo');
const storageKey = isDemo ? 'demo' : 'ide';
const demo = isDemo ? await loadDemo() : null;

// Test files can be loaded only in demo builds. The build sets this attribute.
const allowImport = document.body.dataset.import === 'on';

registerSW().catch((error) => console.warn('service worker:', error));

/**
 * Load the demo tasks.
 * @returns {Promise<object[]|null>} The tasks, or null if this build has no demo.
 */
async function loadDemo() {
  try {
    const response = await fetch(here('demo/tasks.json'));
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

const tabs = loadTabs(storageKey, demo);
let current = 0;

// ---------------------------------------------------------------------------------------------------------
// Editor buffers
//
// Each tab has two buffers, one per language. A buffer is a CodeMirror state, which holds the text, the
// cursor and the undo history. The page has a single editor view, which shows the current buffer.

const buffers = new WeakMap(); // Tab -> {cpp, py}

/**
 * Return a tab's buffers, creating them on first use.
 * @param {Tab} tab
 * @returns {{cpp: object, py: object}}
 */
function buffersOf(tab) {
  if (!buffers.has(tab)) {
    buffers.set(tab, {
      cpp: newState(tab.code.cpp, 'cpp', queueSave),
      py: newState(tab.code.py, 'py', queueSave),
    });
  }
  return buffers.get(tab);
}

const view = createView($('editor'), buffersOf(tabs[0])[tabs[0].lang]);

/** Store the editor's state back into the current buffer, before the view shows another one. */
function keepView() {
  const tab = tabs[current];
  buffersOf(tab)[tab.lang] = view.state;
}

// ---------------------------------------------------------------------------------------------------------
// Saving

let saveTimer;

/** Save half a second after the last edit. */
function queueSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 500);
}

/** Copy each buffer's text into its tab, then save all tabs. */
function save() {
  keepView();
  for (const tab of tabs) {
    const { cpp, py } = buffersOf(tab);
    tab.code = { cpp: cpp.doc.toString(), py: py.doc.toString() };
  }
  if (!saveTabs(storageKey, tabs)) {
    status('Autosave failed: storage is full.');
  }
}

// ---------------------------------------------------------------------------------------------------------
// Tabs

/**
 * Create an element with the given properties.
 * @param {string} tag
 * @param {object} properties
 * @returns {HTMLElement}
 */
function element(tag, properties) {
  return Object.assign(document.createElement(tag), properties);
}

/** Draw the tab bar: one button per tab, then a button that adds a tab. */
function renderTabBar() {
  const buttons = tabs.map((tab, i) => {
    const button = element('button', {
      className: 'tab',
      textContent: tab.name,
      title: 'Double-click to rename',
    });
    button.setAttribute('aria-current', String(i === current));
    button.onclick = () => show(i);
    button.ondblclick = () => rename(i);

    // The last remaining tab cannot be closed.
    if (tabs.length > 1) {
      const close = element('span', { className: 'close', textContent: '×', title: 'Close tab' });
      close.onclick = (event) => {
        event.stopPropagation();
        closeTab(i);
      };
      button.append(close);
    }
    return button;
  });

  const add = element('button', { textContent: '+', title: 'New tab', onclick: addTab });
  $('tabs').replaceChildren(...buttons, add);
}

/**
 * Show a tab: its buffer, language, time limit, demo notes and tests.
 * @param {number} i
 * @param {boolean} [keep]  Whether to store the current editor state first. It is false when the
 *   current tab has just been removed.
 */
function show(i, keep = true) {
  if (keep) keepView();
  current = i;
  const tab = tabs[i];

  view.setState(buffersOf(tab)[tab.lang]);
  renderTabBar();
  $('lang').value = tab.lang;
  $('limit').value = tab.limit;
  showMessages('');
  status('Ready');
  showDemoNotes(demo?.[tab.demo]);
  drawTests();
  view.focus();
}

/**
 * Show a demo task's title, summary and links, or hide them for other tabs.
 * @param {object|undefined} task
 */
function showDemoNotes(task) {
  $('about').hidden = !task;
  if (!task) return;

  $('about-title').textContent = task.title;
  $('about-text').textContent = task.about;
  $('about-statement').href = here(`demo/${task.statement}`);

  // Show the source as owner/repository/task rather than the full URL.
  $('about-source').href = task.source;
  $('about-source').textContent = task.source.replace(/^https:\/\/github\.com\/|\/tree\/\w+/g, '');
}

/** Add an empty tab and show it. */
function addTab() {
  keepView();
  tabs.push(newTab(`Tab ${tabs.length + 1}`));
  show(tabs.length - 1, false);
  save();
}

/**
 * Ask for a new name for a tab.
 * @param {number} i
 */
function rename(i) {
  const name = prompt('Tab name', tabs[i].name)?.trim();
  if (!name) return;
  tabs[i].name = name;
  renderTabBar();
  save();
}

/**
 * Close a tab after the user confirms.
 * @param {number} i
 */
function closeTab(i) {
  if (!confirm(`Close "${tabs[i].name}"? Its code and tests will be lost.`)) return;
  keepView();
  tabs.splice(i, 1);

  // Keep showing the same tab if it still exists; otherwise show the one that took its place.
  const next = i < current ? current - 1 : Math.min(current, tabs.length - 1);
  show(next, false);
  save();
}

// ---------------------------------------------------------------------------------------------------------
// Language and time limit

$('lang').onchange = () => {
  keepView();
  const tab = tabs[current];
  tab.lang = $('lang').value;
  view.setState(buffersOf(tab)[tab.lang]);
  showMessages('');
  save();
};

$('limit').onchange = () => {
  tabs[current].limit = Number($('limit').value) || 1;
  save();
};

// ---------------------------------------------------------------------------------------------------------
// Tests and running

/** Draw the current tab's test cases. */
function drawTests() {
  renderTests($('tests'), tabs[current].tests, { onChange: queueSave, allowImport });
}

$('add').onclick = () => {
  tabs[current].tests.push(newTest());
  drawTests();
  save();
};

/**
 * Show compiler or Python messages above the tests. An empty string hides them.
 * @param {string} text
 */
function showMessages(text) {
  $('compile').textContent = text.trim();
  $('compile').hidden = !text.trim();
}

/**
 * Turn the compiler's errors and warnings into editor diagnostics.
 * @param {string} stderr  The compiler's output.
 * @returns {{line: number, col: number, severity: string, message: string}[]}
 */
function parseErrors(stderr) {
  const pattern = /^main\.cpp:(\d+):(\d+): (error|warning): (.*)$/gm;
  return [...stderr.matchAll(pattern)].map(([, line, col, severity, message]) => ({
    line: Number(line),
    col: Number(col),
    severity,
    message,
  }));
}

let busy = false;

/** Run every test of the current tab. */
async function run() {
  if (busy) return;
  busy = true;
  $('run').disabled = true;
  save();

  const tab = tabs[current];
  const cards = [...$('tests').children];
  const ui = {
    status,
    messages: showMessages,
    // Mark errors only if the user is still looking at the same tab.
    markErrors: (stderr) => {
      if (tabs[current] === tab) showDiagnostics(view, parseErrors(stderr));
    },
  };

  try {
    await runTab(tab, cards, ui);
  } catch (error) {
    status(`Failed: ${error.message}`);
  } finally {
    busy = false;
    $('run').disabled = false;
  }
}

// ---------------------------------------------------------------------------------------------------------
// Getting the code out, for submission

/** Download the current buffer as a file named after the tab, ending in .cpp or .py. */
function download() {
  save();
  const tab = tabs[current];
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([tab.code[tab.lang]], { type: 'text/plain' }));
  link.download = `${tab.name.replace(/[^\w.-]+/g, '_')}.${tab.lang}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

/** Copy the current buffer to the clipboard. */
async function copy() {
  await navigator.clipboard.writeText(view.state.doc.toString());
  status('Copied');
}

$('run').onclick = run;
$('save').onclick = download;
$('copy').onclick = copy;

// Ctrl+Enter runs the tests and Ctrl+S downloads. These take priority over the editor's own shortcuts.
addEventListener(
  'keydown',
  (event) => {
    if (!event.ctrlKey && !event.metaKey) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      run();
    }
    if (event.key === 's') {
      event.preventDefault();
      download();
    }
  },
  true,
);

show(0, false);
