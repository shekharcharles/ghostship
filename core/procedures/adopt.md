# /ghostship adopt — bring existing code under Ghostship

`GS` = `node .ghostship/core/runtime/gs.mjs`. Init has already run and written `.ghostship/migration-plan.md` (nothing moved yet).

1. **Migration.** `GS migrate list`. Show it as a table and recommend an action for each `ask` row.
   - `import` rows: read them first; requirements feed the PRD draft, open work becomes task drafts later.
   - `ask` rows (CLAUDE.md, GEMINI.md, Cursor/Copilot rules): show which lines are project facts (copy them into the facts part of `AGENTS.md`) and which are another tool's workflow (dropped).
   - Apply with the owner's approval: `GS migrate apply` (terminal) or `GS migrate apply --quote "…"`; settle ask rows with `--keep 3` / `--archive 4`. Files move to `docs/archive/<tool>/`; nothing is deleted; it commits once.
2. **Understand the code** before asking anything: stack, entry points, test command, how it runs. Write `docs/05-code/CODEMAP.md` with `GS codemap` and list files with no purpose header (they get one when a task next touches them).
3. **Interview the owner — always, even though there is code.** The code tells you what exists; only the owner can tell you what this round is *for*. Never go straight from reading the code to writing the PRD.
   - **Start with the goal.** Your first `AskUserQuestion` round asks what the owner wants from this round of work: the problem to solve, the outcome, the priority. This round is mandatory. Code can never answer it, so never mark goal / scope / success areas `answered --note "from code: …"`.
   - Then run the interview as in `new.md` (rounds of 3–5 `AskUserQuestion` questions). For each open area, first check whether the code answers its *factual* part (stack, entry points, data, integrations, test command); if it fully does, mark it `answered --note "from code: …"` and move on. Ask the owner about every area the code only partly answers or cannot answer: intent, users, scope in/out, non-functional targets, security posture, business model, timeline, risks.
   - **You must ask the owner at least one round before writing the PRD.** Marking every area "from code" and writing the PRD with no questions is a defect: if you think the code answered everything, you have not asked about intent. `GS interview status` must show the owner's answers, not only "from code" notes.
   - Write interview notes to `.ghostship/interview/rounds.md` as you go (crash-safe).
4. **PRD**: `docs/01-requirements/PRD.draft.md` = what exists today (short) + what this round adds (full detail). **Show it to the owner as in `new.md` step 4** — the section headings and the load-bearing parts, not just the path — then approve as in `new.md`.
5. `GS next` moves on to `design.md`: document the architecture as it is; propose changes only where the new goal needs them.

Existing tests stay. Acceptance tests cover only the new goal's checks.
