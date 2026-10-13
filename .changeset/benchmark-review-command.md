---
'@nanocollective/nanotune': minor
---

Added `nanotune benchmark review [report]`, which turns failed benchmark tests into training data. It loads a saved run (the latest by default, or one named the same way `benchmark compare` accepts) and walks each failure one at a time, showing the prompt or full conversation, the acceptable answers, and what the model actually said. Type a corrected answer and it is appended to `train.jsonl` with the project's context message, the same way `/keep` does in `nanotune chat`; multi-turn failures keep their earlier turns. Leave the input blank to skip a failure, or press Esc to stop early and see how many were saved. A run with no failures says so and exits. The benchmark run itself is untouched, so a report can be reviewed any time after it was produced. Thanks to @addyCooks. Closes #178.
