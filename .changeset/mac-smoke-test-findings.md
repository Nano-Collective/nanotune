---
'@nanocollective/nanotune': patch
---

Fixes from a full run of the release smoke test on Apple Silicon. Installing PyTorch or `mlx-lm` inside a virtualenv no longer fails with "Can not perform a '--user' install", which broke the venv remedy that the externally-managed-environment error recommends. The exit hint on `export`, `benchmark`, `benchmark compare`, `benchmark review`, `judge test`, `status` and `data validate` now names the keys that really exit (Enter, Esc, and `q` where it applies) instead of "Press any key". `benchmark review` and a bare `benchmark compare` no longer pick up a `--base` control by default: review offers the latest run of your model, and compare pairs the newest control with the newest run of your model when the two latest runs are both controls. The `init` success screen no longer shows "[Esc] Cancel". The docs now state that `train --resume` loads the checkpoint weights and runs `iterations` more from a fresh counter.
