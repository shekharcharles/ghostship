---
name: ghostship
description: Ghostship — the autonomous software factory. Use when the user types /ghostship (init, new, adopt, resume, bridge, add, change, solve, autopilot, agents, help) or asks to start, continue, plan, build, judge or release a project that Ghostship runs (a project with a .ghostship/ folder).
argument-hint: init | new | adopt | resume | bridge | add | change | solve | autopilot | agents | help
---

# Ghostship launcher

This global skill is only a launcher. Every project carries its own pinned copy of Ghostship in `.ghostship/core/`, so the rules a project was started with never change under it.

**Commands:** `init` set up here · `new` start fresh · `adopt` existing code · `resume` continue · `bridge` where are we · `add` a feature · `change` something approved · `solve` a bug · `autopilot` run headless · `agents` models & tabs · `help` explain the commands. No argument → show this list and ask which. `help` → run the `ghostship-help` skill.

## Route the command

1. Find the project root: the folder that holds `.ghostship/`. If you are not in one, the root is the current folder.
2. Pick the procedure:

| user says | procedure |
|---|---|
| `/ghostship` with no argument | list the commands above in one line each and ask which they want; do nothing else |
| `/ghostship help` / "what does X do" / "explain the commands" | invoke the `ghostship-help` skill (do not improvise) |
| `/ghostship init` (or the folder has no `.ghostship/`) | `init` |
| `/ghostship new` | `new` |
| `/ghostship adopt` | `adopt` |
| `/ghostship bridge` / "where are we" | `bridge` |
| `/ghostship resume` / "continue" / "run" / "keep going" / after a crash or `/clear` | `resume` (it is `GS next` in a loop) |
| `/ghostship autopilot` / "run it headless" | tell the owner to run `GS autopilot start` in their own terminal (`… status`, `… stop`); while it runs, this session only watches |
| `/ghostship agents` / "which agents", "add codex", local model, gateway, herdr | `agents` |
| `/ghostship add` (feature) · `change` (alter approved) · `solve` (bug, quick fix) | same name |
| `/ghostship harbor` / "all my projects" | the owner runs `node ~/.ghostship/core/runtime/gs.mjs harbor` in their own terminal (it edits owner settings); a quick look: `… harbor --tui --once` |

3. Read the procedure file and follow it exactly:
   - In a Ghostship project: `.ghostship/core/procedures/<name>.md`
   - For `init` in a folder without Ghostship: `~/.ghostship/core/procedures/init.md`
4. If the procedure file is missing, say so and stop. Do not improvise the workflow.

## The CLI

`GS` means `node .ghostship/core/runtime/gs.mjs` inside a project (`node ~/.ghostship/core/runtime/gs.mjs` only for `init`). Every state change goes through it. When it refuses with `✗ CODE: message`, the message says what to do; do not work around it.

## The loop

`GS next` is the one source of what to do now: it prints `→ <what>`, the fact behind it, and either a command to run, an agent to dispatch (with its `GS brief`), or an owner gate. Run it, do it, run it again. Stop the turn only on `owner`, `done`, or `wait` (a run in flight → `GS run wait`). Each procedure is this loop plus one stage's details.

**Do exactly what `GS next` says — nothing more, nothing else.** You are the loop's hands, not its author. `GS next` already encodes the whole order (interview → PRD → design → STOP 1 → plan → tasks → acceptance tests → lock → build → release). You never skip a step, re-order the stages, jump ahead to building, or decide a stage is "done enough". If a step looks wrong or you disagree, run `GS next` and `GS status --json` and follow them, or raise it with the owner — do not route around the engine. The messy runs come entirely from freelancing; a faithful loop does not produce them.

## Autonomy

`GS autonomy` shows the owner's mode. **autopilot** (default) / **full**: after the PRD, never ask the owner or end a turn with a question — keep going until STOP 1 (autopilot), STOP 2 or a pause; the engine retries then parks stuck tasks, and environment problems become `GS ask --command …` while you work elsewhere. **guided**: every gate waits for the owner. Never change the mode yourself.

## Never

- Never edit `.claude/settings*.json` yourself. How agents launch is the owner's setting (`launch.skipPermissions`, default on here: Ghostship starts its agents with `--dangerously-skip-permissions --remote-control`). The guard and riskhold hooks still apply under it.
- Never write outside the project, except `~/.ghostship/` (projects.json, shared-lessons.md) when a procedure says so.
- Never read `~/.ghostship/secrets` or `.env*` files.
- **Never hand-edit `.ghostship/state/` or `.ghostship/evidence/`** (or `tasks/*.md`, locked docs, the acceptance lock). These are the engine's; every change goes through a `GS` command. If `GS` refuses, the refusal is the answer — fix the cause it names, never reach past it into state. Editing state is the one thing the guard exists to stop; doing it by hand corrupts the audit.
- **Never answer an owner gate yourself.** When `GS go`, `gs config set`, a build tool, or any prompt asks "Approve? / Type yes", that is the *owner's* to answer, not yours — even when a pane is waiting and the loop seems stuck. Do not type `yes`, do not self-approve, do not improvise the owner's decision. Surface the gate to the owner (in chat, with the options) and wait.
- **Never ask the owner ad-hoc questions in place of the real gate.** The interview runs through `GS interview` and `AskUserQuestion`; approvals run through the `GS … approve` commands. Do not invent your own question flow or your own approval outside those.
- Never answer the owner queue or approve for the owner. In **chat** mode (the default) you surface each pending gate in chat with its options and pass the owner's exact words back as the quote (`GS … approve --quote "…"`); in **bridge**/**terminal** mode the owner acts in the pane or their own shell. Either way the owner decides — never pass `--owner-key-stdin` or touch `~/.ghostship/bridge.key`.
