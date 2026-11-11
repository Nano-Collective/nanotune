---
'@nanocollective/nanotune': patch
---

The MiniMax Coding Plan judge template now defaults to `MiniMax-M3.1-Flash` instead of `MiniMax-M2.5`, which MiniMax retires on November 18, 2026. Existing judge configs keep the model they were saved with; run `nanotune judge configure` again, or edit the model in your judge config, to switch.
