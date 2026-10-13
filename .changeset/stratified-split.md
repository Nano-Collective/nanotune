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
  dataset into `valid.jsonl`. A ratio of 1 or more dropped an extra example via
  `slice(0, -1)`. Both are now rejected before anything is read or written.
- The generated `.nanotune/.gitignore` did not list `data/`, so a user's
  training data — their prompts and the model's replies to them — was
  committable. Existing projects are brought up to date in place, keeping any
  patterns you added yourself.
