# Blueprint — todo

Plain Node, no dependencies. `bin/todo.mjs` parses the command line and calls one function per command in `src/commands.mjs`; `src/store.mjs` reads and writes the JSON file named by `TODO_FILE`.

## Folder layout
- `bin/todo.mjs` — the entry point
- `src/store.mjs` — load/save of the item list
- `src/commands.mjs` — add, list, done, clear
- `tests/unit/` — one test file per module, run by `scripts/unit.mjs`
- `tests/acceptance/` — one file per check, run by `scripts/acc.mjs`

## How to test
`node scripts/unit.mjs` runs the unit tests; `node scripts/acc.mjs <files>` runs acceptance files; `node scripts/lint.mjs` syntax-checks every module.
