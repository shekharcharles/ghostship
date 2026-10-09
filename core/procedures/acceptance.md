# Acceptance checks — STOP 1

`GS` = `node .ghostship/core/runtime/gs.mjs`. This is the first of the two times the owner must stop and decide. `GS next` says `acceptance.write` until the draft exists, `acceptance.lint` until it is clean, then the gate.

## 1. Draft
Write `docs/03-acceptance/ACCEPTANCE-CHECKS.draft.md`:

```markdown
# Acceptance checks — <project>

## Rules for the judge
1. Grade only the checks below. Binary: PASS or FAIL with one line of reason.
2. Anything listed in "Out of scope" that gets built is a FAIL.

## Destination
<one sentence: what the owner can do when this is done>

## Checks
| # | check | kind | proven by | reference | source |
|---|---|---|---|---|---|
| C1 | <one observable outcome, with a number> | run | tests/acceptance/C1-* | - | PRD#<feature> |
| C2 | <a look-and-feel outcome> | pick | owner compares | mocks/x.png | PRD#<feature> |

## Out of scope
1. <thing> — <why / later>

## Unknowns
- U1: <question> — owner: <who decides>, by: YYYY-MM-DD, blocks: C2
```

- `run` = a machine proves it; `pick` = the owner judges it against a reference.
- One outcome per check (the linter rejects "and"). Every check cites the PRD section it comes from.
- Every PRD feature is covered by at least one check, or listed in Out of scope.
- No unknowns? Write `None identified — <why>`.

## 2. Lint until clean
`GS acceptance lint` (`GS next` asks for it while errors remain). Fix every error. Do not show the owner a draft that fails lint.

## 3. STOP 1
`GS next` says which:
- **full** (`do`): `GS acceptance approve --auto` approves by policy once lint is clean. Show the table in one message and go on.
- **autopilot / guided** (`owner`): show the checks table, out of scope and unknowns, then stop for the owner. In **chat** mode (the default) they approve in chat and you run `GS acceptance approve --quote "<their exact words>"`; in bridge/terminal mode they press it in the Bridge pane (`/gs-bridge`) or run `GS acceptance approve` and type `yes`. Surface the gate wherever the owner is; never approve it yourself. Ask nothing else.
After approval the file is locked. Changing it later is `/ghostship change`.

Then `GS next` moves on to `plan.md`.
