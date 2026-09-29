---
"@nanocollective/nanotune": patch
---

`nanotune benchmark --timeout` now also bounds the LLM-judge call. Previously `--timeout` only covered inference, so a judge provider that accepted the connection but never answered would lock the whole run on a single test, with the AI SDK's default retry policy sitting on top re-issuing the request nobody was timing. Judging gets its own budget of `--timeout` (a second model call, not the inference one), `callJudge` forwards the signal into `generateText` so retries are cancelled too, and a timed-out judge fails the sample, leaves `judgeScore` unset, and records the reason ("Judge timed out after Nms") in `judgeReasoning` so the report does not read as the model scoring 0. Thanks to @addyCooks. Closes #132.
