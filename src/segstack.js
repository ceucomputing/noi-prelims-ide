// Deep recursion, part 1: rewriting the compiled program.
//
// A browser gives WebAssembly a native stack of only several thousand frames, but contest solutions often
// recurse a million levels deep. This module rewrites a compiled program so that, every `seg` nested
// calls, the next call continues on a fresh stack. Chrome's JavaScript Promise Integration (JSPI) provides
// the extra stacks. The caller's stack waits, suspended, until the call returns.
//
// Each function f that makes calls becomes a wrapper around its original body, f$impl:
//
//   f(args) {
//     if (depth >= seg) {                        // This stack is full: continue on a new one.
//       saved = depth; depth = 0;
//       result = trampoline(index of f, args);   // Runs f$impl on a new stack.
//       depth = saved;
//       return result;
//     }
//     depth++; result = f$impl(args); depth--;
//     return result;
//   }
//
// The trampoline is a JavaScript import, defined in segstack-runtime.js. It calls the exported
// segstack_dispatch function through WebAssembly.promising, which runs it on a new stack. The dispatch
// function calls f through a table.
//
// Finally, each f$impl is inlined into its wrapper, its only caller. That keeps one native frame per call,
// so `seg` calls fit on one stack even when frames are large.
import binaryen from './binaryen.js';

// The WebAssembly features to allow. These are the ones that Chrome and Edge support. Binaryen's "all"
// setting includes encodings that Chrome rejects.
const FEATURES =
  binaryen.Features.MVP |
  binaryen.Features.SignExt |
  binaryen.Features.MutableGlobals |
  binaryen.Features.NontrappingFPToInt |
  binaryen.Features.BulkMemory |
  binaryen.Features.ReferenceTypes |
  binaryen.Features.Multivalue |
  binaryen.Features.ExceptionHandling |
  binaryen.Features.TailCall |
  binaryen.Features.SIMD128 |
  binaryen.Features.Memory64 |
  binaryen.Features.ExtendedConst |
  binaryen.Features.BulkMemoryOpt;

const DEPTH = 'segstack$depth';

/**
 * Name a function signature, for example 'i32_i64__i32' for (i32, i64) -> i32.
 * @param {number} params  A binaryen type.
 * @param {number} results  A binaryen type.
 * @returns {string}
 */
function signatureName(params, results) {
  const names = (type) => binaryen.expandType(type).map(String).join('_') || 'v';
  return `${names(params)}__${names(results)}`;
}

/**
 * Check whether a function body makes any call. A function that makes no calls cannot recurse, so it is
 * left as it is.
 * @param {object} module  A binaryen module.
 * @param {number} body  A binaryen expression.
 * @returns {boolean}
 */
function makesCalls(module, body) {
  return (binaryen.getSideEffects(body, module) & binaryen.SideEffects.Calls) !== 0;
}

/**
 * Rewrite a compiled program for deep recursion, as described above.
 * @param {Uint8Array} bytes  The program, as compiled by clang.
 * @param {{seg?: number}} [options]  `seg` is the number of nested calls per stack.
 * @returns {{wasm: Uint8Array, signatures: string[]}} The rewritten program, and the signatures of its
 *   trampolines, which segstack-runtime.js needs.
 */
export function instrument(bytes, { seg = 4000 } = {}) {
  const m = binaryen.readBinary(bytes);
  m.setFeatures(FEATURES);

  // The functions defined in this module that make calls.
  const functions = [];
  for (let i = 0; i < m.getNumFunctions(); i++) {
    const info = binaryen.getFunctionInfo(m.getFunctionByIndex(i));
    if (!info.module && makesCalls(m, info.body)) functions.push(info);
  }

  m.addGlobal(DEPTH, binaryen.i32, true, m.i32.const(0));
  const depth = () => m.global.get(DEPTH, binaryen.i32);
  const addToDepth = (n) => m.global.set(DEPTH, m.i32.add(depth(), m.i32.const(n)));

  // signature name -> {params, results, names of the functions with that signature}
  const signatures = new Map();

  for (const f of functions) {
    const key = signatureName(f.params, f.results);
    if (!signatures.has(key)) {
      signatures.set(key, { params: f.params, results: f.results, names: [] });
    }
    const signature = signatures.get(key);
    const tableIndex = signature.names.push(f.name) - 1;

    // Move the body to f$impl, then rebuild f as the wrapper. Binaryen refers to functions by name, so
    // every call, export and table entry now reaches the wrapper.
    const body = m.copyExpression(f.body);
    m.removeFunction(f.name);
    m.addFunction(`${f.name}$impl`, f.params, f.results, f.vars, body);

    const paramTypes = binaryen.expandType(f.params);
    const args = paramTypes.map((type, i) => m.local.get(i, type));
    const hasResult = f.results !== binaryen.none;
    const savedDepth = paramTypes.length; // Local variable: the saved depth.
    const result = paramTypes.length + 1; // Local variable: the result, if any.
    const locals = hasResult ? [binaryen.i32, f.results] : [binaryen.i32];

    const callTrampoline = m.call(
      `segstack$tramp_${key}`,
      [m.i32.const(tableIndex), ...args],
      f.results,
    );
    const callBody = m.call(`${f.name}$impl`, args, f.results);
    const returnResult = () => m.return(hasResult ? m.local.get(result, f.results) : undefined);
    const keep = (call) => (hasResult ? m.local.set(result, call) : call);

    const onNewStack = m.block(null, [
      m.local.set(savedDepth, depth()),
      m.global.set(DEPTH, m.i32.const(0)),
      keep(callTrampoline),
      m.global.set(DEPTH, m.local.get(savedDepth, binaryen.i32)),
      returnResult(),
    ]);
    const wrapper = m.block(
      null,
      [
        m.if(m.i32.ge_u(depth(), m.i32.const(seg)), onNewStack),
        addToDepth(1),
        keep(callBody),
        addToDepth(-1),
        returnResult(),
      ],
      binaryen.none,
    );
    m.addFunction(f.name, f.params, f.results, locals, wrapper);
  }

  // For each signature: the trampoline import, a table of its functions, and the dispatch export.
  for (const [key, signature] of signatures) {
    const paramTypes = binaryen.expandType(signature.params);
    const withIndex = binaryen.createType([binaryen.i32, ...paramTypes]);
    const table = `segstack$tab_${key}`;

    m.addFunctionImport(`segstack$tramp_${key}`, 'segstack', key, withIndex, signature.results);
    m.addTable(table, signature.names.length, signature.names.length, binaryen.funcref);
    m.addActiveElementSegment(table, `segstack$elem_${key}`, signature.names, m.i32.const(0));

    const args = paramTypes.map((type, i) => m.local.get(i + 1, type));
    const dispatch = m.call_indirect(
      table,
      m.local.get(0, binaryen.i32),
      args,
      signature.params,
      signature.results,
    );
    m.addFunction(`segstack$dispatch_${key}`, withIndex, signature.results, [], dispatch);
    m.addFunctionExport(`segstack$dispatch_${key}`, `segstack_dispatch_${key}`);
  }

  // Inline each f$impl into its wrapper. Plain inlining of single-caller functions is enough, and fast.
  binaryen.setOneCallerInlineMaxSize(1e9);
  m.runPasses(['inlining']);

  if (!m.validate()) throw new Error('The rewritten program is not valid WebAssembly.');
  const wasm = m.emitBinary();
  m.dispose();
  return { wasm, signatures: [...signatures.keys()] };
}
