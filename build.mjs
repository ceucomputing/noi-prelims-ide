// Builds the static site into dist/.
//
// Usage: node build.mjs [--demo]
//
//   --demo  Also include the demo tasks, which are served at /?demo. Never use this for a contest.
//
// The output has two parts:
//
//   dist/index.html, selfcheck.html, sw.js, build.json, _headers   Small files, always revalidated.
//   dist/b/<id>/...                                                Everything else, cached for good.
//
// <id> is a hash of every file, so each build gets new URLs and a new offline store.
//
// Apart from copying files, the build bundles CodeMirror with src/editor.js, packs the C++ standard library
// into one file, compiles the two runtime files in src/rt/, patches one function in the compiler, and
// compresses large files.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { runClang } from '@yowasp/clang';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const NODE_MODULES = path.join(ROOT, 'node_modules');
const DEMO = process.argv.includes('--demo');

// The pages may connect only to their own origin. Every response carries this policy.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

// Files that are not on npm, with their SHA-256 hashes. README.md says how to download them.
const DOWNLOADS = {
  'wasi-sysroot-34.0.tar.gz': '9d813544eeebe38b7b8f2244ed591de46b6db812c6dd1a257ff9f0d2a905a2be',
  'vermin-1.9.2-py3-none-any.whl':
    '3e3e95d937f7d165eb928e0c268dfec466ccc40e9e1ce825e5d6e5aa027b6f30',
};

/**
 * Return a path inside the project.
 * @param {...string} parts
 * @returns {string}
 */
function local(...parts) {
  return path.join(ROOT, ...parts);
}

/**
 * Return the SHA-256 hash of some data, in hexadecimal.
 * @param {Buffer|Uint8Array} data
 * @returns {string}
 */
function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Format a number of bytes as megabytes.
 * @param {number} bytes
 * @returns {string}
 */
function megabytes(bytes) {
  return `${(bytes / 2 ** 20).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------------------------------------
// Collecting the files

const assets = new Map(); // path under b/<id>/ -> contents

/**
 * Add a file to the build.
 * @param {string} name  Its path under b/<id>/.
 * @param {string|Buffer|Uint8Array} contents
 */
function add(name, contents) {
  assets.set(name, Buffer.from(contents));
}

/**
 * Add the files of a directory to the build.
 * @param {string} name  The directory's path under b/<id>/.
 * @param {string} directory
 * @param {(file: string) => boolean} [keep]  Chooses which files to add.
 */
function addDirectory(name, directory, keep = () => true) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) addDirectory(`${name}/${entry.name}`, file, keep);
    else if (keep(file)) add(`${name}/${entry.name}`, fs.readFileSync(file));
  }
}

/** Check the downloaded files' hashes, and unpack the C++ standard library if needed. */
function checkDownloads() {
  for (const [name, expected] of Object.entries(DOWNLOADS)) {
    if (sha256(fs.readFileSync(local('downloads', name))) !== expected) {
      throw new Error(`downloads/${name} does not have the expected SHA-256 hash.`);
    }
  }
  if (!fs.existsSync(local('downloads/wasi-sysroot-34.0'))) {
    execFileSync('tar', ['-xzf', 'wasi-sysroot-34.0.tar.gz'], { cwd: local('downloads') });
  }
}

/** Add our own code. The pages and the service worker are templates, written at the end. */
async function addOurCode() {
  for (const name of fs.readdirSync(local('src'))) {
    const isTemplate = name === 'sw.js';
    const isBundled = name === 'editor.js';
    if (/\.(js|css|py)$/.test(name) && !isTemplate && !isBundled) {
      add(name, fs.readFileSync(local('src', name)));
    }
  }
  add('include/bits/stdc++.h', fs.readFileSync(local('src/include/bits/stdc++.h')));

  // editor.js imports CodeMirror, so it is bundled with it into one file.
  const bundle = await esbuild.build({
    entryPoints: [local('src/editor.js')],
    bundle: true,
    format: 'esm',
    write: false,
    legalComments: 'inline',
  });
  add('editor.js', bundle.outputFiles[0].contents);
}

// The one change to upstream code. The compiler's in-memory file system copied the whole file on every
// write, so writing a file took time proportional to the square of its size. Global arrays are written
// into the compiled object file as zeros, so large arrays made compiling very slow. The replacement grows
// a file by doubling its buffer. It reuses spare room only in buffers that it allocated itself.
const FILE_WRITE = {
  original: `    const newData = new Uint8Array(Math.max(this.file.data.length, offset + contents.length));
    newData.set(this.file.data);
    newData.subarray(offset).set(contents);
    this.file.data = newData;`,
  replacement: `    const data = this.file.data, end = offset + contents.length; // patched by build.mjs: amortised growth
    if (end > data.length) {
      const room = (globalThis.__grown ??= new WeakSet()).has(data.buffer) ? data.buffer.byteLength - data.byteOffset : 0;
      if (end <= room) this.file.data = new Uint8Array(data.buffer, data.byteOffset, end);
      else {
        const grown = new Uint8Array(Math.max(end, 2 * data.length));
        globalThis.__grown.add(grown.buffer);
        grown.set(data);
        this.file.data = grown.subarray(0, end);
      }
    }
    this.file.data.subarray(offset).set(contents);`,
};

/** Add the compiler, the WebAssembly tools, the WASI runtime and Python. */
function addUpstreamCode() {
  const clang = fs.readFileSync(path.join(NODE_MODULES, '@yowasp/clang/gen/bundle.js'), 'utf8');
  if (!clang.includes(FILE_WRITE.original)) {
    throw new Error('@yowasp/clang has changed. Review the file-write patch in build.mjs.');
  }
  addDirectory(
    'clang',
    path.join(NODE_MODULES, '@yowasp/clang/gen'),
    (file) => !file.endsWith('bundle.js'),
  );
  add('clang/bundle.js', clang.replace(FILE_WRITE.original, FILE_WRITE.replacement));

  add('binaryen.js', fs.readFileSync(path.join(NODE_MODULES, 'binaryen/index.js')));
  addDirectory('wasi', path.join(NODE_MODULES, '@bjorn3/browser_wasi_shim/dist'), (file) =>
    file.endsWith('.js'),
  );

  for (const name of [
    'pyodide.mjs',
    'pyodide.asm.mjs',
    'pyodide.asm.wasm',
    'python_stdlib.zip',
    'pyodide-lock.json',
  ]) {
    add(`pyodide/${name}`, fs.readFileSync(path.join(NODE_MODULES, 'pyodide', name)));
  }
  add(
    'vermin-1.9.2-py3-none-any.whl',
    fs.readFileSync(local('downloads/vermin-1.9.2-py3-none-any.whl')),
  );
}

/**
 * Read a directory as a nested object: each directory name maps to an object, and each file name to its
 * bytes.
 * @param {string} directory
 * @param {(file: string) => boolean} [keep]  Chooses which files to include.
 * @returns {object}
 */
function readTree(directory, keep = () => true) {
  const tree = {};
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const subtree = readTree(file, keep);
      if (Object.keys(subtree).length > 0) tree[entry.name] = subtree;
    } else if (keep(file)) {
      tree[entry.name] = new Uint8Array(fs.readFileSync(file));
    }
  }
  return tree;
}

/**
 * Read the parts of the C++ standard library that the compiler needs: the headers and three libraries.
 * @returns {object} A tree, as from readTree.
 */
function readSysroot() {
  const sysroot = local('downloads/wasi-sysroot-34.0');
  const libraries = ['libc++.a', 'libc++abi.a', 'libunwind.a'];
  return {
    include: { cfg: readTree(path.join(sysroot, 'include/wasm32-wasip1/eh/c++/v1')) },
    lib: readTree(path.join(sysroot, 'lib/wasm32-wasip1/eh'), (file) =>
      libraries.includes(path.basename(file)),
    ),
  };
}

/**
 * Pack the C++ standard library into one file, so that the browser fetches one file instead of about a
 * thousand. The file holds a 4-byte index length, a JSON index of {path: [offset, length]}, and then the
 * files' bytes. cpp-worker.js unpacks it.
 * @param {object} s34  The tree from readSysroot.
 */
function addSysrootPack(s34) {
  const index = {};
  const chunks = [];
  let offset = 0;

  const walk = (tree, prefix) => {
    for (const [name, value] of Object.entries(tree)) {
      if (value instanceof Uint8Array) {
        index[prefix + name] = [offset, value.length];
        chunks.push(value);
        offset += value.length;
      } else {
        walk(value, `${prefix}${name}/`);
      }
    }
  };
  walk({ s34 }, '');

  const header = Buffer.from(JSON.stringify(index));
  const headerLength = Buffer.alloc(4);
  headerLength.writeUInt32LE(header.length);
  add('sysroot.pack', Buffer.concat([headerLength, header, ...chunks]));
}

/**
 * Compile the runtime files in src/rt/ with the same flags as the browser, so that the browser compiles
 * only the contestant's file.
 * @param {object} s34  The tree from readSysroot.
 */
async function addRuntimeObjects(s34) {
  for (const name of ['sync_wrap', 'ubsan_min']) {
    const flags = [
      '-std=gnu++17',
      '-O2',
      '-nostdinc++',
      '-isystem',
      's34/include/cfg',
      '-fwasm-exceptions',
      '-mllvm',
      '-wasm-use-legacy-eh=false',
    ];
    const output = await runClang(
      ['clang++', ...flags, '-c', `${name}.cpp`, '-o', `${name}.o`],
      { s34, [`${name}.cpp`]: fs.readFileSync(local(`src/rt/${name}.cpp`), 'utf8') },
      {
        stdout: () => {},
        stderr: (bytes) => bytes && process.stderr.write(bytes),
        fetchProgress: () => {},
      },
    );
    add(`rt/${name}.o`, output[`${name}.o`]);
  }
}

/**
 * Add the demo: the NOI 2026 Preliminary Contest from the organisers' repository. demo/fetch.mjs downloads
 * it into downloads/noi/. The demo uses the statement, every test, and the solutions chosen in each task's
 * task.json.
 */
function addDemo() {
  const zip = local('downloads/noi/noi-2026-prelim.zip');
  const entries = execFileSync('unzip', ['-Z1', zip], { maxBuffer: 1 << 26 })
    .toString()
    .split('\n');
  const top = entries[0]; // The archive's top-level folder.
  const unzip = (file) => execFileSync('unzip', ['-p', zip, top + file], { maxBuffer: 1 << 30 });

  add('demo/statement.pdf', unzip('statement.pdf'));
  const tasks = [];
  for (const slug of fs
    .readFileSync(local('demo/tasks.txt'), 'utf8')
    .split(/\s+/)
    .filter(Boolean)) {
    const task = JSON.parse(fs.readFileSync(local('demo', slug, 'task.json')));
    const code = {};
    for (const [lang, file] of Object.entries(task.solutions)) code[lang] = unzip(file).toString();

    const inputs = entries
      .filter((entry) => entry.startsWith(top + task.tests) && entry.endsWith('.in'))
      .map((entry) => entry.slice(top.length))
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    const tests = inputs.map((input, i) => {
      const file = `${slug}-${i + 1}`;
      add(`demo/${file}.in`, unzip(input));
      add(`demo/${file}.out`, unzip(input.replace(/\.in$/, '.out')));
      return file;
    });

    tasks.push({
      name: task.title.split(': ').pop(),
      title: task.title,
      about: task.about,
      limit: task.limit,
      code,
      statement: `statement.pdf#page=${task.statementPage}`,
      source: `https://github.com/noisg/noi-2026-prelim/tree/f653489f0de45fd5839925aad6e3237978ff8999/${slug}`,
      tests,
    });
  }
  add('demo/tasks.json', JSON.stringify(tasks));
}

// ---------------------------------------------------------------------------------------------------------
// Writing the output

/**
 * Write every file under dist/b/<id>/, with a compressed copy of each large file.
 * @param {string} id
 * @returns {{path: string, size: number, br: number, sha256: string}[]} The files, largest first. `br` is the
 *   compressed size.
 */
function writeAssets(id) {
  const written = [];
  for (const [name, data] of assets) {
    const file = local('dist', 'b', id, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data);

    let compressedSize = data.length;
    if (data.length > 4096 && !/\.(whl|zip)$/.test(name)) {
      const compressed = zlib.brotliCompressSync(data, {
        params: {
          [zlib.constants.BROTLI_PARAM_QUALITY]: 9,
          [zlib.constants.BROTLI_PARAM_LGWIN]: 24,
        },
      });
      // Keep the compressed copy only if it saves at least a tenth.
      if (compressed.length < data.length * 0.9) {
        fs.writeFileSync(`${file}.br`, compressed);
        compressedSize = compressed.length;
      }
    }
    written.push({
      path: `b/${id}/${name}`,
      size: data.length,
      br: compressedSize,
      sha256: sha256(data),
    });
  }
  return written.sort((a, b) => b.size - a.size);
}

/**
 * Fill in a template from src/ with this build's values.
 * @param {string} name
 * @param {string} id
 * @returns {string}
 */
function fillTemplate(name, id) {
  return fs
    .readFileSync(local('src', name), 'utf8')
    .replaceAll('%BUILD%', id)
    .replaceAll('%CSP%', CSP)
    .replace('%DEMO_LINK%', DEMO ? '<a href="?demo">Demo</a> · ' : '')
    .replace('%IMPORT%', DEMO ? 'on' : 'off');
}

/**
 * Write the pages, the service worker, build.json and _headers.
 * @param {string} id
 * @param {object[]} files  The files that the service worker stores for offline use.
 * @param {object[]} demoFiles  The demo's files, which are fetched only when used.
 */
function writeTopLevel(id, files, demoFiles) {
  const total = (list, key) => list.reduce((sum, file) => sum + file[key], 0);

  const versions = {};
  for (const name of [
    '@yowasp/clang',
    'binaryen',
    '@bjorn3/browser_wasi_shim',
    'pyodide',
    'codemirror',
  ]) {
    versions[name] = JSON.parse(
      fs.readFileSync(path.join(NODE_MODULES, name, 'package.json')),
    ).version;
  }
  versions.sysroot = 'wasi-sdk-34 (eh)';
  versions.vermin = '1.9.2';

  const build = {
    id,
    csp: CSP,
    versions,
    rawBytes: total(files, 'size'),
    brBytes: total(files, 'br'),
    files,
    demoFiles,
  };
  fs.writeFileSync(local('dist', 'build.json'), JSON.stringify(build, null, 1));

  for (const name of ['index.html', 'selfcheck.html']) {
    fs.writeFileSync(local('dist', name), fillTemplate(name, id));
  }

  const stored = [
    './',
    'index.html',
    'selfcheck.html',
    'build.json',
    ...files.map((file) => file.path),
  ];
  const serviceWorker = fillTemplate('sw.js', id).replace(
    '__BUILD_CONFIG__',
    JSON.stringify({ id, files: stored, csp: CSP }),
  );
  fs.writeFileSync(local('dist', 'sw.js'), serviceWorker);

  // For hosts that read a _headers file. serve.mjs sends the same headers.
  const headers = [
    '/*',
    '  Cross-Origin-Opener-Policy: same-origin',
    '  Cross-Origin-Embedder-Policy: require-corp',
    '  Cross-Origin-Resource-Policy: same-origin',
    `  Content-Security-Policy: ${CSP}`,
    '  X-Content-Type-Options: nosniff',
    '  Cache-Control: no-cache',
    '/b/*',
    '  Cache-Control: public, max-age=31536000, immutable',
  ];
  fs.writeFileSync(local('dist', '_headers'), `${headers.join('\n')}\n`);

  console.log(
    `build ${id}: ${files.length} files, ${megabytes(total(files, 'size'))}, ${megabytes(total(files, 'br'))} compressed`,
  );
  if (DEMO) {
    console.log(
      `  demo: ${demoFiles.length} files, ${megabytes(total(demoFiles, 'size'))}, ${megabytes(total(demoFiles, 'br'))} compressed`,
    );
  }
}

// ---------------------------------------------------------------------------------------------------------
// The build

checkDownloads();
await addOurCode();
addUpstreamCode();
const s34 = readSysroot();
addSysrootPack(s34);
await addRuntimeObjects(s34);
if (DEMO) addDemo();

// The id is a hash of every file's name and contents.
const hash = crypto.createHash('sha256');
for (const [name, data] of [...assets].sort(([a], [b]) => (a < b ? -1 : 1))) {
  hash.update(name).update(data);
}
const id = hash.digest('hex').slice(0, 12);

fs.rmSync(local('dist'), { recursive: true, force: true });
const written = writeAssets(id);
const isDemoFile = (file) => file.path.includes('/demo/');
writeTopLevel(
  id,
  written.filter((file) => !isDemoFile(file)),
  written.filter(isDemoFile),
);
