# Plan

`GS` = `node .ghostship/core/runtime/gs.mjs`. `GS next` walks these steps; this is what each one means.

1. **Planner** (`agent`, role planner): `GS route --role planner`. In-session → Agent tool, `subagent_type: ghostship-planner`, brief "Plan from the approved acceptance checks. Drafts go to `.ghostship/drafts/tasks/`." Headless or tab → `GS dispatch --role planner`, then `GS run wait`.
   A task that only sets the project up (runners, scaffold, a fake server for tests) is a **setup task**: `skeleton: true` (one, first) or `kind: setup`. It needs no failing test first; build, lint and tests must pass.
2. **Import** (`do`): `GS task import` validates every draft (ids, checks, allowedPaths, blockers, cycles) and writes `tasks/T###-slug.md` and `tasks/BOARD.md`. Refused → send the error to the planner and import again. It reports run checks with no task yet: plan for them before building.
3. **Skeleton first**: `GS next` starts the skeleton task before the lock when the runners do not exist yet (`build.md`).
4. **Acceptance tests** (`do`, acceptance.tests): one per `run` check, `tests/acceptance/C<n>-<slug>.<ext>`, each calling the product through its public surface (HTTP, CLI, UI driver, public API) and asserting exactly the check. Many? A builder subagent with allowedPaths `tests/acceptance/**`; it records no evidence for this.
5. **Lock** (`do`): `GS acceptance lock` runs every acceptance test, requires each to FAIL now, locks the files and commits them. A test that already passes tests nothing: rewrite it.

Then `GS next` moves into the build loop. In autopilot/full go straight on, without checking in with the owner.
