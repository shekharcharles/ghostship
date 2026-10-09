# Agents, herdr and the gateway — owner setup

Agents, providers, launch templates and policy are the owner's settings. Agents may read this file and explain it, but only the owner edits `.ghostship/config.yaml` (or Harbor). Check the result with `gs agents` and `gs config check`.

## 1. See what is installed
`node .ghostship/core/runtime/gs.mjs agents` lists the agent CLIs found on this machine, every configured agent, how each would run (in-session, headless, tab) and why one cannot.

## 2. Add an agent
```yaml
providers:
  codex-plan: { type: cli-login }                 # the CLI's own login (ChatGPT plan, Google AI Pro, …)
  qwen-local: { type: local, baseUrl: "http://127.0.0.1:11434/v1" }
  openrouter: { type: openai-compatible, baseUrl: "https://openrouter.ai/api/v1", key: OPENROUTER_KEY }
  gw: { type: gateway }                            # Claude Code pointed at the gateway
agents:
  codex-gpt:   { harness: codex,  provider: codex-plan, model: gpt-5 }
  gemini-pro:  { harness: gemini, provider: codex-plan, model: gemini-2.5-pro }
  claude-qwen: { harness: claude, provider: gw, model: qwen-coder }
routing:
  tiers:
    grunt:    [claude-qwen, claude-haiku]
    standard: [codex-gpt, claude-sonnet]
```
`key:` is the NAME of a line in `~/.ghostship/secrets` (`OPENROUTER_KEY=…`), never the key itself.
A provider can hand secrets to a CLI as env vars: `env: { OPENAI_API_KEY: OPENAI_KEY }`.

## 3. How agents start

| harness | headless (no tab) | in a herdr tab |
|---|---|---|
| claude | `-p` with accept-edits and an allow-list | yes; Remote Control on when signed in to claude.ai |
| codex | `exec` with the workspace-write sandbox, no approval prompts | yes |
| gemini, qwen, opencode, agy, kimi, pi, copilot, cursor, droid | no — needs a tab | yes |
| prime-agent, dsh, others | only with your own template | no |

Your own template: `harnesses: { prime-agent: { headless: "prime run --model {model} {prompt}" } }` ({model} {prompt} {name} {root} {role}).
Ghostship never adds permission-bypass flags. If your template has one, that is your decision; every run logs a notice.

## 3b. The headless runner
`gs autopilot start` (the owner, in their own terminal) runs the whole loop without a Claude Code session: `gs next` → a step → the next. Agents run headless (`claude -p` with accept-edits and the allow-list; Codex `exec` in its sandbox); an agent with no headless mode is skipped for one that has it. `gs autopilot status` · `stop` · `log --tail 20`. It stops by itself at STOP 1 (autopilot), STOP 2, a pause, or after the same step failed 3 times (an alert says why). While it runs, a Claude Code session in the project only watches; the Bridge pane shows its step.

## 4. herdr
Start Claude inside herdr (so `HERDR_ENV=1`); the orchestrator is then only the pane you type in, and each agent run opens in its own tab in the same workspace, named `gs-t004-builder-a1`, closing when the run ends. A Claude tab agent runs with `--permission-mode acceptEdits` and the role's allow-list — it builds on its own, with no bypass flag and no prompt for you to answer. It waits for you only if it needs a tool outside its allow-list: the run writes an alert to `.ghostship/runs/alerts.jsonl` and the Bridge says "needs your answer in the herdr tab", then continues once you answer there. `dispatch: { claude: tab }` sends Claude builds to tabs instead of in-session subagents; `herdr: { use: off }` never uses tabs; `close-tabs: false` keeps them open after a run.

## 5. Gateway (local and OpenAI-compatible models inside Claude Code)
```yaml
gateway:
  port: 8787
  routes:
    qwen-coder: { provider: qwen-local, model: "qwen2.5-coder:32b" }
    "*":        { provider: openrouter, model: "qwen/qwen3-coder" }   # optional catch-all
```
`gs gateway start` · `gs gateway env` (the two lines to start a Claude session on it) · `gs gateway status` · `gs gateway stop`.
It listens on 127.0.0.1 only, needs its own random key, forwards only to local, OpenAI-compatible or Anthropic API-key providers, and refuses subscription logins. A Claude session on the gateway has no Remote Control. Token use is logged to `.ghostship/usage/gateway.jsonl`.

## 6. Policy
`policy: { confidential: true }` for client code: only your Claude plan and local models are used. `policy: { allowed-providers: [ … ] }` limits it further.
