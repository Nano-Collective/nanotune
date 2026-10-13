---
"@nanocollective/nanotune": patch
---

Literal API keys in `judge.json` that contain a `$` are no longer truncated by environment-variable expansion. Only the documented `${VAR}` and `${VAR:-default}` forms are expanded, and an unset variable with no default now fails with an error naming the variable instead of sending a blank bearer token. Closes #128.
