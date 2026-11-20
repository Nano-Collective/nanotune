---
'@nanocollective/nanotune': patch
---

Small LoRA `scale` and `dropout` values are now written to the temporary `lora.yaml` with exactly their own digits, instead of being padded to 20 decimals by `toFixed(20)`. Values below 1e-20 also no longer lose their digits or round to `0`. Closes #151.
