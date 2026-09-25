---
'@nanocollective/nanotune': patch
---

Fix `data list` edit overwriting the first turn when editing any other turn of a multi-turn example. `mergeEditedTurn` used to locate the turn to replace with `messages.findIndex(m => m.role === 'user'/'assistant')`, which always resolved to the first turn regardless of which one was being edited — the UI worked around this by only ever allowing turn 1 to be edited. `mergeEditedTurn` now takes an explicit turn index and locates that turn's messages by position, and `data list`'s `e` key now shows a turn picker for multi-turn examples so any turn can be selected and edited without disturbing the others. Closes #135.
