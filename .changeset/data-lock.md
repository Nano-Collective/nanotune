---
'@nanocollective/nanotune': patch
---

Writes to the training data are now serialized between `nanotune` processes, fixing silent data loss when two of them ran at once.

Starting a `data import` and then using `/keep` in a `chat` session, or pressing `d` in `data list` while an import was running, lost examples without any error. A split reads `train.jsonl` and writes both halves back through a temp file and a rename; an append landing between the read and the rename went to the file the rename had already replaced, and vanished. Every command that writes now takes a lock on `.nanotune/data.lock` for the length of one read-modify-write, so the second waits instead of overwriting.

Also fixed, and not named in the issue:

- `nanotune data import` took the lock once per row, so a split starting halfway through would leave the rows imported before it in `valid.jsonl` and the rows after it in `train.jsonl` — an import that reported success and had silently become part of the validation set. An import is now one locked step.
- `deleteExample`, `updateTrainingExample`, `dedupeExamples` and `fixContextMessages` lost the same way, which is `data list` pressing `d` or `e`, and `data validate --fix`, during an import.
- `nanotune train` counted the validation set and then decided to split, without a lock in between. Two `train` runs on a fresh project both saw no validation set, both split, and the second discarded the first's.
- `data validate --fix` rewrote context messages and then deduped as two separate steps, so a write in between left the reported counts describing a file that no longer matched.
- `appendTrainingExample` checked whether the file ended in a newline and then appended. Two processes both seeing no trailing newline both wrote one, leaving a blank line that `data validate` then reported as malformed.

A lock left behind by a process that was killed is taken over by the next command, so a crash mid-import no longer leaves the project permanently unwritable. A lock held by another machine is never taken over, because on a shared home directory that process's pid means nothing here.

One deliberate consequence: `/keep`, `data list` and `data validate` now wait for a long `data import` to finish rather than writing alongside it. There is no "waiting" message, because every command that can block is an interactive screen that owns the terminal.

Reads are deliberately not locked. A read that races a write can only observe a state that genuinely existed, and locking them would stop `nanotune status` answering for the length of an import.

Closes #196.
