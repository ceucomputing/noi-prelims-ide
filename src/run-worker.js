// Runs one compiled C++ program. Each run gets a new worker, so that the page can stop it at any time.
//
// Request: {wasm, signatures, stdin}
// Replies: {started} just before the program starts, then {ms, code, error, stdout, stderr, heapMB, segments}.
//
// heapMB is how much memory grew while the program ran. The stack is reserved in advance, so this measures
// the heap only.
import { WASI, File, OpenFile, WASIProcExit } from './wasi/index.js';
import { segstackImports } from './segstack-runtime.js';

const KEPT_OUTPUT = 16 * 2 ** 20; // Bytes kept from each of stdout and stderr.

/**
 * Decode the start of a file's bytes as UTF-8.
 * @param {File} file
 * @returns {string}
 */
function decode(file) {
  return new TextDecoder().decode(file.data.subarray(0, KEPT_OUTPUT));
}

self.onmessage = async ({ data: { wasm, signatures, stdin } }) => {
  const stdout = new File([]);
  const stderr = new File([]);
  const wasi = new WASI(
    ['main'],
    [],
    [new OpenFile(new File(stdin)), new OpenFile(stdout), new OpenFile(stderr)],
  );
  const segstack = segstackImports(signatures);

  const module = await WebAssembly.compile(wasm);
  const instance = await WebAssembly.instantiate(module, {
    wasi_snapshot_preview1: wasi.wasiImport,
    segstack: segstack.imports,
  });
  wasi.inst = instance;
  segstack.link(instance);

  const memoryAtStart = instance.exports.memory.buffer.byteLength;
  self.postMessage({ started: true });

  let code = 0;
  let error = null;
  const start = performance.now();
  try {
    await WebAssembly.promising(instance.exports._start)();
  } catch (e) {
    if (e instanceof WASIProcExit) code = e.code;
    else error = `${e?.name}: ${e?.message ?? e}`;
  }
  const ms = performance.now() - start;

  self.postMessage({
    ms,
    code,
    error,
    stdout: decode(stdout),
    stderr: decode(stderr),
    heapMB: (instance.exports.memory.buffer.byteLength - memoryAtStart) / 2 ** 20,
    segments: segstack.stats.segments,
  });
};
