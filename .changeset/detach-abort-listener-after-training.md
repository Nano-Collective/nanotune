---
"@nanocollective/nanotune": patch
---

Detach the training `abort` listener once a run finishes, so aborting a reused signal later no longer sends SIGINT to a closed subprocess.
