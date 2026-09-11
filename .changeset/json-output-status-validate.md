---
'@nanocollective/nanotune': minor
---

`nanotune status --json` and `nanotune data validate --json` now print a single JSON document to stdout, so the read-only commands can be consumed by scripts and CI. Diagnostics and the unknown-config-key warnings go to stderr; Ink never renders in this mode. The schema is documented in `docs/guides/json-output.md` and the `ValidationResult` now exposes `duplicateInputs` and `inconsistentContextMessages` counts that both views read rather than pattern-matching warning prose. Thanks to @yashksaini-coder. Closes #69 for `status` and `data validate`.