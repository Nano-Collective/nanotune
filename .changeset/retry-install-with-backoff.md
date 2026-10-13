---
"@nanocollective/nanotune": patch
---

Retry transient network failures while installing llama.cpp, instead of failing the
whole run. A single `502` from GitHub releases or a reset socket mid-transfer
previously discarded an entire multi-gigabyte download, and the user started from
zero. `installLlamaCpp` now wraps its four fetches in a 3-attempt exponential
backoff (1s and 2s waits, with server `Retry-After` hints honoured), and only genuine transients are retried:
server errors, 408/425/429, a 403 that carries `Retry-After` (GitHub's
unauthenticated rate limit), and reset/timeout socket errors. A 404 on a missing
asset still fails immediately, because retrying it only makes the user wait for
an error that cannot change. Failed transfers never publish partial scripts or
archives. Ctrl+C is never retried. Addresses the llama.cpp installation portion
of #215; Hugging Face model downloads remain a separate follow-up.
