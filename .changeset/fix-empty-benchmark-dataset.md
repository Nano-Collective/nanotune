---
"@nanocollective/nanotune": patch
---

`nanotune benchmark` now errors with `Benchmark dataset is empty (<path>). Add at least one test.` when `tests.json` is an empty array, before any model is loaded or downloaded. Previously the run would proceed, write a result file with `passRate: null` (the result of `0/0 = NaN` serialised by `JSON.stringify`), and `benchmark compare` would later read it as a believable 0% regression against any healthy baseline. The dataset is now also validated before any model/sampling work, so a bad file fails immediately rather than after a multi-gigabyte download. Closes #163.
