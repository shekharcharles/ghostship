# CI/CD
<!-- ghostship:todo — replace every line marked TODO, then delete this comment -->

## Pipeline
`.github/workflows/ghostship.yml` (from `gs ci init`) runs the tests, the acceptance tests and `gs audit` on every push.

## Branches
`task/*` → `develop` (squash, one conventional commit per task) → `main` at each release (tagged `vX.Y.Z`).

## Deploy
TODO: what deploys, from which branch or tag, and how to roll back.
