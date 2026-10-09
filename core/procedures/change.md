# /ghostship change — change something already approved

`GS` = `node .ghostship/core/runtime/gs.mjs`.

1. Say back to the owner, in ≤5 lines: what changes, which checks it affects (`docs/01-requirements/TRACEABILITY.md`), what already-merged work becomes stale. Recommend the smallest change.
2. Open it with their approval: `GS change open --scope prd|acceptance --reason "<one line>"` (chat: `--quote`).
3. Edit the draft the command names.
   - A changed check keeps its id; its locked tests unlock, and the merged tasks that proved the old wording no longer cover it.
   - A removed check is retired: delete its `tests/acceptance/C<n>-*` files.
   - Never rewrite unchanged rows.
4. Approve (STOP 1 again; `--auto` in full). From there `GS next` runs it: tasks for the changed checks, their acceptance tests rewritten, `GS acceptance lock`, build, release. After the approval, autopilot/full ask nothing more until STOP 2.

Ghostship refuses to reopen while a task is active, an outside run is going, or a release waits for STOP 2. Finish those first.
