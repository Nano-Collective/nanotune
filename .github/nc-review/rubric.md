# nc-review rubric — Nanotune

This is the **project** half of the rubric: what Nanotune cares about. The
reviewing method — how to read a diff against a base checkout, how to rate
severity, what to emit — is the shared base rubric you were also given. Read
both; where they disagree, this file wins.

## What this project is, and why that changes review

Nanotune is an interactive Ink TUI that wraps **MLX** for LoRA training and
**llama.cpp** for GGUF conversion, quantization and inference. `AGENTS.md` is the
architecture document and is authoritative.

Two things follow from that and shape almost every review here:

**It drives long, expensive, irreversible work.** A training run costs a user
hours of their machine. A bug that corrupts a dataset, loses a checkpoint, or
crashes at minute 90 does not cost a retry — it costs the run. Weigh data-loss
and late-crash risks harder than you would in a library.

**It is macOS on Apple Silicon only, and CI is not.** MLX has no fallback and
only `macos-arm64` llama.cpp binaries ship. So the paths that matter most are
the ones CI cannot execute, and "the tests pass" says correspondingly less here.
When a diff touches the MLX or llama.cpp boundary, read it as though nothing
downstream will catch a mistake — because nothing will.

## Where the bugs actually are

Every one of these has been fixed here. Check them first.

### Dataset writes

The dataset is the user's work. Bugs found in this area already: orphaned
`.temp` files left behind by a crashed atomic write, a `validate` pass applying
its fixes more than once per invocation, and write helpers that could omit
`isEval` and silently mislabel a row.

Any diff that writes `train.jsonl` or touches the atomic-write path should be
read for: what happens if the process dies between write and rename, whether the
operation is idempotent, and whether every helper that writes a row is forced to
say which split it belongs to.

### Subprocess boundaries

MLX and llama.cpp are spawned. Review those call sites for arguments built by
string concatenation from user input, missing timeouts, and exit codes that are
not checked. An LLM-judge call went out unbounded until `--timeout` was added.

### Secrets and environment expansion

Env-var substitution once corrupted literal API keys by expanding something that
should have been passed through. Treat any change to `env-substitution` or to
how provider keys are read as security-relevant, and check the case where the
value itself contains `$`.

### Crashing the render

Malformed `config.json` or `train.jsonl` used to take the Ink render down rather
than being reported. A TUI that dies on bad input gives the user a stack trace
where an error message belongs. Prefer a rendered error, and flag changes that
let a parse failure escape into a component.

### Ink and the event loop

React here is Ink, not a browser: no DOM, no bundler. Synchronous work in a
component blocks the terminal, and writing to stdout directly corrupts the
render. Neither shows up in a unit test.

### Numeric flags

Unparseable numeric flags were accepted and became `NaN` downstream. Flag
parsing that does not reject bad input is a finding.

## Public contracts

Breaking these is `blocking` without a changeset and a deliberate bump:

- **The dataset format** — `train.jsonl` rows and the `isEval` split. Existing
  projects on disk must keep working.
- **`.nanotune/` project layout** and `config.json`'s schema.
- **CLI commands and flags** across `init`, `data`, `train`, `export`,
  `benchmark`, `judge`, `chat`, `status`.
- **Exported types** in `src/types/`.

## Tests

Tests are colocated as `src/**/*.spec.ts` and `*.spec.tsx`.

**Coverage here is 71.6% against the collective's 80% bar**, and the caller
workflow pins the floor at 71 with fail-on-drop while the gap closes. Two
consequences for review:

- New code arriving without tests makes the gap worse, and the pin means it
  cannot be repaid by someone else later without effort. Ask for tests on new
  logic even when the overall gate is green.
- A pinned floor is temporary, not the standard. Do not cite 71 as the bar.

Judge whether a test would actually fail if the behaviour regressed. Given how
much of this codebase cannot run in CI, a test that only asserts a function was
called is close to worthless here.

## Scope

Contributions cluster in `src/lib` because that is the part that runs anywhere.
That is fine. But a fix in `lib` for a problem that really lives at the MLX or
llama.cpp boundary is treating the symptom — say so when you see it.
