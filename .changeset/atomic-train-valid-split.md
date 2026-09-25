---
"@nanocollective/nanotune": patch
---

Fix a crash-safety gap where an interrupted train/validation split could
permanently lose the held-back validation examples. `saveTrainingData` now
writes through the existing atomic file-write helper, and the split writes
`valid.jsonl` before truncating `train.jsonl`, so an interruption between the
two writes can at worst leave a recoverable duplicate — never a loss.
