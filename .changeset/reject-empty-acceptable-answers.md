---
'@nanocollective/nanotune': patch
---

An empty string in a benchmark test's `acceptable` array no longer makes the test pass no matter what the model says. Under `contains`, `startsWith` and `partial` (and the `semantic` delimiter branch) an empty answer matches everything, so a stray `""` in `tests.json` quietly inflated the pass rate. `checkPass` now skips blank answers, and `nanotune benchmark` rejects a dataset containing one at load time with `Test #N: "acceptable" contains an empty string.` before any model is loaded. Thanks to @addyCooks. Closes #164.
