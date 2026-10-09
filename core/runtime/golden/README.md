# The golden path

A real to-do CLI that Ghostship takes from `gs init` to a tagged `v0.1.0`, doing only what `gs next` says.

- `todo-cli/` — the fixture: the PRD, blueprint and acceptance checks the orchestrator would write, the task drafts the
  planner would write, the acceptance tests, and under `solutions/<task>/` what each builder produces (`tests/` before
  RED, `code/` after).
- `drive.mjs` — the driver: a loop over `next()` with one handler per step id and scripted stand-ins for the owner,
  the builder, the judge and the planner. A step with no handler fails the run by name: the driver never guesses.
- `../test/golden-path.test.mjs` — runs it in autopilot and in full and asserts: the owner is asked only at the PRD,
  STOP 1 (autopilot) and STOP 2; nothing parked; every task merged; the release tagged; the audit clean; the product
  works; the scorecard shows zero questions after the PRD. Seconds, no model.
- `run-live.mjs` — the same project with the real headless autopilot runner and `claude -p` builders and judges.
  Needs a Claude login; takes minutes. `node core/runtime/golden/run-live.mjs --mode autopilot [--keep]`.
