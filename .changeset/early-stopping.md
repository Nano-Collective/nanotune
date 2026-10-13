---
"@nanocollective/nanotune": minor
---

Stop a training run when validation loss stops improving, and atomically restore the exact weights evaluated as best over `adapters.safetensors`. Selection uses a private per-run snapshot at the MLX validation callback rather than numbered checkpoints from earlier runs. Record early-stop and restoration outcomes in training history. Patience defaults to 0, so existing runs are unchanged. Closes #207.
