// Tabs, test cases, and saving them.
//
// The IDE starts with five empty tabs. Work is saved in sessionStorage, so it survives a page reload but
// not closing the browser tab.

/**
 * A test case.
 *
 * A demo test also has a `file`. Its input and expected output are the files demo/<file>.in and
 * demo/<file>.out. Its `input` and `expected` stay null until the test is opened; if it is never opened,
 * the files are read when it runs.
 * @typedef {object} Test
 * @property {string|null} input
 * @property {string|null} expected
 * @property {boolean} open      Whether its card is expanded.
 * @property {string} [file]     Demo tests only.
 * @property {boolean} [edited]  Set once a demo test's text has been changed.
 */

/**
 * An editor tab, with a C++ and a Python buffer, a time limit and test cases.
 * @typedef {object} Tab
 * @property {string} name
 * @property {'cpp'|'py'} lang       The language currently shown.
 * @property {{cpp: string, py: string}} code
 * @property {number} limit          The time limit, in seconds.
 * @property {Test[]} tests
 * @property {number} [demo]         The index of its demo task, if any.
 */

/** The Python buffer of a demo task that has no published Python solution. */
export const NO_PY = '# No Python solution was published for this task.\n';

/**
 * Create an empty test case, expanded.
 * @returns {Test}
 */
export function newTest() {
  return { input: '', expected: '', open: true };
}

/**
 * Create an empty tab.
 * @param {string} name
 * @returns {Tab}
 */
export function newTab(name) {
  return {
    name,
    lang: 'cpp',
    code: { cpp: '', py: '' },
    limit: 1,
    tests: [newTest()],
  };
}

/**
 * Create one tab per demo task, holding its published solutions and its tests.
 * @param {object[]} demo  The contents of demo/tasks.json.
 * @returns {Tab[]}
 */
function demoTabs(demo) {
  return demo.map((task, i) => ({
    name: task.name,
    lang: 'cpp',
    code: { cpp: task.code.cpp, py: task.code.py ?? NO_PY },
    limit: task.limit,
    demo: i,
    tests: task.tests.map((file) => ({ file, input: null, expected: null, open: false })),
  }));
}

/**
 * Load the saved tabs, or create the starting ones.
 * @param {string} key  The sessionStorage key. The demo and the normal IDE use different keys.
 * @param {object[]|null} demo  The demo tasks, in the demo.
 * @returns {Tab[]}
 */
export function loadTabs(key, demo) {
  try {
    const tabs = JSON.parse(sessionStorage[key]);
    if (Array.isArray(tabs) && tabs.length > 0 && typeof tabs[0].code === 'object') return tabs;
  } catch {
    // Nothing has been saved in this browser tab yet.
  }

  if (demo) return demoTabs(demo);
  return [1, 2, 3, 4, 5].map((n) => newTab(`Task ${n}`));
}

/**
 * Save the tabs.
 *
 * A demo test that has not been edited is saved without its text, which is read from its files again.
 * This keeps large tests out of storage.
 * @param {string} key
 * @param {Tab[]} tabs
 * @returns {boolean} False if storage is full.
 */
export function saveTabs(key, tabs) {
  const withoutDemoText = (test) =>
    test.file && !test.edited ? { ...test, input: null, expected: null } : test;
  const slim = tabs.map((tab) => ({ ...tab, tests: tab.tests.map(withoutDemoText) }));
  try {
    sessionStorage[key] = JSON.stringify(slim);
    return true;
  } catch {
    return false;
  }
}
