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

## Viewing Data

```bash
nanotune data list
```

The data list shows a **Turns** column indicating how many user/assistant exchanges each example contains. Press **Enter** on any row to expand/collapse the full conversation.

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
