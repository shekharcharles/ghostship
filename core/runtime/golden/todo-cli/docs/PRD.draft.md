# PRD — todo

A to-do list you keep from the terminal: one JSON file, four commands, no accounts.

## Add
`todo add "<text>"` stores a new item and confirms it: `added: <text>`.

## List
`todo list` prints every item, numbered from 1, with `[ ]` for open and `[x]` for done. With no items it prints `nothing to do`.

## Done
`todo done <n>` marks item n done and confirms it: `done: <text>`.

## Clear
`todo clear` removes every item and prints `cleared`.

## Operations
Items live in the file named by `TODO_FILE` (default `.todo.json` in the current folder). Plain Node 18+, no dependencies.
