---
"@nanocollective/nanotune": minor
---

Persist local training run history with the effective model settings, dataset counts, duration, outcome, and separate training/validation loss reports. Records are saved before training and refreshed during the run so interrupted runs retain their history. `nanotune status` shows settings and outcome for the current adapter, including checkpoints from failed runs, and `nanotune runs` lists recent runs or exports their complete loss histories as JSON. Resumed runs reference the prior adapter run when available.
