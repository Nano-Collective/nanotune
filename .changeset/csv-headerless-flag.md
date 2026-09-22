---
'@nanocollective/nanotune': minor
---

`nanotune data import` gains a `--headerless` flag for CSV files. The importer used to auto-detect a header by checking whether the first row was exactly `input`/`output`, which meant a headerless file whose first *data* row genuinely was that literal pair got silently dropped as a "header". Passing `--headerless` skips auto-detection entirely so that row always imports as data; default behaviour is unchanged. Thanks to @akramcodez. Closes #136.
