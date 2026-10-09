# Runbook

- Install: none. Copy the folder; Node 18+ is the only requirement.
- Where the data is: the file named by `TODO_FILE`, else `.todo.json` in the working folder.
- A corrupt item file is read as empty; delete it to start over.
- Exit codes: 0 ok, 2 bad usage.
