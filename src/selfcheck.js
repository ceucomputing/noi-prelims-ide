// The self-check page.
//
// It checks that a contest computer can run the IDE: the browser's features, the service worker, the
// network path, and small C++ and Python programs run from start to finish. It ends with a summary and a
// report that can be copied and sent back.
import { Cpp, Py, runCpp, registerSW } from './lib.js';

const $ = (id) => document.getElementById(id);

/** @type {{name: string, ok: boolean|'warn', detail: string}[]} */
const results = [];

// ---------------------------------------------------------------------------------------------------------
// Helpers

/**
 * Format milliseconds as seconds.
 * @param {number} ms
 * @returns {string}
 */
function seconds(ms) {
  return `${(ms / 1000).toFixed(2)} s`;
}

/**
 * Format a number of bytes as megabytes.
 * @param {number} bytes
 * @returns {string}
 */
function megabytes(bytes) {
  return `${(bytes / 2 ** 20).toFixed(1)} MB`;
}

/**
 * Wait for a promise, but give up after a time limit.
 * @param {Promise} promise
 * @param {number} ms
 * @param {string} what  Names the operation in the error message.
 * @returns {Promise}
 */
function withTimeout(promise, ms, what) {
  const timeout = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`${what}: no answer in ${ms / 1000} s`)), ms);
  });
  return Promise.race([promise, timeout]);
}

/**
 * Add a row to the results table.
 * @param {string} name
 * @param {boolean|'warn'} ok
 * @param {string} detail
 */
function addRow(name, ok, detail) {
  results.push({ name, ok, detail });
  const [mark, style] = ok === true ? ['✓', 'ok'] : ok === 'warn' ? ['!', 'warn'] : ['✗', 'bad'];
  const row = document.createElement('tr');
  for (const [text, className] of [
    [mark, style],
    [name, ''],
    [detail, ''],
  ]) {
    const cell = document.createElement('td');
    cell.textContent = text;
    cell.className = className;
    row.append(cell);
  }
  $('rows').append(row);
}

/**
 * Run one check and add its row.
 *
 * The check returns [ok, detail], where ok is true, false or 'warn'. If it throws, it has failed.
 * @param {string} name
 * @param {() => Promise<[boolean|'warn', string]>|[boolean|'warn', string]} check
 */
async function step(name, check) {
  try {
    const [ok, detail] = await check();
    addRow(name, ok, detail);
  } catch (error) {
    addRow(name, false, `${error?.name ?? 'Error'}: ${error?.message ?? error}`);
  }
}

// ---------------------------------------------------------------------------------------------------------
// Test programs

const CPP = {
  // Reads numbers with cin and prints their sum.
  sum: `#include <bits/stdc++.h>
using namespace std;

int main() {
    ios::sync_with_stdio(false);
    cin.tie(nullptr);
    int n;
    cin >> n;
    long long sum = 0;
    for (int i = 0; i < n; i++) {
        long long x;
        cin >> x;
        sum += x;
    }
    cout << sum << "\\n";
}`,

  // A depth-first search on a path of n nodes, which recurses n levels deep.
  deep: `#include <bits/stdc++.h>
using namespace std;

vector<vector<int>> adjacent;
vector<int> size_of;

void dfs(int u, int parent) {
    size_of[u] = 1;
    for (int v : adjacent[u]) {
        if (v != parent) {
            dfs(v, u);
            size_of[u] += size_of[v];
        }
    }
}

int main() {
    int n;
    cin >> n;
    adjacent.resize(n);
    size_of.resize(n);
    for (int i = 1; i < n; i++) {
        adjacent[i - 1].push_back(i);
        adjacent[i].push_back(i - 1);
    }
    dfs(0, -1);
    cout << size_of[0] << "\\n";
}`,

  // Recursion n levels deep, with large stack frames.
  wide: `#include <bits/stdc++.h>
using u64 = unsigned long long;

u64 f(int n, u64 a, u64 b, u64 c, u64 d, u64 e, u64 g) {
    if (n == 0) return a ^ b ^ c ^ d ^ e ^ g;
    u64 r = f(n - 1, b + n, c * 3, d ^ a, e + 1, g - n, a * 7);
    return (r * (a | 1)) ^ (b + c) ^ (d * e) ^ g;
}

int main() {
    int n;
    std::cin >> n;
    std::cout << (f(n, 1, 2, 3, 4, 5, 6) != 42) << "\\n";
}`,

  // 64 MB of global arrays.
  arrays: `long long a[8000000];
int b[2000000];

int main() {
    a[7999999] = 1;
    b[5] = 2;
    return (int)(a[7999999] + b[5]) - 3;
}`,

  // Throws and catches an exception.
  exception: `#include <bits/stdc++.h>
using namespace std;

int main() {
    vector<int> v(1);
    try {
        v.at(5) = 1;
        cout << "not caught\\n";
    } catch (const out_of_range&) {
        cout << "caught\\n";
    }
}`,

  // Overflows a 32-bit long.
  long: `#include <bits/stdc++.h>
using namespace std;

int main() {
    long a;
    cin >> a;
    long b = a * a;
    cout << b << "\\n";
}`,

  // Never stops.
  loop: `int main() {
    volatile unsigned x = 0;
    while (true) x++;
}`,
};

const PYTHON = {
  sum: `import sys

data = sys.stdin.buffer.read().split()
print(sum(map(int, data[1:])))`,

  deep: `import sys
from functools import lru_cache

sys.setrecursionlimit(10**6)


def f(n):
    return 0 if n == 0 else f(n - 1) + 1


@lru_cache(maxsize=None)
def g(n):
    return 0 if n == 0 else g(n - 1) + 1


print(f(100000), g(100000))`,

  loop: 'while True:\n    pass',
  after: 'print(6 * 7)',
};

const NUMBERS = Array.from({ length: 200000 }, (_, i) => (i * 7919) % 1000003);
const SUM_INPUT = `${NUMBERS.length}\n${NUMBERS.join(' ')}\n`;
const SUM_OUTPUT = String(NUMBERS.reduce((a, b) => a + b, 0));

// ---------------------------------------------------------------------------------------------------------
// Checks

/** Check the browser's version and the features that the IDE needs. */
async function checkBrowser() {
  await step('Browser', () => {
    const brands = navigator.userAgentData?.brands ?? [];
    const brand = brands.find((b) => /Chrome|Edge/.test(b.brand) && !/Not/.test(b.brand));
    const version = Number(brand?.version ?? navigator.userAgent.match(/Chrome\/(\d+)/)?.[1]);
    const name = brands.some((b) => b.brand === 'Microsoft Edge') ? 'Edge' : 'Chrome';
    const platform = navigator.userAgentData?.platform ?? navigator.platform;
    const memory = navigator.deviceMemory
      ? `, at least ${navigator.deviceMemory} GB of memory`
      : '';
    return [
      version >= 137,
      `${name} ${version} on ${platform}; needs 137 or later; ${navigator.hardwareConcurrency} threads${memory}`,
    ];
  });

  await step('Cross-origin isolation', () =>
    crossOriginIsolated
      ? [true, 'Isolated.']
      : [false, 'Not isolated. A proxy may have removed the COOP and COEP headers.'],
  );

  await step('SharedArrayBuffer', () => [
    typeof SharedArrayBuffer === 'function',
    typeof SharedArrayBuffer,
  ]);

  await step('WebAssembly stack switching (JSPI)', () => [
    typeof WebAssembly.Suspending === 'function' && typeof WebAssembly.promising === 'function',
    'WebAssembly.Suspending and WebAssembly.promising',
  ]);

  await step('WebAssembly exceptions', () => {
    // A minimal module whose only function contains an empty try_table block.
    const module = new Uint8Array([
      0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 10, 8, 1, 6, 0, 0x1f, 0x40, 0,
      0x0b, 0x0b,
    ]);
    return [WebAssembly.validate(module), 'try_table'];
  });

  await step('Requests to other origins are blocked', async () => {
    // The browser refuses the request before sending anything, so nothing leaves this computer.
    try {
      await fetch('https://example.com/', { mode: 'no-cors' });
      return [false, 'Not blocked.'];
    } catch {
      return [true, 'Blocked.'];
    }
  });
}

/**
 * Check the service worker, the offline store and the storage quota.
 * @param {object} build  The contents of build.json.
 * @returns {Promise<string>} A note for the report: 'ok', or why the service worker is not active.
 */
async function checkServiceWorker(build) {
  let note = 'ok';

  await step('Service worker', async () => {
    await registerSW();
    if (!navigator.serviceWorker.controller) {
      note = 'not active yet';
      return ['warn', 'Not active yet. Reload the page.'];
    }
    return [true, `Active, build ${build.id}.`];
  });

  await step('Offline files', async () => {
    const cache = await caches.open(build.id);
    const stored = (await cache.keys()).length;
    const wanted = build.files.length + 4; // The build's files, plus the two pages, build.json and "./".
    const detail = `${stored}/${wanted} files stored${stored < wanted ? '; still downloading?' : ''}`;
    return [stored >= wanted ? true : 'warn', detail];
  });

  await step('Storage', async () => {
    const estimate = await navigator.storage.estimate();
    const persisted = await navigator.storage.persisted?.();
    const enough = estimate.quota > 1.5 * build.rawBytes;
    return [
      enough ? true : 'warn',
      `Using ${megabytes(estimate.usage)} of ${megabytes(estimate.quota)}; persisted: ${persisted}`,
    ];
  });

  return note;
}

/**
 * Download the largest file directly from the server and check that it arrives unchanged. A proxy might
 * block, cut short or alter large downloads.
 * @param {object} build  The contents of build.json.
 */
async function checkDownload(build) {
  await step('Large download', async () => {
    const file = build.files[0];
    const start = performance.now();
    let response;
    try {
      response = await fetch(`${file.path}?probe=${Date.now()}`, { cache: 'no-store' });
    } catch (error) {
      return ['warn', `The server is unreachable (${error.message}).`];
    }
    const data = await response.arrayBuffer();
    const ms = performance.now() - start;

    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
    const hex = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const intact = hex === file.sha256;

    const name = file.path.split('/').pop();
    const speed = (data.byteLength / 2 ** 20 / (ms / 1000)).toFixed(0);
    const headers = [
      'cross-origin-opener-policy',
      'cross-origin-embedder-policy',
      'content-encoding',
    ]
      .map((header) => `${header}: ${response.headers.get(header)}`)
      .join(', ');
    return [
      intact,
      `${name}: ${megabytes(data.byteLength)} in ${seconds(ms)} (${speed} MB/s), ${intact ? 'intact' : 'CHANGED'}; ${headers}`,
    ];
  });
}

/** Compile and run C++ programs. */
async function checkCpp() {
  const cpp = new Cpp();
  let sumProgram;

  await step('C++ first compile, including loading the compiler', async () => {
    sumProgram = await withTimeout(cpp.compile(CPP.sum), 180000, 'compile');
    if (!sumProgram.ok) return [false, sumProgram.stderr.slice(0, 400)];
    return [
      true,
      `${seconds(sumProgram.compileMs)}, plus ${sumProgram.segMs.toFixed(0)} ms to prepare for deep recursion`,
    ];
  });

  await step('C++ reading 200,000 numbers with cin', async () => {
    const result = await runCpp(sumProgram, SUM_INPUT);
    const output = result.stdout?.trim();
    return [
      output === SUM_OUTPUT,
      `${seconds(result.ms)}; output ${output}, expected ${SUM_OUTPUT} ${result.error ?? ''}`,
    ];
  });

  await step('C++ second compile', async () => {
    const program = await cpp.compile(CPP.sum);
    if (!program.ok) return [false, program.stderr.slice(0, 400)];
    const fastEnough = program.compileMs < 10000 ? true : 'warn';
    return [fastEnough, `${seconds(program.compileMs)}, plus ${program.segMs.toFixed(0)} ms`];
  });

  await step('C++ recursion 1,000,000 levels deep', async () => {
    const program = await cpp.compile(CPP.deep);
    if (!program.ok) return [false, program.stderr.slice(0, 400)];
    const result = await runCpp(program, '1000000\n', { killAfterMs: 20000 });
    const passed = result.stdout?.trim() === '1000000';
    return [
      passed,
      `${seconds(result.ms)}; ${result.segments} extra stacks; ${result.error ?? result.stdout?.trim()}`,
    ];
  });

  await step('C++ deep recursion with large stack frames', async () => {
    const program = await cpp.compile(CPP.wide);
    if (!program.ok) return [false, program.stderr.slice(0, 400)];
    const result = await runCpp(program, '1000000\n', { killAfterMs: 20000 });
    // Fewer than 100 extra stacks would mean the compiler removed the recursion, so the check proved nothing.
    const passed = result.stdout?.trim() === '1' && result.segments > 100;
    return [
      passed,
      `${seconds(result.ms)}; ${result.segments} extra stacks; ${result.error ?? result.stdout?.trim()}`,
    ];
  });

  await step('C++ compile with 64 MB of global arrays', async () => {
    const program = await cpp.compile(CPP.arrays);
    if (!program.ok) return [false, program.stderr.slice(0, 300)];
    const result = await runCpp(program, '');
    const passed = result.code === 0 ? (program.compileMs < 10000 ? true : 'warn') : false;
    return [passed, `${seconds(program.compileMs)}; ${result.error ?? `exit code ${result.code}`}`];
  });

  await step('C++ exceptions', async () => {
    const program = await cpp.compile(CPP.exception);
    if (!program.ok) return [false, program.stderr.slice(0, 300)];
    const result = await runCpp(program, '');
    return [result.stdout?.trim() === 'caught', result.error ?? result.stdout?.trim()];
  });

  await step('C++ warning for 32-bit long', async () => {
    const program = await cpp.compile(CPP.long);
    if (!program.ok) return [false, program.stderr.slice(0, 300)];
    const result = await runCpp(program, '100000\n');
    const stderr = (result.stderr ?? '').trim();
    return [stderr.includes('[IDE] Integer overflow'), stderr.slice(0, 200)];
  });

  await step('C++ infinite loop is stopped', async () => {
    const program = await cpp.compile(CPP.loop);
    const start = performance.now();
    const result = await runCpp(program, '', { killAfterMs: 1000 });
    return [Boolean(result.killed), `Stopped after ${seconds(performance.now() - start)}.`];
  });
}

/** Start Python and run Python programs. */
async function checkPython() {
  const py = new Py();

  await step('Python start', async () => {
    const ready = await withTimeout(py.ready, 120000, 'Python');
    return [true, `Python ${ready.version} in ${seconds(ready.loadMs)}`];
  });

  await step('Python reading 200,000 numbers', async () => {
    const result = await py.run(PYTHON.sum, SUM_INPUT);
    const output = result.stdout?.trim();
    return [output === SUM_OUTPUT, `${seconds(result.ms)}; output ${output} ${result.error ?? ''}`];
  });

  await step('Python recursion 100,000 levels deep, with and without lru_cache', async () => {
    const result = await py.run(PYTHON.deep, '', { killAfterMs: 20000 });
    return [
      result.stdout?.trim() === '100000 100000',
      `${seconds(result.ms ?? 0)}; ${result.error ?? result.stdout?.trim()}`,
    ];
  });

  await step('Python 3.8 check', async () => {
    const { warnings } = await py.check('import math\nprint(math.lcm(4, 6))\n');
    return [warnings.some((w) => w.includes('lcm')), warnings.join(' | ') || 'No warning.'];
  });

  await step('Python infinite loop is stopped', async () => {
    const result = await py.run(PYTHON.loop, '', { killAfterMs: 1000 });
    const after = await py.run(PYTHON.after, '');
    const reusable = after.stdout?.trim() === '42';
    return [
      Boolean(result.interrupted) && reusable,
      `Interrupted: ${Boolean(result.interrupted)}; usable afterwards: ${reusable}`,
    ];
  });
}

/** Check that nothing was requested from another origin, according to both the page and the service worker. */
async function checkOtherOrigins() {
  await step('No requests to other origins', async () => {
    const fromPage = performance
      .getEntriesByType('resource')
      .map((entry) => new URL(entry.name).origin)
      .filter((origin) => origin !== location.origin);

    const worker = navigator.serviceWorker.controller;
    if (!worker) {
      return [
        'warn',
        `The service worker is not active. The page saw: ${fromPage.join(', ') || 'none'}`,
      ];
    }

    const reply = await withTimeout(
      new Promise((resolve) => {
        navigator.serviceWorker.addEventListener('message', (event) => resolve(event.data), {
          once: true,
        });
        worker.postMessage('status');
      }),
      5000,
      'service worker',
    );
    const all = [...new Set([...reply.foreign, ...fromPage])];
    return [
      all.length === 0,
      all.length > 0 ? all.join(', ') : `None. Only ${location.origin} was used.`,
    ];
  });
}

// ---------------------------------------------------------------------------------------------------------
// Running everything

/** Run every check in order, then show the summary and the report. */
async function main() {
  results.length = 0;
  $('rows').replaceChildren();
  $('summary').className = '';
  $('summary').textContent = 'Running…';
  const start = performance.now();
  const build = await (await fetch('build.json', { cache: 'no-store' })).json();

  await checkBrowser();
  const workerNote = await checkServiceWorker(build);
  await checkDownload(build);
  await checkCpp();
  await checkPython();
  await checkOtherOrigins();

  const failed = results.filter((r) => r.ok === false).length;
  const warned = results.filter((r) => r.ok === 'warn').length;
  const warnings = warned > 0 ? `, ${warned} warning(s)` : '';
  $('summary').className = failed > 0 ? 'fail' : 'pass';
  $('summary').textContent =
    failed > 0
      ? `${failed} check(s) FAILED${warnings}`
      : `All ${results.length} checks passed${warnings} in ${seconds(performance.now() - start)}`;

  const verdict = (ok) => (ok === true ? 'PASS' : ok === 'warn' ? 'WARN' : 'FAIL');
  const report = {
    build: build.id,
    origin: location.origin,
    browser: navigator.userAgent,
    at: new Date().toISOString(),
    serviceWorker: workerNote,
    results: results.map((r) => [verdict(r.ok), r.name, r.detail]),
  };
  $('report').value = JSON.stringify(report, null, 1);
}

/** Copy the report to the clipboard. */
async function copyReport() {
  try {
    await navigator.clipboard.writeText($('report').value);
    $('copy').textContent = 'Copied';
  } catch {
    $('report').select();
    document.execCommand('copy');
  }
}

$('again').onclick = main;
$('copy').onclick = copyReport;
main();
