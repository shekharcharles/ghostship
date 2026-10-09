# /ghostship new — from idea to approved PRD

`GS` = `node .ghostship/core/runtime/gs.mjs`. You are the orchestrator. The owner talks only to you.

## 1. Take the input
The owner either describes the idea in chat or points at files (notes, a brief, screenshots, an old spec). Read what they give. Put copies of reference material in `docs/research/`.

## 2. Interview until every area is closed
1. `GS interview init` (uses the project tier).
2. Ask in rounds of **3–5 questions**, one `AskUserQuestion` call per round. Every question:
   - offers 2–4 concrete options, your **recommended option first with "(Recommended)"**;
   - says in one line why you recommend it.
   Pick the next round from the open areas: `GS interview status`.
3. After each round, record every area it closed:
   - `GS interview mark <area> answered --note "<their answer, short>"`
   - `GS interview mark <area> na --note "<why it does not apply>"`
   - `GS interview mark <area> assumption --note "<what you assumed>"` — only when the owner says "you decide"; say the assumption back to them.
4. Write interview notes to `.ghostship/interview/rounds.md` as you go (crash-safe).
5. Do not ask what you can find out yourself (existing files, the stack's defaults, public docs).

## 3. Write the PRD
When `GS interview status` shows no open areas, write `docs/01-requirements/PRD.draft.md`:
Vision · Users · Problem and current state · Scope (in / out) · Features and flows (one `## <feature>` heading each, so checks can cite `PRD#<feature>`) · Data · Integrations · Platform and UX · Non-functional (numbers) · Security and privacy · Business model · Operations · Timeline · Risks and unknowns · Success measures · Assumptions (every `assumption` area).
Short sentences. Numbers instead of adjectives.

## 4. Approval
Show the PRD before asking for approval — the owner approves what they can see, not a path:
- print the PRD's section headings and, under each, the load-bearing parts — scope (in / out), the features and flows, the success measures — not a vague précis;
- give the path (`docs/01-requirements/PRD.draft.md`) and offer to render the whole document in chat or send it as a file (`SendUserFile`) if they'd rather read it in full;
- then ask the owner to approve.
Ask the owner to approve:
- terminal approvals: they run `GS prd approve` themselves and type `yes`;
- chat approvals: when they approve in words, run `GS prd approve --quote "<their exact words>"`.
Never invent or paraphrase a quote.

`GS next` says `interview.init`, then `interview` (an `owner` gate: the interview is where you ask), `prd.write`, then `prd.approve` (`owner`, in every mode). In **chat** mode (the default) you take the owner's approval in chat: show the PRD, let them approve in words, and run `GS prd approve --quote "<their exact words>"`. In bridge/terminal mode they press it in the Bridge pane or run `GS prd approve` in their shell. After the approval it moves on to `design.md`, and in autopilot/full you do not ask the owner anything more until STOP 1 (autopilot) or STOP 2 — but you still surface those two gates in chat, you do not approve them yourself.
