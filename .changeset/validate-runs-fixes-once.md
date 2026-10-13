---
'@nanocollective/nanotune': patch
---

`nanotune data validate --fix` and `--rewrite-context` now run their dataset rewrites exactly once per invocation. Previously the call to `collectValidation` lived directly in the component's render body; a render body carries no guarantee about how many times it runs, and any future state, context, or parent re-render would have replayed the entire `train.jsonl` write without a user action behind it. The command now computes its report behind a `useRef` and renders from that, so the first frame already reflects the fixed file and `useAutoExit` reads the same value the user saw. Separately, `saveTrainingData` now writes through the same `writeFileAtomic` helper used for configs and benchmark reports, so an interrupted save can no longer leave `train.jsonl` truncated. Thanks to @addyCooks. Closes #133.
