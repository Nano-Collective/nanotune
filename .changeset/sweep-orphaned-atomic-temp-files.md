---
"@nanocollective/nanotune": patch
---

`nanotune` now reaps orphaned `.tmp-<pid>` files left behind by a crashed or SIGKILL'd atomic write. The temp file created by `writeFileAtomic` is normally removed in the same call, but a process killed between its temp write and rename never reaches the cleanup — those leftovers used to accumulate forever in `.nanotune/benchmarks/`. On startup every command sweeps dead-pid temps in the benchmarks directory, and `writeFileAtomic` itself sweeps dead-pid temps for its own target path before each write, so a crashed run is healed on the next invocation. Live-pid temps are left alone, so concurrent writes remain safe. Thanks to @ig-imanish.
