// `gs next`: the one answer to "what now". Reads the project and returns ONE step, so the orchestrator, the Stop hook,
// the headless autopilot runner and the Bridge never disagree about what happens next. Pure read, save that in
// autopilot/full it first settles task decisions that were still waiting for the owner (engine.settleDecisions).
//
// kind: do     — a step the orchestrator performs itself (a gs command, or a document to write)
//       agent  — fresh builder / judge / planner work (brief = the gs brief command that yields the prompt)
//       owner  — only the owner can do it (a gate); the loop waits here
//       wait   — something is in flight (an outside run, a night-shift pause); poll later
//       done   — released, nothing left to do
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load, exists as stateExists } from './store.mjs';
import { loadConfig, autonomyOf } from './config.mjs';
import { activeTask, frontier, waitingOnParked, settleDecisions, acceptanceLint, coverage, isPaused, DESIGN_FILES } from './engine.mjs';
import { coverageSummary } from './interview.mjs';
import { treeHash } from './git.mjs';
import { readActive, alive } from './runs.mjs';
import { runLabel } from './herdr.mjs';
import { check as docsCheck } from './docs.mjs';
import { DOCS, DRAFTS_DIR, ACCEPTANCE_TESTS_DIR } from './paths.mjs';

export const GS = 'node .ghostship/core/runtime/gs.mjs';
const gs = (args) => `${GS} ${args}`;
const read = (root, rel) => { try { return existsSync(join(root, rel)) ? readFileSync(join(root, rel), 'utf8') : null; } catch { return null; } };
const has = (root, rel, min = 40) => { const t = read(root, rel); return t !== null && t.trim().length >= min; };

const step = (kind, id, say, why, extra = {}) => ({ kind, id, say, why, ...extra });
const doStep = (id, say, why, command, extra = {}) => step('do', id, say, why, { ...(command ? { command } : {}), ...extra });
const ownerStep = (id, say, why, gate, command) => step('owner', id, say, why, { owner: { gate, command } });
const agentStep = (id, say, why, role, task, extra = {}) => step('agent', id, say, why, { role, task: task || null, brief: gs(`brief --role ${role}${task ? ` --task ${task}` : ''}${extra.depth ? ` --depth ${extra.depth}` : ''}${role === 'judge' ? ' --token <token>' : ''}`), ...extra });

/** The judge's depth, as routing picks it: full for risky work (planned high, or risky paths changed) or a last attempt, else light. */
export function judgeDepth(cfg, t) {
  // Risky paths in the submission always get the full judge, whatever judge.depth says.
  if (t.submit?.risky?.length) return 'full';
  const d = cfg.judge?.depth;
  if (d === 'full' || d === 'light') return d;
  return t.risk === 'high' || t.attempt >= t.maxAttempts ? 'full' : 'light';
}

/** The evidence a submit needs on the current tree (mirrors engine.taskSubmit), and what is still missing. */
function missingEvidence(cfg, state, t, tree) {
  const run = new Set((state.acceptance?.checks || []).filter((c) => c.kind === 'run').map((c) => c.id));
  const need = ['green'];
  if (t.checks.some((c) => run.has(c)) && cfg.commands.acceptance) need.push('acceptance');
  if (cfg.commands.test) need.push('regression');
  if (cfg.commands.lint) need.push('lint');
  if (cfg.commands.typecheck) need.push('typecheck');
  return need.filter((k) => {
    const e = t.evidence?.[k];
    const viaGreen = k === 'regression' && t.evidence?.green?.tree === tree && t.evidence.green.command === cfg.commands.test;
    return !(e && e.tree === tree) && !viaGreen;
  });
}

function acceptanceTestsMissing(root, state) {
  const ids = (state.acceptance?.checks || []).filter((c) => c.kind === 'run').map((c) => c.id);
  let files = [];
  try { files = readdirSync(join(root, ACCEPTANCE_TESTS_DIR)); } catch { /* none yet */ }
  return ids.filter((id) => !files.some((f) => f.startsWith(`${id}-`)));
}

function drafts(root) {
  try { return readdirSync(join(root, DRAFTS_DIR, 'tasks')).filter((f) => f.endsWith('.md')); } catch { return []; }
}

export function next(root) {
  const n = nextStep(root);
  if (n && n.kind === 'agent') {
    // One name everywhere: the Agent tool's description, the herdr tab, the Claude session.
    let title = '';
    try { title = n.task ? load(root).tasks?.[n.task]?.title || '' : 'tasks from the acceptance checks'; } catch { /* no title */ }
    let attempt = 1;
    try { attempt = n.task ? load(root).tasks?.[n.task]?.attempt || 1 : 1; } catch { /* first */ }
    n.label = runLabel({ task: n.task, role: n.role, attempt, title });
  }
  return n;
}

function nextStep(root) {
  if (!stateExists(root)) return ownerStep('init', 'Set Ghostship up in this folder (/ghostship init)', 'no .ghostship/state here', 'init', `node ~/.ghostship/core/runtime/gs.mjs init`);
  const cfg = loadConfig(root);
  const a = autonomyOf(cfg);
  if (a.mode !== 'guided') { try { settleDecisions(root); } catch { /* the next call tries again */ } }
  const state = load(root);

  // Helm first: nothing starts while paused. A night-shift pause lifts by itself; an owner's pause needs the owner.
  const pz = isPaused(root);
  if (pz) {
    if (pz.kind === 'night-shift') {
      const secs = pz.resumeAt ? Math.max(60, Math.min(3600, Math.round((Date.parse(pz.resumeAt) - Date.now()) / 1000))) : 600;
      return step('wait', 'night-shift', `Night shift: wait for the Claude plan to reset (${pz.reason})`, 'the 5h limit was reached; Ghostship resumes by itself', { wait: { seconds: secs } });
    }
    return ownerStep('paused', `Resume work (gs go) — paused: ${pz.reason}`, 'an owner pause lifts only when the owner says so', 'go', gs('go'));
  }

  // An outside agent run in flight: wait for it; one whose supervisor died needs clearing.
  const run = readActive(root);
  if (run && (run.status === 'running' || run.status === 'starting')) {
    if (run.status === 'running' && !alive(run.supervisorPid)) return doStep('run.lost', `The ${run.role} run ${run.runId} lost its supervisor: check git status, then clear it (gs run clear)`, 'a run file says running but its process is gone', gs('run clear'), { task: run.task || null });
    return step('wait', 'run.wait', `Wait for the ${run.role}${run.task ? ` on ${run.task}` : ''} (${run.agentId}) to finish`, `run ${run.runId} is ${run.status}`, { wait: { seconds: 20 }, task: run.task || null, role: run.role });
  }

  // ---------------------------------------------------------------- discover: interview → PRD
  if (state.stage === 'new' || state.stage === 'adopt') {
    if (!state.interview) return doStep('interview.init', 'Start the interview (gs interview init)', 'no coverage areas yet', gs('interview init'));
    const open = coverageSummary(state.interview).open;
    if (open.length) return ownerStep('interview', `Interview the owner: ${open.length} area${open.length === 1 ? '' : 's'} open (${open.slice(0, 4).join(', ')}${open.length > 4 ? ' …' : ''}), in rounds of 3–5 questions`, 'the PRD needs every coverage area closed', 'interview', gs('interview mark <area> answered --note "…"'));
    if (!has(root, DOCS.prdDraft) && !has(root, DOCS.prd)) return doStep('prd.write', `Write the PRD draft at ${DOCS.prdDraft}`, 'every coverage area is closed and no PRD exists', null, { path: DOCS.prdDraft });
    return ownerStep('prd.approve', `The owner approves the PRD (gs prd approve)`, 'the PRD is always the owner\'s to approve', 'prd', gs('prd approve'));
  }

  // ---------------------------------------------------------------- design
  if (state.stage === 'design') {
    const need = DESIGN_FILES[cfg.project?.tier] || DESIGN_FILES.standard;
    const missing = need.filter((f) => !has(root, `${DOCS.design}/${f}`));
    if (missing.length) return doStep('design.write', `Write the design: ${missing.map((f) => `${DOCS.design}/${f}`).join(', ')}`, `tier ${cfg.project?.tier || 'standard'} needs ${need.join(', ')}`, null, { path: `${DOCS.design}/${missing[0]}`, paths: missing.map((f) => `${DOCS.design}/${f}`) });
    return doStep('design.done', 'Close the design (gs design done)', 'every design document is written', gs('design done'));
  }

  // ---------------------------------------------------------------- acceptance: STOP 1
  if (state.stage === 'acceptance' || !state.acceptance?.approved) {
    if (!has(root, DOCS.acceptanceDraft) && !has(root, DOCS.acceptance)) return doStep('acceptance.write', `Write the acceptance checks at ${DOCS.acceptanceDraft}`, 'the checks are the contract STOP 1 approves', null, { path: DOCS.acceptanceDraft });
    const lint = acceptanceLint(root);
    if (!lint.ok) return doStep('acceptance.lint', `Fix the acceptance checks, then lint them (gs acceptance lint): ${lint.errors[0]}${lint.errors.length > 1 ? ` (+${lint.errors.length - 1} more)` : ''}`, 'lint must pass before STOP 1', gs('acceptance lint'), { errors: lint.errors });
    if (a.mode === 'full') return doStep('acceptance.approve', `Approve the acceptance checks by policy (gs acceptance approve --auto)`, 'full autonomy passes STOP 1 once lint is clean', gs('acceptance approve --auto'));
    return ownerStep('acceptance.approve', `STOP 1: the owner approves the acceptance checks (gs acceptance approve)`, `${lint.contract.checks.length} checks pass lint`, 'acceptance', gs('acceptance approve'));
  }

  // ---------------------------------------------------------------- plan / build / release
  const tasks = Object.values(state.tasks || {});
  const needs = tasks.filter((t) => t.status === 'NEEDS_DECISION');
  if (needs.length) {
    const t = needs[0];
    if (t.hold) return ownerStep('decide', `You decide on ${t.id}: it passed and waits for you before merging — gs decide ${t.id} --merge | --grant 1 --note "…" | --drop`, t.hold.reason.slice(0, 200), 'decide', gs(`decide ${t.id} --merge | --grant 1 --note "…" | --drop`));
    return ownerStep('decide', `You decide: gs decide ${t.id} --grant 1 | --drop`, `${t.id} used ${t.attempt}/${t.maxAttempts} attempts (${(t.history.at(-1)?.reason || 'no reason recorded').slice(0, 120)})`, 'decide', gs(`decide ${t.id} --grant 1 | --drop`));
  }
  const act = activeTask(state);
  if (act) {
    if (act.status === 'BUILDING') {
      const tree = treeHash(root);
      const missing = missingEvidence(cfg, state, act, tree);
      if (!missing.length) return doStep('submit', `Submit ${act.id} for judging (gs task submit ${act.id}); keep the token for the judge only`, 'every piece of evidence is recorded on the current tree', gs(`task submit ${act.id}`), { task: act.id });
      const setup = act.setup || act.skeleton;
      const phase = setup ? 'setup task: make the build, lint and tests pass, then evidence --kind green (no failing test first)'
        : act.red || act.noTdd ? `implement, then record ${missing.map((k) => `evidence --kind ${k}`).join(', ')}` : 'write a failing test, record evidence --kind red, then implement';
      return agentStep('builder', `Fresh builder on ${act.id} (attempt ${act.attempt}/${act.maxAttempts}): ${phase}`, `${act.id} is BUILDING; missing evidence: ${missing.join(', ')}`, 'builder', act.id, { attempt: act.attempt });
    }
    if (act.status === 'JUDGING') {
      const depth = judgeDepth(cfg, act);
      return agentStep('judge', `Fresh judge on ${act.id} (depth ${depth}) with the token submit printed; lost it → gs task reissue ${act.id}`, `${act.id} is JUDGING`, 'judge', act.id, { depth, reissue: gs(`task reissue ${act.id}`) });
    }
    if (act.status === 'PASSED') return doStep('merge', `Merge ${act.id} (gs task merge ${act.id})`, 'the judge passed it', gs(`task merge ${act.id}`), { task: act.id });
  }
  if (drafts(root).length) return doStep('task.import', `Import the task drafts (gs task import)`, `${drafts(root).length} draft(s) in ${DRAFTS_DIR}/tasks`, gs('task import'));
  if (!tasks.length) return agentStep('plan.write', 'Fresh planner: write task drafts from the acceptance checks, then they are imported', 'the checks are approved and no task exists', 'planner', null);
  const fr = frontier(state);
  const lockCurrent = state.acceptanceLock && (state.acceptanceLock.rev || 1) >= (state.acceptance.rev || 1);
  if (!lockCurrent) {
    const setupId = fr.find((id) => state.tasks[id].skeleton || state.tasks[id].setup);
    if (setupId) return doStep('task.start', `Start the setup task ${setupId} (gs task start ${setupId}); it may run before the acceptance tests are locked`, 'the runners must exist before the acceptance tests can fail for the right reason', gs(`task start ${setupId}`), { task: setupId });
    const missing = acceptanceTestsMissing(root, state);
    if (missing.length) return doStep('acceptance.tests', `Write ${ACCEPTANCE_TESTS_DIR}/<C#>-* for ${missing.join(', ')} (they must fail now)`, 'every run check needs a locked acceptance test', null, { path: ACCEPTANCE_TESTS_DIR, checks: missing });
    return doStep('acceptance.lock', 'Lock the acceptance tests (gs acceptance lock)', 'every run check has a test file', gs('acceptance lock'));
  }
  const cov = coverage(root);
  if (cov.uncoveredRun.length) return agentStep('plan.write', `Fresh planner: plan tasks for ${cov.uncoveredRun.join(', ')}`, 'run checks without a task', 'planner', null, { checks: cov.uncoveredRun });
  if (fr.length) return doStep('task.start', `Start ${fr[0]} (gs task start ${fr[0]})`, `ready: ${fr.join(', ')}`, gs(`task start ${fr[0]}`), { task: fr[0] });
  if (state.release) return ownerStep('release.approve', `STOP 2: the owner reviews ${state.release.packet} and approves the release (gs release approve)`, `candidate v${state.release.version} is ${state.release.result}`, 'release', gs('release approve'));
  const waiting = new Set(waitingOnParked(state));
  const settled = tasks.every((t) => ['MERGED', 'DROPPED', 'PARKED'].includes(t.status) || waiting.has(t.id));
  if (settled) {
    const last = (state.releases || []).at(-1);
    const sinceRelease = last ? tasks.some((t) => t.merged?.at && t.merged.at > last.approvedAt) : true;
    if (last && !sinceRelease && !state.change) return step('done', 'done', `Released ${last.tag}; nothing left to do`, 'every task is merged and shipped');
    if (cfg.docs?.['release-gate'] !== false) {
      const dc = docsCheck(root);
      if (!dc.ok) return doStep('docs.check', `Fill the release docs, then gs docs check: ${[...dc.missing, ...dc.unfilled].slice(0, 4).join(', ')}${dc.missing.length + dc.unfilled.length > 4 ? ' …' : ''}`, 'the release ships its docs', gs('docs check'), { missing: dc.missing, unfilled: dc.unfilled });
    }
    const parked = tasks.filter((t) => t.status === 'PARKED').map((t) => t.id);
    return doStep('release.candidate', `Prepare the release candidate: gs release candidate${parked.length ? ` (${parked.length} parked for STOP 2: ${parked.join(', ')})` : ''}`, 'every task is merged, dropped or parked', gs('release candidate'), { parked });
  }
  return ownerStep('blocked', 'Blocked: check gs status --json', `tasks: ${tasks.map((t) => `${t.id}=${t.status}`).join(', ')}`, 'decide', gs('status --json'));
}

/** `gs next` as text: the step, the fact behind it, and the command or brief to use. */
export function text(n) {
  const lines = [`→ ${n.say}`, `   ${n.why}`];
  if (n.command) lines.push(`   $ ${n.command}`);
  if (n.brief) lines.push(`   prompt: ${n.brief}`);
  if (n.owner) lines.push(`   owner: ${n.owner.command}`);
  if (n.wait) lines.push(`   poll again in ${n.wait.seconds}s`);
  return lines.join('\n');
}
