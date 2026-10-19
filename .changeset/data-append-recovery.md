---
"@nanocollective/nanotune": minor
---

Journal dataset appends so interrupted writes can be recovered without duplicating examples. Add `nanotune data repair` with validation-set and JSON output options to back up datasets and quarantine malformed rows before rewriting them.

Repair also preserves and quarantines invalid append journals so corrupt recovery metadata does not permanently block dataset commands. Existing project ignore files are backfilled for journal and quarantine artifacts. The JSONL dataset format remains unchanged.
