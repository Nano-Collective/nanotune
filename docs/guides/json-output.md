---
title: "JSON Output"
description: "Machine-readable output from Nanotune's read-only commands, for scripts and CI"
sidebar_order: 5
---

# JSON Output

`nanotune status`, `nanotune data validate` and `nanotune benchmark` accept
`--json`, which prints a single JSON document to stdout instead of the
interactive report. This is what you want in CI, in a shell pipeline, or
anywhere you would otherwise have parsed a box-drawn table.

```bash
nanotune status --json | jq .
nanotune data validate --json | jq '.checks'
nanotune benchmark --json | jq '.summary.passRate'
```

## The contract

These rules hold for every `--json` command, and are what the schemas below can
be relied on against:

- **stdout carries the payload or nothing.** On success it is exactly one JSON
  document followed by a newline. Nothing else is ever written there — no
  progress, no warnings, no partial document.
- **Diagnostics go to stderr.** Errors, warnings such as unknown keys in
  `config.json`, and the progress lines `benchmark --json` prints while a suite
  runs are all written to stderr, so they never corrupt the parse.
- **The exit code carries the status.** `0` on success, non-zero on failure.
  When a command fails, stdout is empty and the reason is on stderr:

  ```bash
  $ cd /tmp && nanotune status --json
  Not a Nanotune project. Run `nanotune init` first.   # stderr
  $ echo $?
  1
  ```

- **Exit codes are unchanged from the interactive commands.** In particular,
  `data validate --json` still exits `1` when the data is invalid — and in that
  case it *does* print its report, because the report is the useful part.
- **Optional values are `null`, never omitted.** A key that can be absent is
  always present with a `null` value, so `jq` never has to distinguish a
  missing key from an empty one.
- **Timestamps are ISO 8601; sizes are raw bytes.** The human forms shown in
  the terminal (`2 hours ago`, `1.2 GB`) are a display concern and never appear
  in JSON.

There is deliberately no `schemaVersion` field. Fields may be **added** in a
minor release; existing fields will not be removed or change meaning without a
major version. If a breaking change ever becomes necessary, a version field
will be introduced then, and its absence can be read as version 1.

## `nanotune status --json`

```bash
nanotune status --json
```

```json
{
  "project": {
    "name": "my-bot",
    "version": "1.0.0",
    "baseModel": "mlx-community/Qwen2.5-0.5B-Instruct-4bit"
  },
  "data": {
    "trainExamples": 120,
    "validExamples": 13,
    "trainLastModified": "2026-09-04T09:12:03.000Z"
  },
  "training": {
    "hasTrained": true,
    "lastRun": "2026-09-03T18:40:11.000Z"
  },
  "exports": [
    {
      "name": "my-bot-q4_k_m.gguf",
      "sizeBytes": 402653184,
      "modified": "2026-09-03T19:02:55.000Z"
    }
  ],
  "benchmarks": {
    "latest": {
      "file": "benchmark-2026-09-03T19-40-02-113Z.json",
      "timestamp": "2026-09-03T19:40:02.113Z",
      "passed": 45,
      "total": 50,
      "passRate": 0.9,
      "isBase": false
    }
  }
}
```

| Field | Type | Notes |
|-------|------|-------|
| `project.name` | string | Project name from `config.json` |
| `project.version` | string | Config schema version |
| `project.baseModel` | string | HuggingFace model id being fine-tuned |
| `data.trainExamples` | number | Examples in `train.jsonl` |
| `data.validExamples` | number | Examples in `valid.jsonl` |
| `data.trainLastModified` | string \| null | ISO 8601 mtime of `train.jsonl`; `null` if it does not exist |
| `training.hasTrained` | boolean | Whether an adapter checkpoint exists |
| `training.lastRun` | string \| null | ISO 8601 mtime of `adapters.safetensors`; `null` if never trained |
| `exports[]` | array | Exported GGUFs, **newest first** — `.exports[0]` is the latest |
| `exports[].sizeBytes` | number | File size in bytes |
| `benchmarks.latest` | object \| null | Most recent saved run; `null` if none, or if the saved run could not be parsed |
| `benchmarks.latest.file` | string | Filename under `.nanotune/benchmarks/`, usable with `nanotune benchmark compare` |
| `benchmarks.latest.passRate` | number | Fraction between 0 and 1, not a percentage |
| `benchmarks.latest.isBase` | boolean | True when the run benchmarked the base model as a control |

Gate a release on the last benchmark:

```bash
nanotune status --json | jq -e '.benchmarks.latest.passRate >= 0.9'
```

## `nanotune data validate --json`

```bash
nanotune data validate --json
```

Accepts the same flags as the interactive command: `--fix`, `--rewrite-context`
and `-e, --eval` all behave identically, including writing their repairs to
disk.

```json
{
  "set": "train",
  "examples": 120,
  "valid": true,
  "errors": [],
  "warnings": ["12 duplicate user inputs found"],
  "checks": {
    "dataFileExists": true,
    "validJsonStructure": true,
    "contextMessageConsistency": true,
    "noDuplicateInputs": false,
    "minimumExampleCount": true
  },
  "fixes": null
}
```

| Field | Type | Notes |
|-------|------|-------|
| `set` | `"train"` \| `"eval"` | Which set was validated; `"eval"` with `--eval` |
| `examples` | number | Example count **after** any fixes were applied |
| `valid` | boolean | False when `errors` is non-empty; drives the exit code |
| `errors[]` | string[] | Problems that make the data untrainable |
| `warnings[]` | string[] | Advisory notes; do not affect `valid` |
| `checks.dataFileExists` | boolean | True when the set holds at least one example |
| `checks.validJsonStructure` | boolean | True when there are no structural errors |
| `checks.contextMessageConsistency` | boolean | True when every example's context message matches `config.json` |
| `checks.noDuplicateInputs` | boolean | True when no two examples share a user input |
| `checks.minimumExampleCount` | boolean | True at 50+ examples. Always true for a validation set, which is a slice of the training data and not subject to the floor |
| `fixes` | object \| null | `null` unless `--fix` or `--rewrite-context` ran |
| `fixes.duplicatesRemoved` | number | Exact-duplicate examples deleted by `--fix` |
| `fixes.contextMessagesRewritten` | number | Examples rewritten by `--rewrite-context` |

`warnings` are human-readable prose and their wording may change. Read `checks`
and `fixes` instead — they are the stable, machine-readable form of the same
findings.

Fail a CI job on invalid data, or on a specific check:

```bash
nanotune data validate --json          # exits 1 when the data is invalid
nanotune data validate --json | jq -e '.checks.contextMessageConsistency'
```

## `nanotune benchmark --json`

```bash
nanotune benchmark --json > run.json
```

Accepts every flag the interactive command does. Prints **exactly the document
written to `.nanotune/benchmarks/benchmark-<timestamp>.json`**, so the stdout
schema and the saved-file schema are the same thing — see
[Benchmarking](benchmarking.md) for what the fields mean.

Progress is written to stderr while the suite runs, since a benchmark can take
minutes:

```
[1/50] list all files
[2/50] show current directory
```

| Field | Type | Notes |
|-------|------|-------|
| `model` | string | Path to the GGUF that was benchmarked |
| `timestamp` | string | ISO 8601 run time |
| `config` | object | `temperature`, `seed` and `samples` the run used |
| `isBase` | boolean | True when `--base` benchmarked the base model as a control |
| `warning` | string \| undefined | Present only on a run that stopped early; see below |
| `summary` | object | Totals, `passRate` (0–1), and average latency, tok/s, TTFT and judge score |
| `categories` | object | `{passed, total}` per category |
| `results[]` | array | Every test, with its response, timings and any judge scores |
| `failures[]` | array | Failed tests only, for quick reference |

### Detecting a partial run

If llama-server dies mid-suite, the run saves what it has rather than throwing
the whole thing away. `summary` then scores against **the tests that actually
ran**, which on its own looks exactly like a complete run with a worse pass
rate. `warning` is what distinguishes them, and it is absent on a complete run:

```bash
nanotune benchmark --json | jq -e 'has("warning") | not'   # fails on a partial run
```

A run where the server died before *any* test completed produces no document at
all: nothing on stdout, the reason on stderr, exit `1`.

### Exit codes

A completed run exits `0` **whatever its pass rate** — there is no configured
threshold, and inventing one would be surprising. Gate on the score yourself:

```bash
nanotune benchmark --json | jq -e '.summary.passRate >= 0.9'
```

## See Also

- [`nanotune status`](../commands/status.md)
- [`nanotune data validate`](../commands/data.md#nanotune-data-validate)
- [`nanotune benchmark`](../commands/benchmark.md)
- [Benchmarking](benchmarking.md) — what the benchmark fields mean
