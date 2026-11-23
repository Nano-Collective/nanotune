---
"@nanocollective/nanotune": patch
---

Literal API keys in `judge.json` that contain a `$` are no longer truncated by environment-variable expansion. Only the documented `${VAR}` and `${VAR:-default}` forms are expanded, and an unset variable with no default now fails with an error naming the variable instead of sending a blank bearer token. Closes #128. **If you upgrade:** a bare `$VAR` (as in `"apiKey": "$OPENROUTER_API_KEY"`) or a `${VAR}` inside a longer value (as in `"baseUrl": "https://${HOST}/v1"`) is no longer expanded and is sent as written, so the provider will reject it. Change it to a whole-value `${VAR}`.
