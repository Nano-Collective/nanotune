# Contributing to Nanotune

Thank you for your interest in contributing to Nanotune! We welcome contributions from developers of all skill levels. This guide will help you get started with contributing to the project.

## Table of Contents

- [Getting Started](#getting-started)
- [How to Contribute](#how-to-contribute)
- [Development Setup](#development-setup)
- [Testing](#testing)
- [Coding Standards](#coding-standards)
- [Community and Communication](#community-and-communication)

## Getting Started

Before contributing, please:

1. Read our [README](README.md) to understand what Nanotune does
2. Check our [issue tracker](https://github.com/Nano-Collective/nanotune/issues) for existing issues

## How to Contribute

### Finding Work

Browse our open issues. If you find an unassigned issue you'd like to work on, comment on it to let us know you're picking it up.

### Working on an Issue

1. **Check for a spec** - Some issues include a specification or implementation details. Feel free to follow it or propose alternatives if you think you have a better approach.

2. **No spec? Write one** - If the issue lacks a spec, draft one and post it in the issue comments for discussion before starting work.

3. **Submit a PR** - When ready, open a pull request referencing the issue. We'll review it and work with you to get it merged.

## Development Setup

### Prerequisites

- macOS with Apple Silicon (M1/M2/M3/M4)
- Node.js 18+
- Python 3.10+
- pnpm

### Setup Steps

1. **Fork and clone the repository:**

   ```bash
   git clone https://github.com/YOUR-USERNAME/nanotune.git
   cd nanotune
   ```

2. **Install dependencies:**

   ```bash
   pnpm install
   ```

3. **Build the project:**

   ```bash
   pnpm build
   ```

4. **Run in development mode:**

   ```bash
   pnpm dev
   ```

### Recommended Editor Setup

For the best development experience, we recommend using VS Code with the **Biome extension** for automatic formatting and linting:

1. **Install Biome VS Code Extension:**
   - Open VS Code and go to Extensions (Cmd+Shift+X)
   - Search for "Biome" and install the official extension
   - Or install from the command line:
   ```bash
   code --install-extension biomejs.biome
   ```

2. **Configure VS Code settings** (optional, for format on save):
   Add to your `.vscode/settings.json`:
   ```json
   {
     "editor.defaultFormatter": "biomejs.biome",
     "editor.formatOnSave": true,
     "editor.codeActionsOnSave": {
       "quickfix.biome": "explicit",
       "source.organizeImports.biome": "explicit"
     }
   }
   ```

## Testing

### Running Tests

Execute the full test suite with:

```bash
pnpm test:all
```

This runs formatting checks, type checks, and tests.

### Test Requirements for PRs

- New features should include passing tests
- Bug fixes should include regression tests when possible
- All tests must pass before merging

### Manual Testing

When testing Nanotune functionality:

1. **Test the full workflow:**
   - `nanotune init` - Project initialization
   - `nanotune data add/import` - Data management
   - `nanotune train` - Training with MLX
   - `nanotune export` - GGUF export
   - `nanotune benchmark` - Benchmark evaluation

2. **Test with different models:**
   - Try various HuggingFace model sizes (0.5B, 1.5B)
   - Test different quantization options

3. **Test error scenarios:**
   - Invalid model names
   - Missing training data
   - Network failures during model download

## Coding Standards

### TypeScript Guidelines

- **Strict Mode**: The project uses strict TypeScript settings
- **Types First**: Always define proper TypeScript types
- **No `any`**: Avoid using `any` type; use proper type definitions
- **ESNext**: Use modern JavaScript/TypeScript features

### Code Style

- **Formatting**: Run `pnpm format` before committing
- **Naming**: Use descriptive variable and function names
- **Comments**: Add comments for complex logic, not obvious code
- **Error Handling**: Always handle errors gracefully

### React Ink Guidelines

- Keep components focused and small
- Use hooks for state management
- Handle terminal resize and cleanup properly

## Community and Communication

### Getting Help

- **GitHub Issues**: For bugs, features, and questions
- **Discord Server**: Join our community Discord for real-time discussions, help, and collaboration: [Join our Discord server](https://discord.gg/ktPDV6rekE)

### Code of Conduct

- Be respectful and inclusive
- Focus on constructive feedback
- Help create a welcoming environment for all contributors
- Remember that everyone is learning and contributing voluntarily

### Recognition

All contributors are recognized in the project. We appreciate:

- Code contributions
- Bug reports and testing
- Documentation improvements
- Feature suggestions and feedback
- Community support and discussions

---

Thank you for contributing to Nanotune! Your efforts help make fine-tuning small language models more accessible for everyone.
