# /ghostship init

Sets up Ghostship in the current folder. Writes only inside the project. Safe to run again (it refreshes the managed parts and keeps everything else).

1. Ask in ONE `AskUserQuestion` call (recommended option first):
   - **Size** — light (a tool or prototype) · standard (a product) · full (regulated or large).
   - **Tracker** — local Markdown tasks (recommended) · GitHub issues + PRs · both.
   - **Approvals** — how you approve STOP 1, STOP 2, the PRD and task decisions:
     - `chat` (recommended, the default): you approve in words, in chat, and Ghostship records your exact quote. Works from any client — a terminal, a phone, a cloud session — because it needs no pane and no terminal trip. The orchestrator surfaces each gate in chat; it can never fabricate your approval (the guard blocks agents from self-approving).
     - `terminal` (stricter): you run the `gs` command in your own shell and type `yes`. The CLI checks for a real terminal, which no agent can fake. The trade-off: no approving from a client without a shell.
     - `bridge`: one press in the Bridge pane (`/gs-bridge`), proved by the owner key `~/.ghostship/bridge.key` that `node install.mjs` creates. Convenient at a terminal, but the pane is invisible from a phone or a cloud client, and it relies on the guard keeping agents away from the key.
2. Run `node ~/.ghostship/core/runtime/gs.mjs init --tier <t> --tracker <t> --approvals <a>`.
   (If `~/.ghostship/core` does not exist, Ghostship is not installed: tell the user to run `node install.mjs` from the Ghostship package and stop.)
3. Show the health table exactly as printed. If the `approvals` row says the owner key is missing, tell the user to run `node install.mjs` from the Ghostship package.
3b. **Preflight, once.** If the `preflight` row shows anything failing (git refuses the folder, no git author, no first commit, gh not signed in), fix it now, before any other step, so nothing stops the build later:
   - Ask ONE `AskUserQuestion` covering every failing item together. For example: "Let Ghostship trust this folder in git and set your git name and email for this repo?", with the name and email to use (offer the account email if you know it; ask for the name in the same question).
   - On yes, run `node .ghostship/core/runtime/gs.mjs preflight --fix --allow-global --name "<name>" --email "<email>"` (leave out `--allow-global` if git does not refuse the folder; it is the only global change). It also makes the first commit when there is none, never including `.env` or key files.
   - Show the table it prints. Items it cannot fix (installing git, Node or `gh`, `gh auth login`) go to the user as one list of exact commands.
   - Never ask about these again later in the project; `gs preflight` re-checks without asking.
4. If `.ghostship/migration-plan.md` exists, show it as a table and say nothing was moved. Rows with action `ask` (CLAUDE.md, GEMINI.md, Cursor or Copilot rules): show the user what rules would move into the project-facts part of `AGENTS.md`, apply only what they approve, and keep their original file.
5. Register the project in `~/.ghostship/projects.json` (create it if missing): `{ "projects": [{ "name", "path", "added" }] }`. Do not add duplicates.
6. Say the next step from the table (`/ghostship new` for an empty folder, `/ghostship adopt` for existing code). Do not start it unless the user asks. Mention once that `gs autopilot start` in their own terminal runs the build headless later, after the PRD.

Never edit `.claude/settings.local.json` yourself. How agents launch is the owner's `launch.skipPermissions` setting (default on: agents start with `--dangerously-skip-permissions --remote-control`; the guard hooks still apply).
