---
"@nanocollective/nanotune": minor
---

- Added `nanotune clean --target <fused|base|all>` to also cover the shared base-model cache alongside the fused-model cache, and hardened the completeness checks behind both: an interrupted multi-shard fuse or a permission error reading a cache directory no longer produces a false "usable" or crashes `nanotune status`/`nanotune clean`. Thanks to @rohanshrma222. Closes #125.
