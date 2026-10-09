# Ghostship 1.6.0

**New here? Read [HANDBOOK.md](HANDBOOK.md)**: how to install, set up a project and work with Ghostship day to day.

An autonomous software factory for Claude Code. You talk to one orchestrator. It:

1. interviews you and writes the PRD;
2. designs the product;
3. gets your approval of the acceptance checks (**STOP 1**);
4. builds every task test-first, with fresh builder and judge agents (Claude or any CLI you have);
5. merges through a queue;
6. asks you to approve the release (**STOP 2**), and ships the docs with it.

Every rule is enforced in code, not in prompts. Everything a project needs lives inside that project.

## Install (once per machine)

```bash
node install.mjs
```

The installer writes only these:

| Path | What it is |
|---|---|
| `~/.ghostship/core/` | The installed core. The previous one is kept in `core/.prev/`. A re-run reinstalls when the version or the content changed (`core/.hash`); `--force` always does. The new core is copied beside the old one and swapped in whole, so a crash never loses the installed one. |
| `~/.ghostship/projects.json` | The project list Harbor reads |
| `~/.ghostship/shared-lessons.md` | Lessons shared across projects |
| `~/.ghostship/secrets` | API keys, by name. Owner-only, never committed. |
| `~/.ghostship/bridge.key` | The owner key a press in the Bridge pane carries (approvals mode `bridge`). Owner-only; agents never read it. |
| `~/.claude/skills/ghostship/SKILL.md` | The `/ghostship` command |
| `~/.claude/skills/ghostship-bridge/` | The Bridge mod; inactive outside Ghostship projects |

Requires Node 18 or later and git. Optional extras:

- **herdr**, for agent tabs;
- **`gh`**, for the GitHub tracker;
- other agent CLIs: Codex, Gemini, Qwen, OpenCode, Antigravity, Kimi, Pi and more.

To shorten the command: `alias gs='node .ghostship/core/runtime/gs.mjs'` inside a project. For Harbor, run `node ~/.ghostship/core/runtime/gs.mjs harbor`.

## Commands

| You type | What happens |
|---|---|
| `/ghostship init` | Sets up the folder (writes only inside it) and prints a health table. Registers it in Harbor. |
| `/ghostship new` | Interview in rounds of 3–5 questions until 22 areas are closed, then the PRD → design → checks → plan → build → release |
| `/ghostship adopt` | Existing code: other tools' files move to `docs/archive/` with your approval, then the same flow |
| `/ghostship add` | A new feature after approval: reopen the PRD or the checks, approve, build only what is new |
| `/ghostship change` | Alter something approved. Only the changed checks unlock. |
| `/ghostship solve` | Quick fix for a bug: a reproduction test, the fix, the judge, the merge; no questions in autopilot |
| `/ghostship bridge` | Where the project stands |
| `/ghostship resume` | Continue after a crash, `/clear` or a new day: `gs next` in a loop |
| `/ghostship agents` | Which agents run which work, plus herdr and the gateway |

The CLI behind it, `gs` (`node .ghostship/core/runtime/gs.mjs`):

| command | what it does |
|---|---|
| `gs next [--json]` | The one source of what to do now: a command to run, an agent to dispatch, or an owner gate. Claude and the headless runner both follow it. |
| `gs autopilot start \| status \| stop \| log` | Runs the loop headless (`claude -p`), from your own terminal, until STOP 1, STOP 2 or a pause. The Bridge pane shows it. |
| `gs scorecard` | Tasks merged / parked, attempts, asks, owner gates, questions after the PRD, time and spend per task. Also in every release packet. |
| `gs preflight [--fix]` | git trust, author, first commit, Node, gh — checked at init, fixed once. |
| `gs status` · `gs audit` · `gs asks` · `gs autonomy` · `gs spend` | Where things stand, the evidence chain, the owner queue, the mode, the money. |

## What each phase delivers

| Phase | What it adds |
|---|---|
| **A · Core** | Lifecycle engine and the `gs` CLI. Test-first evidence tied to the exact tree. One-time judge tokens. Scope guard and hooks. Merge queue onto `develop`. Semantic versioning and changelog. Crash-safe resume. |
| **B · Many agents** | Each piece of work → tier → agent (Claude subagents, Codex headless in its sandbox, other CLIs in herdr tabs). Quota fallback. Confidential policy. Localhost OpenAI ⇄ Anthropic gateway. |
| **C · Bridge + Harbor** | A Claude Code mod (installed to `~/.claude/skills/ghostship-bridge`) with five parts: <br>• **band** – live status line above the prompt <br>• **pane** – the bridge panel (`/gs-bridge`) <br>• **alerts** – decisions, ended runs, release waiting <br>• **keeper** – at 150k tokens, writes a handoff, clears, resumes <br>• **riskhold** – refuses secrets and risky commands <br>Plus helm (pause/go), heartbeat and logbook. Status line and `gs watch` work without the mod. **Harbor** shows every project, spend and decisions, and lets you edit config. |
| **D · Docs** | The SDLC document set per tier, scaffolded at design and required at release. Traceability matrix. Offline docs site: diagrams, API reference from OpenAPI, search. Interactive code explorer: tree, symbols, dependency map. Docs shipped as `.tar.gz`. CI workflow. |
| **1.1 · Bridge** | • **owner queue** – everything only you can do (a key, a choice, STOP 1/2, a stuck task) in one list with buttons in the pane; answers go back to Claude in your words <br>• **ping** – sound, toast and the pane open when something needs you <br>• **step line** – what each agent is doing right now, with a timer, under the band <br>• **plan limits** – Claude 5h/7d use and reset in the band; above 85% cheap work moves off the Claude plan (`gs limits`) |
| **1.2 · Bridge, interactive** | A tabbed pane (`/gs-bridge` or the ⛴ footer button), a key for every action: **q** queue · **t** tasks · **w** crew · **l** log · **m** menu · **f** refresh · **h** hide. <br>• **voyage** – Discover ━ Design ━ ◉ Checks ─ Plan ─ Build ─ ◆ Release, with progress inside the stage <br>• **queue** – the selected ask as a card: options on **1–4**, **d** Done, **r** Answer, **x** Won't do, **p** a long answer in the prompt (`↳ Answer to #N: …`), **c** copies the ask's command (`gs ask --command`), **j/k** move. Answers given while Claude works wait and go together when its turn ends; **s** sends now. <br>• **approvals from the pane** – PRD, STOP 1, STOP 2, a stuck task, resume. `bridge` (the default) approves with one press after **y**, proven by the owner key on stdin; `terminal` shows the exact command with a copy key; `chat` sends your words <br>• **tasks** board, **crew** (who does what, pause, handoff), **log**, **menu** of every `/ghostship` command <br>• an agent's ask shows in the transcript as "Asked you"; before `/ghostship init` the pane offers to set the folder up |
| **1.3 · Autonomy** | `autonomy.mode` (yours alone; `gs autonomy`, or Menu → Mode in the pane): **guided** asks at every gate · **autopilot** (default) asks nothing after the PRD except STOP 1 and STOP 2 · **full** also approves STOP 1 itself once the checks lint clean. <br>• **auto-retries** – a task that used its attempts gets 1 more by policy, then is **parked**: skipped with the tasks behind it, listed in the release packet, yours to grant or drop at STOP 2 <br>• **autopilot driver** – the Stop hook sends Claude back to the next step while work it can do remains <br>• **night shift** – pauses new work at `night-shift-at` % of the plan's 5h use, resumes after the reset <br>• **quick fix** – `/ghostship solve` end to end without questions <br>• **preflight** – `gs preflight [--fix]` at init: git trust, author, first commit, Node, gh, so nothing surfaces mid-build |
| **1.4 · Steady loop** | • **settled decisions** – in autopilot or full, a task decision already waiting (from guided mode or an older core) goes through the same policy: one more attempt, then parked <br>• **agents in view** – the band keeps a builder's row while it works after Claude's own turn ends, and the status line adds `◆ builder: Editing parser.ts · 4s` from the guard's heartbeat <br>• **band** – the stage as the bar's title, the phase or task inside it, tasks merged of all, two cells spare at the edge; the project total never reads below the session |
| **1.5 · Steady state** | • **`gs next`** – one step at a time, computed from state: the procedures shrink to "run `gs next`, do it, repeat", and the Stop hook pushes Claude with the same step <br>• **setup tasks** – `skeleton: true` or `kind: setup` needs no failing test first: build, lint and tests must pass, then GREEN <br>• **headless autopilot** – `gs autopilot start` drives the loop with `claude -p` from your terminal; your Claude Code session is the control tower (pane, queue, approvals) <br>• **golden path** – a tiny to-do CLI is taken from init to release inside the test suite, with scripted agents, and the suite fails if any step other than PRD, STOP 1 and STOP 2 needs the owner <br>• **scorecard** – per release: questions after the PRD, tasks parked, retries, time and cost per task <br>• **installer** – copies beside, swaps whole; same-version reinstall by content hash; `--force` |
| **1.6 · Owner's eye** | • **held merges** – a PASS that touches dependency manifests, CI, deploy config, migrations or `judge.risk-paths` (auth, payment…) gets a full judge and waits for you instead of merging: `gs decide <id> --merge`, or send it back with `--grant 1 --note "…"`; parked in autopilot, listed in the release packet <br>• **lenses** – risky changes need `SECURITY=PASS` and UI changes `UX=PASS` in the verdict, with a checklist in the judge's brief and a browser look on the run's own port (`commands.serve`, `agent-browser`) <br>• **assumptions** – `gs assume --task <id> --text "…" [--product]`; product decisions hold the merge, every assumption is in the release packet <br>• **merge-tree** – a conflict with develop is found before any rebase, without touching the tree <br>• **autopilot record** – crash-safe writes, one start at a time, a stop that a late runner write can never undo |
| **E · Living project** | Change management with check revisions (only new or changed checks reopen). Memory captured automatically and searched into every brief. **Self-learning:** a failure seen twice becomes a rule with a prediction, measured, then kept or reverted. Safe-point core upgrades with verification and rollback. Migration apply. GitHub issues, release PR and releases. |

## Status

Plain words about what is proven and what is not.

- **Proven in the test suite:** the engine's rules (test-first evidence, locks, scope, roles, the evidence chain), the autonomy policy (retry, park, settle), the Stop-hook driver, night shift, preflight, the installer, and the **golden path**: a to-do CLI goes from `gs init` to a tagged release driven by `gs next` alone, with scripted builders and judges standing in for Claude. The suite fails if any step other than the PRD, STOP 1 and STOP 2 needs the owner, or if a task is parked.
- **Not yet proven:** the same path run live, with real `claude -p` agents (`node core/runtime/golden/run-live.mjs`). Until it is, expect the odd surprise on a real project; the Bridge shows where.
- **Frozen** until the loop is proven live: the gateway, the Harbor web UI, the docs site and self-learning. They work as shipped and get no new features.

## Two stops, and your other decisions

1. **STOP 1:** approve the acceptance checks. They lock, and so do their tests once they are proven to fail. (`full` mode approves it by policy once lint is clean.)
2. **STOP 2:** approve the release packet, parked tasks included. Every mode stops here.

How much else Ghostship asks is `autonomy.mode`:

| mode | after the PRD, Ghostship asks you about |
|---|---|
| `guided` | every gate below |
| `autopilot` (default) | STOP 1 and STOP 2 only; stuck tasks are retried, then parked |
| `full` | STOP 2 only |

Everything that needs you also lands in **the owner queue** (band, `/gs-bridge` pane, Harbor, `gs asks`). Approvals always need you. How you give them is `approvals.mode` in `.ghostship/config.yaml`, which only you edit:

| mode | how you approve |
|---|---|
| `terminal` | you type `yes` in your own shell; the pane shows the exact command with a key that copies it |
| `chat` | your quoted words, passed by Claude |
| `bridge` (default) | one press in the pane, then **y**; the press carries your owner key (PRD, STOP 1, STOP 2, a stuck task, resume) |

Approvals that also go through that gate:

- a task after its attempts (guided; autopilot and full retry, then park), and un-parking one;
- changing `autonomy`;
- reopening approved documents;
- resuming after a pause;
- migrating other tools' files.

## Safety, in code

- **Test-first.** RED must fail with only test files changed; the tests are then locked.
- **Scope.** Every task has `allowedPaths`. The guard hook checks it on every write, and the tree hash checks it again at submit.
- **Evidence.** Commands come from config, never from the agent. Results are hash-chained, and `gs audit` verifies them.
- **Roles.**
  - Builders never see the judge token.
  - Outside agents carry their role, so a builder cannot submit, judge or approve.
  - Nothing can be submitted while a builder process still runs.
- **Owner-only settings.** Agents cannot edit config, agents, providers or policy. Harbor starts only from your own terminal.
- **Secrets** are never read by agents (guard + riskhold), nor searched into with Grep, and are redacted from evidence. A queue answer that looks like a secret is refused, in the pane and in the CLI.
- **The owner key** (`~/.ghostship/bridge.key`) reaches the CLI only on stdin from a press in the pane, never on a command line or in a log, and only in `bridge` mode. Guard and riskhold refuse any agent command that names it or `--owner-key-stdin`. That makes it a file agents are blocked from by rules, which is weaker than `terminal` mode's real-terminal check. Owners who want the stricter check set `approvals.mode: terminal`.
- **The queue is yours.** Agents can file asks; only you answer them. An answer to an agent ask is never an approval.
- **Confidential projects** stay on your Claude plan and local models.
- **Permission bypass is the owner's call.** Ghostship never edits your `.claude/settings*.json`. It launches its own agents with `--dangerously-skip-permissions --remote-control` when you set `launch.skipPermissions: true` (the default in this build), so an unattended agent never waits on a prompt. This skips Claude Code's prompts, not Ghostship's guard: the guard and riskhold are PreToolUse hooks that still run under skip-permissions, so secrets, scope and locked tests stay enforced. Set `launch.skipPermissions: false` to make agents ask instead.

## Tests

```bash
node core/runtime/selftest.mjs          # engine, CLI, hooks, routing, autonomy, the golden path, gateway, Harbor, docs, learning, upgrade, installer
claude plugin test core/mod/ghostship-bridge   # the Bridge mod
node core/runtime/golden/run-live.mjs   # the golden path with real claude -p agents (needs a Claude login; not part of the suite)
```

The bundled Mermaid (`core/vendor/`, MIT) stays in `~/.ghostship/core`. It is not copied into projects.
