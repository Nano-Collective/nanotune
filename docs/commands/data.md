---
title: "nanotune data"
description: "Add, import, list, and validate training data"
sidebar_order: 2
---

# nanotune data

Manage your training data. This command group includes subcommands for adding, importing, listing, and validating examples.

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

See the [Training Data](../guides/training-data.md) guide for format details and examples.

## nanotune data list

```bash
nanotune data list
```

View and manage your training data with pagination and delete. Shows a **Turns** column indicating how many user/assistant exchanges each example contains. Press **Enter** on any row to expand/collapse the full conversation.

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

## See Also

- [Training Data](../guides/training-data.md) — Formats, multi-turn examples, and best practices
