---
name: ghostship-help
description: Explains what each /ghostship command does and when to use it. Use when the user asks for ghostship help, "what does /ghostship <x> do", "which ghostship command", "explain the ghostship commands", or types /ghostship help.
---

# Ghostship commands

Ghostship is an autonomous software factory. You talk to one orchestrator; it interviews you, designs the product, builds every task test-first with fresh builder and judge agents, merges through a queue, and ships. You approve two things; the rest runs on its own.

Type a command as `/ghostship <command>`. With no argument, `/ghostship` lists these and asks which.

| Command | What it does | When to use it |
|---|---|---|
| `init` | Sets up `.ghostship/` in this folder (writes only inside it), runs preflight (git trust, author, first commit, tools), prints a health table, registers the project in Harbor. | Once, to turn a folder into a Ghostship project. |
| `new` | Interviews you in rounds until the coverage areas are closed, then writes the PRD → design → acceptance checks → plan → build → release. | A brand-new product from nothing. |
| `adopt` | Like `new`, but for a folder that already has code: other tools' files move to `docs/archive/` with your approval first. | Bringing existing code under Ghostship. |
| `resume` | Runs `GS next` in a loop: continues from wherever the project stands. | After a crash, `/clear`, a new day, or just "keep going". |
| `bridge` | Shows where the project stands: stage, the task in hand, what waits for you, spend and limits. | A quick "where are we". Also the `/gs-bridge` pane. |
| `add` | Reopens the PRD or the checks for a new feature, you approve, then builds only what is new. | A feature after the first release. |
| `change` | Alters something already approved; only the changed checks unlock. | Changing agreed behaviour. |
| `solve` | Quick fix for a bug: writes a reproduction test first, then the fix, judged and merged — no questions in autopilot. | A bug to fix. |
| `autopilot` | The owner runs `gs autopilot start` in their terminal; a headless runner drives the build loop on its own and this session only watches. `gs autopilot status`/`stop`/`log`. | Letting it build unattended. |
| `agents` | Which agent/model runs which work (tiers and activities), adding other CLIs (Codex, Gemini, …), herdr tabs, the gateway. | Changing models or launching outside agents. |
| `help` | This page. | Understanding the commands. |

## The two stops

Everything else is automatic; these two always wait for you:

1. **STOP 1** — you approve the acceptance checks. They lock, and so do their tests once proven to fail. (In `full` mode the engine may approve these itself once they pass the linter.)
2. **STOP 2** — you approve the release packet before it ships.

## Autonomy modes (`gs autonomy`)

- **autopilot** (default) — you approve the PRD, STOP 1 and STOP 2; a task that exhausts its attempts is retried once more by policy, then parked for you to see at STOP 2. A passed task that touches risky paths (dependencies, CI, deploy, migrations, auth, payments…) or rests on a product assumption is held for you there too: `gs decide <id> --merge`, `--grant 1 --note "…"` or `--drop`. No questions in between.
- **full** — also approves STOP 1 by policy once the checks pass the linter. You still approve the PRD and STOP 2.
- **guided** — every gate waits for you.

Only you change the mode, in the Bridge pane's menu or `gs autonomy <mode>` in your terminal.

## What's next

`gs next` always prints the single next action. The whole build is that one command in a loop. `gs scorecard` shows how autonomous a run actually was (questions asked, tasks parked, retries, spend).
