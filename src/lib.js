// Page-side interface to the workers.
//
// It compiles and runs C++, runs Python, and registers the service worker. The IDE (run.js) and the
// self-check page use it.

const encoder = new TextEncoder();

/**
 * Return a URL relative to this module.
 * @param {string} path
 * @returns {URL}
 */
function here(path) {
  return new URL(path, import.meta.url);
}

/**
 * Convert text to UTF-8 bytes. Bytes are returned unchanged.
 * @param {string|Uint8Array} data
 * @returns {Uint8Array}
 */
function toBytes(data) {
  return typeof data === 'string' ? encoder.encode(data) : data;
}

/** The C++ compiler. It is one long-lived worker, cpp-worker.js. */
export class Cpp {
  constructor() {
    this.nextId = 0;
    this.pending = new Map(); // request id -> resolve function
    this.worker = new Worker(here('./cpp-worker.js'), { type: 'module' });

    this.worker.onmessage = ({ data }) => {
      this.pending.get(data.id)?.(data);
      this.pending.delete(data.id);
    };

    this.worker.onerror = (event) => {
      for (const resolve of this.pending.values()) {
        resolve({ ok: false, stderr: `The compiler failed: ${event.message}` });
      }
      this.pending.clear();
    };
  }

  /**
   * Compile one C++ source file.
   * @param {string} source
   * @returns {Promise<{ok: boolean, wasm?: Uint8Array, signatures?: string[], compileMs: number,
   *   segMs?: number, stderr: string}>}
   */
  compile(source) {
    const id = ++this.nextId;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.worker.postMessage({ id, src: source });
    });
  }
}

/**
 * Run a compiled C++ program in a new worker, which is stopped after killAfterMs.
 * @param {{wasm: Uint8Array, signatures: string[]}} program  The result of Cpp.compile.
 * @param {string|Uint8Array} stdin
 * @param {{killAfterMs?: number}} [options]
 * @returns {Promise<{ms: number, code?: number, error?: string, stdout?: string, stderr?: string,
 *   heapMB?: number, segments?: number, killed?: boolean}>} See run-worker.js for the fields.
 */
export function runCpp({ wasm, signatures }, stdin, { killAfterMs = 4000 } = {}) {
  return new Promise((resolve) => {
    const worker = new Worker(here('./run-worker.js'), { type: 'module' });
    let timer;

    const finish = (result) => {
      clearTimeout(timer);
      worker.terminate();
      resolve(result);
    };

    worker.onmessage = ({ data }) => {
      if (!data.started) {
        finish(data);
        return;
      }
      // The program has started. Time it from here, not from worker start-up.
      const start = performance.now();
      timer = setTimeout(
        () => finish({ killed: true, ms: performance.now() - start }),
        killAfterMs,
      );
    };

    worker.onerror = (event) => finish({ error: `The run failed: ${event.message}` });
    worker.postMessage({ wasm, signatures, stdin: toBytes(stdin) });
  });
}

/** Python. It is one warm worker, py-worker.js, which is restarted after it is stopped or crashes. */
export class Py {
  constructor() {
    this.nextId = 0;
    this.start();
  }

  /** Start a worker. `this.ready` resolves with {version, loadMs} once Python has loaded. */
  start() {
    this.pending = new Map(); // request id -> {resolve, started}
    this.worker = new Worker(here('./py-worker.js'), { type: 'module' });

    this.ready = new Promise((resolveReady, rejectReady) => {
      this.worker.onmessage = ({ data }) => {
        if (data.ready) {
          resolveReady(data);
          return;
        }
        const request = this.pending.get(data.id);
        if (!request) return;
        if (data.started) {
          request.started?.();
          return;
        }
        this.pending.delete(data.id);
        request.resolve(data);
      };

      this.worker.onerror = (event) => {
        rejectReady(new Error(event.message));
        for (const request of this.pending.values()) {
          request.resolve({ fatal: true, error: `Python failed: ${event.message}` });
        }
        this.pending.clear();
      };
    });
  }

  /**
   * Find anything in a program that needs a Python version newer than 3.8.
   * @param {string} source
   * @returns {Promise<{warnings: string[]}>}
   */
  async check(source) {
    await this.ready;
    const id = ++this.nextId;
    return new Promise((resolve) => {
      this.pending.set(id, { resolve });
      this.worker.postMessage({ id, cmd: 'check', src: source });
    });
  }

  /**
   * Run a Python program.
   *
   * After killAfterMs, the program is interrupted as if by Ctrl+C. If it is still running three seconds
   * later, the worker is stopped and a new one is started.
   * @param {string} source
   * @param {string|Uint8Array} stdin
   * @param {{killAfterMs?: number}} [options]
   * @returns {Promise<{ms?: number, stdout?: string, stderr?: string, error?: string, killed?: boolean,
   *   interrupted?: boolean, fatal?: boolean}>} See py-worker.js for the fields.
   */
  async run(source, stdin, { killAfterMs = 4000 } = {}) {
    await this.ready;
    const id = ++this.nextId;
    const interrupt = new Int32Array(new SharedArrayBuffer(4));

    const result = await new Promise((resolve) => {
      let softStop;
      let hardStop;
      this.pending.set(id, {
        started: () => {
          softStop = setTimeout(() => {
            interrupt[0] = 2; // SIGINT, which Python raises as KeyboardInterrupt.
          }, killAfterMs);
          hardStop = setTimeout(() => {
            this.pending.delete(id);
            this.worker.terminate();
            resolve({ killed: true, fatal: true });
          }, killAfterMs + 3000);
        },
        resolve: (value) => {
          clearTimeout(softStop);
          clearTimeout(hardStop);
          resolve(value);
        },
      });
      this.worker.postMessage({
        id,
        cmd: 'run',
        src: source,
        input: toBytes(stdin),
        interrupt: interrupt.buffer,
      });
    });

    if (result.interrupted) result.killed = true;
    if (result.fatal) {
      this.worker.terminate();
      this.start();
    }
    return result;
  }
}

/**
 * Register the service worker, sw.js. It keeps the IDE available offline and adds the security headers on
 * hosts that cannot send them.
 *
 * Python needs the page to be cross-origin isolated. If the page is not, but the service worker can make
 * it so, the page reloads once.
 */
export async function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  await navigator.serviceWorker.register('sw.js');
  await navigator.serviceWorker.ready;

  // On the first visit, wait briefly for the service worker to take control of the page.
  if (!navigator.serviceWorker.controller) {
    await new Promise((resolve) => {
      navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true });
      setTimeout(resolve, 5000);
    });
  }

  if (!crossOriginIsolated && navigator.serviceWorker.controller && !sessionStorage.coiReload) {
    sessionStorage.coiReload = '1';
    location.reload();
  }
}
