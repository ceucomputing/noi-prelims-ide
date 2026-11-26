# Demo: the NOI 2026 Preliminary Contest

```bash
npm run build:demo
```

```bash
npm run serve
```

Then open http://localhost:8130/?demo. The contest build, made with `npm run build`, has no demo.

The tests and solutions come from the organisers' repository,
[noisg/noi-2026-prelim](https://github.com/noisg/noi-2026-prelim). `fetch.mjs` downloads it at a fixed
commit and checks its SHA-256 hash. It is not committed to this repository.

| Task          | Solution                   | Tests |
| ------------- | -------------------------- | ----- |
| Area 2        | `model/bruteForceSol.cpp`  | 12    |
| Hungry Cats   | `model/samplesol.cpp`      | 42    |
| Hungry Cats   | `correct/ac2.py`           | 42    |
| Airplane 2    | `model/full_pan.cpp`       | 94    |
| Digits        | `correct/dp.cpp`           | 88    |
| Mushroom Ring | `model/ac_ufdsLog_opt.cpp` | 101   |

- Every test passes, both in the browser and with the judge's compiler and Python.
- `npm run judge:demo` runs each solution on every test in a Docker image that matches the judge.
- Each test is an ordinary test case. Open one to see or edit it, or load your own file into either box.
  Tests that are not opened are read from their files when they run.
- To see the Python solution, open Hungry Cats and select Python 3. The other tasks have no published
  Python solution.
- The model solution for Digits includes `<ext/pb_ds/...>`, which the IDE does not have yet, so the demo
  uses the organisers' other correct solution.
- The repository has no licence. Ask the organisers before hosting a demo build publicly.
