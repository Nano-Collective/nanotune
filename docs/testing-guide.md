# Nanotune — Testing Guide

> **Repo:** `addyCooks/nanotune` (fork of `Nano-Collective/nanotune`)  
> **Stack:** TypeScript · AVA · Biome · pnpm · Node ≥ 22

---

## Quick-Start

```bash
# 1. Install dependencies (one-time)
pnpm install

# 2. Run every check in one shot
pnpm test:all
```

---

## Test Suite Overview

```mermaid
mindmap
  root((nanotune tests))
    Static Analysis
      test:lint
        Biome check
        Linting & formatting
      test:types
        tsc --noEmit
        Full type safety
      test:knip
        Unused exports
        Dead code detection
    Security
      test:security
        semgrep scan
        macOS / CI only
      test:audit
        pnpm audit
        Dependency CVEs
    Unit Tests
      test:ava
        AVA test runner
        13 spec files
        src/**/*.spec.ts
      test:ava:coverage
        c8 coverage
        80 % line threshold
```

---

## Running Tests — Command Reference

```mermaid
flowchart TD
    A([Developer]) --> B{What do you want?}

    B -->|Quickest check| C[pnpm test:types]
    B -->|Lint only| D[pnpm test:lint]
    B -->|Unit tests only| E[pnpm test:ava]
    B -->|Coverage report| F[pnpm test:ava:coverage]
    B -->|Dead-code check| G[pnpm test:knip]
    B -->|Security scan| H[pnpm test:security]
    B -->|Dep vulnerabilities| I[pnpm test:audit]
    B -->|Everything at once| J[pnpm test:all]

    C --> C1[tsc --noEmit\nFails on type errors]
    D --> D1[biome check .\nFails on lint / format]
    E --> E1[AVA runner\nsrc/**/*.spec.ts]
    F --> F1[c8 + AVA\nLCOV + JSON-summary]
    G --> G1[knip\nNeeds extra RAM on Windows]
    H --> H1[semgrep\nNeeds semgrep CLI]
    I --> I1[pnpm audit\n--audit-level=high]
    J --> J1[Runs lint then types then knip\nthen security then audit then ava]

    style J fill:#6366f1,color:#fff
    style J1 fill:#6366f1,color:#fff
    style G1 fill:#f59e0b,color:#000
    style H1 fill:#f59e0b,color:#000
```

---

## Full `test:all` Pipeline

```mermaid
sequenceDiagram
    actor Dev as Developer
    participant P as pnpm
    participant B as Biome lint
    participant TS as TypeScript
    participant K as Knip
    participant SG as Semgrep
    participant AU as pnpm audit
    participant AV as AVA

    Dev->>P: pnpm test:all

    P->>B: biome check .
    B-->>P: 0 errors

    P->>TS: tsc --noEmit
    TS-->>P: 0 type errors

    P->>K: knip
    K-->>P: no unused exports

    P->>SG: semgrep scan --config auto
    SG-->>P: no findings

    P->>AU: pnpm audit --audit-level=high
    AU-->>P: no vulnerabilities

    P->>AV: ava  src/**/*.spec.ts
    AV-->>P: all tests pass

    P-->>Dev: All checks green
```

---

## Spec Files and What They Test

```mermaid
graph LR
    subgraph Matching
        BM[benchmark-match.spec.ts\n14 tests]
        BM -->|tests| BML[normalizeText\ncheckPass modes:\nexact contains\nstartsWith partial\nsemantic]
    end

    subgraph Benchmarking
        BU[benchmark-utils.spec.ts\n8 tests]
        BS[benchmark.spec.ts\n11 tests]
        BU -->|tests| BUL[buildMessages\ngetTestDisplayPrompt\nformatConversationForJudge]
        BS -->|tests| BSL[BENCHMARK_PRESETS\nlow medium high ultra\nPresetConfig types]
    end

    subgraph Chat
        CH[chat-helpers.spec.ts\n18 tests]
        CH -->|tests| CHL[parseSlashCommand\nbuildServerOptions\nbuildGenerateOptions]
    end

    subgraph MLX
        ML[mlx.spec.ts\n4 tests]
        ML -->|tests| MLL[Output regex parsing\nTrainingProgress\nMLXTrainingOptions]
    end

    subgraph Platform
        PL[platform.spec.ts\n5 tests]
        PL -->|tests| PLL[isSupportedPlatform\nassertSupportedPlatform\nunsupportedPlatformMessage]
    end

    subgraph TTY
        TT[tty.spec.ts\n6 tests]
        TT -->|tests| TTL[supportsRawMode\ninteractiveRequiredMessage]
    end

    subgraph Environment
        EV[env-substitution.spec.ts\n14 tests]
        EV -->|tests| EVL[substituteEnvVars\nbraced unbraced\ndefaults nested objects]
    end

    subgraph Judge
        JT[judge-templates.spec.ts\n9 tests]
        JD[judge.spec.ts\n15 tests]
        JT -->|tests| JTL[PROVIDER_TEMPLATES\nbuildConfig per provider]
        JD -->|tests| JDL[resolveCriteria\nbuildJudgePrompt\nparseJudgeResponse\nsaveJudgeConfig]
    end

    subgraph LlamaCPP
        LC[llama-cpp.spec.ts\n18 tests]
        LC -->|tests| LCL[parseLlamaCppStderr\nparseChatCompletionResponse\nInferenceOptions]
    end

    subgraph Filesystem
        DA[data.spec.ts\n50+ tests]
        CF[config.spec.ts\n15 tests]
        DA -->|tests| DAL[appendToTrainingData\nloadTrainingData\nimportFromCSV JSON JSONL\nsplitTrainValidation]
        CF -->|tests| CFL[ConfigSchema validation\ncreateDefaultConfig\nresolveContextMessage\nfindLatestGGUF]
    end
```

---

## Test Results on This Machine

> Tested on: **Windows 11 · Node v22 · pnpm 11 · repo on OneDrive**

| Spec File | Tests | Status | Notes |
|-----------|------:|--------|-------|
| `benchmark-match.spec.ts` | 14 | ✅ ALL PASS | |
| `benchmark-utils.spec.ts` | 8 | ✅ ALL PASS | |
| `benchmark.spec.ts` | 11 | ✅ ALL PASS | |
| `chat-helpers.spec.ts` | 18 | ✅ ALL PASS | |
| `env-substitution.spec.ts` | 14 | ✅ ALL PASS | |
| `judge-templates.spec.ts` | 9 | ✅ ALL PASS | |
| `llama-cpp.spec.ts` | 18 | ✅ ALL PASS | |
| `mlx.spec.ts` | 4 | ✅ ALL PASS | |
| `platform.spec.ts` | 5 | ✅ ALL PASS | |
| `tty.spec.ts` | 6 | ✅ ALL PASS | |
| `judge.spec.ts` | ~15 | ⚠️ 2 FAIL | Windows: `chmod 0o600` not enforced (by design) |
| `data.spec.ts` | 50+ | ❌ EBUSY | OneDrive locks temp dirs during `rmSync` |
| `config.spec.ts` | ~15 | ❌ EBUSY | OneDrive locks temp dirs during `rmSync` |

**Other checks:**

| Check | Status | Notes |
|-------|--------|-------|
| `test:types` | ✅ PASS | Zero TypeScript errors |
| `test:lint` | ✅ PASS | Fixed 37 CRLF files with `pnpm format` |
| `test:audit` | ✅ PASS | No known vulnerabilities |
| `test:knip` | ❌ OOM | `RangeError: Array buffer allocation failed` — needs extra heap |
| `test:security` | ⚠️ SKIP | semgrep CLI not installed on Windows |

---

## Windows / OneDrive Known Limitations

```mermaid
flowchart TD
    W[Windows + OneDrive] --> E1[EBUSY: rmdir locked]
    W --> E2[Unix chmod 0o600 not enforced]

    E1 --> A1[Affects: data.spec.ts\nconfig.spec.ts]
    E2 --> A2[Affects: judge.spec.ts\n2 saveJudgeConfig tests]

    A1 --> F1[Root cause:\nOneDrive file-sync daemon\nholds a lock on\nprocess.chdir temp dirs]
    A2 --> F2[Root cause:\nWindows NTFS does not\nenforce POSIX permission bits\nchmod is a no-op]

    F1 --> S1[Fix:\nPause OneDrive sync\nOR run from non-OneDrive path\nOR use os.tmpdir in tests]
    F2 --> S2[Fix:\nTests are macOS-only by design\nExpected behaviour on Windows]

    style E1 fill:#ef4444,color:#fff
    style E2 fill:#f59e0b,color:#000
    style S1 fill:#22c55e,color:#fff
    style S2 fill:#6366f1,color:#fff
```

### Quick fix — run only Windows-safe tests

```bash
pnpm ava \
  src/lib/benchmark-match.spec.ts \
  src/lib/benchmark-utils.spec.ts \
  src/lib/benchmark.spec.ts \
  src/lib/chat-helpers.spec.ts \
  src/lib/env-substitution.spec.ts \
  src/lib/judge-templates.spec.ts \
  src/lib/llama-cpp.spec.ts \
  src/lib/mlx.spec.ts \
  src/lib/platform.spec.ts \
  src/lib/tty.spec.ts
```

---

## Coverage Report Workflow

```mermaid
flowchart LR
    A[pnpm test:ava:coverage] --> B[c8 wraps AVA]
    B --> C{Passes 80 percent line threshold?}
    C -->|Yes| D[Coverage OK]
    C -->|No| E[Build fails]
    D --> F[Outputs]
    F --> G[Terminal text summary]
    F --> H[coverage/lcov.info]
    F --> I[coverage/coverage-summary.json]
```

```bash
# Run coverage and generate HTML report
pnpm test:ava:coverage
# Output written to ./coverage/
```

---

## Lint / Format Workflow

```mermaid
sequenceDiagram
    actor D as Developer
    participant BM as Biome
    D->>BM: pnpm test:lint
    BM-->>D: Lists all violations
    D->>BM: pnpm format
    BM-->>D: Auto-fixes formatting and lint
    D->>BM: pnpm test:lint
    BM-->>D: Checked 45 files. No fixes applied.

    Note over D,BM: CRLF to LF fix is automatic on first pnpm format\nHappens when cloning on Windows with git autocrlf
```

---

## Static Analysis Details

```mermaid
flowchart LR
    subgraph Biome["Biome (test:lint)"]
        L1[Formatting\nLF, tabs, 80 cols]
        L2[Linting\nno unused imports\nno unused vars\nnullable warnings]
        L3[Import ordering\norganizeImports on]
    end

    subgraph TypeScript["TypeScript (test:types)"]
        T1[tsc --noEmit\nstrict mode]
        T2[NodeNext modules\nES2022 target]
    end

    subgraph Knip["Knip (test:knip)"]
        K1[Unused exports]
        K2[Dead files]
        K3[Unlisted dependencies]
    end

    src([src/**]) --> Biome
    src --> TypeScript
    src --> Knip
```

> **Knip on Windows:** If you get `RangeError: Array buffer allocation failed`, run:
> ```bash
> node --max-old-space-size=4096 node_modules/.bin/knip
> ```

---

## Security Checks

```mermaid
flowchart TD
    subgraph Audit["pnpm test:audit"]
        AU[pnpm audit --audit-level=high]
        AU --> AUR[No known vulnerabilities]
    end

    subgraph Semgrep["pnpm test:security - macOS / CI"]
        SG[semgrep scan --config auto --error]
        SG --> SGR[Static code security patterns\nOWASP, secrets, injection]
    end

    Note[Semgrep requires the semgrep CLI\nInstall on macOS: brew install semgrep\nOr run in GitHub Actions CI]

    Semgrep -.-> Note
```

---

## CI / GitHub Actions Flow

```mermaid
flowchart TD
    PR([Pull Request or Push]) --> GH[GitHub Actions]

    GH --> J1[Job: Build and Lint]
    GH --> J2[Job: Type Check]
    GH --> J3[Job: Unit Tests + Coverage]
    GH --> J4[Job: Security Audit]
    GH --> J5[Job: Semgrep Scan]

    J1 --> S1[pnpm install\npnpm test:lint]
    J2 --> S2[pnpm test:types]
    J3 --> S3[pnpm test:ava:coverage\nc8 to lcov to upload badge]
    J4 --> S4[pnpm test:audit]
    J5 --> S5[semgrep scan\n--config auto --error]

    S1 & S2 & S3 & S4 & S5 --> PASS{All green?}
    PASS -->|Yes| MERGE[Ready to merge]
    PASS -->|No| BLOCK[PR blocked]

    style MERGE fill:#22c55e,color:#fff
    style BLOCK fill:#ef4444,color:#fff
```

---

## Fork / Remote Workflow

```mermaid
gitGraph
   commit id: "Clone upstream"
   branch feature/my-change
   checkout feature/my-change
   commit id: "Add feature"
   commit id: "Add tests"
   checkout main
   merge feature/my-change id: "PR merged"
   commit id: "Sync from upstream"
```

```bash
# Remotes configured for this fork
git remote -v
# origin    https://github.com/addyCooks/nanotune   (your fork)
# upstream  https://github.com/Nano-Collective/nanotune  (source)

# Keep your fork in sync with upstream
git fetch upstream
git rebase upstream/main
git push origin main
```

---

## Spec File Dependency Map

```mermaid
graph TD
    subgraph Types["src/types/index.ts"]
        TY[ConfigSchema\nBenchmarkPreset\nPresetConfig\nTrainingExample\nMatchMode]
    end

    subgraph Lib["src/lib/"]
        BM[benchmark-match.ts]
        BU[benchmark-utils.ts]
        CH[chat-helpers.ts]
        CF[config.ts]
        DA[data.ts]
        EV[env-substitution.ts]
        JT[judge-templates.ts]
        JD[judge.ts]
        LC[llama-cpp.ts]
        ML[mlx.ts]
        PL[platform.ts]
        TT[tty.ts]
    end

    subgraph Specs["spec files"]
        SM[benchmark-match.spec.ts] --> BM
        SU[benchmark-utils.spec.ts] --> BU
        SB[benchmark.spec.ts] --> TY
        SC[chat-helpers.spec.ts] --> CH
        SF[config.spec.ts] --> CF
        SF --> TY
        SD[data.spec.ts] --> DA
        SD --> TY
        SE[env-substitution.spec.ts] --> EV
        SJT[judge-templates.spec.ts] --> JT
        SJD[judge.spec.ts] --> JD
        SL[llama-cpp.spec.ts] --> LC
        SML[mlx.spec.ts] --> ML
        SP[platform.spec.ts] --> PL
        ST[tty.spec.ts] --> TT
    end
```

---

*Generated by Antigravity · addyCooks/nanotune fork · August 2026*
