# Routing: which agent does which work

`GS` = `node .ghostship/core/runtime/gs.mjs`. Never pick an agent by hand; ask the CLI. `GS next` names the role, task and depth; `GS route` names the agent.

```
GS route --role builder --task T004      # or --role judge / --role planner
```

It answers with the tier, the chosen agent and how it runs:

| runs as | what you do |
|---|---|
| `in-session` | Agent tool, `subagent_type: ghostship-<role>`, `model:` the agent's model (`haiku` · `sonnet` · `opus`) |
| `headless` | `GS dispatch --role <role> --task <id>` then `GS run wait --timeout 540` (repeat while it says still running) |
| `tab` | same commands; the agent opens in a named herdr tab the owner can watch |
| no agent | tell the owner what was skipped and why (quota, not installed, policy) |

How the tier is chosen (from `.ghostship/config.yaml`):

| work | tier |
|---|---|
| planning | `frontier` |
| a task | its `tier:` (grunt · standard · frontier); `risk: high` → frontier |
| attempt 3 of a task | one tier up |
| judging, low risk | `judge-light` |
| judging, high risk or last attempt | `judge-full` |

Each tier is an ordered list of agents. The first one that is installed, allowed by `policy`, and not cooling down after a quota error wins. A Claude-only setup always works.

**Confidential projects** (`policy.confidential: true`, e.g. client code): only the owner's Claude plan and local models are used. Third-party CLIs and cloud APIs are skipped.

**Quota:** a run that ends with a rate-limit or quota error marks that agent as cooling down for 60 minutes and routing moves on. `GS quota clear <agent>` when it is back.

Ghostship never adds permission-bypass flags. Both ways a dispatched agent runs use each tool's own scoped mode, so the agent works without a human answering prompts and without a bypass:
- **headless** — Claude: `--permission-mode acceptEdits` plus the role's `--allowedTools`; Codex: the workspace-write sandbox.
- **herdr tab** — the same scoped posture, in a visible tab the owner can watch. A Claude tab agent is started with the owner's launch posture — `--dangerously-skip-permissions` when `launch.skipPermissions` is on (the default), otherwise `acceptEdits` with the role's allow-list — so it builds on its own with no prompt waiting in the tab. Either way the guard + riskhold hooks still enforce secrets, scope and locks. The session you type in is only the orchestrator; the real build happens in the tab.

The tab opens in the orchestrator's herdr workspace (needs `HERDR_ENV=1`, i.e. Claude itself launched inside herdr). If herdr is not available, routing uses headless or an in-session subagent instead.

**Claude plan limits:** the Bridge records the plan's 5-hour and 7-day use (`GS limits`). When either reaches `routing.claude-limit-pct` (default 85), tiers in `routing.spare-claude-tiers` (default grunt, standard) skip Claude-plan agents, so the plan is kept for frontier work and judges. If nothing else can take the work, Claude still runs it and the route says so. Set the threshold to 0 to turn this off.
