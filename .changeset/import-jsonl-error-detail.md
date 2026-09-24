---
'@nanocollective/nanotune': patch
---

`importFromJSONL` in `src/lib/data.ts` now includes the underlying `SyntaxError` message when a line fails to parse, so a bad line reports `Line 450: Invalid JSON: ...` with the token and position instead of a bare `Invalid JSON` that gave nothing to search a large data file for. Closes #140.
