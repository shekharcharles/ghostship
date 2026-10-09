# Test plan

- Unit tests: one file per module in `tests/unit/`, run by `scripts/unit.mjs`; every task adds its test first (RED), then the code (GREEN).
- Acceptance tests: one file per check in `tests/acceptance/`, run by `scripts/acc.mjs`, locked at STOP 1.
- Lint: `scripts/lint.mjs` runs `node --check` on every module.
