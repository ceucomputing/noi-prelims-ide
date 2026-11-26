# NOI Prelims IDE: proof of concept

This is an IDE for the NOI Preliminary Contest that runs entirely in the browser. C++ and Python programs
compile and run on the contestant's own computer, in WebAssembly. The server only hosts static files.

To try it with the NOI 2026 Preliminary Contest tasks, run `npm run build:demo`, then open `/?demo`. The
demo has the tasks, their tests and the organisers' solutions, in C++ and, for one task, in Python. See
`demo/README.md`.

## Features

- Tabs start as Task 1 to Task 5. The `+` button adds a tab, double-clicking a tab renames it, and `×`
  closes it. Each tab has its own C++ and Python code and its own tests.
- The IDE starts empty, with no templates or snippets.
- The editor has syntax highlighting, find and replace, go to line, bracket matching and comment toggling.
  It has no autocompletion.
- Compile errors are marked on their lines.
- Each test has an input and an optional expected output, both editable. A run shows the verdict, the
  time, the memory used and anything written to stderr. In demo builds, either box can be loaded from a
  file of any type.
- Verdicts are AC (accepted), WA (wrong answer), RTE (runtime error) and TLE (time limit exceeded). They
  are estimates, and the time limit is set per tab.
- The code can be downloaded or copied for submission through CMS.
- Work survives a page reload, but not closing the browser tab.
- C++ and Python behave like the judge's g++ and Python 3.8 where it matters for contests: deep recursion,
  exceptions and fast `cin` and `cout`. The IDE warns when code relies on a 64-bit `long` or on Python
  features newer than 3.8.
- `selfcheck.html` checks whether a contest computer can run the IDE.
- After the first load, the IDE works offline.

## Security

- Contestants' programs run as WebAssembly inside their own browser tab. They cannot reach the computer,
  the network or other tabs. A program that runs too long is stopped.
- Every response carries a Content-Security-Policy that blocks requests to other websites, including any
  made by third-party code. The service worker adds the policy on hosts that cannot send it. The
  self-check confirms that it works.
- The IDE uses no cookies, accounts, analytics or telemetry, and uploads nothing.

## Running it locally

You need Node 22 or later, and Chrome or Edge 137 or later.

```bash
npm ci
```

```bash
curl -L -o downloads/wasi-sysroot-34.0.tar.gz https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-34/wasi-sysroot-34.0.tar.gz
```

```bash
pip download vermin==1.9.2 --no-deps -d downloads
```

```bash
npm run build
```

```bash
npm run serve
```

Then open http://localhost:8130/. The build checks the SHA-256 hash of each download. To test a host that
cannot send security headers, run `node serve.mjs 8131 --bare`.

## Publishing on GitHub Pages

The workflow in `.github/workflows/pages.yml` builds the IDE and publishes it on every push to `main`. To
use it, set the repository's Pages source to GitHub Actions.

- GitHub Pages cannot send the security headers that the IDE needs. The service worker adds them, so the
  IDE works there, but the very first visit reloads the page once.
- GitHub Pages does not serve the build's compressed files, so the first visit downloads more.
- The site includes the demo only if the repository variable `INCLUDE_DEMO` is `true`. The demo serves the
  organisers' tests and solutions, so check with them first.

## Development

- `npm run lint` checks the code with ESLint.
- `npm run format` formats the code with Prettier.
- `npm run check` does both checks without changing anything.

Every function has a JSDoc comment.

## The code

The files are listed in reading order.

| File                                         | Purpose                                                        |
| -------------------------------------------- | -------------------------------------------------------------- |
| `src/index.html`, `src/style.css`            | The page and its layout.                                       |
| `src/ide.js`                                 | Connects the page to the modules below.                        |
| `src/state.js`                               | Tabs and tests, and saving them.                               |
| `src/tests.js`                               | The test-case cards, and loading test files.                   |
| `src/run.js`                                 | Compiling or checking code, running tests and showing results. |
| `src/editor.js`                              | The code editor.                                               |
| `src/lib.js`                                 | The page's interface to the workers.                           |
| `src/cpp-worker.js`                          | The C++ compiler.                                              |
| `src/segstack.js`, `src/segstack-runtime.js` | Deep recursion, on extra stacks.                               |
| `src/run-worker.js`                          | Runs one C++ program.                                          |
| `src/py-worker.js`                           | Python.                                                        |
| `src/py_check.py`, `src/pure_lru.py`         | The Python 3.8 check, and deep recursion through `lru_cache`.  |
| `src/rt/sync_wrap.cpp`                       | Fast `cin` and `cout`.                                         |
| `src/rt/ubsan_min.cpp`                       | Warnings for integer overflow.                                 |
| `src/include/bits/stdc++.h`                  | `<bits/stdc++.h>`.                                             |
| `src/sw.js`                                  | The service worker, for offline use and security headers.      |
| `src/selfcheck.html`, `src/selfcheck.js`     | The self-check page.                                           |
| `build.mjs`, `serve.mjs`                     | The build, and a local web server.                             |
| `demo/`                                      | The demo tasks.                                                |
| `judge/Dockerfile`                           | A container like the judge, for checking the demo's solutions. |

## Third-party components

All are used unmodified, except for one small change to `@yowasp/clang`'s in-memory file system, which
makes compiling programs with large global arrays fast. `build.mjs` explains it.

| Component                                                                            | Version            | Licence                                     | Use                          |
| ------------------------------------------------------------------------------------ | ------------------ | ------------------------------------------- | ---------------------------- |
| [@yowasp/clang](https://www.npmjs.com/package/@yowasp/clang)                         | 22.0.0-git20695-13 | ISC; LLVM is Apache-2.0 with LLVM exception | The C++ compiler             |
| [wasi-sdk sysroot](https://github.com/WebAssembly/wasi-sdk/releases/tag/wasi-sdk-34) | 34.0               | Apache-2.0 with LLVM exception              | The C++ standard library     |
| [binaryen](https://www.npmjs.com/package/binaryen)                                   | 132.0.0            | Apache-2.0                                  | Rewriting for deep recursion |
| [@bjorn3/browser_wasi_shim](https://www.npmjs.com/package/@bjorn3/browser_wasi_shim) | 0.4.2              | MIT or Apache-2.0                           | Input and output for C++     |
| [Pyodide](https://www.npmjs.com/package/pyodide)                                     | 314.0.8            | MPL-2.0                                     | Python                       |
| [vermin](https://pypi.org/project/vermin/)                                           | 1.9.2              | MIT                                         | The Python 3.8 check         |
| [CodeMirror 6](https://codemirror.net/)                                              | 6.0.2              | MIT                                         | The editor                   |

These tools are used during development only: esbuild (MIT) bundles CodeMirror, ESLint (MIT) and
eslint-plugin-jsdoc (BSD-3-Clause) check the code, and Prettier (MIT) formats it. `package-lock.json`
pins every npm package by its hash.

## Not yet done

- GNU policy-based data structures (`<ext/pb_ds/...>`). The organisers' own solutions use them.
- Mapping runtime errors to source lines.
- Feeding one program's output to another, for stress testing.
- A memory limit per tab. The limit is currently fixed at 1024 MB.
- A prompt when a new version of the IDE is ready.
- Interactive, communication and output-only tasks.
- Loading test files in contest builds. The organisers need to decide whether to allow it.
