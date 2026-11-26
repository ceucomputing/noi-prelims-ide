// Running a tab's tests.
//
// C++ is compiled once, and Python is checked once. Then each test runs in turn, and its verdict appears on
// its card. Verdicts and times are estimates.
import { Cpp, Py, runCpp } from './lib.js';
import { inputOf, expectedOf } from './tests.js';

/** @typedef {import('./state.js').Tab} Tab */

const cpp = new Cpp();
let py; // Python starts on first use, to save memory.

const SHOWN_OUTPUT = 64 * 1024; // Characters of output shown per test. All of it is compared.
const CRASH_REPORT = /(Fatal Python error|Stack \(most recent call first\))[\s\S]*$/;

const VERDICTS = {
  AC: 'Accepted: the output matches the expected output.',
  WA: 'Wrong Answer: the output differs from the expected output.',
  RTE: 'Runtime Error.',
  TLE: 'Time Limit Exceeded.',
  Done: 'The program ran. There is no expected output to compare.',
};

/**
 * Format milliseconds as seconds.
 * @param {number} ms
 * @returns {string}
 */
function seconds(ms) {
  return `${(ms / 1000).toFixed(2)} s`;
}

/**
 * Run every test of a tab.
 * @param {Tab} tab
 * @param {Element[]} cards  The tests' cards, in order.
 * @param {object} ui
 * @param {(text: string) => void} ui.status  Shows a one-line status.
 * @param {(text: string) => void} ui.messages  Shows compiler or Python messages. An empty string hides them.
 * @param {(stderr: string) => void} ui.markErrors  Marks compiler errors in the editor.
 */
export async function runTab(tab, cards, ui) {
  const source = tab.code[tab.lang];

  // Stop a run at three times the limit, with at least two seconds, because the IDE's speed differs from
  // the judge's.
  const stopAfterMs = Math.max(2000, tab.limit * 3000);

  const execute =
    tab.lang === 'cpp'
      ? await compileCpp(source, stopAfterMs, ui)
      : await checkPython(source, stopAfterMs, ui);
  if (!execute) return;

  let passed = 0;
  for (const [i, test] of tab.tests.entries()) {
    ui.status(`Running test ${i + 1}/${tab.tests.length}…`);
    const [input, expected] = await Promise.all([inputOf(test), expectedOf(test)]);
    const result = await execute(input);
    if (showResult(cards[i], expected, result, tab.limit, stopAfterMs)) passed++;
  }
  ui.status(`${passed}/${tab.tests.length} AC`);
}

/**
 * Compile C++ and show the compiler's messages.
 * @param {string} source
 * @param {number} stopAfterMs  When to stop each run.
 * @param {object} ui  As for runTab.
 * @returns {Promise<((input: string) => Promise<object>)|null>} A function that runs the program, or null if
 *   compilation failed.
 */
async function compileCpp(source, stopAfterMs, ui) {
  ui.status('Compiling…');
  const program = await cpp.compile(source);
  ui.messages(program.stderr);
  ui.markErrors(program.stderr);

  if (!program.ok) {
    ui.status(`Compile error (${seconds(program.compileMs)})`);
    return null;
  }
  return (input) => runCpp(program, input, { killAfterMs: stopAfterMs });
}

/**
 * Start Python if needed, and warn about anything that Python 3.8, the judge's version, lacks.
 * @param {string} source
 * @param {number} stopAfterMs  When to stop each run.
 * @param {object} ui  As for runTab.
 * @returns {Promise<(input: string) => Promise<object>>} A function that runs the program.
 */
async function checkPython(source, stopAfterMs, ui) {
  if (!py) {
    ui.status('Starting Python…');
    py = new Py();
  }
  await py.ready;

  const { warnings } = await py.check(source);
  if (warnings.length > 0) {
    ui.messages(`Not in Python 3.8 (the judge's version):\n  ${warnings.join('\n  ')}`);
  } else {
    ui.messages('');
  }
  return (input) => py.run(source, input, { killAfterMs: stopAfterMs });
}

/**
 * Compare two outputs token by token, ignoring whitespace.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function sameTokens(a, b) {
  const x = a.split(/\s+/).filter(Boolean);
  const y = b.split(/\s+/).filter(Boolean);
  return x.length === y.length && x.every((token, i) => token === y[i]);
}

/**
 * Show a run's verdict, output and errors on its card.
 * @param {Element} card
 * @param {string} expected
 * @param {object} result  The result from runCpp or Py.run.
 * @param {number} limit  The time limit, in seconds.
 * @param {number} stopAfterMs
 * @returns {boolean} Whether the verdict is AC.
 */
function showResult(card, expected, result, limit, stopAfterMs) {
  // A fatal Python error means the interpreter overflowed its stack and was restarted. Its crash report is
  // not the program's output.
  const crashed = result.fatal && !result.killed;
  const stdout = crashed ? (result.stdout ?? '').replace(CRASH_REPORT, '') : (result.stdout ?? '');

  let verdict;
  let note;
  if (result.killed) {
    verdict = 'TLE';
    note = `stopped at ${seconds(stopAfterMs)}`;
  } else if (crashed) {
    verdict = 'RTE';
    note = 'stack overflow (deep recursion through built-in functions)';
  } else if (result.error || result.code) {
    verdict = 'RTE';
    note = result.error?.trim().split('\n').at(-1) ?? `exit code ${result.code}`;
  } else {
    verdict = expected.trim() ? (sameTokens(stdout, expected) ? 'AC' : 'WA') : 'Done';
    note = seconds(result.ms);
    if (result.ms > limit * 1000) note += ' (over the limit)';
    if (result.heapMB != null) note += ` · heap ${result.heapMB.toFixed(0)} MB`;
  }

  const label = card.querySelector('.verdict');
  label.className = `verdict ${verdict}`;
  label.textContent = `${verdict} · ${note}`;
  label.title = VERDICTS[verdict];

  card.querySelector('.out').textContent =
    stdout.length > SHOWN_OUTPUT
      ? `${stdout.slice(0, SHOWN_OUTPUT)}\n… (${stdout.length} characters)`
      : stdout;

  const stderr = crashed ? '' : [result.stderr, result.error].filter(Boolean).join('\n').trim();
  card.querySelector('.err').textContent = stderr.slice(0, SHOWN_OUTPUT);
  card.querySelector('.errwrap').hidden = !stderr;

  return verdict === 'AC';
}
