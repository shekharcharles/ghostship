// Plans and starts one agent run outside this Claude session: a headless CLI run or an agent in a herdr tab.
// The run is supervised by dispatch-runner.mjs (detached), so a long build never holds the orchestrator's shell.
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { load, fail } from './store.mjs';
import { isPaused } from './engine.mjs';
import { loadConfig } from './config.mjs';
import { commandFor, detect, allowedTools } from './harness.mjs';
import { tierFor, pickAgent, loadQuota } from './routing.mjs';
import { available as herdrAvailable, agentName, runLabel } from './herdr.mjs';
import { liveRun, writeActive, readActive } from './runs.mjs';
import { RUNS_DIR, DOCS } from './paths.mjs';
import { briefRules } from './learn.mjs';
import { claudeLimits } from './bridge.mjs';
import { search as searchMemory } from './memory.mjs';
import { uiPaths, portFor } from './risk.mjs';

const RUNNER = join(dirname(fileURLToPath(import.meta.url)), '..', 'dispatch-runner.mjs');

const SECURITY_LENS = [
  '- access control: every new or changed endpoint, handler or query checks who the caller is and that they own what they touch',
  '- input: user input is validated and never reaches SQL, a shell, a file path or a template unescaped; no raw HTML from users',
  '- data exposure: no ids, emails, tokens or internal errors leak into responses, logs or public files',
  '- secrets: no keys, credentials or .env values in the change',
  '- dependencies: every new package is needed, maintained, and pinned the way the project pins',
  '- CI, deploy, migrations: the change does what the task needs and nothing else; a migration is reversible or says why not',
  'Block (SECURITY=FAIL) only on a real problem this change makes; name pre-existing ones in your report.',
];
const UX_LENS = [
  '- the flow does what the checks promise, with no dead ends',
  '- loading, empty and error states exist and say something useful',
  '- copy is short, plain and consistent with the rest of the app',
  '- accessibility: real buttons and links, labels, focus order, keyboard use, alt text',
  '- it works and fits at phone width, and matches the colours, spacing and type of the components around it',
  'Block (UX=FAIL) only on what a user would actually hit; matters of taste go in your report.',
];

/** How to look at the change in a browser: the app on this run's own port, agent-browser on its own session. */
function visualCheck(cfg, task, role) {
  const port = portFor(task.id, role);
  const serve = cfg.commands?.serve ? `\`${cfg.commands.serve.split('{port}').join(String(port))}\` with PORT=${port}` : `the dev server as AGENTS.md says, on port ${port}`;
  return [
    `If the change shows on a page, look at it: start ${serve}, in the background.`,
    `With the \`agent-browser\` CLI (if installed; \`agent-browser skills get core\` first) open http://localhost:${port}, screenshot it at desktop and phone width, and pass \`--session ${task.id}-${role}\` on every call so no other run drives your browser.`,
    `Do not sign in or submit forms: the app may talk to real services. Close the browser (\`agent-browser --session ${task.id}-${role} close\`) and stop the server when done. No browser at hand: say so in your report.`,
  ];
}
const ROLES = new Set(['builder', 'judge', 'planner']);

function roleInstructions(root, role) {
  const p = join(root, '.claude', 'agents', `ghostship-${role}.md`);
  if (!existsSync(p)) return '';
  return readFileSync(p, 'utf8').replace(/^---[\s\S]*?---\s*/, '').trim();
}

function taskFile(root, id) {
  let names = [];
  try { names = readdirSync(join(root, 'tasks')); } catch { return null; }
  const f = names.find((n) => n.startsWith(`${id}-`));
  return f ? `tasks/${f}` : null;
}

export function writeBrief(root, { state, task, role, attempt, token, depth, changed, report }) {
  const cfg = loadConfig(root);
  const lines = [`# Ghostship brief — ${role}${task ? ` for ${task.id}` : ''}`, ''];
  lines.push('`GS` = `node .ghostship/core/runtime/gs.mjs`. Follow `AGENTS.md`. Ghostship enforces the rules in code; a refusal from `GS` says what to do.', '');
  lines.push('## Your role', roleInstructions(root, role) || `You are the Ghostship ${role}.`, '');
  if (task) {
    const checks = (state.acceptance?.checks || []).filter((c) => task.checks.includes(c.id));
    lines.push('## Task', `- id: ${task.id} — ${task.title}`, `- file: ${taskFile(root, task.id) || '(see tasks/)'}`, `- attempt: ${attempt}/${task.maxAttempts}`,
      `- allowedPaths: ${task.allowedPaths.join(', ')}`, `- test command: ${task.testCommand || '(project default)'}`, '');
    lines.push('## Checks (verbatim)', ...(checks.length ? checks.map((c) => `- ${c.id} [${c.kind}]: ${c.text}`) : ['- none (finding or skeleton task)']), '');
    const notes = task.history.filter((h) => h.reason && ['FAIL', 'BUILDER_GAVE_UP', 'STALLED', 'MERGE_CONFLICT', 'REWORK'].includes(h.outcome));
    if (notes.length && role === 'builder') lines.push('## Earlier attempts', ...notes.map((h) => `- attempt ${h.attempt} ${h.outcome}: ${h.reason}`), '');
    const owner = task.history.filter((h) => h.outcome === 'OWNER_NOTE' && h.reason);
    if (owner.length && role === 'builder') lines.push('## The owner\'s notes (address every one)', ...owner.map((h) => `- after attempt ${h.attempt}: ${h.reason}`), '');
    if (role === 'builder') {
      lines.push('## Assumptions', 'Where the task or the checks leave a decision open, make the smallest reasonable choice and record it: `GS assume --task ' + task.id + ' --text "what you assumed, and why"`. Add `--product` when it is really a product or business decision (pricing, public copy, what is free or paid, who may see what): the owner then sees the work before it merges.', '');
      // A task with something to look at: the planner said so (ui: true), or its allowedPaths name UI files (src/**/*.vue).
      if (task.ui === true || task.allowedPaths.some((p) => uiPaths(cfg, [p.replace(/\*+/g, 'x')]).length)) {
        lines.push('## Visual check', ...visualCheck(cfg, task, 'builder'), '');
      }
    }
  }
  if (role === 'judge') {
    if (!token) fail('NO_TOKEN', 'A judge run needs the token from `gs task submit`.');
    lines.push('## Judging', '- token: in your prompt (never written to disk)', `- depth: ${depth || 'light'}`, `- changed files: ${(changed || []).join(', ') || '(see git diff)'}`, '');
    const sub = task?.submit || {};
    if (sub.risky?.length) lines.push('## Risky paths', 'These changed files make the task risky. Whatever you decide, the owner sees it before it merges.', ...sub.risky.map((r) => `- ${r.path} (${r.why})`), '');
    if (sub.conflicts?.length) lines.push('## Conflicts', `This branch already conflicts with develop in: ${sub.conflicts.join(', ')}. Judge it anyway; the merge will stop for a decision.`, '');
    if ((sub.lenses || []).includes('SECURITY')) lines.push('## Lens: SECURITY (required)', 'Review the change for these, then add `--check "SECURITY=PASS|FAIL — what you checked"` to your verdict. A PASS verdict is refused without SECURITY=PASS.', ...SECURITY_LENS, '');
    if ((sub.lenses || []).includes('UX')) lines.push('## Lens: UX (required)', 'Review what a user sees, then add `--check "UX=PASS|FAIL — what you checked"` to your verdict. A PASS verdict is refused without UX=PASS.', ...UX_LENS, '', ...visualCheck(cfg, task, 'judge'), '');
    const assumed = task?.assumptions || [];
    if (assumed.length) lines.push('## Assumptions the builder recorded', 'If one is really a product decision and is not marked so, record it again yourself with `--product`.', ...assumed.map((a) => `- ${a.product ? '(product) ' : ''}${a.text}`), '');
  }
  const learned = briefRules(root);
  if (learned.length && role !== 'judge') lines.push('## Rules learned in this project (follow them)', ...learned.map((r) => `- ${r.id}: ${r.text}`), '');
  const hits = searchMemory(root, [task?.title, ...(task?.allowedPaths || []), ...(task?.checks || []).map((c) => (state.acceptance?.checks || []).find((x) => x.id === c)?.text)].filter(Boolean).join(' '), { limit: 10 });
  if (hits.length) lines.push('## Relevant memory', ...hits.map((h) => `- (${h.kind}) ${h.line}`), '');
  lines.push('## When you finish', `Write your report (≤10 lines, as your role describes) to \`${report}\`, then stop.`);
  const rel = report.replace(/\.report\.md$/, '.brief.md');
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), lines.join('\n') + '\n');
  return rel;
}

/**
 * The argv for a Claude agent Ghostship starts in a herdr tab. Mirrors the headless posture (acceptEdits + the
 * role's allow-list) so the agent can work with no human in the tab, and keeps `--remote-control` a bare flag —
 * the herdr agent name is given to `herdr agent start`, never as a positional that Claude would read as a prompt.
 */
export function safeTabClaudeArgs({ model, name, remoteControl, role, skipPermissions }) {
  const args = [];
  if (model) args.push('--model', model);
  // skipPermissions (owner opt-in): launch with --dangerously-skip-permissions so no prompt waits for a human in the
  // tab. Ghostship's guard + riskhold are PreToolUse hooks and still run under it, so secrets/scope/locks stay enforced.
  if (skipPermissions) args.push('--dangerously-skip-permissions', '-n', name);
  else args.push('--permission-mode', 'acceptEdits', '-n', name, '--allowedTools', ...allowedTools(role));
  if (remoteControl) args.push('--remote-control');
  return args;
}

/** Decide who runs this and how, without starting anything. */
export function plan(root, { task: id, role, token, depth, agent: forced, which, env = process.env, preview = false, cfg: cfgOverride = null } = {}) {
  if (!ROLES.has(role)) fail('BAD_ROLE', 'role is builder, judge or planner');
  const state = load(root);
  const cfg = cfgOverride || loadConfig(root); // the autopilot runner passes the config with dispatch forced headless
  let task = null;
  if (role !== 'planner') {
    task = state.tasks?.[id];
    if (!task) fail('UNKNOWN_TASK', `No task ${id}`);
    if (role === 'builder' && task.status !== 'BUILDING') fail('NOT_BUILDING', `${id} is ${task.status}: gs task start ${id} first`);
    if (role === 'judge' && task.status !== 'JUDGING') fail('NOT_JUDGING', `${id} is ${task.status}`);
  }
  const attempt = task?.attempt || 1;
  const tier = tierFor(cfg, { role, task: task || {}, attempt, maxAttempts: task?.maxAttempts || 3 });
  const detected = detect({ which, extra: Object.fromEntries(Object.entries(cfg.harnesses || {}).map(([k, v]) => [k, { bins: v.bins || (v.bin ? [v.bin] : undefined) }])) });
  const herdr = cfg.herdr?.use !== 'off' && herdrAvailable(env);
  let pick;
  if (forced) {
    const a = cfg.agents?.[forced];
    if (!a) fail('UNKNOWN_AGENT', `No agent ${forced} under agents`);
    const one = { ...cfg, routing: { ...cfg.routing, tiers: { ...cfg.routing.tiers, __forced: [forced] } } };
    pick = { ...pickAgent(one, '__forced', { detected, herdr, quota: loadQuota(root) }), tier };
  } else pick = pickAgent(cfg, tier, { detected, herdr, quota: loadQuota(root), claude: claudeLimits(root) });
  if (!pick.agentId) return { role, task: id || null, tier, agentId: null, skipped: pick.skipped, wait: pick.wait };
  const agent = pick.agent;
  const provider = cfg.providers[agent.provider] || {};
  const runId = `${(id || 'plan').toLowerCase()}-a${attempt}-${role}-${randomBytes(3).toString('hex')}`;
  const base = `${RUNS_DIR}/${id || '_plan'}/a${attempt}-${role}`;
  const report = `${base}.report.md`;
  const out = { runId, role, task: id || null, attempt, tier, note2: pick.note || null, agentId: pick.agentId, model: agent.model || null, harness: agent.harness, mode: pick.mode, skipped: pick.skipped, report, log: `${base}.log` };
  if (pick.mode === 'in-session') return { ...out, brief: null, note: `Use the Agent tool: subagent_type ghostship-${role}, model ${agent.model}.` };
  const brief = preview ? report.replace(/\.report\.md$/, '.brief.md') : writeBrief(root, { state, task, role, attempt, token, depth, changed: task?.submit?.changed, report });
  const viaGateway = provider.type === 'gateway';
  const remoteControl = cfg.launch?.remoteControl !== 'off' && agent.harness === 'claude' && provider.type === 'claude-login';
  const skipPermissions = cfg.launch?.skipPermissions === true && agent.harness === 'claude';
  const name = agentName(id || null, role, attempt, role === 'planner' ? 'tasks' : task?.title || '');
  // The human name on the herdr tab, the Claude session (-n) and the run record.
  const label = runLabel({ task: id || null, role, attempt, title: role === 'planner' ? 'tasks from the acceptance checks' : task?.title || '' });
  const prompt = `Read ${brief} and follow it exactly.${role === 'judge' && token ? ` Your one-time judge token is ${token}.` : ''} When done, write your report to ${report}.`;
  const cmd = commandFor({ harness: agent.harness, cfgHarness: cfg.harnesses?.[agent.harness], mode: pick.mode, vars: { model: agent.model || '', prompt, name: label, root, role, skipPermissions } });
  if (cmd.error) fail('NO_COMMAND', cmd.error);
  // A Claude agent in a herdr tab runs with --no-focus: no human is there to answer a permission prompt, so an
  // interactive Claude would block on its first Edit/Write/Bash and never build. Give it the same non-interactive
  // posture a headless run has — acceptEdits plus the role's scoped allow-list. acceptEdits is NOT a permission
  // bypass (it only auto-accepts file edits; it is the mode the headless builder already uses), so the
  // "Ghostship never bypasses permissions" rule still holds. Owner templates (cfgHarness.args) are left as the owner wrote them.
  if (pick.mode === 'tab' && agent.harness === 'claude' && !cmd.ownerTemplate) {
    cmd.args = safeTabClaudeArgs({ model: agent.model, name: label, remoteControl: remoteControl && !viaGateway, role, skipPermissions });
  }
  const envNames = Object.entries(provider.env || {}).map(([k, v]) => ({ var: k, secret: v }));
  return { ...out, brief, name, label, prompt, bin: cmd.bin, args: cmd.args, herdrKind: cmd.herdrKind || null, viaGateway, remoteControl: remoteControl && !viaGateway,
    envNames, bypassNote: cmd.bypassNote, workspaceLabel: cfg.project?.name || 'ghostship', closeTab: cfg.herdr?.['close-tabs'] !== false, timeoutMin: cfg.dispatch?.['timeout-min'] || 45, notes: viaGateway ? ['Remote Control is off for this run: it needs a claude.ai login, not the gateway.'] : [] };
}

export function start(root, p, { runner = RUNNER } = {}) {
  if (!p.agentId) fail('NO_AGENT', 'No agent available: ' + (p.skipped || []).map((s) => `${s.agent}: ${s.reason}`).join('; '));
  if (p.mode === 'in-session') fail('IN_SESSION', p.note);
  if (isPaused(root)) fail('PAUSED', 'Ghostship is paused. The owner resumes with gs go.');
  const live = liveRun(root);
  if (live && live.status === 'running') fail('RUN_ACTIVE', `${live.runId} (${live.role} ${live.task || ''}) is still running. gs run wait, or gs run stop.`);
  const prev = readActive(root);
  if (prev?.status === 'lost') fail('RUN_LOST', `${prev.runId} lost its supervisor. Check it, then gs run clear.`);
  // The prompt can carry a judge token: it travels to the runner in its environment, never into a project file.
  const MARK = '\u0000GS_PROMPT\u0000';
  const { prompt, ...rest } = p;
  const args = (p.args || []).map((a) => (prompt && a.includes(prompt) ? a.split(prompt).join(MARK) : a));
  writeActive(root, { ...rest, args, status: 'starting', startedAt: new Date().toISOString() });
  const child = spawn(process.execPath, [runner, root, p.runId], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, GS_RUN_PROMPT: prompt || '' } });
  child.unref();
  writeActive(root, { ...readActive(root), status: 'running', supervisorPid: child.pid });
  return readActive(root);
}
