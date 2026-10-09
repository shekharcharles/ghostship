# /ghostship add — a new feature after the checks were approved

`GS` = `node .ghostship/core/runtime/gs.mjs`. New work always enters through the owner's approval: nothing is built from an unapproved idea.

1. **Is it new requirements, or only new checks?**
   - New behaviour the PRD does not describe → scope `prd`.
   - The PRD already covers it, only checks are missing → scope `acceptance`.
2. Interview the owner briefly (3–5 questions, recommendation first) about the addition only.
3. Open the change (the owner approves reopening): terminal `GS change open --scope <s> --reason "<one line>"`; chat `… --quote "<their words>"`.
4. Scope `prd`: edit `docs/01-requirements/PRD.draft.md` (add a `## <feature>` section), mark any interview areas it touches, then `new.md` step 4 (approval) → `design.md` (update only what changes) → the checks reopen automatically.
5. Checks: edit `docs/03-acceptance/ACCEPTANCE-CHECKS.draft.md` — **append** new checks with new ids (never reuse an id); keep existing rows unchanged. `GS acceptance lint`, then STOP 1 as in `acceptance.md`. Unchanged checks keep their locked tests and merged tasks.
6. `plan.md` for the new checks only: drafts for them, `GS task import`, write `tests/acceptance/C<n>-*` for each new run check, `GS acceptance lock` (it proves only the new tests fail, and that no locked test was touched).
7. From here `GS next` runs the rest (`build.md`, then `release.md`). `GS change status` shows the change until the lock closes it. Once the owner has approved the reopened checks, autopilot/full run on without questions.
