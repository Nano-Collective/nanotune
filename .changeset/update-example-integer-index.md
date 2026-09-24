---
'@nanocollective/nanotune': patch
---

`updateTrainingExample` in `src/lib/data.ts` now rejects non-integer indices, same as `deleteExample`. A float index used to pass the bounds check and then assign to a non-index property that `JSON.stringify` drops on save, silently losing the update instead of failing. Follow-up to #139.
