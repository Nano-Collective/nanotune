---
'@nanocollective/nanotune': patch
---

A benchmark test that sets both `prompt` and `messages` is now rejected before the run starts, naming the test. Previously the `messages` conversation was dropped without a word and the test ran as a single-turn prompt. A test with a `prompt` and an empty `messages` array now sends that prompt to the LLM judge instead of an empty one. Thanks to @inahus99. Closes #142.
