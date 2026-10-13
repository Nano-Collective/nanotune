---
"@nanocollective/nanotune": patch
---

`nanotune benchmark` and `nanotune chat` now start `llama-server` with `--alias <model-name>`, so the server's own API (chat-completion responses, `/v1/models`, `/props`) reports which model/quantization is actually loaded instead of defaulting to the raw file path. Closes #197.
