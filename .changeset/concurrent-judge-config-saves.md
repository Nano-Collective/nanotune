---
'@nanocollective/nanotune': patch
---

Use a unique, private temporary file for each judge configuration save so concurrent processes cannot overwrite or remove each other's pending API-key configuration. Failed saves clean up their own temporary file, and the final configuration remains atomically replaced with owner-only permissions.
