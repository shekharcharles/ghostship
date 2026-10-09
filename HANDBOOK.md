# Ghostship Handbook

How to use Ghostship 1.6, the autonomous software factory for Claude Code. This is for the person who owns the project. You don't need to know how Ghostship works inside.

---

## 1. What Ghostship does

You describe what you want. Ghostship turns it into working, tested software. You talk to one Claude session, the **orchestrator**, and it:

1. **interviews** you and writes the requirements (the PRD);
2. **designs** the product;
3. writes **acceptance checks**, the contract for "done", and **you approve them (STOP 1)**;
4. **plans** small tasks, each with the checks it serves and the files it may touch;
5. **builds** every task test-first, with a fresh builder agent, then a fresh judge agent that never saw the build;
6. **merges** each passed task through a queue onto `develop`;
7. prepares a **release packet** and **you approve it (STOP 2)**.

The rules (tests first, stay in scope, nobody marks their own homework) are enforced by code, not by asking the AI nicely. Every result is recorded as tamper-evident evidence.

```
you ── interview ──► PRD ──► design ──► checks ══ STOP 1 ══► plan ──► build ⟲ judge ──► merge ──► packet ══ STOP 2 ══► release
```

### Words used in this handbook

| word | meaning |
|---|---|
| **orchestrator** | your Claude Code session; it runs the loop and never writes product code itself |
| **builder** | a fresh agent that builds one task, test first |
| **judge** | a fresh, read-only agent that grades one task against its checks, using a one-time token the builder never sees |
| **planner** | a fresh agent that splits the checks into tasks |
| **acceptance checks** | numbered, testable statements of done (`C1 add(2,3) returns 5`); approved at STOP 1, then locked |
| **evidence** | a recorded test or lint run, tied to the exact code it ran on |
| **gate** | a decision only you can make |
| **parked** | set aside by autopilot for you to see at STOP 2 |
| **held** | passed by the judge, but waiting for you before it merges (new in 1.6) |
| **Bridge** | the pane inside Claude Code where you watch and approve |
| **Harbor** | an overview of every Ghostship project on the machine |

---

## 2. Install

**The easy way:** give Claude Code the file `GHOSTSHIP-INSTALL-PROMPT.md` and `Ghostship-1.6.0.zip`, and tell it to follow the prompt. It checks the package, runs the self-test, installs, and sets up a trial project. It never approves anything for you.

**By hand:**

```bash
mkdir -p ~/ghostship-src && cd ~/ghostship-src
unzip Ghostship-1.6.0.zip
node ghostship/core/runtime/selftest.mjs   # optional: 171 tests, about a minute
node ghostship/install.mjs
```

**You need:** Node 18+, git (2.38+ recommended) and Claude Code. Optional extras:
- **herdr**, for agents in their own terminal tabs;
- **gh**, for GitHub issues and releases;
- **Codex** or other agent CLIs;
- **agent-browser**, for looking at UI changes.

**What the installer writes:**

| path | what it is |
|---|---|
| `~/.ghostship/core/` | the installed core; the previous one is kept in `core/.prev/` |
| `~/.ghostship/projects.json` | your project list (Harbor reads it) |
| `~/.ghostship/secrets` | your API keys, one `NAME=value` per line; owner-only, never committed, never read by agents |
| `~/.ghostship/bridge.key` | the key a press in the Bridge pane carries when you approve |
| `~/.claude/skills/ghostship/` | the `/ghostship` command |
| `~/.claude/skills/ghostship-help/` | `/ghostship help` |
| `~/.claude/skills/ghostship-bridge/` | the Bridge pane; inactive outside Ghostship projects |

**Restart Claude Code after installing** so the command and the pane load.

Each project carries its own pinned copy of the core in `.ghostship/core/`, so an upgrade never changes the rules under a project mid-build. To move a project to a newer installed core, run `gs upgrade check`, then `gs upgrade apply`; `gs upgrade rollback` undoes it.

---

## 3. Your first project

```bash
mkdir ~/projects/my-app && cd ~/projects/my-app
claude            # start it inside herdr if you want agent tabs
```

In Claude Code:

1. **`/ghostship init`** turns the folder into a Ghostship project. It prints a health table and offers once to fix git problems (author, first commit). Nothing outside the folder changes.
2. **Optional, recommended the first time:** `gs autonomy guided`, so you're asked at every gate and see how it works.
3. **`/ghostship new`** starts the interview. Answer in rounds of 3–5 questions until every area is covered. You can say "not applicable" or "assume X".
4. **Approve the PRD** when it's written (Bridge pane: press, then **y**).
5. Ghostship designs, then writes the acceptance checks. **STOP 1: read them carefully.** They are the contract: whatever they say is what "done" means, and anything listed under *Out of scope* counts as a defect if built.
6. When asked, give the commands it should use, for example:
   ```bash
   gs config set commands.test "npm test"
   gs config set commands.acceptance "npm run test:acceptance -- {files}"
   gs config set commands.lint "npm run lint"            # optional
   gs config set commands.serve "npm run dev -- --port {port}"   # optional, for UI work
   ```
7. The build runs. Watch it in the Bridge pane. In autopilot you're not asked anything until STOP 2, except for held tasks (section 6).
8. **STOP 2:** read the release packet in `docs/10-releases/v<version>.md` and approve the release. Ghostship merges to `main`, tags the version and builds the docs site.

**A shorter command:** inside a project, `gs` means `node .ghostship/core/runtime/gs.mjs`. Add `alias gs='node .ghostship/core/runtime/gs.mjs'` to your shell.

---

## 4. The `/ghostship` commands

| command | use it for |
|---|---|
| `/ghostship init` | turning a folder into a project (once) |
| `/ghostship new` | a new product from nothing |
| `/ghostship adopt` | existing code: other tools' files move to `docs/archive/` with your approval, then the same flow |
| `/ghostship add` | a new feature after the first release: reopens the PRD or the checks, builds only what's new |
| `/ghostship change` | changing something already approved; only the changed checks unlock |
| `/ghostship solve` | a bug: a reproduction test first, then the fix, judged and merged |
| `/ghostship resume` | carrying on after a crash, `/clear` or a new day |
| `/ghostship bridge` | where things stand |
| `/ghostship autopilot` | running the build headless (section 8) |
| `/ghostship agents` | which models and CLIs do which work |
| `/ghostship help` | the command list |

**Lost?** `gs next` always prints the one next step and why.

---

## 5. Your decisions

### The two stops (every mode)

- **STOP 1:** approve the acceptance checks.
- **STOP 2:** approve the release.

### How much else you're asked: `gs autonomy <mode>`

| mode | after the PRD, you're asked about |
|---|---|
| `guided` | every gate: STOP 1, each stuck or held task, resuming, STOP 2 |
| `autopilot` (default) | STOP 1 and STOP 2. A stuck task gets one more attempt by policy, then is parked; held tasks are parked for you too |
| `full` | STOP 2 only: STOP 1 passes by itself once the checks lint clean |

Only you can change the mode. Turn on **night shift** with `gs autonomy autopilot --night-shift on --night-shift-at 90`: it pauses new work at 90% of your Claude plan's 5-hour limit and resumes after the reset.

### How you approve: `approvals.mode` in `.ghostship/config.yaml` (you edit it)

| mode | how |
|---|---|
| `bridge` (default) | one press in the Bridge pane, then **y** |
| `terminal` | you run the command yourself and type `yes`; the strictest option |
| `chat` | Claude passes your exact words with `--quote "…"` |

### Decisions about a task

| situation | you run |
|---|---|
| a task used its attempts (guided), or was parked | `gs decide T004 --grant 1` for one more try, or `--drop` |
| …and you want to tell the builder something | `gs decide T004 --grant 1 --note "Use the existing date helper"` |
| a passed task is **held** | `gs decide T004 --merge`, or `--grant 1 --note "…"` to send it back, or `--drop` |
| pause everything / carry on | `gs pause --reason "…"` / `gs go` |

Your note appears in the next builder's instructions under "The owner's notes".

---

## 6. What new in 1.6 means for you

### Held merges: risky changes wait for you

A task that passes its judge is still **not merged on its own** when its change touches:

- **dependencies**: `package.json`, lock files, `requirements.txt`, `go.mod`, `Cargo.toml` and the like;
- **CI**: `.github/`, `.gitlab-ci.yml`, …;
- **deploy and hosting**: Dockerfiles, compose files, Terraform, `k8s/`, `vercel.json`, `fly.toml`, deploy scripts, …;
- **database migrations**: `migrations/`, `schema.prisma`, …;
- **your risk words**: `judge.risk-paths`, by default `auth, payment, billing, migration, secret, api`, matched as whole words of the path. `src/authService.ts` matches; `src/author.js` doesn't. Entries with `/` or `*` are globs.

Such a task also always gets the **full** judge and a **security review**.

In autopilot it's parked with its branch kept and listed under **"Held for you"** in the release packet, while the rest of the build carries on. Tasks that depend on it wait. In guided mode it comes to you straight away. Either way you decide with `gs decide <id> --merge | --grant 1 --note "…" | --drop`.

**Exception:** setup and skeleton tasks may create the project's dependency files without being held, because they build the toolchain you approved in the design. Their CI, deploy and migration changes are still held.

To turn holds off (only you can): `merge.hold-risky: false` and/or `merge.hold-product-assumptions: false` in `.ghostship/config.yaml`.

### Review lenses

Besides the acceptance checks, the judge must also report:

- **SECURITY** for risky changes: access control, input handling, data exposure, secrets, new dependencies;
- **UX** for UI files (`.html`, `.css`, `.vue`, `.tsx`, `.svelte`, …): flows, loading, empty and error states, copy, accessibility, phone width.

A PASS is refused without them. To look at the page, the judge starts your app with `commands.serve` on its own port and uses the `agent-browser` CLI if it's installed. Choose lenses with `judge.lenses` (default `[security, ux]`) and UI files with `judge.ui-paths`.

### Assumptions

When a task leaves a decision open, the builder makes the smallest reasonable choice and records it (`gs assume`). If it's really a **product decision** (pricing, public copy, what's free or paid, who sees what), it's marked as one and the task is **held** for you. Every assumption is listed in the release packet.

### Conflicts found early

Before merging, git is asked whether the task would conflict with `develop`, without touching your files. A conflict goes back to a builder like a failed attempt, naming the files.

---

## 7. Watching it work

| where | what you see |
|---|---|
| **Bridge pane** (`/gs-bridge`, or the ⛴ button) | tabs: **q** queue · **t** tasks · **w** crew · **l** log · **m** menu · **f** refresh · **h** hide. Approvals and answers are a key press. |
| **band** (above the prompt) | stage, current task, tasks merged out of all, Claude plan use |
| **owner queue** (`gs asks`) | everything only you can do: a key, a choice, an approval |
| `gs status` | stage, active task, counts, what's next |
| `gs scorecard` | how autonomous the run was: questions, retries, parked tasks, time and cost per task |
| `gs spend` · `gs limits` | money used; Claude 5h/7d use and reset time |
| `gs audit` | verifies the evidence chain and locks; run it if something looks off |
| `gs harbor` | every project on this machine (web on 127.0.0.1, or `--tui`) |
| `gs watch` | band and alerts in a plain terminal |

**Where things are written in your project:**

| path | contents |
|---|---|
| `docs/01-requirements/PRD.md` | requirements |
| `docs/02-design/` | design |
| `docs/03-acceptance/` | checks |
| `docs/04-plan/` | plan |
| `docs/05-code/CODEMAP.md` | code map |
| `docs/10-releases/` | release packets |
| `docs/10-releases/CHANGELOG.md` | changelog |
| `tasks/BOARD.md` | the task board (generated) |
| `tests/acceptance/` | locked acceptance tests |
| `.ghostship/` | state and evidence; don't edit by hand |

---

## 8. Running headless (autopilot runner)

After the PRD is approved, you can let the build run without your Claude session driving it:

```bash
gs autopilot start          # in your own terminal; add --once for a single step
gs autopilot status         # or: log [--tail 50]
gs autopilot stop
```

It runs `gs next` in a loop with headless agents (`claude -p`, or Codex if configured), stops at STOP 1, STOP 2, a pause or an owner decision, and carries on by itself once you've passed the gate. Your Claude session becomes the control tower: watch and approve in the Bridge pane. Only one runner per project; a stop is final until you start it again.

It needs `commands.test` set and an agent that can run headless.

---

## 9. Agents and models

`gs agents` shows what's installed and which agent does which work. Work is sorted into tiers:

- `grunt`, `standard` and `frontier` for builders and planners;
- `judge-light` and `judge-full` for judges.

Each tier lists agents in order of preference. By default these are Claude Haiku, Sonnet and Opus via your Claude subscription. When an agent is out of quota, routing moves to the next in the list (`gs quota mark <agent>`). A judge from a different model family than the builder is better. Add Codex or other CLIs under `agents` in the config (`/ghostship agents` walks you through it).

---

## 10. Configuration you'll touch

`.ghostship/config.yaml`. Agents may set only `commands.*`, `project.tier`, `judge.depth` and `routing.*` (via `gs config set`); everything else is yours.

| key | default | meaning |
|---|---|---|
| `project.tier` | `standard` | `light`, `standard` or `full`: how many design and docs files are required |
| `commands.test` / `acceptance` / `lint` / `typecheck` | empty | the commands evidence runs; `{files}` in `acceptance` is replaced with the check's test files |
| `commands.serve` | empty | starts the app for a browser look; `{port}` or `$PORT` |
| `autonomy.mode` | `autopilot` | see section 5 |
| `autonomy.auto-retries` | `1` | extra attempts autopilot grants before parking |
| `approvals.mode` | `bridge` | see section 5 |
| `loop.attempts` | `3` | attempts per task |
| `judge.depth` | `by-risk` | `light`, `full`, or by risk; risky paths always get full |
| `judge.risk-paths` | auth, payment, billing, migration, secret, api | words or globs that make a change risky |
| `judge.lenses` | `[security, ux]` | lenses the judge must report |
| `merge.hold-risky` | `true` | hold risky changes for you |
| `merge.hold-product-assumptions` | `true` | hold product assumptions for you |
| `branches.main` / `develop` | `main` / `develop` | release and integration branches |
| `launch.skipPermissions` | `true` | outside Claude agents start with `--dangerously-skip-permissions`; the guard hooks still apply. Set `false` for prompts. |
| `policy.confidential` | `false` | `true` keeps the project on your Claude plan and local models |

Check it with `gs config check`.

---

## 11. Safety, in short

- **Tests first.** A failing test must be recorded before any production change; the test is then locked.
- **Scope.** Each task may touch only its `allowedPaths`; this is checked on every write and again at submit.
- **Roles.** Builders can't submit, judge or approve; judges can't build; nobody but you approves.
- **Evidence.** The commands come from config, never from the agent; results are hash-chained and checked by `gs audit`.
- **Secrets** are never read by agents and are redacted from logs.
- **Honest limit:** the shell guard recognises commands by their text. It stops mistakes and casual misuse, not a determined attacker. For untrusted work, run in a sandbox or VM, and use `approvals.mode: terminal`.

---

## 12. Troubleshooting

| you see | do |
|---|---|
| "needs a clean tree" | commit or stash your own edits; Ghostship's files under `.ghostship/` and `tasks/` don't count |
| "No git author" / "no commit yet" | `gs preflight --fix --name "You" --email you@example.com` |
| a task keeps failing | read its file in `tasks/` (judge notes, history); in guided mode decide with `--grant 1 --note "…"` or `--drop` |
| a task is **held** | it passed but touches risky paths or a product assumption: `gs decide <id> --merge`, `--grant 1 --note "…"`, or `--drop` |
| "conflicts with develop in …" | it goes back to a builder automatically; if it keeps happening, look at what landed on `develop` |
| "The builder run … lost its supervisor" | check `git status`, then `gs run clear` |
| "Judge token missing" after a crash | `gs task reissue <id>` |
| "Another autopilot start is in progress" / "The autopilot record is held by pid …" | another start or write is in progress; wait a moment and retry |
| the runner shows `lost` | its process died: `gs autopilot stop` settles it, then start again |
| something looks tampered | `gs audit` |
| after `/clear` or a new day | `/ghostship resume` |

---

## 13. What's proven, and what isn't

- **Proven by the test suite (171 tests):**
  - the engine's rules;
  - the autonomy policy;
  - holds, lenses and assumptions;
  - the autopilot runner's concurrency;
  - a scripted end-to-end run, from init to a tagged release, where only the PRD, STOP 1 and STOP 2 need you.
- **Not yet proven:** the same run with real Claude/Codex agents on a real project, and Windows/macOS. Start with a small project in guided mode and watch the Bridge pane.
- **Not available yet:**
  - a merge button for held tasks in the Bridge pane or Harbor (use `gs decide <id> --merge`);
  - several tasks building in parallel (Ghostship builds one task at a time).
