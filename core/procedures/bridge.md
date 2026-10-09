# /ghostship bridge — where the project stands

1. `node .ghostship/core/runtime/gs.mjs status --json`, `… next --json`, `… audit`, `… spend`, `… run status` and `… autopilot status`.
2. Answer in one table, then at most 3 lines:

| item | value |
|---|---|
| stage | … |
| active task | id, status, attempt n/m |
| outside run | agent, role, status (or none) |
| tasks | merged / total, retrying, needing your decision |
| next step | `gs next`: the step, and whether it is yours (`owner`) or Ghostship's |
| autopilot runner | running (its current step) · waiting for you · stopped · none |
| spend | Claude $, gateway tokens, outside minutes |
| last release | tag and date, or none |
| audit | OK, or the first problem |

3. If something needs the owner's decision, say exactly what and what you recommend.
4. Add a line for anything waiting in the owner queue (`GS asks`), the Claude plan's 5h/7d use (`GS limits`) and, after a release, the scorecard line (`GS scorecard`).
5. The owner's live views: the Bridge pane (`/gs-bridge`, or the ⛴ button in the footer) with its tabs — queue, tasks, crew, log, menu — the band above the prompt (the voyage of stages and the step line: what each agent is doing now), and `gs harbor` for every project. The owner answers and approves — in chat (the default), in the pane, or in their shell, depending on `approvals.mode`; you never answer the queue or approve yourself. The pane is one convenience, not the only channel: a mobile or cloud owner cannot see it, so always surface pending asks in chat too.
Read-only: bridge never changes state.
