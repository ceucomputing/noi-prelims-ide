// Deep recursion, part 2: the trampolines that move a call onto a new stack.
//
// A program rewritten by segstack.js imports one trampoline per function signature. Each trampoline calls
// the program's dispatch function through WebAssembly.promising, which runs it on a new stack, while
// WebAssembly.Suspending suspends the caller until it returns.

/**
 * Build the imports for a rewritten program.
 *
 * Call link() with the instance once it exists, because the trampolines call the instance's exports.
 * @param {string[]} signatures  The signatures returned by instrument().
 * @returns {{imports: object, stats: {segments: number}, link: (instance: WebAssembly.Instance) => void}}
 *   `stats.segments` counts how many times a call moved to a new stack.
 */
export function segstackImports(signatures) {
  const dispatch = {};
  const stats = { segments: 0 };
  const imports = {};

  for (const key of signatures) {
    imports[key] = new WebAssembly.Suspending((index, ...args) => {
      stats.segments++;
      return dispatch[key](index, ...args);
    });
  }

  const link = (instance) => {
    for (const key of signatures) {
      dispatch[key] = WebAssembly.promising(instance.exports[`segstack_dispatch_${key}`]);
    }
  };

  return { imports, stats, link };
}
