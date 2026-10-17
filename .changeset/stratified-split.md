---
"@nanocollective/nanotune": minor
---

Split the training set by category instead of at random (#211).

A pure random split can leave a rare topic entirely out of the validation set —
with one example in two hundred, that happens about nine times in ten — and the
resulting evaluation loss says nothing about how the model handles that topic.

Examples can now carry a `tags` array in any supported format (a third column
for CSV), and the split groups by the first tag so every category contributes
roughly its share. It also holds out whole duplicate groups: two examples
differing only in case or punctuation are the same example as far as evaluation
goes, and a copy on both sides makes the validation loss measure memorization
rather than generalization. `nanotune data validate` reports an overlap for
datasets that already have one.

New `nanotune train` flags: `--validation-ratio` and `--stratify auto|on|off`.
Datasets without tags split exactly as they did before, byte for byte, for the
same seed.

Also fixed, and unrelated to splitting:

- A validation ratio of `NaN` wrote `train.jsonl` empty and moved the whole
  dataset into `valid.jsonl`. A ratio of 1 or more did the same, via a negative
  `trainCount` that `slice` read as an offset from the end of the array. Both
  are now rejected before anything is read or written. No example was ever
  dropped or duplicated by this — the two halves always partitioned the dataset
  — but the train half went empty while the examples were still counted as
  trained on, and the reported counts described neither outcome.
- `--seed`, `--stratify` and `--validation-ratio` are all ignored once
  `valid.jsonl` exists. Only `--seed` said so, so `--validation-ratio 0.2` on an
  already-split project was accepted, applied to nothing, and the run went on to
  report the old 10%. All three are now named, along with the `--stratify` and
  `--validation-ratio` the existing set was actually split with.
- `nanotune data export` wrote a tag containing `;` into the CSV tags column
  unquoted, where it re-imported as two categories that never existed and quietly
  changed what the next split stratified on. It is now left out of the column and
  named in the summary; the example itself is still exported. JSONL and JSON
  carry it either way.
- The generated `.nanotune/.gitignore` did not list `data/`, so a user's
  training data — their prompts and the model's replies to them — was
  committable. Existing projects are brought up to date in place, keeping any
  patterns you added yourself.
