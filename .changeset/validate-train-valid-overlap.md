---
'@nanocollective/nanotune': minor
---

`nanotune data validate` now intersects the normalized user inputs of
`train.jsonl` and `valid.jsonl` and warns when any appear in both. A split
produces disjoint sets, but the two files can drift apart afterwards — a
hand-edit, a re-import, or an interrupted split — and an example the model
trained on scores misleadingly well in validation. The report gains a
`trainValidOverlap` count and a `checks.noTrainValidOverlap` verdict, so the
finding is machine-readable rather than only prose, and `--eval` reports the
same overlap from the validation side. Warning-only: `valid`, the exit code and
what is on disk are all unchanged.
