// Python, running in a worker. One worker is kept warm and runs program after program.
//
// Requests and replies:
//   {id, cmd: 'check', src}
//     -> {id, warnings}
//   {id, cmd: 'run', src, input: Uint8Array, interrupt: SharedArrayBuffer}
//     -> {id, started}, then {id, ms, stdout, stderr, error, interrupted, fatal}
//
// `error` is the traceback, starting from the program's own code. `fatal` means the interpreter can no
// longer be used, so the page starts a new worker.
import { loadPyodide } from './pyodide/pyodide.mjs';

/**
 * Fetch a file from this build.
 * @param {string} path
 * @returns {Promise<Response>}
 */
function get(path) {
  return fetch(new URL(path, import.meta.url));
}

const loadStart = performance.now();
const py = await loadPyodide({
  indexURL: new URL('./pyodide/', import.meta.url).href,
  stdout: () => {},
  stderr: () => {},
});

// vermin finds features that need a newer Python version. py_check.py uses it.
py.unpackArchive(await (await get('./vermin-1.9.2-py3-none-any.whl')).arrayBuffer(), 'wheel');
py.runPython(await (await get('./pure_lru.py')).text());
py.runPython(await (await get('./py_check.py')).text());
const check = py.globals.get('check_python_38');
const version = py.runPython('import sys; sys.version.split()[0]');
postMessage({ ready: true, loadMs: performance.now() - loadStart, version });

let stdout = [];
let stderr = [];
py.setStdout({
  write: (bytes) => {
    stdout.push(bytes.slice());
    return bytes.length;
  },
});
py.setStderr({
  write: (bytes) => {
    stderr.push(bytes.slice());
    return bytes.length;
  },
});

/**
 * Join byte chunks and decode them as UTF-8.
 * @param {Uint8Array[]} chunks
 * @returns {string}
 */
function decode(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const all = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(all);
}

/**
 * Make the given bytes the program's standard input.
 * @param {Uint8Array} input
 */
function setInput(input) {
  let position = 0;
  py.setStdin({
    read: (buffer) => {
      const n = Math.min(buffer.length, input.length - position);
      buffer.set(input.subarray(position, position + n));
      position += n;
      return n;
    },
  });
}

/**
 * Turn a Python error into the message shown to the user: the traceback from the program's own code
 * onwards, without Pyodide's internal frames.
 * @param {Error} e
 * @returns {string|null} The message, or null if the program simply called sys.exit() or exit(0).
 */
function describeError(e) {
  const lines = String(e?.message ?? e)
    .trimEnd()
    .split('\n');
  if (e?.type === 'SystemExit' && /^SystemExit(: (0|None))?$/.test(lines.at(-1))) return null;
  const from = lines.findIndex((line) => line.includes('File "main.py"'));
  if (from < 0) return lines.at(-1);
  return ['Traceback (most recent call last):', ...lines.slice(from)].join('\n');
}

onmessage = ({ data }) => {
  const { id } = data;
  if (data.cmd === 'check') {
    postMessage({ id, warnings: check(data.src).toJs() });
    return;
  }

  setInput(data.input);
  py.setInterruptBuffer(new Int32Array(data.interrupt));
  stdout = [];
  stderr = [];
  const globals = py.globals.get('dict')();
  globals.set('__name__', '__main__');
  postMessage({ id, started: true });

  let error = null;
  let interrupted = false;
  let fatal = false;
  const start = performance.now();
  try {
    py.runPython(data.src, { globals, filename: 'main.py' });
  } catch (e) {
    // A Python exception has a `type`. Any other error, such as running out of native stack, leaves the
    // interpreter unusable.
    interrupted = e?.type === 'KeyboardInterrupt';
    error = describeError(e);
    if (!e?.type) fatal = true;
  }
  const ms = performance.now() - start;

  // Reset the interpreter for the next program.
  try {
    py.runPython('import sys; sys.stdout.flush(); sys.setrecursionlimit(1000)');
    globals.destroy();
  } catch {
    fatal = true;
  }

  postMessage({
    id,
    ms,
    stdout: decode(stdout),
    stderr: decode(stderr),
    error,
    interrupted,
    fatal,
  });
};
