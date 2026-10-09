# /ghostship solve — a bug (Quick fix)

`GS` = `node .ghostship/core/runtime/gs.mjs`. A bug is a **finding**: wrong behaviour against what is already approved. No checks change.

Quick fix: reproduce → failing test → fix → judge → merge. In autopilot/full you ask the owner nothing along the way; their bug report is the brief.

1. Reproduce it yourself first (read-only: run the app or the tests). Note the exact steps and output.
2. Find where it lives: `GS memory search "<words>"`, the code map, the explorer. Keep the scope small.
3. Write one task draft in `.ghostship/drafts/tasks/T###-fix-….md`:
   ```
   ---
   id: T0NN
   title: Fix <symptom>
   kind: fix
   risk: high            # if it touches auth, money, data loss, secrets
   finding: "<steps → actual vs expected>"
   checks: [C3]          # the check it violates, if one does; else leave out
   allowedPaths: [<smallest set>, <its test file>]
   ---
   ## Goal
   <expected behaviour>
   ```
4. `GS task import`, then `GS next` runs the build loop (`build.md`). The builder's RED is a test that reproduces the bug.
5. If it is not a bug but a change in what the owner wants, it is `/ghostship change`. guided: stop and say so. autopilot/full: `GS ask --kind choose --title "Treat <symptom> as a change?" --option "Yes, open a change" --option "No, it is a bug"` and go on with other work.
6. After the merge: `GS memory add lesson "<what caused it, how to avoid it>"`.
