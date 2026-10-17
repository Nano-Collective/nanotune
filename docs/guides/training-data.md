---
title: "Training Data"
description: "Supported formats, importing, multi-turn examples, and data quality tips for Nanotune"
sidebar_order: 1
---

# Training Data

Nanotune supports multiple formats for training data. You can add examples interactively or import them from files. Examples can be single-turn (one user/assistant exchange) or multi-turn conversations.

## Supported Formats

### JSONL (Recommended)

One JSON object per line using the chat messages format:

```jsonl
{"messages":[{"role":"system","content":"You are helpful."},{"role":"user","content":"Hello"},{"role":"assistant","content":"Hi!"}]}
{"messages":[{"role":"system","content":"You are helpful."},{"role":"user","content":"Goodbye"},{"role":"assistant","content":"Bye!"}]}
```

Multi-turn conversations are supported — include multiple user/assistant exchanges:

```jsonl
{"messages":[{"role":"system","content":"You are helpful."},{"role":"user","content":"What is Python?"},{"role":"assistant","content":"A programming language."},{"role":"user","content":"Show me hello world"},{"role":"assistant","content":"print('Hello, world!')"}]}
```

The first message role is flexible — it can be `system`, `developer`, or any role your model expects. Nanotune stores this as the "context message" and applies it consistently across all training examples.

> **Note:** When importing multi-turn JSONL (more than 3 messages), the full conversation is preserved as-is. Single-turn examples (3 messages or fewer) have their context message replaced with your project's configured context message.

### CSV

Simple two-column format (single-turn only):

```csv
input,output
"list all files","ls -la"
"show disk usage","df -h"
```

An optional third column carries the categories described below. Separate
multiple tags with `;`, not `,` — a comma is the column delimiter here.

```csv
input,output,tags
"list all files","ls -la",shell;files
"show disk usage","df -h",shell;system
```

A tag that itself contains a `;` cannot survive this format: the column is one
cell joined on `;` and read back by splitting on `;`, and the quotes that would
otherwise protect the character are stripped by the CSV parser before the tags
are split. `nanotune data export` leaves such a tag out of the column and names
it in the summary rather than splitting it into two categories that never
existed; the example itself is still exported. JSONL and JSON have no such
limit — use one of those if your tags contain `;`.

### JSON

Array of objects with input/output pairs or messages format:

```json
[
  {"input": "list all files", "output": "ls -la"},
  {
    "messages": [
      {"role": "system", "content": "You are helpful."},
      {"role": "user", "content": "What is Python?"},
      {"role": "assistant", "content": "A programming language."},
      {"role": "user", "content": "Show me hello world"},
      {"role": "assistant", "content": "print('Hello, world!')"}
    ]
  }
]
```

## Categories

Any format can carry an optional `tags` array. Nanotune uses it to split
train and validation by category, so a rare topic is not silently missing from
the evaluation set.

```jsonl
{"messages":[{"role":"user","content":"How do I reverse a list?"},{"role":"assistant","content":"Use list[::-1]."}],"tags":["python"]}
{"messages":[{"role":"user","content":"df -h?"},{"role":"assistant","content":"Shows disk usage."}],"tags":["shell"]}
```

The first tag is the category the example counts under, so an example lands in
exactly one bucket. Tag names are matched case- and whitespace-insensitively:
`Math`, `math` and `  math  ` are one category. Anything Nanotune cannot use —
a blank string, a number where a string belongs, a tag over 64 characters — is
dropped rather than being allowed to break a split.

Without tags, the split is exactly what it always was. Datasets written before
this feature need no changes and produce identical splits for the same seed.

## Adding Data Interactively

```bash
nanotune data add
```

The interactive flow supports building multi-turn conversations:

1. Enter a user input and expected output
2. After each turn, you're prompted: **Add another turn? (y/n)**
3. Press **y** to add more turns to the same conversation
4. Press **n** to save the example and start a new one
5. Press **Esc** to auto-save any accumulated turns and exit

Accumulated turns are shown above the input fields as you build the conversation.

## Importing Data

```bash
nanotune data import examples.jsonl
```

The importer auto-detects format based on file extension and content. Multi-turn examples in JSONL and JSON files are preserved with all their turns intact.

## Exporting Data

```bash
nanotune data export backup.jsonl
```

Writes your training data back out in the same formats `data import` accepts (JSONL, CSV, or JSON — selected by the output file's extension). JSONL and JSON exports round-trip exactly, including multi-turn examples and per-example context messages. **CSV can only represent a single input/output pair per example**, so multi-turn examples are skipped (not truncated) during a CSV export and called out in the summary — export to JSONL or JSON instead if you need every example preserved. A tag containing `;` is also left out of a CSV tags column and named in the summary, for the same reason; JSONL and JSON carry it.

## Viewing and Editing Data

```bash
nanotune data list
```

The data list shows a **Turns** column indicating how many user/assistant exchanges each example contains. Press **Enter** on any row to expand/collapse the full conversation, **e** to edit it, or **d** to delete it.

Editing reuses the `data add` input flow, but only the example's first user/assistant turn is editable — additional turns and the context message are preserved unchanged.

## Validating Data

Before training, validate your data:

```bash
nanotune data validate
```

This checks for:

- Valid JSON structure
- Required fields present
- No duplicate examples
- Context message consistency
- Minimum example count
- Consecutive same-role messages (broken turn alternation)

Pass `--fix` to remove exact-duplicate examples (identical messages, not just matching input text), or `--rewrite-context` to rewrite mismatched context messages to match your current config:

```bash
nanotune data validate --fix --rewrite-context
```

## Tips

### Quantity

For 0.5B–1.5B models, 100–500 quality examples typically work well.

### Quality

- Keep context messages consistent across examples
- Make sure outputs match what you want the model to produce
- Include variations of similar prompts
- For multi-turn examples, ensure roles alternate correctly (user, assistant, user, assistant...)

### Multi-Turn Conversations

Multi-turn examples teach the model to maintain context across a conversation. Use them when:

- The model needs to handle follow-up questions
- Responses depend on earlier context
- You're building a chat application with back-and-forth dialogue

### Variety

Cover edge cases and different phrasings of the same intent. If users might ask "list files" or "show me what's in this folder," include both.

## Iterative Improvement

Use benchmark results to identify gaps in your training data:

1. Run `nanotune benchmark`
2. Review the markdown report for failed tests
3. Add examples that address the failures
4. Re-train and benchmark again
