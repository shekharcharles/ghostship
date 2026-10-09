// Ghostship lifecycle engine: new/adopt → design → acceptance → plan → build → release.
// Every rule is enforced here, in code. Agents call it through gs.mjs; nothing is trusted from prose.
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { sha256, matchesAny, redact, detectSkips, nowIso } from './util.mjs';
import {
  headCommit, treeHash, changedPaths, blobInTree, diffStat, tryGit, gitRun, currentBranch, branchExists,
  dirtyPaths, hasIdentity, listTree, commitWork, mergeConflicts,
} from './git.mjs';
import { riskyPaths, uiPaths, lensesFor } from './risk.mjs';
import { load, mutate, fail, verifyEventChain } from './store.mjs';
import { loadConfig, autonomyOf } from './config.mjs';
import { lintContract, parseContract } from './contract.mjs';
import { newCoverage, markArea, coverageSummary } from './interview.mjs';
import { parseTaskFile, renderTaskFile, slugify } from './tasks.mjs';
import { nextVersion, changelogSection, conventionalMessage } from './release.mjs';
import { buildCodemap, missingPurposeHeaders, purposeOf } from './codemap.mjs';
import { liveRun } from './runs.mjs';
import { add as remember } from './memory.mjs';
import { observe as learnObserve, tickAttempt } from './learn.mjs';
import { check as docsCheck, traceability, scaffold as scaffoldDocs } from './docs.mjs';
import { buildSite, packSite } from './docsite.mjs';
import { next as nextStep } from './next.mjs';

import { DOCS, EVIDENCE_DIR, DRAFTS_DIR, TASKS_DIR, BOARD_FILE, ACCEPTANCE_TESTS_DIR, STATE_DIR, TREE_EXCLUDES } from './paths.mjs';

export const TEST_GLOBS = [
  '**/*.test.*', '**/*.spec.*', '**/test/**', '**/tests/**', '**/__tests__/**',
  '**/test_*.py', '**/*_test.py', '**/*_test.go', '**/*Test.java', '**/*Tests.cs',
];
export const ACTIVE = new Set(['BUILDING', 'JUDGING', 'PASSED']);
export const SETUP_NO_TDD = 'setup task: build, lint and tests must pass';
const STAGES = ['new', 'adopt', 'design', 'acceptance', 'plan', 'build', 'release'];
const PROTECTED_PREFIXES = ['.ghostship/', '.claude/', '.git/', 'tasks/', 'tests/acceptance/', 'docs/01-requirements/PRD', 'docs/03-acceptance/'];
const TOO_BROAD = new Set(['**', '*', '.', '/', './', '**/*', '']);
const BOOKKEEPING = ['.ghostship/state', '.ghostship/evidence', '.ghostship/learned', 'tasks', 'docs/11-memory'];
const isTest = (p) => matchesAny(p, TEST_GLOBS);
const read = (root, rel) => (existsSync(join(root, rel)) ? readFileSync(join(root, rel), 'utf8') : null);
const put = (root, rel, text) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };

// ------------------------------------------------------------------ shared guards

export function activeTask(state) {
  return Object.values(state.tasks || {}).find((t) => ACTIVE.has(t.status)) || null;
}

function taskOr(state, id) {
  const t = state.tasks?.[id];
  if (!t) fail('UNKNOWN_TASK', `No task ${id}`);
  return t;
}

export function humanGate(cfg, gate = {}) {
  const mode = cfg.approvals?.mode || 'terminal';
  if (gate.via === 'tty' && gate.confirmed === true) return { via: 'tty' };
  // Set only by the CLI after it verified the owner key a Bridge press carries (gs.mjs gate()).
  if (mode === 'bridge' && gate.via === 'bridge' && gate.confirmed === true) return { via: 'bridge' };
  if (mode === 'chat' && gate.via === 'chat' && typeof gate.quote === 'string' && gate.quote.trim()) {
    return { via: 'chat', quote: gate.quote.trim().slice(0, 500) };
  }
  if (mode === 'terminal') fail('HUMAN_GATE', 'This decision needs you at a terminal: run the same gs command yourself in an interactive shell.');
  if (mode === 'bridge') fail('HUMAN_GATE', 'This decision needs the owner: they press it in the Bridge pane (/gs-bridge), or run the same gs command in their own terminal.');
  fail('HUMAN_GATE', 'This decision needs the owner: pass --quote "<the owner\'s exact words approving it>".');
}

function assertDocLocked(root, state, key, label) {
  const lock = state[key];
  if (!lock?.approved) return;
  const cur = read(root, lock.path);
  if (cur === null || sha256(cur) !== lock.sha) fail(`${key.toUpperCase()}_CHANGED`, `${lock.path} changed after approval. Restore it with git, or reopen it through /ghostship change. (${label})`);
}

function assertLocks(root, state) {
  assertDocLocked(root, state, 'prd', 'PRD');
  assertDocLocked(root, state, 'acceptance', 'acceptance checks');
}

function needAcceptance(state) {
  if (!state.acceptance?.approved) fail('ACCEPTANCE_NOT_APPROVED', 'Acceptance checks are not approved yet (STOP 1).');
}

function locksMismatch(root, tree, locks) {
  return Object.entries(locks || {}).filter(([p, blob]) => blobInTree(root, tree, p) !== blob).map(([p]) => p);
}

function acceptanceDrift(root, state, tree) {
  if (!state.acceptanceLock) return [];
  const bad = locksMismatch(root, tree, state.acceptanceLock.files);
  const now = listTree(root, tree).filter((p) => p.startsWith(ACCEPTANCE_TESTS_DIR + '/'));
  for (const p of now) if (!(p in state.acceptanceLock.files)) bad.push(p);
  return bad;
}

/** While an outside builder process is still running it must not be able to submit or see a verdict path. */
function assertNoLiveBuilder(root, id) {
  const r = liveRun(root);
  if (!r || r.role !== 'builder' || (id && r.task !== id)) return;
  if (r.status === 'running' || r.status === 'starting') fail('BUILDER_RUNNING', `The builder run ${r.runId} is still running. Wait for it (gs run wait) before submitting or judging.`);
  if (r.status === 'lost') fail('BUILDER_LOST', `The builder run ${r.runId} lost its supervisor. Check that its process is gone, then gs run clear.`);
}

/** The owner's pause flag (helm): no new task or outside run starts while it is set. */
export function isPaused(root) {
  try { return JSON.parse(readFileSync(join(root, '.ghostship/runs/pause.json'), 'utf8')); } catch { return null; }
}

function retryOrEscalate(t, s, cfg, why) {
  t.submit = null;
  if (t.attempt < t.maxAttempts) { t.status = 'RETRY'; return; }
  escalate(t, s, cfg, why || `used ${t.attempt}/${t.maxAttempts} attempts`);
}

/**
 * Where a task would wait for the owner. guided: NEEDS_DECISION, the owner decides. autopilot and full: the policy decides,
 * so the loop never stops for it: auto-retries more attempts, then PARKED (skipped with its dependents, listed at STOP 2).
 */
function escalate(t, s, cfg, why) {
  const a = autonomyOf(cfg);
  if (a.mode === 'guided') { t.status = 'NEEDS_DECISION'; return; }
  const at = nowIso();
  if ((t.autoGrants || 0) < a.autoRetries) {
    t.autoGrants = (t.autoGrants || 0) + 1;
    t.maxAttempts = Math.max(t.maxAttempts, t.attempt) + 1;
    t.status = 'RETRY';
    t.history.push({ attempt: t.attempt, outcome: 'AUTO_GRANT', reason: `autopilot granted 1 more attempt (${t.autoGrants}/${a.autoRetries}): ${why}`, at });
    (s.decisions = s.decisions || []).push({ task: t.id, grant: 1, gate: { via: 'autopilot' }, reason: why, at });
    return;
  }
  t.status = 'PARKED';
  t.parked = { at, reason: why };
  t.history.push({ attempt: t.attempt, outcome: 'PARKED', reason: `autopilot parked it: ${why}`, at });
}

/**
 * In autopilot/full, a decision still waiting (from guided mode, or from a core before autopilot) goes through the same
 * policy as a new one: one more attempt while auto-retries remain, else parked. Guided leaves it with the owner.
 */
export function settleDecisions(root) {
  let state;
  try { state = load(root); } catch { return []; }
  const cfg = loadConfig(root);
  if (autonomyOf(cfg).mode === 'guided') return [];
  const waiting = Object.values(state.tasks || {}).filter((t) => t.status === 'NEEDS_DECISION').map((t) => t.id);
  for (const id of waiting) {
    change(root, 'autopilot.settle', id, {}, (s) => {
      const x = s.tasks[id];
      // A judged PASS held for the owner keeps its work: it waits at STOP 2 instead of being built again.
      if (x.hold) { x.status = 'PARKED'; x.parked = { at: nowIso(), reason: `held for the owner: ${x.hold.reason}` }; return x; }
      escalate(x, s, cfg, 'a decision was waiting when autopilot took over'); return x;
    });
    noteParked(root, id);
  }
  return waiting;
}

/** A second event for the record when a change parked the task, so the log says it plainly. */
function noteParked(root, id) {
  try {
    const t = load(root).tasks[id];
    if (t?.status === 'PARKED' && !t.parked?.logged) mutate(root, 'task.park', id, { reason: t.parked?.reason || '' }, (s) => { s.tasks[id].parked = { ...s.tasks[id].parked, logged: true }; });
  } catch { /* the task file still says it */ }
  return load(root).tasks[id];
}

/** Tasks that cannot start because something they wait on (directly or further up) is parked. */
export function waitingOnParked(state) {
  const tasks = state.tasks || {};
  const memo = {};
  const stuck = (id, seen = new Set()) => {
    if (id in memo) return memo[id];
    if (seen.has(id)) return false;
    seen.add(id);
    const t = tasks[id];
    if (!t) return (memo[id] = false);
    return (memo[id] = (t.blockedBy || []).some((b) => tasks[b]?.status === 'PARKED' || stuck(b, seen)));
  };
  return Object.values(tasks).filter((t) => (t.status === 'TODO' || t.status === 'RETRY') && stuck(t.id)).map((t) => t.id);
}

// ------------------------------------------------------------------ task files + board

function taskFileRel(t) { return `${TASKS_DIR}/${t.id}-${slugify(t.title || t.id)}.md`; }

function writeTaskFiles(root, state) {
  for (const t of Object.values(state.tasks || {})) {
    const meta = {
      id: t.id, title: t.title, phase: t.phase, kind: t.kind, scope: t.scope, status: t.status, tier: t.tier, risk: t.risk,
      checks: t.checks, requirement: t.requirement, blockedBy: t.blockedBy, allowedPaths: t.allowedPaths,
      testCommand: t.testCommand || undefined, noTdd: t.noTdd || undefined, finding: t.finding || undefined,
      skeleton: t.skeleton || undefined, setup: t.setup || undefined, ui: t.ui || undefined, attempt: t.attempt, maxAttempts: t.maxAttempts, branch: t.branch || undefined,
    };
    const notes = t.history.filter((h) => h.outcome === 'FAIL' && h.reason).map((h) => `attempt ${h.attempt}: ${h.reason}`);
    const hist = t.history.map((h) => `${h.at} attempt ${h.attempt}: ${h.outcome}${h.reason ? ` — ${h.reason}` : ''}`);
    put(root, taskFileRel(t), renderTaskFile(meta, t.sections || {}, { judgeNotes: notes, history: hist }));
  }
  const rows = Object.values(state.tasks || {}).sort((a, b) => a.id.localeCompare(b.id));
  const board = ['# Task board', '', '_Generated by Ghostship from state. Do not edit._', ''];
  if (!rows.length) board.push('No tasks yet.');
  else {
    board.push('| task | title | status | attempts | checks | blocked by |', '|---|---|---|---|---|---|');
    for (const t of rows) board.push(`| ${t.id} | ${t.title} | ${t.status} | ${t.attempt}/${t.maxAttempts} | ${t.checks.join(' ') || '-'} | ${t.blockedBy.join(' ') || '-'} |`);
  }
  put(root, BOARD_FILE, board.join('\n') + '\n');
}

function change(root, type, ref, data, fn) {
  const r = mutate(root, type, ref, data, fn);
  writeTaskFiles(root, load(root));
  return r;
}

// ------------------------------------------------------------------ secrets for redaction

function kvLiterals(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?[A-Za-z_][\w.]*\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const v = m[1].trim().replace(/^(['"])(.*)\1$/, '$2');
    if (v.length >= 8 && !/^(changeme|your[_-]|xxx|<|\$\{)/i.test(v) && !/^(.)\1+$/.test(v)) out.push(v);
  }
  return out;
}

export function secretLiterals(root, home = homedir()) {
  const out = [];
  let names = [];
  try { names = readdirSync(root).filter((n) => /^\.env/.test(n) && !/(example|sample|template|dist)$/i.test(n)); } catch { /* none */ }
  for (const n of names) { try { out.push(...kvLiterals(readFileSync(join(root, n), 'utf8'))); } catch { /* skip */ } }
  try { out.push(...kvLiterals(readFileSync(join(home, '.ghostship', 'secrets'), 'utf8'))); } catch { /* none */ }
  return out;
}

// ------------------------------------------------------------------ interview + PRD (stage new/adopt)

export function interviewInit(root, { tier } = {}) {
  const state = load(root);
  if (!['new', 'adopt'].includes(state.stage)) fail('WRONG_STAGE', `Interview runs in new/adopt, not ${state.stage}`);
  const cfg = loadConfig(root);
  const cov = newCoverage(tier || cfg.project.tier);
  return change(root, 'interview.init', null, { tier: cov.tier }, (s) => { s.interview = cov; return coverageSummary(cov); });
}

export function interviewMark(root, area, st, note = '') {
  const state = load(root);
  if (!state.interview) fail('NO_INTERVIEW', 'Run: gs interview init');
  const next = markArea(state.interview, area, st, note);
  return change(root, 'interview.mark', area, { state: st, note }, (s) => { s.interview = next; return coverageSummary(next); });
}

export function interviewStatus(root) {
  const state = load(root);
  if (!state.interview) fail('NO_INTERVIEW', 'Run: gs interview init');
  return coverageSummary(state.interview);
}

export function prdApprove(root, gate) {
  const state = load(root);
  if (!['new', 'adopt'].includes(state.stage)) fail('WRONG_STAGE', `PRD approval belongs to new/adopt (now ${state.stage})`);
  if (!state.interview) fail('NO_INTERVIEW', 'Run the interview first: gs interview init');
  const open = coverageSummary(state.interview).open;
  if (open.length) fail('COVERAGE_OPEN', `Coverage areas still open: ${open.join(', ')}. Answer, mark N/A with a reason, or record an assumption.`);
  const draft = read(root, DOCS.prdDraft);
  const final = read(root, DOCS.prd);
  const text = draft ?? final;
  if (!text || text.trim().length < 40) fail('NO_PRD', `Write ${DOCS.prdDraft} first.`);
  const g = humanGate(loadConfig(root), gate);
  if (draft !== null) renameSync(join(root, DOCS.prdDraft), join(root, DOCS.prd));
  const sha = sha256(text);
  const cfg = loadConfig(root);
  if (headCommit(root)) { const dev = ensureDevelop(root, cfg); if (currentBranch(root) !== dev) checkout(root, dev); }
  const r = change(root, 'prd.approve', null, { sha, gate: g }, (s) => {
    s.prd = { path: DOCS.prd, sha, approved: true, at: nowIso(), gate: g };
    s.stage = 'design';
    return s.prd;
  });
  commitDocs(root, [DOCS.requirements, DOCS.prdDraft, ...BOOKKEEPING], 'docs(prd): approve PRD');
  return r;
}

// ------------------------------------------------------------------ design

export const DESIGN_FILES = {
  light: ['BLUEPRINT.md'],
  standard: ['BLUEPRINT.md', 'ARCHITECTURE.md', 'THREAT-MODEL.md'],
  full: ['BLUEPRINT.md', 'ARCHITECTURE.md', 'THREAT-MODEL.md', 'API.md', 'DATA-MODEL.md'],
};

export function designDone(root) {
  const state = load(root);
  if (state.stage !== 'design') fail('WRONG_STAGE', `Design is done in the design stage (now ${state.stage})`);
  assertLocks(root, state);
  const tier = loadConfig(root).project.tier;
  const need = DESIGN_FILES[tier] || DESIGN_FILES.standard;
  const missing = need.filter((f) => (read(root, `${DOCS.design}/${f}`) || '').trim().length < 40);
  if (missing.length) fail('DESIGN_INCOMPLETE', `Missing or empty in ${DOCS.design}/: ${missing.join(', ')}`);
  const reopenChecks = state.change?.scope === 'prd' && state.acceptance?.approved;
  if (reopenChecks) put(root, DOCS.acceptanceDraft, read(root, DOCS.acceptance));
  const r = change(root, 'design.done', null, { files: need, reopenChecks }, (s) => {
    s.design = { files: need, at: nowIso() };
    s.stage = 'acceptance';
    if (reopenChecks) s.acceptance = { ...s.acceptance, approved: false, reopenedAt: nowIso() };
    return s.design;
  });
  scaffoldDocs(root, join(root, '.ghostship/core'), { tier });
  commitDocs(root, ['docs', ...BOOKKEEPING], 'docs(design): design complete');
  return r;
}

// ------------------------------------------------------------------ acceptance (STOP 1)

export function acceptanceLint(root) {
  const md = read(root, DOCS.acceptanceDraft) ?? read(root, DOCS.acceptance);
  if (md === null) return { ok: false, errors: [`${DOCS.acceptanceDraft} does not exist`], contract: null };
  return lintContract(md);
}

export function acceptanceApprove(root, gate, { auto = false } = {}) {
  const state = load(root);
  if (state.stage !== 'acceptance') fail('WRONG_STAGE', `Acceptance approval belongs to the acceptance stage (now ${state.stage})`);
  if (state.acceptance?.approved) fail('ALREADY_APPROVED', 'Acceptance checks are already approved.');
  assertLocks(root, state);
  const lint = acceptanceLint(root);
  if (!lint.ok) fail('ACCEPTANCE_LINT', 'Acceptance checks fail lint:\n- ' + lint.errors.join('\n- '));
  // Full autonomy: STOP 1 passes by policy once the checks pass lint. Every other mode keeps it with the owner.
  if (auto && autonomyOf(loadConfig(root)).mode !== 'full') fail('HUMAN_GATE', 'Only autonomy mode full approves STOP 1 by itself. The owner approves the checks: gs acceptance approve.');
  const g = auto ? { via: 'autopilot' } : humanGate(loadConfig(root), gate);
  const draft = read(root, DOCS.acceptanceDraft);
  const text = draft ?? read(root, DOCS.acceptance);
  if (draft !== null) renameSync(join(root, DOCS.acceptanceDraft), join(root, DOCS.acceptance));
  const sha = sha256(text);
  const prev = state.acceptance?.checks || null;
  const rev = prev ? (state.acceptance.rev || 1) + 1 : 1;
  const checks = lint.contract.checks.map(({ id, kind, text: t }) => {
    const p = prev?.find((c) => c.id === id);
    const same = p && p.text === t && p.kind === kind;
    return { id, kind, text: t, rev: same ? (p.rev || 1) : rev };
  });
  const diff = prev ? {
    added: checks.filter((c) => !prev.some((p) => p.id === c.id)).map((c) => c.id),
    changed: checks.filter((c) => c.rev === rev && prev.some((p) => p.id === c.id)).map((c) => c.id),
    removed: prev.filter((p) => !checks.some((c) => c.id === p.id)).map((p) => p.id),
  } : null;
  const r = change(root, 'acceptance.approve', null, { sha, gate: g, rev, diff }, (s) => {
    if (s.acceptance?.sha) (s.acceptanceHistory = s.acceptanceHistory || []).push({ sha: s.acceptance.sha, rev: s.acceptance.rev || 1, at: s.acceptance.at });
    s.acceptance = { path: DOCS.acceptance, sha, approved: true, at: nowIso(), gate: g, rev, checks, diff };
    if (diff && s.acceptanceLock) {
      const unlock = [...diff.changed, ...diff.removed];
      const kept = {}, unlocked = [];
      for (const [f, blob] of Object.entries(s.acceptanceLock.files)) {
        const base = f.slice(ACCEPTANCE_TESTS_DIR.length + 1);
        if (unlock.some((id) => base.startsWith(`${id}-`))) unlocked.push(f); else kept[f] = blob;
      }
      s.acceptanceLock = { ...s.acceptanceLock, files: kept, unlocked };
      if (diff.removed.length) (s.retired = s.retired || []).push(...diff.removed.map((id) => ({ id, rev, at: nowIso() })));
    }
    s.stage = 'plan';
    return s.acceptance;
  });
  commitDocs(root, ['docs/03-acceptance', ...BOOKKEEPING], 'docs(acceptance): approve acceptance checks');
  return r;
}

function checkFiles(root, tree, ids) {
  const files = listTree(root, tree).filter((p) => p.startsWith(ACCEPTANCE_TESTS_DIR + '/'));
  const out = {};
  for (const id of ids) out[id] = files.filter((p) => p.slice(ACCEPTANCE_TESTS_DIR.length + 1).startsWith(`${id}-`));
  return out;
}

const shq = (s) => (/^[\w./@:-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);
const withFiles = (cmd, files) => (cmd.includes('{files}') ? cmd.split('{files}').join(files.map(shq).join(' ')) : cmd);

function ensureDevelop(root, cfg) {
  const dev = cfg.branches.develop, main = cfg.branches.main;
  if (!branchExists(root, dev)) {
    const base = branchExists(root, main) ? main : 'HEAD';
    gitRun(root, ['branch', dev, base]);
  }
  return dev;
}

function checkout(root, branch, { carry = false } = {}) {
  // carry: Ghostship's own records (state, evidence, the task board: TREE_EXCLUDES) are the one live copy, committed on
  // develop and never on a task branch. Moving between develop and a task branch after develop moved on (a held task,
  // a retry after a revert) must keep them as they are, not refuse or bring back the branch's older copy.
  const saved = carry ? carryRecords(root, branch) : null;
  const r = tryGit(root, ['checkout', '-q', branch]);
  if (saved) for (const [rel, buf] of saved) {
    if (buf === null) rmSync(join(root, rel), { force: true });
    else { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), buf); }
  }
  if (!r.ok) fail('CHECKOUT_FAILED', `git checkout ${branch} failed: ${r.out}`);
}

/** The records a checkout to `branch` would change or refuse over: saved, then set to what git expects. */
function carryRecords(root, branch) {
  const paths = new Set();
  const list = (args) => { const r = tryGit(root, args); return r.ok ? r.out.split('\n').map((l) => l.trim()).filter(Boolean) : []; };
  for (const p of list(['diff', '--name-only', 'HEAD', branch, '--', ...TREE_EXCLUDES])) paths.add(p);
  for (const p of list(['diff', '--name-only', 'HEAD', '--', ...TREE_EXCLUDES])) paths.add(p);
  for (const p of list(['ls-files', '--others', '--exclude-standard', '--', ...TREE_EXCLUDES])) paths.add(p);
  const saved = new Map();
  for (const rel of paths) saved.set(rel, existsSync(join(root, rel)) ? readFileSync(join(root, rel)) : null);
  const tracked = new Set(list(['ls-files', '--', ...paths]));
  for (const rel of paths) {
    if (tracked.has(rel)) tryGit(root, ['checkout', '-q', 'HEAD', '--', rel]); // back to HEAD, so git switches it cleanly
    else rmSync(join(root, rel), { force: true }); // untracked here: git would refuse to overwrite it
  }
  return saved;
}

function assertClean(root, what) {
  const dirty = dirtyPaths(root, TREE_EXCLUDES);
  if (dirty.length) fail('DIRTY_TREE', `${what} needs a clean tree. Uncommitted: ${dirty.slice(0, 10).join(', ')}${dirty.length > 10 ? ' …' : ''}`);
}

function bookkeep(root, message) {
  if (!hasIdentity(root)) return false;
  const paths = BOOKKEEPING.filter((p) => existsSync(join(root, p)));
  if (!paths.length) return false;
  const r = tryGit(root, ['add', '-A', '--', ...paths]);
  if (!r.ok) return false;
  if (tryGit(root, ['diff', '--cached', '--quiet']).ok) return false;
  gitRun(root, ['commit', '-q', '--no-verify', '-m', message]);
  return true;
}

/** Commits .ghostship/config.yaml after an owner edit (gs config set, gs autonomy), so the next task start finds a clean tree. Quiet without git. */
export function commitConfig(root, message) {
  try {
    if (!headCommit(root) || !hasIdentity(root)) return false;
    return commitDocs(root, ['.ghostship/config.yaml'], message);
  } catch { return false; }
}

function commitDocs(root, paths, message) {
  if (!hasIdentity(root)) return false;
  const have = paths.filter((p) => existsSync(join(root, p)));
  if (!have.length) return false;
  if (!tryGit(root, ['add', '-A', '--', ...have]).ok) return false;
  if (tryGit(root, ['diff', '--cached', '--quiet']).ok) return false;
  gitRun(root, ['commit', '-q', '--no-verify', '-m', message]);
  return true;
}

export function acceptanceLock(root) {
  const state = load(root);
  needAcceptance(state);
  assertLocks(root, state);
  const amend = !!state.acceptanceLock;
  if (amend && (state.acceptanceLock.rev || 1) >= (state.acceptance.rev || 1)) fail('ALREADY_LOCKED', 'Acceptance tests are already locked.');
  if (activeTask(state)) fail('TASK_ACTIVE', 'Finish the active task before locking acceptance tests.');
  assertCleanExcept(root, [ACCEPTANCE_TESTS_DIR, 'docs']);
  const cfg = loadConfig(root);
  if (!cfg.commands.acceptance) fail('NO_COMMAND', 'Set commands.acceptance in .ghostship/config.yaml (use {files} for the per-check file list).');
  const tree = treeHash(root);
  const curRev = state.acceptance.rev || 1;
  const runIds = state.acceptance.checks.filter((c) => c.kind === 'run' && (!amend || (c.rev || 1) === curRev)).map((c) => c.id);
  const allIds = new Set(state.acceptance.checks.map((c) => c.id));
  if (amend) {
    const changedLocked = locksMismatch(root, tree, state.acceptanceLock.files);
    if (changedLocked.length) fail('ACCEPTANCE_TESTS_CHANGED', `Locked tests of unchanged checks were edited: ${changedLocked.join(', ')}`);
    const orphans = listTree(root, tree).filter((p) => p.startsWith(ACCEPTANCE_TESTS_DIR + '/') && /^(C\d+)-/.test(p.slice(ACCEPTANCE_TESTS_DIR.length + 1)) && !allIds.has(/^(C\d+)-/.exec(p.slice(ACCEPTANCE_TESTS_DIR.length + 1))[1]));
    if (orphans.length) fail('ACCEPTANCE_TESTS_ORPHANED', `Delete the tests of retired checks: ${orphans.join(', ')}`);
  }
  if (amend) {
    const fresh = listTree(root, tree).filter((p) => p.startsWith(ACCEPTANCE_TESTS_DIR + '/') && !(p in state.acceptanceLock.files));
    const stray = fresh.filter((p) => !runIds.some((id) => p.slice(ACCEPTANCE_TESTS_DIR.length + 1).startsWith(`${id}-`)));
    if (stray.length) fail('ACCEPTANCE_TESTS_UNPROVEN', `New acceptance tests for checks that did not change would be locked without failing first: ${stray.join(', ')}. Remove them, or change those checks.`);
  }
  const byCheck = checkFiles(root, tree, runIds);
  const missing = runIds.filter((id) => !byCheck[id].length);
  if (missing.length) fail('ACCEPTANCE_TESTS_MISSING', `No ${ACCEPTANCE_TESTS_DIR}/<C#>-* file for: ${missing.join(', ')}`);
  const results = [];
  const groups = cfg.commands.acceptance.includes('{files}') ? runIds.map((id) => [id, byCheck[id]]) : [['all', runIds.flatMap((id) => byCheck[id])]];
  for (const [id, files] of groups) {
    const ev = record(root, { kind: 'acceptance-red', task: null, command: withFiles(cfg.commands.acceptance, files), expectFail: true, label: id });
    results.push({ check: id, evidence: ev.id, accepted: ev.accepted, reason: ev.rejectReason });
  }
  const bad = results.filter((r) => !r.accepted);
  if (bad.length) fail('ACCEPTANCE_NOT_RED', `Acceptance tests must fail before any feature exists: ${bad.map((b) => `${b.check} (${b.evidence}: ${b.reason})`).join('; ')}`);
  const files = {};
  for (const p of listTree(root, tree).filter((x) => x.startsWith(ACCEPTANCE_TESTS_DIR + '/'))) files[p] = blobInTree(root, tree, p);
  const dev = ensureDevelop(root, cfg);
  if (currentBranch(root) !== dev) checkout(root, dev);
  commitDocs(root, [ACCEPTANCE_TESTS_DIR, 'docs'], `test(acceptance): lock ${runIds.join(' ') || '(no new run checks)'}`);
  return change(root, 'acceptance.lock', null, { tree, files: Object.keys(files), results, rev: curRev, amend }, (s) => {
    s.acceptanceLock = { tree, files, at: nowIso(), evidence: results.map((r) => r.evidence), rev: curRev };
    if (s.change) { (s.changes = s.changes || []).push({ ...s.change, closedAt: nowIso(), diff: s.acceptance.diff }); s.change = null; }
    return s.acceptanceLock;
  });
}

function assertCleanExcept(root, prefixes) {
  const dirty = dirtyPaths(root, TREE_EXCLUDES).filter((p) => !prefixes.some((x) => p.startsWith(x + '/')));
  if (dirty.length) fail('DIRTY_TREE', `Uncommitted changes outside ${prefixes.join(', ')}: ${dirty.slice(0, 10).join(', ')}. Code goes in through a task.`);
}

// ------------------------------------------------------------------ change: reopen the PRD or the checks (/ghostship add, change)

export function changeOpen(root, { scope, reason = '', ...gate } = {}) {
  const state = load(root);
  if (!['prd', 'acceptance'].includes(scope)) fail('BAD_SCOPE', 'scope is prd (new or changed requirements) or acceptance (checks only)');
  needAcceptance(state);
  if (state.change) fail('CHANGE_OPEN', `A ${state.change.scope} change is already open (${state.change.reason}). Finish it first.`);
  const act = activeTask(state);
  if (act) fail('TASK_ACTIVE', `${act.id} is ${act.status}. Finish it before reopening approved documents.`);
  const live = liveRun(root);
  if (live && live.status === 'running') fail('RUN_ACTIVE', `${live.runId} is still running.`);
  if (state.release) fail('RELEASE_PENDING', 'A release candidate is waiting for STOP 2. Approve or abandon it first.');
  if (!String(reason).trim()) fail('NO_REASON', 'Say what changes and why (--reason).');
  const g = humanGate(loadConfig(root), gate);
  if (scope === 'prd') put(root, DOCS.prdDraft, read(root, DOCS.prd));
  else put(root, DOCS.acceptanceDraft, read(root, DOCS.acceptance));
  const r = change(root, 'change.open', null, { scope, reason, gate: g }, (s) => {
    s.change = { scope, reason: String(reason).trim(), at: nowIso(), gate: g };
    if (scope === 'prd') { s.prd = { ...s.prd, approved: false, reopenedAt: nowIso() }; s.stage = 'new'; }
    else { s.acceptance = { ...s.acceptance, approved: false, reopenedAt: nowIso() }; s.stage = 'acceptance'; }
    return s.change;
  });
  return { ...r, draft: scope === 'prd' ? DOCS.prdDraft : DOCS.acceptanceDraft };
}

// ------------------------------------------------------------------ plan: task import

function validPaths(paths) {
  const allowed = (paths || []).map((p) => String(p).trim().replace(/\\/g, '/')).filter(Boolean);
  if (!allowed.length) fail('ALLOWED_PATHS_MISSING', 'allowedPaths is mandatory and fails closed.');
  for (const p of allowed) {
    if (TOO_BROAD.has(p)) fail('ALLOWED_PATHS_TOO_BROAD', `"${p}" allows the whole repository`);
    if (p.includes('..') || p.startsWith('/')) fail('ALLOWED_PATHS_TOO_BROAD', `${p} escapes the repository`);
    if (PROTECTED_PREFIXES.some((x) => p.startsWith(x))) fail('ALLOWED_PATHS_PROTECTED', `${p} is Ghostship-protected`);
  }
  return allowed;
}

export function taskImport(root) {
  const state = load(root);
  needAcceptance(state);
  assertLocks(root, state);
  const dir = join(root, DRAFTS_DIR, 'tasks');
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md')).sort() : [];
  if (!files.length) fail('NO_DRAFTS', `No task drafts in ${DRAFTS_DIR}/tasks/. The planner writes them there.`);
  const cfg = loadConfig(root);
  const known = new Set(state.acceptance.checks.map((c) => c.id));
  const drafts = files.map((f) => {
    let p;
    try { p = parseTaskFile(readFileSync(join(dir, f), 'utf8')); } catch (e) { fail('BAD_TASK_FILE', `${f}: ${e.message}`); }
    return { file: f, ...p };
  });
  const ids = new Set([...Object.keys(state.tasks || {}), ...drafts.map((d) => String(d.meta.id))]);
  const out = [];
  for (const { file, meta: m, sections } of drafts) {
    const id = String(m.id);
    if (!/^T\d{3,4}$/.test(id)) fail('BAD_TASK_ID', `${file}: id must look like T001`);
    if (state.tasks?.[id]) fail('DUPLICATE_TASK', `${id} already exists`);
    if (out.some((t) => t.id === id)) fail('DUPLICATE_TASK', `${id} appears twice in drafts`);
    if (!m.title) fail('NO_TITLE', `${id}: title is required`);
    const checks = (m.checks || []).map(String);
    for (const c of checks) if (!known.has(c)) fail('UNKNOWN_CHECK', `${id}: ${c} is not in the approved acceptance checks`);
    const setup = m.skeleton === true || m.kind === 'setup';
    if (!checks.length && !m.finding && !setup) fail('NO_CHECKS', `${id}: a task serves at least one check, or carries finding/skeleton`);
    const blockedBy = (m.blockedBy || []).map(String);
    for (const b of blockedBy) if (!ids.has(b)) fail('UNKNOWN_TASK', `${id}: blocker ${b} does not exist`);
    if (m.noTdd !== undefined && m.noTdd !== null && !String(m.noTdd).trim()) fail('NO_TDD_JUSTIFICATION', `${id}: a non-TDD task must say why a test cannot be written`);
    out.push({
      id, title: String(m.title), phase: m.phase || null, kind: m.kind || 'feat', scope: m.scope || null, tier: m.tier || 'standard',
      risk: m.risk || 'low', checks, requirement: m.requirement || null, blockedBy, allowedPaths: validPaths(m.allowedPaths),
      // A setup task (walking skeleton, build/test runners) cannot write a failing test before the runner exists:
      // it needs no RED, but its GREEN, lint, typecheck and regression evidence must still pass at submit.
      testCommand: m.testCommand ? String(m.testCommand) : null, noTdd: setup ? SETUP_NO_TDD : (m.noTdd ? String(m.noTdd).trim() : null),
      finding: m.finding || null, skeleton: m.skeleton === true, setup, ui: m.ui === true, sections, acceptanceRev: state.acceptance.rev || 1,
      status: 'TODO', attempt: 0, maxAttempts: cfg.loop.attempts, branch: null,
      originBase: null, attemptBase: null, red: null, locks: {}, relocks: [], evidence: {}, submit: null, judgeRuns: [], verdict: null, history: [],
    });
  }
  // dependency cycles
  const all = { ...(state.tasks || {}) };
  for (const t of out) all[t.id] = t;
  const seen = new Set(), stack = new Set();
  const visit = (id) => {
    if (stack.has(id)) fail('DEPENDENCY_CYCLE', `Task dependencies form a cycle at ${id}`);
    if (seen.has(id)) return;
    stack.add(id); for (const b of all[id]?.blockedBy || []) visit(b); stack.delete(id); seen.add(id);
  };
  Object.keys(all).forEach(visit);
  const r = change(root, 'task.import', null, { ids: out.map((t) => t.id) }, (s) => {
    s.tasks = s.tasks || {};
    for (const t of out) s.tasks[t.id] = t;
    if (s.stage === 'plan' && out.some((t) => !t.skeleton)) s.stage = 'build';
    return out.map((t) => t.id);
  });
  for (const f of files) rmSync(join(dir, f));
  commitDocs(root, ['docs/04-plan', ...BOOKKEEPING], `chore(ghostship): plan ${r.join(' ')}`);
  return { imported: r, uncovered: coverage(root).uncoveredRun };
}

export function coverage(root) {
  const state = load(root);
  const checks = state.acceptance?.checks || [];
  const tasks = Object.values(state.tasks || {}).filter((t) => t.status !== 'DROPPED');
  const covers = (c) => tasks.some((t) => t.checks.includes(c.id) && (t.acceptanceRev || 1) >= (c.rev || 1));
  return {
    uncoveredRun: checks.filter((c) => c.kind === 'run' && !covers(c)).map((c) => c.id),
    pick: checks.filter((c) => c.kind === 'pick').map((c) => c.id),
  };
}

export function frontier(state) {
  return Object.values(state.tasks || {})
    .filter((t) => (t.status === 'TODO' || t.status === 'RETRY') && t.blockedBy.every((b) => state.tasks[b]?.status === 'MERGED'))
    .sort((a, b) => a.id.localeCompare(b.id)).map((t) => t.id);
}

// ------------------------------------------------------------------ build loop

export function taskStart(root, id) {
  const state = load(root);
  needAcceptance(state);
  assertLocks(root, state);
  const t = taskOr(state, id);
  const act = activeTask(state);
  if (act && act.id !== id) fail('TASK_ACTIVE', `${act.id} is ${act.status}. One active task at a time.`);
  if (act) fail('ALREADY_ACTIVE', `${id} is already ${t.status}`);
  if (t.status === 'MERGED') fail('ALREADY_MERGED', `${id} is already merged`);
  if (t.status === 'DROPPED') fail('DROPPED', `${id} was dropped`);
  if (t.status === 'PARKED') fail('PARKED', `${id} is parked (${t.parked?.reason || 'attempts used'}). It waits for the owner at STOP 2, or gs decide ${id} --grant 1.`);
  if (t.status === 'NEEDS_DECISION' || t.attempt >= t.maxAttempts) fail('NEEDS_DECISION', `${id} used ${t.attempt}/${t.maxAttempts} attempts. You decide: gs decide ${id} --grant 1 | --drop`);
  const blocked = t.blockedBy.filter((b) => state.tasks[b]?.status !== 'MERGED');
  if (blocked.length) fail('BLOCKED', `${id} waits on ${blocked.join(', ')}`);
  const lockCurrent = state.acceptanceLock && (state.acceptanceLock.rev || 1) >= (state.acceptance.rev || 1);
  if (!lockCurrent && !t.skeleton) fail('ACCEPTANCE_NOT_LOCKED', state.acceptanceLock ? 'The acceptance checks changed: write or update the tests for the new and changed checks, then gs acceptance lock.' : 'Lock the acceptance tests first (gs acceptance lock). Only skeleton tasks may run before that.');
  if (isPaused(root)) fail('PAUSED', `Ghostship is paused (${isPaused(root).reason}). The owner resumes with gs go.`);
  assertClean(root, 'Starting a task');
  const cfg = loadConfig(root);
  const dev = ensureDevelop(root, cfg);
  const branch = t.branch || `task/${id}-${slugify(t.title)}`;
  if (branchExists(root, branch)) checkout(root, branch, { carry: true });
  else { checkout(root, dev); gitRun(root, ['checkout', '-q', '-b', branch]); }
  const tree = treeHash(root);
  const started = change(root, 'task.start', id, { attempt: t.attempt + 1, tree, branch }, (s) => {
    const x = s.tasks[id];
    x.attempt += 1;
    x.status = 'BUILDING';
    x.branch = branch;
    x.attemptBase = tree;
    if (!x.originBase) x.originBase = tree;
    x.evidence = {}; x.submit = null; x.judgeRuns = [];
    if (s.stage === 'plan') s.stage = 'build';
    return x;
  });
  try { const changed = tickAttempt(root); started.learned = changed.map((r) => `${r.id} ${r.status}`); } catch { /* learning is best effort */ }
  return started;
}

export function taskFail(root, id, reason = '') {
  const state = load(root);
  const t = taskOr(state, id);
  if (t.status !== 'BUILDING') fail('NOT_BUILDING', `${id} is ${t.status}`);
  const cfg = loadConfig(root);
  change(root, 'task.fail', id, { reason, attempt: t.attempt }, (s) => {
    const x = s.tasks[id];
    x.history.push({ attempt: x.attempt, outcome: 'BUILDER_GAVE_UP', reason, at: nowIso() });
    retryOrEscalate(x, s, cfg, reason ? `builder gave up: ${reason}` : '');
    return x;
  });
  return noteParked(root, id);
}

export function escalateStall(root, id, reason) {
  const state = load(root);
  const t = taskOr(state, id);
  if (!ACTIVE.has(t.status) || t.status === 'PASSED') return t;
  const cfg = loadConfig(root);
  change(root, 'stop.stall', id, { reason, attempt: t.attempt }, (s) => {
    const x = s.tasks[id];
    x.history.push({ attempt: x.attempt, outcome: 'STALLED', reason, at: nowIso() });
    x.submit = null;
    escalate(x, s, cfg, `stalled: ${reason}`);
    return x;
  });
  return noteParked(root, id);
}

const TASK_KINDS = new Set(['red', 'green', 'acceptance', 'regression', 'lint', 'typecheck', 'judge']);

/** Low-level: run a command, check it did not touch the tree, write evidence, append the event. */
function record(root, { kind, task, command, expectFail = false, label = null, timeoutSec }) {
  const state = load(root);
  const cfg = loadConfig(root);
  const tmo = timeoutSec || cfg.loop['timeout-sec'] || 900;
  const tree = treeHash(root);
  const started = Date.now();
  const res = spawnSync(command, {
    cwd: root, shell: true, encoding: 'utf8', timeout: tmo * 1000, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GHOSTSHIP_EVIDENCE: '1', CI: process.env.CI || '1' }, windowsHide: true,
  });
  const timedOut = res.error?.code === 'ETIMEDOUT';
  const exitCode = typeof res.status === 'number' ? res.status : (timedOut ? 124 : 1);
  const raw = `${res.stdout || ''}${res.stderr ? `\n--- stderr ---\n${res.stderr}` : ''}${res.error && !timedOut ? `\n--- spawn error ---\n${res.error.message}` : ''}`;
  const lits = secretLiterals(root);
  const output = redact(raw, lits);
  const treeAfter = treeHash(root);
  let accepted = true, rejectReason = null;
  const reject = (r) => { if (accepted) { accepted = false; rejectReason = r; } };
  if (timedOut) reject(`timed out after ${tmo}s`);
  if (treeAfter !== tree) {
    const changed = (() => { try { return changedPaths(root, tree, treeAfter); } catch { return []; } })();
    const named = changed.length ? `: ${changed.slice(0, 5).join(', ')}${changed.length > 5 ? `, +${changed.length - 5} more` : ''}` : '';
    reject(`the command changed project files${named}; evidence must not change the tree. Ignore build output in .gitignore or keep the command from writing into the project.`);
  }
  if (expectFail) {
    if (exitCode === 0) reject('passed on first run — it tests existing behaviour or nothing');
  } else {
    if (exitCode !== 0) reject(`exit code ${exitCode}`);
    const skip = detectSkips(output);
    if (skip) reject(`skipped or missing tests: "${skip}"`);
  }
  const id = 'E' + String((state.evidenceSeq || 0) + 1).padStart(4, '0');
  const rel = `${EVIDENCE_DIR}/${task || '_project'}/${id}`;
  mkdirSync(join(root, rel), { recursive: true });
  writeFileSync(join(root, rel, 'output.log'), output, { flag: 'wx' });
  const manifest = {
    id, task, kind, label, attempt: task ? state.tasks[task].attempt : null, command: redact(command, lits), exitCode, timedOut,
    accepted, rejectReason, tree, head: headCommit(root), startedAt: new Date(started).toISOString(), durationMs: Date.now() - started,
    outputSha256: sha256(output),
  };
  const manifestText = JSON.stringify(manifest, null, 2) + '\n';
  writeFileSync(join(root, rel, 'manifest.json'), manifestText, { flag: 'wx' });
  mutate(root, `evidence.${kind}`, task, { id, exitCode, accepted, rejectReason, tree }, (s) => {
    s.evidenceSeq = (s.evidenceSeq || 0) + 1;
    s.evidence = s.evidence || {};
    s.evidence[id] = { dir: rel, task, kind, label, tree, exitCode, accepted, manifestSha256: sha256(manifestText), outputSha256: manifest.outputSha256 };
  });
  return { ...manifest, dir: rel };
}

function runChecksOf(state, t) {
  const run = new Set((state.acceptance?.checks || []).filter((c) => c.kind === 'run').map((c) => c.id));
  return t.checks.filter((c) => run.has(c));
}

function commandFor(cfg, t, kind, tree, root, state) {
  const c = cfg.commands;
  if (kind === 'red' || kind === 'green') return t.testCommand || c.test;
  if (kind === 'regression') return c.test;
  if (kind === 'lint') return c.lint;
  if (kind === 'typecheck') return c.typecheck;
  if (kind === 'acceptance') {
    if (!c.acceptance) return '';
    const runChecks = runChecksOf(state, t);
    const files = Object.values(checkFiles(root, tree, runChecks)).flat();
    return withFiles(c.acceptance, files);
  }
  if (kind === 'judge') return t.testCommand || c.test;
  return '';
}

export function evidence(root, { task: id, kind, command, token } = {}) {
  const state = load(root);
  if (!TASK_KINDS.has(kind)) fail('BAD_KIND', `kind must be one of ${[...TASK_KINDS].join(', ')}`);
  const t = taskOr(state, id);
  if (kind === 'judge') {
    if (t.status !== 'JUDGING') fail('NOT_JUDGING', `${id} is ${t.status}`);
    if (!token || sha256(String(token)) !== t.submit?.tokenHash) fail('BAD_TOKEN', 'Judge token missing or wrong.');
  } else if (t.status !== 'BUILDING') fail('NOT_BUILDING', `${id} is ${t.status}`);
  const cfg = loadConfig(root);
  const tree = treeHash(root);
  const cmd = command && kind === 'judge' ? command : commandFor(cfg, t, kind, tree, root, state);
  if (command && kind !== 'judge') fail('FIXED_COMMAND', `The ${kind} command comes from config/task, not the caller.`);
  if (!cmd) fail('NO_COMMAND', `No command configured for ${kind} (commands.* in .ghostship/config.yaml${kind === 'red' || kind === 'green' ? ' or task testCommand' : ''}).`);

  let testsChanged = [];
  if (kind === 'red') {
    if (t.setup || t.skeleton) fail('SETUP_TASK', `${id} is a setup task: no failing test first. Make the build, lint and tests pass, then gs evidence --task ${id} --kind green.`);
    if (t.noTdd) fail('NO_TDD_TASK', `${id} is a recorded non-TDD task; record green directly.`);
    const changed = changedPaths(root, t.attemptBase, tree).filter((p) => !p.startsWith('docs/'));
    testsChanged = changed.filter(isTest);
    const prod = changed.filter((p) => !isTest(p));
    if (prod.length) fail('TDD_PRODUCTION_BEFORE_RED', `Production files changed before a failing test was recorded: ${prod.join(', ')}. Revert them, record RED, then implement.`);
    if (!testsChanged.length) fail('TDD_NO_TEST_CHANGE', 'RED needs a new or changed test file since this attempt started.');
  }
  if (['green', 'regression', 'acceptance', 'lint', 'typecheck'].includes(kind)) {
    if (!t.noTdd && !t.red && kind === 'green') fail('TDD_NO_RED', `${id} has no recorded RED. Write the failing test first.`);
    const bad = locksMismatch(root, tree, t.locks);
    if (bad.length) fail('LOCKED_TEST_CHANGED', `Locked tests changed after RED: ${bad.join(', ')}. Restore them, or record a new RED if the test itself was wrong.`);
    const drift = acceptanceDrift(root, state, tree);
    if (drift.length) fail('ACCEPTANCE_TESTS_CHANGED', `Locked acceptance tests changed: ${drift.join(', ')}`);
  }
  if (kind === 'acceptance' && !runChecksOf(state, t).length) fail('NO_CHECKS', `${id} serves no acceptance checks; acceptance evidence is not needed.`);

  const ev = record(root, { kind, task: id, command: cmd, expectFail: kind === 'red' });
  change(root, `evidence.bind`, id, { id: ev.id, kind }, (s) => {
    const x = s.tasks[id];
    if (kind === 'red' && ev.accepted) {
      const prior = Object.keys(x.locks || {});
      const relocked = testsChanged.filter((p) => prior.includes(p));
      if (relocked.length) x.relocks.push({ evidenceId: ev.id, paths: relocked, attempt: x.attempt });
      for (const p of testsChanged) x.locks[p] = blobInTree(root, tree, p);
      x.red = { evidenceId: ev.id, tree };
      x.evidence = {};
    }
    if (kind !== 'red' && kind !== 'judge' && ev.accepted) x.evidence[kind] = { evidenceId: ev.id, tree, command: cmd };
    if (kind === 'judge') x.judgeRuns.push(ev.id);
  });
  return ev;
}

// ------------------------------------------------------------------ code map + docs gate

const NOT_MAPPED = ['.ghostship/', '.claude/', 'docs/', 'tasks/', '.github/', 'node_modules/'];

function sourceFiles(root, tree) {
  const files = {};
  for (const p of listTree(root, tree)) {
    if (NOT_MAPPED.some((x) => p.startsWith(x)) || /(^|\/)\.git/.test(p)) continue;
    const txt = purposeOf(p, '') === undefined ? '' : (read(root, p) ?? '');
    files[p] = txt;
  }
  return files;
}

export function codemap(root, { write = true } = {}) {
  const md = buildCodemap(sourceFiles(root, treeHash(root)));
  if (write) put(root, DOCS.codemap, md);
  return { path: DOCS.codemap, md };
}

function docsGate(root, cfg, tree, changed) {
  const problems = [];
  if (cfg.docs?.['purpose-headers'] !== false) {
    const files = {};
    for (const p of changed) { const txt = read(root, p); if (txt !== null) files[p] = txt; }
    const miss = missingPurposeHeaders(files, changed.filter((p) => !NOT_MAPPED.some((x) => p.startsWith(x))));
    if (miss.length) problems.push(`no one-line purpose comment at the top of: ${miss.join(', ')}`);
    const want = buildCodemap(sourceFiles(root, tree));
    if (read(root, DOCS.codemap) !== want) problems.push(`${DOCS.codemap} is stale: run gs codemap`);
  }
  return problems;
}

// ------------------------------------------------------------------ submit / verdict

export function taskSubmit(root, id) {
  assertNoLiveBuilder(root, id);
  const state = load(root);
  assertLocks(root, state);
  const t = taskOr(state, id);
  if (t.status !== 'BUILDING') fail('NOT_BUILDING', `${id} is ${t.status}`);
  if (!t.noTdd && !t.red) fail('TDD_NO_RED', `${id} has no RED`);
  const cfg = loadConfig(root);
  const tree = treeHash(root);
  const need = ['green'];
  if (runChecksOf(state, t).length && cfg.commands.acceptance) need.push('acceptance');
  if (cfg.commands.test) need.push('regression');
  if (cfg.commands.lint) need.push('lint');
  if (cfg.commands.typecheck) need.push('typecheck');
  const bad = locksMismatch(root, tree, t.locks);
  if (bad.length) fail('LOCKED_TEST_CHANGED', bad.join(', '));
  const drift = acceptanceDrift(root, state, tree);
  if (drift.length) fail('ACCEPTANCE_TESTS_CHANGED', drift.join(', '));
  const stale = [];
  for (const k of need) {
    const e = t.evidence?.[k];
    const viaGreen = k === 'regression' && t.evidence?.green?.tree === tree && t.evidence.green.command === cfg.commands.test;
    if (!(e && e.tree === tree) && !viaGreen) stale.push(k);
  }
  if (stale.length) fail('MISSING_EVIDENCE', `Record on the current tree: ${stale.map((k) => `gs evidence --task ${id} --kind ${k}`).join(' · ')}`);
  const changed = changedPaths(root, t.originBase, tree);
  const free = (p) => p.startsWith('docs/') && p !== DOCS.prd && !p.startsWith('docs/03-acceptance/') && !p.startsWith('docs/10-releases/');
  const protectedHit = changed.filter((p) => PROTECTED_PREFIXES.some((x) => p.startsWith(x)) && !p.startsWith('tests/acceptance/'));
  if (protectedHit.length) fail('PROTECTED_PATH', `Ghostship-owned or locked files changed: ${protectedHit.join(', ')}. Restore them; allowedPaths never covers these.`);
  const outside = changed.filter((p) => !matchesAny(p, t.allowedPaths) && !free(p));
  if (outside.length) fail('OUT_OF_SCOPE', `Changed outside allowedPaths [${t.allowedPaths.join(', ')}]: ${outside.join(', ')}`);
  const docs = docsGate(root, cfg, tree, changed);
  if (docs.length) fail('DOCS_GATE', 'Docs gate:\n- ' + docs.join('\n- '));
  if (!hasIdentity(root)) fail('NO_GIT_IDENTITY', 'Set git user.name and user.email so Ghostship can commit task work.');
  commitWork(root, `wip(${id}): attempt ${t.attempt}`);
  if (treeHash(root) !== tree) fail('TREE_CHANGED', 'Committing changed the tree (line-ending filters?). Check .gitattributes.');
  // What the judge must look at besides the checks, fixed at submit: risky paths (a full judge, a SECURITY lens, and
  // the owner before it merges), UI paths (a UX lens), and whether it would already conflict with develop.
  const risky = riskyPaths(cfg, changed, { setup: !!(t.setup || t.skeleton) });
  const ui = uiPaths(cfg, changed);
  const lenses = lensesFor(cfg, { risky, ui });
  const conflicts = mergeConflicts(root, ensureDevelop(root, cfg), 'HEAD');
  const token = randomBytes(16).toString('hex');
  change(root, 'task.submit', id, { tree, changed, risky: risky.map((r) => r.path), lenses }, (s) => {
    const x = s.tasks[id];
    x.status = 'JUDGING';
    x.submit = { tree, tokenHash: sha256(token), at: nowIso(), changed, commit: headCommit(root), risky, ui, lenses, conflicts: conflicts || [] };
    x.judgeRuns = [];
  });
  return { token, tree, changed, risky, lenses, conflicts: conflicts || [] };
}

/** A lost judge token (crash, /clear) is never recovered; a fresh one is issued for the same untouched submission. */
export function taskReissue(root, id) {
  assertNoLiveBuilder(root, id);
  const state = load(root);
  const t = taskOr(state, id);
  if (t.status !== 'JUDGING') fail('NOT_JUDGING', `${id} is ${t.status}`);
  if (treeHash(root) !== t.submit.tree) fail('TREE_CHANGED', 'The tree differs from the submission. Restore it (git checkout -- .) before re-issuing.');
  const token = randomBytes(16).toString('hex');
  change(root, 'task.reissue', id, { tree: t.submit.tree }, (s) => {
    const x = s.tasks[id];
    x.submit = { ...x.submit, tokenHash: sha256(token), reissuedAt: nowIso() };
    x.judgeRuns = [];
  });
  return { token, tree: t.submit.tree, changed: t.submit.changed };
}

export function verdict(root, { task: id, result, token, checks = {}, reason = '' } = {}) {
  assertNoLiveBuilder(root, id);
  const state = load(root);
  const t = taskOr(state, id);
  if (t.status !== 'JUDGING') fail('NOT_JUDGING', `${id} is ${t.status}`);
  if (!token || sha256(String(token)) !== t.submit?.tokenHash) fail('BAD_TOKEN', 'Judge token missing or wrong. Only the judge holds it.');
  if (!['PASS', 'FAIL'].includes(result)) fail('BAD_RESULT', 'result is PASS or FAIL');
  if (treeHash(root) !== t.submit.tree) fail('TREE_CHANGED', 'The tree differs from what was submitted. Restore any planted change, then judge.');
  const runs = t.judgeRuns.map((e) => state.evidence[e]).filter((e) => e && e.tree === t.submit.tree);
  if (!runs.length) fail('NO_JUDGE_EVIDENCE', `The judge must run the proof itself: gs evidence --task ${id} --kind judge --token …`);
  if (result === 'PASS') {
    const badRun = runs.find((e) => !e.accepted);
    if (badRun) fail('DETERMINISTIC_FAILURE', `A judge run failed (exit ${badRun.exitCode}). A deterministic failure blocks PASS.`);
    const missing = t.checks.filter((c) => !String(checks[c] || '').startsWith('PASS'));
    if (missing.length) fail('CHECKS_INCOMPLETE', `PASS needs every check PASS: ${missing.join(', ')}`);
    const lensMissing = (t.submit.lenses || []).filter((l) => !String(checks[l] || '').startsWith('PASS'));
    if (lensMissing.length) fail('LENS_INCOMPLETE', `This change needs a PASS line for each lens: ${lensMissing.map((l) => `--check "${l}=PASS — what you checked"`).join(' ')}`);
  } else {
    const missing = t.checks.filter((c) => !checks[c]);
    if (missing.length) fail('CHECKS_INCOMPLETE', `Give a line per check: ${missing.join(', ')}`);
    if (!String(reason).trim()) fail('NO_REASON', 'A FAIL needs a reason the next builder can act on.');
  }
  if (result === 'FAIL') {
    try { remember(root, 'failed', `attempt ${t.attempt}: ${reason}`, { task: id }); learnObserve(root, { code: 'JUDGE_FAIL', task: id, text: reason }); } catch { /* best effort */ }
  }
  const cfg = loadConfig(root);
  const r = change(root, 'task.verdict', id, { result, checks, reason, judgeRuns: t.judgeRuns }, (s) => {
    const x = s.tasks[id];
    x.verdict = { result, checks, reason, at: nowIso(), tree: x.submit.tree, judgeRuns: [...x.judgeRuns] };
    x.history.push({ attempt: x.attempt, outcome: result, reason, at: nowIso() });
    if (result === 'PASS') { x.status = 'PASSED'; x.submit = { ...x.submit, tokenHash: null }; } else retryOrEscalate(x, s, cfg, `judge failed it: ${reason}`);
    return x;
  });
  if (result === 'FAIL') noteParked(root, id);
  return r;
}

// ------------------------------------------------------------------ merge queue

/**
 * Why a judged PASS waits for the owner instead of merging: risky paths (merge.hold-risky) or a product assumption
 * (merge.hold-product-assumptions). Null when it may merge, or once the owner said merge (gs decide --merge).
 */
export function holdReason(cfg, t) {
  if (t.mergeApproved) return null;
  const m = cfg.merge || {};
  const risky = m['hold-risky'] === false ? [] : (t.submit?.risky || []);
  const product = m['hold-product-assumptions'] === false ? [] : (t.assumptions || []).filter((a) => a.product);
  if (!risky.length && !product.length) return null;
  const parts = [];
  if (risky.length) parts.push(`risky change: ${risky.map((r) => `${r.path} (${r.why})`).join(', ')}`);
  if (product.length) parts.push(`product assumption${product.length > 1 ? 's' : ''}: ${product.map((a) => `"${a.text}"`).join('; ')}`);
  return { reason: parts.join(' · '), paths: risky, assumptions: product };
}

/** A decision the request left open, recorded where the owner sees it (STOP 2). A product one holds the merge. */
export function assume(root, { task: id, text, product = false } = {}) {
  const state = load(root);
  const t = taskOr(state, id);
  if (!['BUILDING', 'JUDGING'].includes(t.status)) fail('NOT_ACTIVE', `${id} is ${t.status}; assumptions are recorded while it is built or judged.`);
  const say = String(text || '').trim();
  if (!say) fail('NO_TEXT', 'Say what you assumed and why (--text "…").');
  return change(root, 'task.assume', id, { text: say.slice(0, 500), product: !!product }, (s) => {
    const x = s.tasks[id];
    (x.assumptions = x.assumptions || []).push({ text: say.slice(0, 500), product: !!product, attempt: x.attempt, at: nowIso() });
    return x.assumptions.at(-1);
  });
}

export function taskMerge(root, id) {
  const state = load(root);
  const t = taskOr(state, id);
  if (t.status !== 'PASSED') fail('NOT_PASSED', `${id} is ${t.status}; only a judged PASS merges.`);
  const cfg = loadConfig(root);
  const dev = ensureDevelop(root, cfg);
  if (currentBranch(root) !== t.branch) { assertClean(root, 'Merging'); checkout(root, t.branch, { carry: true }); }
  assertClean(root, 'Merging');
  if (treeHash(root) !== t.verdict?.tree) fail('TREE_CHANGED', `${id}'s branch differs from what the judge passed. Restore it, or fail the task and start a new attempt.`);
  const hold = holdReason(cfg, t);
  if (hold) {
    // Risky paths or a product assumption: the work stays on its branch and the owner decides (gs decide --merge).
    checkout(root, dev, { carry: true });
    const out = change(root, 'task.hold', id, { reason: hold.reason }, (s) => {
      const x = s.tasks[id];
      const at = nowIso();
      x.hold = { ...hold, at };
      x.history.push({ attempt: x.attempt, outcome: 'HELD', reason: `passed, waits for the owner before merging: ${hold.reason}`, at });
      if (autonomyOf(cfg).mode === 'guided') x.status = 'NEEDS_DECISION';
      else { x.status = 'PARKED'; x.parked = { at, reason: `held for the owner: ${hold.reason}` }; }
      return { merged: false, held: true, reason: `held for the owner: ${hold.reason}` };
    });
    noteParked(root, id);
    bookkeep(root, `chore(ghostship): ${id} held for the owner`);
    return out;
  }
  const base = tryGit(root, ['merge-base', dev, t.branch]).out;
  const devHead = gitRun(root, ['rev-parse', dev]);
  // Ask git first whether it would conflict, without touching the tree; only a clean answer (or an old git) rebases.
  const conflicts = base !== devHead ? mergeConflicts(root, dev, t.branch) : [];
  if (conflicts?.length) {
    const out = change(root, 'task.merge-conflict', id, { files: conflicts }, (s) => {
      const x = s.tasks[id];
      x.history.push({ attempt: x.attempt, outcome: 'MERGE_CONFLICT', reason: `conflicts with ${dev} in ${conflicts.join(', ')}`, at: nowIso() });
      escalate(x, s, cfg, `merge conflict with ${dev} in ${conflicts.join(', ')}`);
      return { merged: false, reason: 'conflict', files: conflicts };
    });
    noteParked(root, id);
    return out;
  }
  // merge-tree said it merges cleanly: the squash below needs no rebase (and a rebase would refuse over the records).
  // Only a git too old to answer (null) still rebases first, as before.
  if (base !== devHead && conflicts === null) {
    const rb = tryGit(root, ['rebase', '-q', dev]);
    if (!rb.ok) {
      tryGit(root, ['rebase', '--abort']);
      const out = change(root, 'task.merge-conflict', id, { detail: rb.out.slice(0, 500) }, (s) => {
        const x = s.tasks[id];
        x.history.push({ attempt: x.attempt, outcome: 'MERGE_CONFLICT', reason: `rebase onto ${dev} failed`, at: nowIso() });
        escalate(x, s, cfg, `merge conflict: rebase onto ${dev} failed`);
        return { merged: false, reason: 'conflict' };
      });
      noteParked(root, id);
      return out;
    }
  }
  checkout(root, dev, { carry: true });
  const sq = tryGit(root, ['merge', '--squash', t.branch]);
  if (!sq.ok) { tryGit(root, ['reset', '--merge']); fail('MERGE_FAILED', sq.out); }
  const msg = conventionalMessage(t);
  let mergeCommit = null;
  if (!tryGit(root, ['diff', '--cached', '--quiet']).ok) {
    gitRun(root, ['commit', '-q', '--no-verify', '-m', msg]);
    mergeCommit = headCommit(root);
  }
  // post-merge regression on develop
  const checksRun = [];
  if (cfg.commands.test) checksRun.push(record(root, { kind: 'merge-regression', task: id, command: cfg.commands.test }));
  if (cfg.commands.acceptance && runChecksOf(state, t).length) checksRun.push(record(root, { kind: 'merge-acceptance', task: id, command: commandFor(cfg, t, 'acceptance', treeHash(root), root, state) }));
  const broken = checksRun.find((e) => !e.accepted);
  if (broken) {
    if (mergeCommit) tryGit(root, ['revert', '--no-edit', mergeCommit]);
    change(root, 'task.merge-reverted', id, { evidence: broken.id }, (s) => {
      const x = s.tasks[id];
      x.history.push({ attempt: x.attempt, outcome: 'FAIL', reason: `post-merge ${broken.kind} failed on ${dev} (${broken.id}); merge reverted`, at: nowIso() });
      retryOrEscalate(x, s, cfg, `post-merge ${broken.kind} failed; merge reverted`);
    });
    noteParked(root, id);
    try { remember(root, 'failed', `merge reverted: post-merge ${broken.kind} failed on develop (${broken.id})`, { task: id }); } catch { /* best effort */ }
    bookkeep(root, `chore(ghostship): ${id} merge reverted`);
    return { merged: false, reason: `post-merge ${broken.kind} failed`, evidence: broken.id };
  }
  tryGit(root, ['branch', '-D', t.branch]);
  change(root, 'task.merge', id, { commit: mergeCommit, message: msg, evidence: checksRun.map((e) => e.id) }, (s) => {
    const x = s.tasks[id];
    x.status = 'MERGED';
    x.merged = { commit: mergeCommit, message: msg, at: nowIso() };
    x.history.push({ attempt: x.attempt, outcome: 'MERGED', reason: msg, at: nowIso() });
  });
  try { remember(root, 'memory', `merged: ${msg}`, { task: id }); } catch { /* best effort */ }
  bookkeep(root, `chore(ghostship): ${id} merged`);
  return { merged: true, commit: mergeCommit, message: msg };
}

export function decide(root, { task: id, grant, drop, merge, note, ...gate } = {}) {
  const state = load(root);
  const t = taskOr(state, id);
  const say = typeof note === 'string' ? note.trim().slice(0, 2000) : '';
  if (note !== undefined && note !== false && !say) fail('NO_NOTE', '--note needs the text for the builder.');
  if (say && drop) fail('BAD_NOTE', 'A note goes to the next builder: pass it with --grant (or --merge), not --drop.');
  if (merge) {
    if (!t.hold) fail('NOT_HELD', `${id} is not held for a merge decision (${t.status}).`);
    if (t.status !== 'NEEDS_DECISION' && t.status !== 'PARKED') fail('NOT_NEEDS_DECISION', `${id} is ${t.status}`);
    const act = activeTask(state);
    if (act) fail('TASK_ACTIVE', `${act.id} is ${act.status}. Merge ${id} when it is done (at STOP 2 at the latest).`);
  }
  const g = humanGate(loadConfig(root), gate);
  if (merge) {
    try { remember(root, 'decision', `owner approved the held merge${g.quote ? `: "${g.quote}"` : ''}`, { task: id }); } catch { /* best effort */ }
    const dropped = !!state.release;
    change(root, 'human.merge', id, { gate: g, note: say || undefined }, (s) => {
      const x = s.tasks[id];
      const at = nowIso();
      x.status = 'PASSED'; x.mergeApproved = { gate: g, at }; delete x.parked;
      if (say) x.history.push({ attempt: x.attempt, outcome: 'OWNER_NOTE', reason: say, at });
      (s.decisions = s.decisions || []).push({ task: id, merge: true, gate: g, at });
      // A candidate prepared without this work is stale once it merges: the next gs next prepares a new one.
      if (s.release) s.release = null;
    });
    return { ...taskMerge(root, id), candidateDropped: dropped };
  }
  if (drop) {
    if (ACTIVE.has(t.status)) fail('TASK_ACTIVE', 'Fail the task before dropping it.');
    try { remember(root, 'decision', `owner dropped the task${g.quote ? `: "${g.quote}"` : ''}`, { task: id }); } catch { /* best effort */ }
    return change(root, 'human.drop', id, { gate: g }, (s) => { s.tasks[id].status = 'DROPPED'; (s.decisions = s.decisions || []).push({ task: id, drop: true, gate: g, at: nowIso() }); });
  }
  const n = Number(grant);
  if (!Number.isInteger(n) || n < 1 || n > 3) fail('BAD_GRANT', 'grant 1..3 extra attempts');
  if (t.status !== 'NEEDS_DECISION' && t.status !== 'PARKED') fail('NOT_NEEDS_DECISION', `${id} is ${t.status}`);
  try { remember(root, 'decision', `owner granted ${n} more attempt(s)${g.quote ? `: "${g.quote}"` : ''}`, { task: id }); } catch { /* best effort */ }
  return change(root, 'human.grant', id, { grant: n, gate: g, note: say || undefined }, (s) => {
    const x = s.tasks[id];
    x.maxAttempts = Math.max(x.maxAttempts, x.attempt) + n; x.status = 'RETRY'; delete x.parked;
    // Rework of a held task: the owner sent it back, so its judged PASS no longer stands.
    if (x.hold) { x.history.push({ attempt: x.attempt, outcome: 'REWORK', reason: `owner sent it back instead of merging: ${x.hold.reason}`, at: nowIso() }); delete x.hold; delete x.mergeApproved; }
    if (say) x.history.push({ attempt: x.attempt, outcome: 'OWNER_NOTE', reason: say, at: nowIso() });
    (s.decisions = s.decisions || []).push({ task: id, grant: n, gate: g, at: nowIso() });
  });
}

// ------------------------------------------------------------------ release (STOP 2)

/** The autonomy scorecard (lib/scorecard.mjs) as a packet section; an absent or failing module costs nothing. */
function scorecardSection(root) {
  try {
    const SC = createRequire(import.meta.url)('./scorecard.mjs');
    const md = SC.markdown(SC.scorecard(root));
    return md ? [md.trimEnd(), ''] : [];
  } catch { return []; }
}

function lastTag(root) {
  const r = tryGit(root, ['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*']);
  return r.ok ? r.out : null;
}

export function releaseCandidate(root) {
  const state = load(root);
  if (state.change) fail('CHANGE_OPEN', `A ${state.change.scope} change is open (${state.change.reason}). Finish it before releasing.`);
  if (!state.prd?.approved) fail('PRD_NOT_APPROVED', 'The PRD is not approved.');
  assertLocks(root, state);
  needAcceptance(state);
  const tasks = Object.values(state.tasks || {});
  if (!tasks.length) fail('NO_TASKS', 'Nothing to release.');
  // Parked tasks, and tasks that wait on them, go to STOP 2 for the owner instead of holding the release.
  const waiting = new Set(waitingOnParked(state));
  const parked = tasks.filter((t) => t.status === 'PARKED');
  const open = tasks.filter((t) => t.status !== 'MERGED' && t.status !== 'DROPPED' && t.status !== 'PARKED' && !waiting.has(t.id));
  if (open.length) fail('TASKS_OPEN', `Not all tasks merged: ${open.map((t) => `${t.id}=${t.status}`).join(', ')}`);
  const cov = coverage(root);
  if (cov.uncoveredRun.length) fail('UNCOVERED_CHECKS', `run checks without a task: ${cov.uncoveredRun.join(', ')}`);
  const cfg = loadConfig(root);
  if (!cfg.commands.test || !cfg.commands.acceptance) fail('NO_COMMAND', 'Release needs commands.test and commands.acceptance.');
  const dev = ensureDevelop(root, cfg);
  assertCleanExcept(root, ['docs']);
  if (currentBranch(root) !== dev) checkout(root, dev);
  commitDocs(root, ['docs'], 'docs: prepare release docs');
  if (cfg.docs?.['release-gate'] !== false) {
    const dc = docsCheck(root);
    if (!dc.ok) fail('DOCS_INCOMPLETE', `The release ships its docs. Fill these first (a task, or the orchestrator for docs-only): ${[...dc.missing.map((m) => `${m} (missing)`), ...dc.unfilled.map((m) => `${m} (still has TODO)`)].join(', ')}`);
  }
  traceability(root);
  const tree = treeHash(root);
  const runIds = state.acceptance.checks.filter((c) => c.kind === 'run').map((c) => c.id);
  const regression = record(root, { kind: 'final-regression', task: null, command: cfg.commands.test });
  const acceptance = record(root, { kind: 'final-acceptance', task: null, command: withFiles(cfg.commands.acceptance, Object.values(checkFiles(root, tree, runIds)).flat()) });
  const prevTag = lastTag(root);
  const range = prevTag ? `${prevTag}..HEAD` : 'HEAD';
  const msgs = gitRun(root, ['log', '--format=%B%x00', range]).split('\0').map((s) => s.trim()).filter(Boolean)
    .filter((m) => !/^chore\(ghostship\)|^chore\(release\)|^wip\(/.test(m));
  msgs.reverse();
  const version = nextVersion(prevTag ? prevTag.replace(/^v/, '') : null, msgs);
  const date = nowIso().slice(0, 10);
  const c = parseContract(read(root, DOCS.acceptance));
  const rows = c.checks.map((k) => {
    if (k.kind === 'pick') return { ...k, status: 'YOUR PICK', tasks: '-', ev: k.reference };
    const rev = state.acceptance.checks.find((c) => c.id === k.id)?.rev || 1;
    const ts = tasks.filter((t) => t.checks.includes(k.id) && t.status === 'MERGED' && (t.acceptanceRev || 1) >= rev);
    const pass = ts.length > 0 && acceptance.accepted && ts.every((t) => String(t.verdict?.checks?.[k.id] || '').startsWith('PASS'));
    const held = tasks.filter((t) => t.checks.includes(k.id) && (t.status === 'PARKED' || waiting.has(t.id))).map((t) => t.id);
    return { ...k, status: pass ? 'PASS' : held.length && !ts.length ? `PARKED (${held.join(', ')})` : (ts.length ? 'FAIL' : 'NOT COVERED'), tasks: ts.map((t) => t.id).join(', ') || held.join(', ') || '-', ev: acceptance.id };
  });
  const runFail = !regression.accepted || rows.some((r) => r.kind === 'run' && r.status !== 'PASS');
  const result = runFail ? 'FAIL' : (rows.some((r) => r.kind === 'pick') || c.unknowns.length ? 'NEEDS_YOUR_CALL' : 'PASS');
  const esc = (s) => String(s).replace(/\|/g, '\\|');
  const held = tasks.filter((t) => t.hold && (t.status === 'PARKED' || t.status === 'NEEDS_DECISION'));
  const assumed = tasks.filter((t) => t.status !== 'DROPPED').flatMap((t) => (t.assumptions || []).map((a) => ({ t, a })));
  const changelog = changelogSection(version, date, msgs);
  const md = [
    `# Release v${version} — ${c.destination}`, '',
    `Prepared ${nowIso()} · previous ${prevTag || '(first release)'} · tree ${tree.slice(0, 12)} · acceptance ${state.acceptance.sha.slice(0, 12)} · evidence ${regression.id} ${acceptance.id}`, '',
    `## Result: ${result}`, '',
    result === 'FAIL' ? 'At least one run check or the full regression is not PASS. Releasing needs an explicit override.'
      : result === 'NEEDS_YOUR_CALL' ? 'Every run check passes. You still judge each pick row and accept or resolve each unknown.' : 'Every check passes.', '',
    '## Checks', '| # | check | kind | tasks | status | evidence |', '|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.id} | ${esc(r.text)} | ${r.kind} | ${r.tasks} | ${r.status} | ${esc(r.ev)} |`), '',
    '## Unknowns (yours to accept or resolve)',
    ...(c.unknowns.length ? c.unknowns.map((u) => `- ${u.id}: ${u.text} — owner ${u.owner || '?'}, by ${u.by || '?'}`) : ['- None identified']), '',
    '## Out of scope (anything built here is a defect)', ...c.outOfScope.map((o) => `- ${o.replace(/^(\d+[.)]|[-*])\s+/, '')}`), '',
    '## Tasks', '| task | status | attempts | merge |', '|---|---|---|---|',
    ...tasks.map((t) => `| ${t.id} ${esc(t.title)} | ${t.status} | ${t.attempt}/${t.maxAttempts} | ${t.merged?.commit?.slice(0, 10) || '-'} |`), '',
    '## Parked tasks (autopilot set these aside; yours to grant more attempts or drop)',
    ...(parked.length ? [
      '| task | attempts | last reason | waiting on it |', '|---|---|---|---|',
      ...parked.map((t) => `| ${t.id} ${esc(t.title)} | ${t.attempt}/${t.maxAttempts} | ${esc(String(t.parked?.reason || t.history.at(-1)?.reason || '-').slice(0, 200))} | ${[...waiting].filter((w) => state.tasks[w].blockedBy.includes(t.id)).join(', ') || '-'} |`),
      '', `Grant more attempts: \`gs decide <id> --grant 1\` · drop: \`gs decide <id> --drop\``,
    ] : ['- none']), '',
    '## Held for you (passed, not merged: risky change or product assumption)',
    ...(held.length ? [
      '| task | why | branch |', '|---|---|---|',
      ...held.map((t) => `| ${t.id} ${esc(t.title)} | ${esc(t.hold.reason.slice(0, 300))} | ${t.branch || '-'} |`),
      '', 'Merge: `gs decide <id> --merge` · send back: `gs decide <id> --grant 1 --note "…"` · drop: `gs decide <id> --drop`',
    ] : ['- none']), '',
    '## Assumptions the builders made',
    ...(assumed.length ? assumed.map(({ t, a }) => `- ${t.id}${a.product ? ' **(product decision)**' : ''}: ${esc(a.text)}`) : ['- none recorded']), '',
    '## Your decisions on record',
    ...((state.decisions || []).length ? state.decisions.map((d) => `- ${d.at} ${d.task}: ${d.drop ? 'DROPPED' : d.merge ? 'MERGE APPROVED' : `+${d.grant} attempts`} (${d.gate.via}${d.gate.quote ? `: "${d.gate.quote}"` : ''})`) : ['- none']), '',
    ...scorecardSection(root),
    '## Changelog', changelog,
    '## Blast radius', '```', (prevTag ? diffStat(root, gitRun(root, ['rev-parse', `${prevTag}^{tree}`]), tree) : `${listTree(root, tree).length} files (first release)`) || '(no changes)', '```', '',
  ].join('\n');
  const packetRel = `${DOCS.releases}/v${version}.md`;
  put(root, packetRel, md);
  const prevLog = read(root, DOCS.changelog) || '# Changelog\n\n';
  const [head, ...rest] = prevLog.split(/\n(?=## )/);
  // A new candidate for the same version (stale evidence, a held task merged) replaces its section, never repeats it.
  const others = rest.filter((sec) => !sec.startsWith(`## ${version} `));
  put(root, DOCS.changelog, [head.trimEnd() + '\n', changelog, ...others].join('\n'));
  const sha = sha256(md);
  change(root, 'release.candidate', null, { version, result, sha, tree }, (s) => {
    s.release = { version, prev: prevTag, packet: packetRel, sha, result, tree, evidence: [regression.id, acceptance.id], at: nowIso() };
    s.stage = 'release';
  });
  return { version, result, packet: packetRel };
}

export function releaseApprove(root, { override, ...gate } = {}) {
  const state = load(root);
  assertLocks(root, state);
  const rel = state.release;
  if (!rel) fail('NO_CANDIDATE', 'Prepare a candidate first: gs release candidate');
  if (sha256(read(root, rel.packet) || '') !== rel.sha) fail('PACKET_CHANGED', `${rel.packet} was edited. Regenerate it.`);
  const drift = changedPaths(root, rel.tree, treeHash(root)).filter((p) => !p.startsWith(DOCS.releases + '/'));
  if (drift.length) fail('STALE_EVIDENCE', `Code changed since the candidate: ${drift.join(', ')}. Prepare a new candidate.`);
  if (rel.result === 'FAIL' && !override) fail('RELEASE_BLOCKED', 'The candidate is FAIL. Only your explicit override releases it.');
  const g = humanGate(loadConfig(root), gate);
  const cfg = loadConfig(root);
  const tag = `v${rel.version}`;
  if (!hasIdentity(root)) fail('NO_GIT_IDENTITY', 'Set git user.name and user.email first.');
  commitWork(root, `chore(release): ${tag}`);
  bookkeep(root, `chore(ghostship): ${tag} approved`); // main may hold older state files; commit ours before switching
  const dev = cfg.branches.develop, main = cfg.branches.main;
  if (!branchExists(root, main)) gitRun(root, ['branch', main, dev]);
  checkout(root, main);
  const m = tryGit(root, ['merge', '--no-ff', '-q', '-m', `chore(release): merge ${tag}`, dev]);
  if (!m.ok) { tryGit(root, ['merge', '--abort']); checkout(root, dev); fail('MERGE_FAILED', m.out); }
  gitRun(root, ['tag', '-a', tag, '-m', `Release ${tag}`]);
  const releaseCommit = headCommit(root);
  checkout(root, dev);
  tryGit(root, ['merge', '--ff-only', '-q', main]);
  change(root, 'release.approve', null, { version: rel.version, override: !!override, gate: g, commit: releaseCommit }, (s) => {
    (s.releases = s.releases || []).push({ ...s.release, tag, commit: releaseCommit, override: !!override, gate: g, approvedAt: nowIso() });
    s.release = null;
    s.stage = 'build';
  });
  try { remember(root, 'memory', `released ${tag} (${rel.result}${override ? ', override' : ''})`); } catch { /* best effort */ }
  bookkeep(root, `chore(ghostship): ${tag} released`);
  let site = null;
  try {
    const b = buildSite(root, { out: 'docs-site', version: tag });
    const pack = packSite(root, 'docs-site', `docs-site/${slugify(cfg.project?.name || 'project')}-docs-${tag}.tar.gz`, `${slugify(cfg.project?.name || 'project')}-docs-${tag}`);
    site = { ...b, archive: pack.path };
  } catch (e) { site = { error: e.message }; }
  return { tag, commit: releaseCommit, site };
}

// ------------------------------------------------------------------ audit + status

export function audit(root) {
  const state = load(root);
  const { problems, events } = verifyEventChain(root);
  for (const [id, e] of Object.entries(state.evidence || {})) {
    try {
      if (sha256(readFileSync(join(root, e.dir, 'manifest.json'), 'utf8')) !== e.manifestSha256) problems.push(`${id}: manifest edited`);
      if (sha256(readFileSync(join(root, e.dir, 'output.log'), 'utf8')) !== e.outputSha256) problems.push(`${id}: output.log edited`);
    } catch { problems.push(`${id}: evidence files missing`); }
  }
  for (const [key, label] of [['prd', 'PRD'], ['acceptance', 'acceptance checks']]) {
    const l = state[key];
    if (l?.approved && sha256(read(root, l.path) ?? '') !== l.sha) problems.push(`${label} changed since approval`);
  }
  if (state.acceptanceLock) {
    const drift = acceptanceDrift(root, state, treeHash(root));
    if (drift.length) problems.push(`locked acceptance tests changed: ${drift.join(', ')}`);
  }
  return { ok: problems.length === 0, problems, events };
}

export function status(root) {
  const state = load(root);
  const act = activeTask(state);
  const fr = frontier(state);
  const counts = {};
  for (const t of Object.values(state.tasks || {})) counts[t.status] = (counts[t.status] || 0) + 1;
  const needs = Object.values(state.tasks || {}).filter((t) => t.status === 'NEEDS_DECISION').map((t) => t.id);
  const parked = Object.values(state.tasks || {}).filter((t) => t.status === 'PARKED').map((t) => t.id);
  const waiting = new Set(waitingOnParked(state));
  const autonomy = autonomyOf(loadConfig(root));
  const cov = state.acceptance ? coverage(root) : null;
  // What happens next comes from one place (lib/next.mjs), so status, the Stop hook, the runner and the Bridge agree.
  let next;
  try { next = nextStep(root).say; } catch (e) { next = `Blocked: ${e.message}`; }
  const pz = isPaused(root);
  return {
    paused: !!pz, stage: state.stage, active: act ? { id: act.id, status: act.status, attempt: act.attempt, max: act.maxAttempts } : null,
    counts, frontier: fr, needsDecision: needs, parked, uncovered: cov?.uncoveredRun || [], approvals: loadConfig(root).approvals.mode, autonomy: autonomy.mode,
    release: state.release ? { version: state.release.version, result: state.release.result } : null, next,
  };
}

export { STAGES, STATE_DIR };
