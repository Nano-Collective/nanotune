---
'@nanocollective/nanotune': patch
---

`nanotune status`, `nanotune train`, `nanotune export`, `nanotune data validate` and `nanotune data list` no longer crash with a React reconciler stack trace when `config.json` is malformed, and `nanotune data validate` no longer crashes when `train.jsonl` contains a bad line — instead each command reports the file (and line, where applicable) and exits with code 1. Malformed lines in `train.jsonl` are preserved so the mutating helpers never silently delete user data; `--fix`/`--rewrite-context` and edit/delete skip when the data does not fully parse. Thanks to @addyCooks. Closes #126.