# Developer guide

## Set up
Node 18 or later. No install step and no secrets: `git clone`, then run.

## Run it
`node bin/todo.mjs <command>`. Items go to the file named by `TODO_FILE` (default `.todo.json`).

## Test it
`node scripts/unit.mjs` runs the unit tests in `tests/unit/`; `node scripts/acc.mjs tests/acceptance/C1-add.test.mjs` runs one acceptance check; `node scripts/lint.mjs` syntax-checks every module.
