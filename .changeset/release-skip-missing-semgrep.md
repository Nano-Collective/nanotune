---
---

Release tooling only: `test:all` skips the Semgrep scan when Semgrep isn't installed, as the other Nano Collective repos do, so the shared release workflow can run it. PR checks still run Semgrep.
