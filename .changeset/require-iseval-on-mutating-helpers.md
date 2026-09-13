---
'@nanocollective/nanotune': patch
---

Require `isEval` on every helper in `src/lib/data.ts` that writes to the dataset. A caller that forgot the flag used to silently append to, or overwrite, the wrong file; the type checker now catches it at compile time. Read-only helpers (`loadTrainingData`, `countExamples`, `validateTrainingData`, the exporters) keep the `isEval = false` default — a missing flag shows the wrong set but destroys nothing. No runtime behaviour change. Thanks to @addyCooks. Closes #129.