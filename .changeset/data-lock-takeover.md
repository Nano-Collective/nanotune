---
"@nanocollective/nanotune": patch
---

Fix a race when two commands take over a data lock left behind by a killed process. Both could enter the write at once, and a concurrent read could fail with a missing-file error. Taking over the lock now claims it by renaming its owner record first, so only one command can remove it.
