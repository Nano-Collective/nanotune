---
'@nanocollective/nanotune': minor
---

`nanotune benchmark --json` now prints the finished run as a single JSON document on stdout — the same document already written to `.nanotune/benchmarks/benchmark-<timestamp>.json`, so there is one schema rather than two. Progress goes to stderr, since a suite can take minutes and stdout must stay one document. The run itself moves out of the command component into `runBenchmark` in `src/lib/benchmark-run.ts`, an async generator both the Ink view and the JSON path consume, and `BenchmarkResult` gains an optional `warning` so a partial run is distinguishable from a complete one with a worse pass rate. A bad `--preset` now fails immediately instead of after the base model downloads. Thanks to @yashksaini-coder. Closes #69 for `benchmark`.
