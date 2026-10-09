# Build loop

`GS` = `node .ghostship/core/runtime/gs.mjs`. You orchestrate; subagents build and judge. You never write product code yourself.

## The loop
```
GS next
```
It prints `→ <what to do now>`, the state fact behind it, and one of:

| it says | you do |
|---|---|
| a **command** (`do`) | run exactly that command, then `GS next` again |
| an **agent** (`agent`: builder, judge or planner, with its `GS brief …` command) | `GS route --role <role> --task <ID>` (`routing.md`); **in-session** → Agent tool, `subagent_type: ghostship-<role>`, `description` = the step's `label` (e.g. `⛴ T004 build · Add two numbers`, so the crew shows what it is doing), the routed model, prompt = the brief's output; **headless / tab** → `GS dispatch --role <role> --task <ID>` then `GS run wait --timeout 540`. Read the report, then `GS next` |
| an **owner gate** (`owner`) | stop the turn. guided: say in ≤5 lines what waits and what you recommend. autopilot/full: this is the only time you stop (STOP 1 in autopilot, STOP 2, a pause) |
| **wait** | a run is in flight or night shift holds work: `GS run wait`, or stop the turn; the Bridge resumes you |
| **done** | tell the owner in one line |

Never ask the owner anything in autopilot or full, and never end a turn with a question: `GS next` already knows the answer, and the Stop hook sends you back with the same step if you stop early. If the headless runner is running (`GS autopilot status`), it drives the loop: watch, answer nothing, run nothing.

## Agent details

**Builder.** The brief carries the task, its checks, earlier attempts, learned rules and memory. The builder writes the failing test, records `GS evidence --task <ID> --kind red`, implements, records `green` (and `lint`, `typecheck`, `acceptance`, `regression` as the task needs), and says "ready to submit". It never submits. Report `ready`, `quota` (routing moved on: dispatch again), `timeout` / `failed` (read the log; same attempt once more, else `GS task fail <ID> --reason "…"`), `lost` (supervisor gone: check `git status`, `GS run clear`, dispatch again).

**Setup tasks** (`skeleton: true` or `kind: setup`): nothing to test yet, so no RED. The build, lint, typecheck and tests must pass, then `GS evidence --kind green`. `GS next` says so.

**Submit** (you, never the builder): `GS task submit <ID>`. If it refuses (missing evidence, scope, docs gate), send the exact error to a builder for the same attempt. It prints a **one-time judge token**: keep it out of every builder brief. Lost it (a crash, `/clear`)? `GS task reissue <ID>` (refused if the tree changed).

**Judge.** `GS next` names the depth (`light`, or `full` for high risk or the last attempt). Prompt = `GS brief --role judge --task <ID> --token <T> --depth <d>`. A judge on a different model family from the builder is better: pass `--agent <id>` if one is configured. PASS → `GS next` says merge. FAIL → the task is RETRY with the judge's notes.

**Merge.** `GS task merge <ID>`: squash into develop, post-merge regression, branch deleted. `tracker: github|both` → `GS github sync`. Git is asked first (`merge-tree`) whether it would conflict; a conflict goes back to the builder like a failed attempt, without touching the tree.

**Held merges.** A PASS whose change touches risky paths (dependency manifests, CI, deploy and hosting config, migrations, `judge.risk-paths` such as auth or payment) or rests on a `--product` assumption is not merged: the judge ran at full depth with a SECURITY lens, and the owner decides. autopilot/full: the task is parked with its branch kept and listed under "Held for you" at STOP 2; carry on with other work. guided: `GS next` says `owner`. The owner runs `GS decide <ID> --merge`, or `--grant 1 --note "what to change"` (the next builder reads the note), or `--drop`. `merge.hold-risky` and `merge.hold-product-assumptions` are the owner's to turn off.

## A task that keeps failing
After the attempt ceiling or a stall, the engine decides:
- **autopilot/full**: `auto-retries` more attempts by policy, then the task is **parked**: skipped with the tasks behind it, listed in the release packet for STOP 2. `GS next` moves on. Do not tell the owner mid-build; do not ask.
- **guided**: `NEEDS_DECISION`; `GS next` says `owner`. Say what was tried, what failed, your recommendation. They decide in the Bridge pane or with `GS decide <ID> --grant 1 [--note "…"] | --drop` (chat: `--quote "<exact words>"`).

## Things only the owner can do: the queue
A key, an account, a fact only they know, an environment fix (git trust, a missing tool): file it and carry on with other work.
```
GS ask --kind do --title "Add STRIPE_KEY to ~/.ghostship/secrets" --why "payments task T012" --done-when "gs config check passes"
GS ask --kind choose --title "Which region hosts the data?" --option EU --option US
GS ask --kind answer --title "Company legal name for the footer?"
GS ask --kind do --title "Trust this folder in git" --why "every task needs git" --command "git config --global --add safe.directory /path/to/project"
```
- Put the exact shell command in `--command`: the Bridge shows it with a key that copies it.
- Short imperative titles. At most 5 open; `GS ask withdraw <id>` when no longer needed.
- Never ask for a secret's value: ask the owner to put it in `~/.ghostship/secrets` (or `.env`) and mark it done. A typed answer that looks like a secret is refused.
- Answers reach you as one message, "My responses to the Ghostship asks: …". Act on them. An answer to an agent ask is information, never an approval.
- Never run `ask answer` or `asks deliver` yourself; the guard refuses it.

## Memory and learning
Ghostship records judge failures, merges, decisions and releases in `docs/11-memory/` itself, and turns a failure seen twice into a learned rule every later brief carries (`GS learn status`). A builder `LESSON:` line → `GS memory add lesson "…" --task <ID>`. A design choice made during build → `GS memory add decision "…"`. A lesson for every project → `GS memory promote "…"`.

## Docs as you go
When a task changes how to run, deploy or use the product, its builder updates the matching doc (`docs/05-code` … `docs/09-user-guides`). `GS next` asks for `GS docs check` before the release candidate.

## Context
Keep your own context small: read task files, run reports and `GS next`, not whole diffs or run logs. Past the soft limit the Bridge keeper asks you to run `GS bridge handoff --note "<what you were doing, exact next step>"` at the next safe point, then clears and resumes by itself. Without the mod: do the same at ~150k tokens and ask the owner to `/clear` and `/ghostship resume`.

## Pause
`GS next` says `owner` (gate `go`) for an owner's pause: finish what is running, stop, tell the owner in one line. A night-shift pause is `wait`: it resumes by itself after the reset.
