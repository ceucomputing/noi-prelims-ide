// The C++ compiler, running in a worker.
//
// It compiles with clang, links against libc++ with exception support, and rewrites the program so that
// deep recursion works (see segstack.js).
//
// Request: {id, src}
// Reply:   {id, ok, wasm, signatures, compileMs, segMs, stderr}

// The compiler and the rewriter are imported dynamically. The rewriter uses top-level await, and a module
// worker drops messages that arrive before its top-level code has finished. Setting onmessage first,
// below, avoids that.
const modules = Promise.all([import('./clang/bundle.js'), import('./segstack.js')]);

/**
 * Fetch a file from this build.
 * @param {string} path
 * @returns {Promise<ArrayBuffer>}
 */
async function get(path) {
  const response = await fetch(new URL(path, import.meta.url));
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.arrayBuffer();
}

/**
 * Unpack sysroot.pack into the nested form that clang's file system expects.
 *
 * The pack holds a 4-byte index length, a JSON index of {path: [offset, length]}, and then the files'
 * bytes. The result maps each directory name to a nested object and each file name to its bytes.
 * @param {ArrayBuffer} buffer
 * @returns {object}
 */
function unpack(buffer) {
  const indexLength = new DataView(buffer).getUint32(0, true);
  const index = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, indexLength)));
  const tree = {};
  for (const [path, [offset, length]] of Object.entries(index)) {
    const parts = path.split('/');
    let directory = tree;
    for (const name of parts.slice(0, -1)) {
      directory[name] ??= {};
      directory = directory[name];
    }
    directory[parts.at(-1)] = new Uint8Array(buffer, 4 + indexLength + offset, length);
  }
  return tree;
}

const files = Promise.all([
  get('sysroot.pack').then(unpack),
  get('include/bits/stdc++.h'),
  get('rt/sync_wrap.o'),
  get('rt/ubsan_min.o'),
]);

const COMPILE_FLAGS = [
  '-std=gnu++17',
  '-O2',
  '-I',
  'include',
  '-nostdinc++',
  '-isystem',
  's34/include/cfg',

  // A 256 MB stack inside a 1024 MB memory limit. As on the judge, the memory limit includes the stack.
  '-Wl,-z,stack-size=268435456',
  '-Wl,--max-memory=1073741824',

  // Exceptions.
  '-fwasm-exceptions',
  '-mllvm',
  '-wasm-use-legacy-eh=false',

  // Overflow checks. On the judge `long` is 64 bits, but here it is 32 bits, so overflow of `long` gets a
  // warning. `long long` is 64 bits on both, so it is not checked: the check would make 64-bit
  // multiplication many times slower.
  '-fsanitize=signed-integer-overflow,implicit-integer-truncation',
  '-fsanitize-minimal-runtime',
  '-fsanitize-ignorelist=ubsan.ignore',
];
const UNCHECKED_TYPES = '[signed-integer-overflow]\ntype:long long\ntype:unsigned long long\n';

const LINK_FLAGS = [
  'sync_wrap.o',
  'ubsan_min.o',
  '-nostdlib++',
  '-Ls34/lib',
  '-lc++',
  '-lc++abi',
  '-lunwind',
  // Replace sync_with_stdio with the version in sync_wrap.cpp, which makes cin and cout fast.
  '-Wl,--wrap=_ZNSt3__28ios_base15sync_with_stdioEb',
];

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

self.onmessage = async ({ data: { id, src } }) => {
  const errors = [];
  const start = performance.now();
  try {
    const [[{ runClang }, { instrument }], [sysroot, header, syncWrap, ubsan]] = await Promise.all([
      modules,
      files,
    ]);

    const inputFiles = {
      s34: sysroot.s34,
      include: { bits: { 'stdc++.h': new Uint8Array(header) } },
      'main.cpp': src,
      'sync_wrap.o': new Uint8Array(syncWrap),
      'ubsan_min.o': new Uint8Array(ubsan),
      'ubsan.ignore': UNCHECKED_TYPES,
    };
    const output = await runClang(
      ['clang++', ...COMPILE_FLAGS, 'main.cpp', ...LINK_FLAGS, '-o', 'main.wasm'],
      inputFiles,
      {
        stderr: (bytes) => bytes && errors.push(bytes),
        stdout: () => {},
        fetchProgress: () => {},
      },
    );
    const compileMs = performance.now() - start;

    const rewriteStart = performance.now();
    const { wasm, signatures } = instrument(output['main.wasm'], { seg: 4000 });
    const segMs = performance.now() - rewriteStart;

    self.postMessage({ id, ok: true, wasm, signatures, compileMs, segMs, stderr: decode(errors) }, [
      wasm.buffer,
    ]);
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      compileMs: performance.now() - start,
      stderr: decode(errors) || String(error),
    });
  }
};
