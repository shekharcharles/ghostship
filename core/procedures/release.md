# Release — STOP 2

`GS` = `node .ghostship/core/runtime/gs.mjs`. `GS next` walks these steps; this is what each one means.

1. **Docs** (`do`): `GS docs check` must be clean. Fill every doc it lists (a docs task, or yourself for docs-only edits; the candidate commits doc edits for you).
2. **Candidate** (`do`): `GS release candidate`. On `develop`, with a clean tree, it runs the full regression and every acceptance test, works out the next version from the conventional commits since the last tag, writes `docs/10-releases/v<x.y.z>.md` (the release packet, with the parked tasks and the autonomy scorecard) and prepends `docs/10-releases/CHANGELOG.md`.
3. **STOP 2** (`owner`, every mode): show the owner the packet's result line, the checks table, every `pick` row with its reference, every unknown, the decisions on record, every **parked** task (what failed, what waits on it) and the scorecard line. Keep it short; the file has the rest. Then stop. The owner:
   - judges each `pick` row and each unknown;
   - approves in the Bridge pane · terminal `GS release approve` (types `yes`) · chat `GS release approve --quote "<exact words>"`;
   - for a parked task: `GS decide <ID> --grant n` to build it before the release (then a new candidate), or `--drop`.
   A FAIL result releases only with `--override`, and only if the owner says so in words.
4. Approval commits the packet, merges `develop` into `main` (`--no-ff`), tags `v<x.y.z>`, returns to `develop`, and builds the shipped docs: `docs-site/index.html`, `docs-site/explorer.html` and `docs-site/<name>-docs-v<x.y.z>.tar.gz`.
5. `tracker: github|both` → `GS github sync` (pushes main, develop and the tag, creates the GitHub release with the packet and the docs archive).
6. `GS memory add memory "<what shipped, what was deferred>"`.

If the code changes after the candidate, `GS next` asks for a new one; the old one is refused.
