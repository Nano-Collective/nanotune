---
'@nanocollective/nanotune': patch
---

`nanotune chat`, `benchmark` and `benchmark --json` no longer hang for up to the full startup timeout (60s by default) after reporting that `llama-server` exited during startup. The health-check loop that raced against the child's exit was never cancelled, so it kept polling a dead port until its own deadline. It is now aborted as soon as the race ends. Thanks to @addyCooks. Closes #220.
