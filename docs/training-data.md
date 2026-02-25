# Training Data

Nanotune supports multiple formats for training data. You can add examples interactively or import them from files.

## Supported Formats

### JSONL (Recommended)

One JSON object per line using the chat messages format:

```jsonl
{"messages":[{"role":"system","content":"You are helpful."},{"role":"user","content":"Hello"},{"role":"assistant","content":"Hi!"}]}
{"messages":[{"role":"system","content":"You are helpful."},{"role":"user","content":"Goodbye"},{"role":"assistant","content":"Bye!"}]}
```

### CSV

Simple two-column format with input and output:

```csv
input,output
"list all files","ls -la"
"show disk usage","df -h"
```

### JSON

Array of objects with input/output pairs:

```json
[
  {"input": "list all files", "output": "ls -la"},
  {"input": "show disk usage", "output": "df -h"}
]
```

## Importing Data

```bash
nanotune data import examples.jsonl
```

The importer auto-detects format based on file extension and content.

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

## Tips

### Quantity

For 0.5B–1.5B models, 100–500 quality examples typically work well.

### Quality

- Keep context messages consistent across examples
- Make sure outputs match what you want the model to produce
- Include variations of similar prompts

### Variety

Cover edge cases and different phrasings of the same intent. If users might ask "list files" or "show me what's in this folder," include both.

## Iterative Improvement

Use benchmark results to identify gaps in your training data:

1. Run `nanotune benchmark`
2. Review the markdown report for failed tests
3. Add examples that address the failures
4. Re-train and benchmark again
