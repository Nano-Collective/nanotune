# 1.7.0

## Benchmarks are reproducible by default

_[@addyCooks](https://github.com/addyCooks) in [#97](https://github.com/Nano-Collective/nanotune/pull/97)_

`nanotune benchmark` defaulted to `temperature: 0.8` with no seed and a single sample per test, so running the same suite twice against the same model produced different pass rates. For a tool whose output is a score, that made every number ambiguous — a 3-point move could be a real regression or just sampling noise.

Benchmarks now default to `temperature: 0` with a fixed seed of `42`. Two consecutive runs with default flags produce identical results.

> **Existing benchmark numbers will move.** Scores recorded before this release were sampled at temperature 0.8; re-running the same suite will produce a different — and from now on stable — figure. Re-baseline any pass rates you're tracking.

Sampling is still available for anyone who wants it:

```bash
nanotune benchmark --temperature 0.8
```

### `--samples <n>`

New flag runs each test n times and records the per-test pass rate and variance in both reports, rather than reporting a single coin flip:

```bash
nanotune benchmark --temperature 0.8 --samples 5
```

A test passes when the majority of its samples pass. Each sample uses `seed + sample_index`, so runs stay reproducible while the samples differ from one another.

`--temperature`, `--seed`, and `--samples` now reject a value they can't parse instead of falling back to the default. `--samples 5x` used to run a single sample; it now fails with a message naming the flag, so a score is never reported under settings you didn't ask for.

### `nanotune benchmark compare`

_[@rohanshrma222](https://github.com/rohanshrma222) in [#92](https://github.com/Nano-Collective/nanotune/pull/92)_

A score on its own doesn't tell you whether fine-tuning helped. `compare` diffs two saved runs and reports what moved, per test and per category:

```bash
nanotune benchmark compare                      # the two most recent runs
nanotune benchmark compare before.json after.json
```

With one argument, it compares that run against the latest. With none, it picks the two most recent.

### `nanotune benchmark --base`

_[@rohanshrma222](https://github.com/rohanshrma222) in [#92](https://github.com/Nano-Collective/nanotune/pull/92)_

Benchmarks the base model, before any fine-tuning, as a control. This is the number your fine-tuned score is only meaningful against:

```bash
nanotune benchmark --base
nanotune benchmark
nanotune benchmark compare
```

The base model has to be downloaded, converted, and quantized before it can be benchmarked, which is slow. The result is cached under `~/.nanotune/models/base-cache/`, keyed by model id and quantization, so every project fine-tuning from the same base model pays that cost once. The cache is written to a temp file and renamed into place, so a run killed mid-quantize can't leave a corrupt GGUF that later runs treat as valid.

Saved reports record whether the run was a base-model control, along with the temperature, seed, and sample count used.

## Chat streams as it generates

_[@akramcodez](https://github.com/akramcodez) in [#103](https://github.com/Nano-Collective/nanotune/pull/103)_

`nanotune chat` waited for the entire reply before printing anything, so a long answer looked like a hung terminal. Tokens now stream in over SSE as the model produces them.

Press `Esc` to cancel a generation in flight. Whatever had been generated is kept and stays in the conversation history, so the transcript on screen and the history the model sees never disagree. Cancelling a turn that produced nothing rolls it back entirely.

### `/save` and `/keep`

_[@addyCooks](https://github.com/addyCooks) in [#98](https://github.com/Nano-Collective/nanotune/pull/98)_

The best training examples tend to surface during a chat, and there was no way to capture them without retyping into `data add`.

```
/save [file]   Save the transcript to JSON (--force overwrites)
/keep          Append the last exchange to train.jsonl
```

`/save` writes to `.nanotune/chats/` by default and refuses to overwrite an existing file unless you pass `--force`, since a transcript can't be recovered once it's gone.

## Training hyperparameters are settable from the CLI

_[@rohanshrma222](https://github.com/rohanshrma222) in [#110](https://github.com/Nano-Collective/nanotune/pull/110) and [#111](https://github.com/Nano-Collective/nanotune/pull/111)_

Tuning a run meant hand-editing `config.json`. Every training hyperparameter now has a flag:

```bash
nanotune train --batch-size 8 --num-layers 8 --lora-rank 16 --lora-alpha 32
```

New flags: `--batch-size`, `--num-layers`, `--steps-per-eval`, `--save-every`, `--fine-tune-type` (`lora`, `dora`, or `full`), `--lora-rank`, `--lora-alpha`, `--lora-dropout`, `--max-seq-length`, `--grad-checkpoint` / `--no-grad-checkpoint`, `--val-batches`, and `--train-seed`.

Flags override `config.json`; anything you don't pass keeps its configured value. Values are validated against the config schema before the run starts, so a bad number fails immediately with a message naming the flag you typed rather than dying inside `mlx_lm` minutes later. `--fine-tune-type full` skips the LoRA parameter block entirely.

### Ctrl+C stops training gracefully

_[@addyCooks](https://github.com/addyCooks) in [#93](https://github.com/Nano-Collective/nanotune/pull/93)_

Ctrl+C used to tear the app down while MLX was still writing, and the "checkpoint saved" hint it printed was never verified. Training now stops on a signal, MLX flushes its checkpoint, and the summary reports the actual last-saved iteration and how to resume:

```
Checkpoint saved at iteration 100
Resume with: nanotune train --resume
```

A second Ctrl+C gives up on the checkpoint rather than trapping you behind a trainer that won't exit. Interrupted runs exit `130`.

### The train/validation split is visible

_[@addyCooks](https://github.com/addyCooks) in [#80](https://github.com/Nano-Collective/nanotune/pull/80)_

`ensureValidationSet()` silently moved ~10% of `train.jsonl` into `valid.jsonl` on the first run, so the training-example count dropped with no explanation. The split is now reported when it happens, and both counts are shown on every run.

`--seed <n>` makes the split reproducible. Because the split only happens when no validation set exists yet, passing a seed to an already-split project now says so instead of letting you believe the split was re-rolled.

## Working with the validation set

_[@rohanshrma222](https://github.com/rohanshrma222) in [#96](https://github.com/Nano-Collective/nanotune/pull/96)_

Every `data` subcommand takes `-e, --eval` to operate on `valid.jsonl` instead of `train.jsonl`:

```bash
nanotune data add --eval
nanotune data list --eval
nanotune data import extra.jsonl --eval
nanotune data validate --eval
nanotune data export valid-backup.jsonl --eval
```

`data validate` no longer warns that a validation set has fewer than 50 examples. A validation set is a slice of the training data, so that floor never applied to it and the warning was noise on a correct split.

## `nanotune data export`

_[@rohanshrma222](https://github.com/rohanshrma222) in [#96](https://github.com/Nano-Collective/nanotune/pull/96)_

Exports training data to JSONL, CSV, or JSON, chosen by the output file's extension:

```bash
nanotune data export backup.jsonl
```

JSONL and JSON round-trip exactly: re-importing the output reproduces the original data, including multi-turn conversations and per-example context messages. CSV can't represent a multi-turn example, so those are skipped rather than silently truncated, and reported in the summary. Existing files prompt before being overwritten; `--yes` skips the prompt for scripts and CI.

## Editing and repairing training data

_[@rohanshrma222](https://github.com/rohanshrma222) in [#96](https://github.com/Nano-Collective/nanotune/pull/96)_

`data list` gains `e` to edit the selected example in place. Only the first user/assistant turn is editable; every other message is preserved untouched, and the count of preserved turns is shown so a multi-turn example can't be quietly flattened.

`data validate` gains two repair flags:

```bash
nanotune data validate --fix              # remove exact duplicates
nanotune data validate --rewrite-context  # match context messages to config
```

`--fix` only removes examples that are identical across every message. This is deliberately stricter than the duplicate warning, which compares first user messages only: two examples sharing an input but differing in output are real data. `--rewrite-context` fixes examples whose context message has drifted from the current config, and never inserts one where an example didn't have it. When both are passed, the rewrite runs first so examples that only become identical after normalization are still caught.

## Config typos are reported

_[@addyCooks](https://github.com/addyCooks) in [#78](https://github.com/Nano-Collective/nanotune/pull/78)_

`ConfigSchema` silently dropped unknown keys, so `loraLayers` instead of `numLayers` was discarded with no warning and the default used instead. Unknown keys are now reported with a suggestion:

```
Warning: unknown key "training.loraLayers" in config.json — ignored. Did you mean "numLayers"?
```

Nested objects are checked too. An invalid `config.json` now fails with the offending path and what was wrong with it, instead of the raw Zod issue array serialized as a wall of JSON.

## Fixes

- **`data list --eval` corrupted training data.** Editing a validation example wrote to `train.jsonl` at the same index, overwriting a real training example and then displaying training data in the validation view. Silent and unrecoverable.
- **CSV import dropped valid rows.** Header detection matched any first cell *containing* "input" or "output", so a genuine first row like `"explain the input parameter","..."` was swallowed as a header. Detection now requires the row to be exactly the two column names. _([@Aryagarg23](https://github.com/Aryagarg23), [#91](https://github.com/Nano-Collective/nanotune/pull/91))_
- **CSV import choked on spreadsheet exports.** A leading UTF-8 BOM, which Excel and Numbers both write, was parsed as part of the first field. It's now stripped. _([@addyCooks](https://github.com/addyCooks), [#89](https://github.com/Nano-Collective/nanotune/pull/89))_
- **Benchmark matching treated distinct answers as equal.** `normalizeText` canonicalized `"`, `'`, and `` ` `` to a single character, so a test expecting one quote style passed on any other. Quote characters are now kept distinct. _([@addyCooks](https://github.com/addyCooks), [#90](https://github.com/Nano-Collective/nanotune/pull/90))_
- **`llama-server` dying could kill the CLI.** Execa's promise rejects when a child is killed or exits non-zero, and the handler was attached at stop time, potentially hours later. On Node 22 that unhandled rejection is fatal, so a server that died mid-run took the whole CLI down with a raw stack dump. The handler is now attached at spawn. _([@addyCooks](https://github.com/addyCooks), [#116](https://github.com/Nano-Collective/nanotune/pull/116))_
- **A bad GGUF reported a timeout instead of the real error.** `llama-server` rejects an incompatible model in milliseconds, but startup waited out the full 60-second health-check timeout before reporting a generic failure. Startup now races the health check against the child's exit. _([@addyCooks](https://github.com/addyCooks), [#116](https://github.com/Nano-Collective/nanotune/pull/116))_
- **A benchmark run whose server died scored as a catastrophic regression.** Every remaining test failed to connect and was counted against the total. The run now stops at the failure, saves partial results, scores against what actually ran, and says why. _([@addyCooks](https://github.com/addyCooks), [#116](https://github.com/Nano-Collective/nanotune/pull/116))_
- **`nanotune export` progress jumped.** Both sub-steps reported a flat 25% then 100% regardless of actual progress. Each sub-step's progress is now mapped onto its slice of the overall export. _([@addyCooks](https://github.com/addyCooks), [#95](https://github.com/Nano-Collective/nanotune/pull/95))_
- **`data list` stranded you on an empty page.** Deleting the last row of the last page left the view on a page that no longer existed. Pagination now steps back. _([@addyCooks](https://github.com/addyCooks), [#94](https://github.com/Nano-Collective/nanotune/pull/94))_
- **`judge.json` could briefly exist with loose permissions.** It was written and then `chmod`ed, so a file replacing a `0644` config from an earlier version held the API key at the old mode in between. It's now written to a fresh `0600` temp file and renamed into place, which is atomic and carries the mode with it. _([@yashksaini-coder](https://github.com/yashksaini-coder), [#101](https://github.com/Nano-Collective/nanotune/pull/101))_
- **`train --save-every` was ignored in the stop summary.** The last-checkpoint iteration was computed from `config.json` rather than the value the run actually used, naming the wrong iteration exactly when you need it to decide whether to resume.
- **`Object.prototype` keys weren't reported as unknown config keys.** A key like `constructor` in `config.json` passed the known-key check via the prototype chain. _([@addyCooks](https://github.com/addyCooks), [#78](https://github.com/Nano-Collective/nanotune/pull/78))_
- **Concurrent `--base` runs could delete each other's work.** The stale-artifact sweep removed every `.tmp-*.gguf` in the cache directory, including one belonging to a running export. It now only sweeps files whose owning process is gone.
- **The published package shipped more than it needed to.** The `files` allowlist was trimmed, and spec files are excluded from `dist`. _([@floze-the-genius](https://github.com/floze-the-genius), [#79](https://github.com/Nano-Collective/nanotune/pull/79))_

## Documentation

- New pages and sections for `benchmark compare`, `benchmark --base`, `data export`, chat streaming, `/save` and `/keep`, the training hyperparameter flags, and the `--eval` flag across the data commands.
- New [`docs/testing-guide.md`](docs/testing-guide.md) covering the Ink component test harness.
- Benchmarking guide documents reproducibility, sampling, and base-model comparison.
- Clarified why `judge.json` needs both a file mode and an explicit `chmod`. _([@yashksaini-coder](https://github.com/yashksaini-coder), [#99](https://github.com/Nano-Collective/nanotune/pull/99))_

## Internals

- **The command layer has tests.** `src/commands/` previously had no test harness, which is why several of the bugs above shipped. Commands are now rendered through `ink-testing-library` and driven with real keypresses. _([@addyCooks](https://github.com/addyCooks), [#88](https://github.com/Nano-Collective/nanotune/pull/88))_
- `knip` now enforces `exports: "error"`. Dead exports (`runGGUFInference`, `parseLlamaCppStderr`, `updateExample`) were removed rather than kept on the assumption a caller existed. _([@yashksaini-coder](https://github.com/yashksaini-coder), [#104](https://github.com/Nano-Collective/nanotune/pull/104))_
- Logic continues to move out of `.tsx` and into testable helpers: `benchmark-compare.ts`, `benchmark-utils.ts`, `model-cache.ts`, `chat-helpers.ts`, plus `buildTrainingArgs`, `mergeEditedTurn`, `clampPagination`, and `scaleProgress`.
- **452 tests total (+213).**

## Toolchain

- Dependency updates via Dependabot: `ai` 7.0.77, `@ai-sdk/anthropic` 4.0.36, `commander` 15.0.0, `execa` 10.0.1, `typescript` 7.0.2, `c8` 12.0.0, `@biomejs/biome` 2.5.7, `@types/node` 26.2.0, `react` and `@types/react`.
- Restored Biome formatting across the repo _([@yashksaini-coder](https://github.com/yashksaini-coder), [#102](https://github.com/Nano-Collective/nanotune/pull/102))_, and repinned the config `$schema` to the installed Biome version.

## Contributors

Every one of them is a first-time Nanotune contributor. Thank you:

- [@addyCooks](https://github.com/addyCooks) — deterministic benchmarks, graceful Ctrl+C during training, train/validation split visibility, config typo warnings, chat `/save` and `/keep`, the Ink command test harness, and fixes to CSV BOM handling, benchmark quote matching, export progress, data list pagination, and llama-server lifecycle
- [@rohanshrma222](https://github.com/rohanshrma222) — `benchmark compare`, `benchmark --base`, the training hyperparameter flags, `data export`, data editing, and the `--eval` flag across the data commands
- [@akramcodez](https://github.com/akramcodez) — SSE token streaming in `nanotune chat`
- [@yashksaini-coder](https://github.com/yashksaini-coder) — atomic `judge.json` writes, dead-export removal with a knip rule to keep it that way, restored Biome formatting, and judge permission docs
- [@Aryagarg23](https://github.com/Aryagarg23) — exact CSV header matching
- [@floze-the-genius](https://github.com/floze-the-genius) — trimmed published package contents

Dependency updates in this release came in via Dependabot.

---

# 1.6.0

## Nanotune works without a terminal

Every command previously crashed when `stdin` wasn't a TTY. Ink enables raw mode as soon as a component calls `useInput`, so piping output, running in CI, running in Docker without `-t`, or simply redirecting stdin produced a 40-line React reconciler stack trace instead of output — even for read-only commands like `status` that never needed a keypress.

```bash
nanotune status | tee run.log     # previously: ERROR Raw mode is not supported...
```

Commands now detect whether a keyboard is available and behave accordingly.

### Render-and-exit commands
`status`, `data validate`, `train`, `export`, `benchmark`, and `judge test` render their output and exit on their own when there's no TTY, instead of parking on a "press any key" frame forever.

- **Non-zero exit codes on failure** — a failed run now sets exit code 1, so `nanotune train && nanotune export` chains correctly and CI can gate on `nanotune data validate`.
- **Keyboard hints are suppressed** when there's no keyboard, keeping captured output clean.

### Interactive-only commands
`init`, `data add`, `data list`, `chat`, and `judge configure` genuinely need a keyboard. They now print a single clear sentence and exit 1:

```
`nanotune chat` needs an interactive terminal.
stdin is not a TTY, so it cannot read keypresses. Run it directly in a
terminal rather than through a pipe, a CI job, or with stdin redirected.
```

### `nanotune data import --yes`
New `-y, --yes` flag skips the confirmation prompt, making `data import` usable from scripts and CI:

```bash
nanotune data import examples.jsonl --yes
```

Without a TTY and without `--yes`, the command explains that the flag is required rather than failing obscurely.

## Fixes

- **Platform check now fires up front.** The Apple Silicon assertion only ran inside `installLlamaCpp`, so users on Linux or Intel Macs hit a confusing `pip install mlx-lm` resolver error during `train` instead of the clear message that already existed. `train` and `export` now assert supported hardware before doing any work. Extracted to `src/lib/platform.ts`.
- **`judge.json` is written with `0600` permissions.** The file can hold a literal API key for users who don't use the `${ENV_VAR}` form. Existing configs written by earlier versions are tightened on next save.

## Documentation

- **`nanotune chat` is documented.** The 1.5.0 headline feature shipped with no docs page. Added [`docs/commands/chat.md`](docs/commands/chat.md) covering slash commands, all flags, per-turn stats, and chat-template handling, and listed it in the commands index.
- **Quick start covers `chat`** — added as step 5, between export and benchmark.
- **`data import --yes` documented** in the data command reference.
- **Fixed the benchmark preset table** — the max-tokens column read 50/100/150/200; the actual values are 128/256/512/1024.

## Internals

- **Coverage now reports an honest number.** The `c8` `exclude` pointed at `source/app/App.tsx`, a path that has never existed, and spec files were counted as covered source — trivially 100%, inflating the total. Excluding them moves the reported figure from 88.62% to 78.97% with no change in actual test coverage.
- New `src/lib/tty.ts` (raw-mode detection) and `src/lib/platform.ts` (hardware assertion), both pure and unit-tested.
- New `useKeyInput`, `useAutoExit`, and `ExitHint` in `src/components/` — `useKeyInput` is now the only sanctioned way to read keys; calling Ink's `useInput` directly reintroduces the crash.
- **239 tests total (+16)** covering raw-mode detection, platform assertions, and judge config file permissions.

## Toolchain

- Dependency updates via Dependabot: `ai` 7.0.15, `@ai-sdk/anthropic` 4.0.8, `@ai-sdk/google` 4.0.8, `ink` 7.1.0, `ava` 8.0.1, `c8` 11.0.0, `knip` 6.24.0, `tsx` 4.23.0, `typescript` 6.0.3, `@types/node` 26.x, `@biomejs/biome` 2.5.1.
- Repaired a broken `pnpm-lock.yaml` and several latent toolchain breaks in CI.
- Resolved Biome config deprecations and Semgrep findings.

---

# 1.5.0

## `nanotune chat`

A new interactive REPL closes the loop from train → export → chat. Talk to your fine-tuned model without leaving Nanotune.

```bash
nanotune chat                # uses the latest exported GGUF
nanotune chat -m my.gguf     # specific model
nanotune chat --preset high
nanotune chat --system "You are a Bash command generator..."
```

### Features
- **Persistent `llama-server`** — model loads once, conversation reuses the same hot process. No cold start between turns.
- **Chat-template aware** — uses `/v1/chat/completions` so the GGUF's chat template is applied (ChatML, Llama-3 tags, etc.). Same wire format the model was trained on.
- **Slash commands**:
  - `/help` — show available commands
  - `/reset` (or `/clear`) — wipe conversation history
  - `/system <text>` — replace the system message mid-session and reset history
  - `/stats` — show session token totals
  - `/exit` or `/quit` — leave (Esc also exits when idle)
- **Per-turn stats** — TTFT, tokens/sec, and tokens generated displayed below each assistant reply.
- **Hardware controls** — same `--preset`, `--threads`, `--gpu-layers`, `--ctx-size`, `--batch-size`, `--cpu-only`, `--max-tokens`, `--temperature`, `--top-p`, `--seed` flags as `nanotune benchmark`.
- **Override system prompt** — `--system` flag overrides the project's `contextMessage` for the session.

### Internals
- Extracted `findLatestGGUF()` into `src/lib/config.ts`; `benchmark` and `chat` both consume it.
- Server lifecycle reuses the SIGTERM → SIGKILL escalation from 1.4.0, so a hung llama-server can't keep the REPL alive after exit.
- `process.on('exit')` backstop SIGKILLs the child on abrupt terminations (Ctrl-C, signal kills) that bypass the React unmount.

## Test Coverage

Backfilled direct unit tests for several pure-function helpers that were previously only exercised indirectly. **223 tests total (+92).**

### Extractions to enable testing
- `checkPass` + `normalizeText` moved from `src/commands/benchmark.tsx` to `src/lib/benchmark-match.ts`.
- `buildServerOptions`, `buildGenerateOptions`, and a new `parseSlashCommand` discriminated-union helper moved to `src/lib/chat-helpers.ts`.
- `parseChatCompletionResponse` extracted from `chatCompletion` and exported from `src/lib/llama-cpp.ts`.

### New tests
- **`parseCSV`** — 13 cases covering LF/CRLF/CR endings, quoted fields with embedded commas, escaped quotes (`""`), newlines inside quoted fields, mixed quoted/unquoted columns, empty fields, unclosed-quote-at-EOF, and trailing-newline handling. Plus an `importFromCSV` regression asserting that a row with an embedded comma round-trips.
- **`splitTrainValidation`** — same-seed reproducibility, full-permutation invariant (no drops, no duplicates), different-seeds-produce-different-splits, zero-examples, and the minimum-one-validation guarantee.
- **`checkPass`** — every match mode, plus an explicit regression that `semantic` mode no longer accepts `"ls"` as a pass for `acceptable: ["ls -la"]` (the 1.4.0 bug fix).
- **`normalizeText`** — whitespace collapse, quote canonicalization, trim.
- **`findLatestGGUF`** — missing dir, empty dir, no GGUFs, newest-by-mtime selection, and ignores non-`.gguf` siblings even when they're newer.
- **`parseChatCompletionResponse`** — content extraction, trimming, missing/empty `choices`, missing `message`, top-level `timings` mapping (rounded), `usage.completion_tokens` fallback, `timings.predicted_n` preferred over the usage fallback, and the `prompt_ms=0` edge case (pins current behaviour).
- **`parseSlashCommand`** — empty/whitespace noop, plain-text send, `/exit` `/quit` `/reset` `/clear` `/help` `/stats` aliases, `/system` with and without arg, case-insensitive command name, case-preserving argument, unknown commands surface as `unknown` rather than being prompted into the model.
- **`buildServerOptions` / `buildGenerateOptions`** — defaults, numeric flag parsing, `cpuOnly` passthrough, low/high preset application, preset wins over individual flags, unknown preset falls back, and the chat-specific 256-token default (vs benchmark's 50).

---

# 1.4.0

## Correctness Fixes

### Chat-template-aware inference
- **Switched benchmark inference from `/completion` to `/v1/chat/completions`** — llama-server now applies the model's chat template (ChatML, Llama-3 tags, etc.) baked into the GGUF. Training (which feeds MLX a `messages: []` array) and benchmarking now use the same wire format end-to-end. Previously, benchmarks built raw `User:/Assistant:` strings, bypassing the chat template and systematically under-reporting fine-tuned model quality.
- **`llama-server` is now started once per benchmark run** instead of once per test. Cold-starting the server (which loads a multi-GB model) per test has been collapsed to a single startup.

### Data import
- **Fixed CSV parser** — replaced a regex that broke on any field containing a comma with a proper state-machine parser. Quoted fields with embedded commas, escaped quotes (`""`), and CRLF line endings are now handled correctly.
- **JSONL/JSON imports preserve `messages` arrays verbatim** — previously, examples with ≤3 messages had their embedded system prompts silently overwritten by the project's context message. Now any imported `messages` array is preserved as-is.

### Benchmark `semantic` match mode
- **No longer accepts truncated answers** — the old `semantic` mode treated `"ls"` as a pass for `acceptable: ["ls -la"]`, inflating pass rates. The truncation behaviour is now opt-in via a new `partial` match mode.

### Train/valid split
- **Seedable Fisher-Yates shuffle** — replaced the biased `sort(() => Math.random() - 0.5)` with Mulberry32 + Fisher-Yates. Pass a seed to `splitTrainValidation` for a reproducible split.

## Robustness & UX

- **CLI `--version` now reads from `package.json`** (was hardcoded to `1.0.0`).
- **`nanotune init` writes `.nanotune/.gitignore`** covering `judge.json` (API keys), `adapters/`, `models/`, and `benchmarks/` — protects users from committing keys or multi-GB binaries.
- **Upfront platform check** — non-arm64 / non-macOS systems now get a clear, actionable error before any download attempt.
- **Better `mlx-lm` install errors** — `installMLX` tries `--user` first and surfaces actionable guidance when stock macOS Python rejects pip with `externally-managed-environment`.
- **`nanotune train --resume` validates the checkpoint exists** before invoking MLX, replacing an opaque file-not-found with a clear message.
- **f16 intermediate cleanup moved to `finally`** — quantization failures no longer leak multi-GB intermediate files in `models/`.
- **Removed `console.error` in env-substitution** — was corrupting Ink TUI output when an env var was missing.
- **Removed CommonJS `require('node:fs')`** inside the ESM benchmark module.

## Cleanup

- Removed dead code: `runInference`, `parseDownloadProgress`, `runGGUFInferenceLegacy`.
- `InferenceOptions` is now a type alias for `ServerOptions & GenerateOptions` (was a duplicate interface).
- `chatCompletion` accepts an `AbortSignal` via `GenerateOptions.signal`; benchmarks pass one so a timed-out test actually cancels its in-flight `fetch` rather than letting the server keep generating into the void.
- `stopLlamaServer` escalates SIGTERM → SIGKILL after a 2s grace period so a hung server can't block the caller's `finally`.
- Updated spec files to match new behaviour. All 131 tests pass.

---

# 1.3.7

## Toolchain

- **Bumped to pnpm 11 and Node.js 22** — `packageManager` field pinned in `package.json` so CI and contributors stay in sync.
- **Regenerated `pnpm-lock.yaml`** under pnpm 11 to fix `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` on frozen installs.
- **Raised `engines.node` to `>=22.0.0`** and updated CONTRIBUTING and installation docs to match.

---

# 1.3.6

- Updated documentation to match guidelines.

---

# 1.3.5

## Auto-install llama-server

- **Auto-install `llama-server` for existing users** — if the `llama-server` binary is missing from an older llama.cpp installation, benchmarks now automatically re-download llama.cpp before proceeding. No manual steps needed.

---

# 1.3.4

## Benchmark Inference Fix

- **Switched from `llama-cli` to `llama-server`** — benchmarks now spin up a temporary `llama-server` instance and use the `/completion` HTTP API instead of invoking `llama-cli` directly. This avoids the interactive conversation mode that newer llama.cpp versions enter by default, and returns structured timing data (TTFT, tokens/sec, generation time) directly from the response instead of parsing stderr.

---

# 1.3.3

## Benchmark Inference Fix

- **Fixed ENOENT error when running benchmarks** — the inference runner referenced a non-existent `llama-completion` binary. Updated to use `llama-cli`, which is the actual binary name shipped in llama.cpp releases and already provisioned by `nanotune export`.

---

# 1.3.1

## Benchmark Timing Fixes

- **Fixed tokens/sec parsing** — now matches llama.cpp's actual `llama_perf_context_print` output format instead of the old `tok/s` pattern
- **Fixed TTFT** — extracted from `prompt eval time` in llama.cpp stderr instead of estimating as 10% of total time
- **Fixed generation time and token count** — parsed from `eval time` stderr line
- **Added `--verbose` flag** to llama-cli invocation to ensure timing output is always emitted
- **Added summary averages** — benchmark results now include `avgTokensPerSecond` and `avgTtftMs` in the summary, displayed in both the terminal UI and markdown reports
- **Backward compatible** — old `tok/s` and `tokens generated` patterns kept as fallback for older llama.cpp versions

---

# 1.3.0

## Multi-Turn Training & Benchmarking

Nanotune now supports multi-turn conversations in both training data and benchmarks, enabling fine-tuning for dialogue and multi-step interactions.

### Multi-Turn Training
- **`nanotune data add`** supports building multi-turn examples interactively — add as many user/assistant exchanges as needed per example
- **Import** preserves multi-turn conversations from JSONL and JSON sources (4+ messages kept as-is)
- **`nanotune data list`** shows turn count per example
- **Validation** warns on consecutive same-role messages (broken alternation)

### Multi-Turn Benchmarking
- **Benchmark tests** accept a `messages` array as an alternative to `prompt` for multi-turn evaluation
- **LLM judge** receives full conversation context when evaluating multi-turn tests
- **Reports** label multi-turn tests with turn count for clarity

### Model Download Progress
- **`nanotune train`** now shows download progress when fetching a model for the first time, with percentage, file size, and elapsed time
- Downloads are tracked by polling the HuggingFace cache directory, avoiding tqdm/pipe issues

### Improved Benchmark Presets
- **`maxTokens`** values updated to sensible defaults: `low` 128, `medium` 256, `high` 512, `ultra` 1024 (previously 50–200, which was too small for meaningful responses)

---

# 1.2.1

## Bug Fix

- **Benchmark command** now works with minimal config files from external tools. Previously, `nanotune benchmark` required a full project config (with `name`, `baseModel`, `training`, `export` fields). Now it gracefully falls back to an empty context message when the config doesn't match the full schema, enabling benchmark-only workflows.

---

# 1.2.0

## Message-Structure-Agnostic Training

Nanotune is no longer locked into the `system/user/assistant` message structure. The hardcoded `systemPrompt` config field has been replaced with a flexible `contextMessage` that accepts any role (`system`, `developer`, or custom roles).

### What Changed
- **`nanotune init`** now asks for a context message role (defaulting to `system`) and content, instead of just a system prompt
- **Config format** uses `contextMessage: { role, content }` instead of `systemPrompt`
- **Validation** is relaxed: training examples require at least 2 messages with any role names, instead of exactly 3 with hardcoded roles
- **Backward compatible**: existing projects using `systemPrompt` in config.json continue to work without changes

### Why
Models like FunctionGemma use a `developer` role instead of `system`. This change lets you fine-tune for any chat message structure.

---

# 1.1.1

## Security Updates

- Fixed high severity vulnerabilities in transitive dependencies (`minimatch`, `tar`) via pnpm overrides

## Documentation

- Added basic documentation in `./docs` ahead of new documentation website
  - Getting started guide
  - Command reference
  - Training data formats
  - Benchmarking guide

# 1.1.0

## Enhanced Benchmarking

Added `--preset` flag for quick hardware profile selection:
- `low` - Low-end hardware (4 threads, CPU only, 2048 ctx)
- `medium` - Mid-range hardware (8 threads, 20 GPU layers, 4096 ctx)
- `high` - High-end hardware (auto threads, max GPU layers, 8192 ctx)
- `ultra` - Maximum performance (auto threads, max GPU layers, 16384 ctx)

### New CLI Flags
- `--threads <n>` - Number of CPU threads
- `--gpu-layers <n>` - GPU layers to offload
- `--ctx-size <n>` - Context size in tokens
- `--batch-size <n>` - Batch size for processing
- `--cpu-only` - Disable GPU, use CPU only
- `--max-tokens <n>` - Max tokens to generate
- `--temperature <n>` - Sampling temperature
- `--seed <n>` - Random seed for reproducibility

### Detailed Timing
Each query now reports:
- Total latency
- Time to first token (TTFT)
- Generation time
- Tokens generated
- Tokens per second

# 1.0.0

Initial release of Nanotune - a simple, interactive CLI for fine-tuning small language models on Apple Silicon.

## Features

- **Interactive TUI** - Built with React Ink for a smooth terminal experience
- **LoRA Fine-tuning** - Powered by MLX for efficient training on Apple Silicon
- **GGUF Export** - Automatic conversion using pre-built llama.cpp binaries (no compilation needed)
- **Flexible Benchmarking** - Test your models with configurable evaluation modes:
  - `semantic` - Normalized comparison with prefix matching (ideal for code/commands)
  - `contains` - Check if response contains expected answer (ideal for Q&A)
  - `startsWith` - Response must start with expected answer
  - `exact` - Exact match comparison (ideal for classification)
- **Detailed Reports** - JSON and Markdown benchmark reports with model responses and latency metrics
- **Data Management** - Import from JSONL, CSV, or JSON formats with validation

## Commands

- `nanotune init` - Initialize a new fine-tuning project
- `nanotune data add` - Interactively add training examples
- `nanotune data import` - Import training data from files
- `nanotune data list` - View and manage training data
- `nanotune data validate` - Validate training data
- `nanotune train` - Run LoRA fine-tuning with live progress
- `nanotune export` - Export to GGUF format with quantization options
- `nanotune benchmark` - Run benchmarks with detailed reporting
- `nanotune status` - Show project status

If there are any problems, feedback or thoughts please drop an issue or message us through Discord! Thank you for using Nanotune. 🙌