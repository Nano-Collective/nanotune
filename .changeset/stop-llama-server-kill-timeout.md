---
"@nanocollective/nanotune": patch
---

Stopping llama-server no longer hangs when the process outlives SIGKILL: the wait after the force-kill is now bounded, so shutdown always returns.
