---
title: "Installation"
description: "System requirements and installation methods for Nanotune"
sidebar_order: 1
---

# Installation

## Requirements

- macOS with Apple Silicon (M1/M2/M3/M4)
- Node.js 18+
- Python 3.10+
- 8GB RAM minimum (16GB recommended)

> **Note:** Nanotune uses MLX for training and llama.cpp for export, both of which require Apple Silicon. Intel Macs are not supported.

## Install via npm

Install globally:

```bash
npm install -g @nanocollective/nanotune
```

Then run commands directly:

```bash
nanotune init
```

## Run with npx

If you prefer not to install globally, use npx to run Nanotune directly:

```bash
npx @nanocollective/nanotune init
```

This downloads and runs the latest version each time.

## Verify Installation

Check that Nanotune is installed and working:

```bash
nanotune --version
```

## Next Steps

Once installed, follow the [Quick Start](quick-start.md) guide to create your first project.
