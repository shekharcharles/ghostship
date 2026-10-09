# Design

`GS` = `node .ghostship/core/runtime/gs.mjs`. Input: the approved `docs/01-requirements/PRD.md`.

Write into `docs/02-design/` (required files depend on the tier; `GS status` lists them):

| file | light | standard | full | contents |
|---|---|---|---|---|
| BLUEPRINT.md | ✓ | ✓ | ✓ | stack and why, folder layout, how to run and test, the commands for `commands.test` / `commands.acceptance` |
| ARCHITECTURE.md | | ✓ | ✓ | components and data flow as Mermaid diagrams (context, container, deployment) |
| THREAT-MODEL.md | | ✓ | ✓ | assets, trust boundaries, STRIDE table, mitigations that become checks |
| API.md | | | ✓ | endpoints or interfaces; OpenAPI file next to it if HTTP |
| DATA-MODEL.md | | | ✓ | entities, relations (Mermaid ER), retention |

Decisions with real alternatives go in `docs/02-design/decisions/ADR-###-slug.md` (context, options, decision, consequences).

guided: ask the owner only about choices that are expensive to reverse (stack, hosting, data store), 3–5 per round, recommendation first. autopilot/full: ask nothing; the PRD is your brief. Decide every choice and record it as an ADR. Everything else, in every mode: decide, and record it as an ADR.

Set the commands with `GS config set commands.test "<cmd>"` (also `commands.acceptance` with `{files}` where the per-check file list goes, `commands.lint`, `commands.typecheck`). Agents never edit `.ghostship/config.yaml` directly; after STOP 1 a command change needs the owner's approval.

Diagrams are code: Mermaid blocks (```mermaid) in these files are drawn in the shipped docs site. An HTTP API gets `docs/02-design/api/openapi.yaml`; the docs site renders it as the API reference.

Commit nothing yourself. `GS next` says `design.write` until the tier's files exist, then `design.done`: `GS design done` also scaffolds the rest of the SDLC docs for the tier (developer guide, test plan, runbook, user handbook, …) with TODO markers to fill during the build. Then `GS next` moves on to `acceptance.md`.
