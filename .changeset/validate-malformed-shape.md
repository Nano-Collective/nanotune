---
'@nanocollective/nanotune': patch
---

`nanotune data validate` (including `--fix` and `--json`) and `nanotune data list` no longer crash with a raw `TypeError` when a line of `train.jsonl` parses as JSON but has the wrong shape (`null`, an object without `messages`, a `null` message, or a non-string `role`/`content`). Such lines are now reported as `Example N: invalid structure` and, like unparseable lines, are left untouched on disk. Thanks to @addyCooks. Closes #218.
