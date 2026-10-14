---
"@nanocollective/nanotune": patch
---

Cancel the health-check request and retry timer when llama-server exits during startup, so chat and benchmark commands return promptly after reporting the error.
