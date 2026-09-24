---
'@nanocollective/nanotune': patch
---

`deleteExample` in `src/lib/data.ts` now rejects non-integer indices instead of letting `splice()` silently truncate them — `deleteExample(1.9)` used to delete the second item without complaint. Closes #139.
