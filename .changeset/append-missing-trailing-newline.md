---
'@nanocollective/nanotune': patch
---

Appending a training example to `train.jsonl` or `valid.jsonl` no longer glues it onto the previous line when the file does not end in a newline, which corrupted both examples. `nanotune data add`, `data import` and chat's `/keep` now start a new line first. Thanks to @addyCooks. Closes #217.
