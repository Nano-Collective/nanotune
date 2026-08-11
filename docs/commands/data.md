---
title: "nanotune data"
description: "Add, edit, import, export, list, and validate training data"
sidebar_order: 2
---

# nanotune data

Manage your training data. This command group includes subcommands for adding, editing, importing, exporting, listing, and validating examples.

## nanotune data add

```bash
nanotune data add
```

Interactively add training examples. Each example starts with a user input and expected output.

The interactive flow supports multi-turn conversations:

1. Enter a user input and expected output
2. After each turn, you're prompted: **Add another turn? (y/n)**
3. Press **y** to add more turns to the same conversation
4. Press **n** to save the example and start a new one
5. Press **Esc** to auto-save any accumulated turns and exit

Accumulated turns are shown above the input fields as you build the conversation.

## nanotune data import

```bash
nanotune data import <file>
```

Import training data from a file. The importer auto-detects format based on file extension and content.

**Supported formats:**

| Format | Extension | Description |
|--------|-----------|-------------|
| JSONL | `.jsonl` | Chat format with messages array (recommended) |
| CSV | `.csv` | Simple input/output columns |
| JSON | `.json` | Array of examples |

Multi-turn examples in JSONL and JSON files are preserved with all their turns intact.

**Options:**

| Flag | Description |
|------|-------------|
| `-y, --yes` | Skip the confirmation prompt |

By default the importer previews your existing data and asks for confirmation. Pass `--yes` to import without prompting — this is also what lets `data import` run in a script or CI job, where there is no terminal to answer the prompt.

```bash
nanotune data import examples.jsonl --yes
```

See the [Training Data](../guides/training-data.md) guide for format details and examples.

## nanotune data export

```bash
nanotune data export <file>
```

Export training data to a file. Uses the same formats as `data import`, selected by the output file's extension:

| Format | Extension | Description |
|--------|-----------|-------------|
| JSONL | `.jsonl` | Chat format with messages array (recommended) |
| CSV | `.csv` | Simple input/output columns |
| JSON | `.json` | Array of examples |

**Options:**

| Flag | Description |
|------|-------------|
| `-y, --yes` | Skip the overwrite confirmation prompt |

JSONL and JSON exports preserve every example exactly, including multi-turn conversations and per-example context messages — feeding the output back into `data import` reproduces the original data. **CSV has no way to represent multi-turn examples**, so any example with more than one turn is skipped (not truncated) during a CSV export, and reported in the summary.

If the target file already exists, you're asked to confirm before it's overwritten. Pass `--yes` to skip the prompt — this is also what lets `data export` run in a script or CI job.

```bash
nanotune data export backup.jsonl --yes
```

## nanotune data list

```bash
nanotune data list
```

View and manage your training data with pagination, editing, and delete. Shows a **Turns** column indicating how many user/assistant exchanges each example contains.

| Key | Action |
|-----|--------|
| Up/Down | Navigate rows |
| Left/Right | Change page |
| Enter | Expand/collapse the full conversation |
| e | Edit the selected example |
| d | Delete the selected example |
| q | Quit |

Editing reuses the same input flow as `data add`, but only covers the example's **first** user/assistant turn — any additional turns and the example's context message are preserved unchanged. Press **Tab** to switch between the input and output fields, **Enter** to submit a field, and **Esc** to cancel without saving.

## nanotune data validate

```bash
nanotune data validate
```

Validate your training data before training. Checks for:

- Valid JSON structure
- Required fields present
- No duplicate examples
- Context message consistency
- Minimum example count
- Consecutive same-role messages (broken turn alternation)

**Options:**

| Flag | Description |
|------|-------------|
| `--fix` | Remove exact-duplicate examples (identical messages, not just matching input text) |
| `--rewrite-context` | Rewrite each example's context message to match the current config |

`--fix` is intentionally stricter than the "duplicate user inputs" warning above: the warning flags examples that merely share the same input text (worth a human look, since the outputs or context could differ on purpose), while `--fix` only ever removes examples whose entire message list is identical — the only case where deleting one is provably safe. `--rewrite-context` only touches examples that already have a context/system message; it never inserts one where an example starts directly with a user message. Both flags report exactly how many examples they changed, and can be combined:

```bash
nanotune data validate --fix --rewrite-context
```

## See Also

- [Training Data](../guides/training-data.md) — Formats, multi-turn examples, and best practices
