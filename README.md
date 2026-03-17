# Nanotune

A simple, interactive CLI for fine-tuning small language models on Apple Silicon — built by the [Nano Collective](https://github.com/Nano-Collective), a community collective building AI tooling not for profit, but for the community. Everything we build is open, transparent, and driven by the people who use it. AI done right.

No YAML configs, no complex flags — just an interactive TUI that guides you through each step. Nanotune handles the MLX and llama.cpp tooling for you automatically.

![Example](./.github/assets/example.gif)

---
![Build Status](https://github.com/Nano-Collective/nanotune/raw/main/badges/build.svg)
![Coverage](https://github.com/Nano-Collective/nanotune/raw/main/badges/coverage.svg)
![Version](https://github.com/Nano-Collective/nanotune/raw/main/badges/npm-version.svg)
![NPM Downloads](https://github.com/Nano-Collective/nanotune/raw/main/badges/npm-downloads-monthly.svg)
![NPM License](https://github.com/Nano-Collective/nanotune/raw/main/badges/npm-license.svg)
![Repo Size](https://github.com/Nano-Collective/nanotune/raw/main/badges/repo-size.svg)
![Stars](https://github.com/Nano-Collective/nanotune/raw/main/badges/stars.svg)
![Forks](https://github.com/Nano-Collective/nanotune/raw/main/badges/forks.svg)

## Quick Start

```bash
npm install -g @nanocollective/nanotune
nanotune init
nanotune data add
nanotune train
nanotune export
nanotune benchmark
```

Or run directly with npx:

```bash
npx @nanocollective/nanotune init
```

## Documentation

Full documentation is available online at **[docs.nanocollective.org](https://docs.nanocollective.org/nanotune/docs)** or in the [docs/](docs/) folder:

- **[Getting Started](docs/getting-started/index.md)** — Installation, requirements, and your first project
- **[Commands](docs/commands/index.md)** — Full reference for all CLI commands
- **[Guides](docs/guides/index.md)** — Training data, benchmarking, LLM judge, and tuning tips
- **[Configuration](docs/configuration/index.md)** — Project config, recommended models, and judge setup
- **[Community](docs/community.md)** — Contributing, Discord, and how to help

## Community

The Nano Collective is a community collective building AI tooling for the community, not for profit. We'd love your help!

- **Contributing**: See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines
- **Discord**: [Join our server](https://discord.gg/ktPDV6rekE) to connect with other users and contributors
- **GitHub**: Open issues or join discussions on our repository
