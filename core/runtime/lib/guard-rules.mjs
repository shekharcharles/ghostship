// Pure policy for the PreToolUse guard. evaluate() returns { deny: false } or { deny: true, reason }.
// Layers: (1) enforcement + records are CLI-only, (2) locked documents/tests, (3) roles, (4) task scope.
// Bash is checked best-effort; the deterministic backstop is the tree-hash scope check at submit and audit.
import { matchesAny, normRel } from './util.mjs';
import { activeTask } from './engine.mjs';
import { DOCS, ACCEPTANCE_TESTS_DIR } from './paths.mjs';

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
export const JUDGE = 'ghostship-judge';
export const BUILDER = 'ghostship-builder';
export const PLANNER = 'ghostship-planner';

const RECORDS = ['.ghostship/runs/asks.json', '.ghostship/state/**', '.ghostship/evidence/**', '.ghostship/core/**', '.ghostship/VERSION', '.ghostship/learned/**', '.ghostship/runs/pause.json', '.ghostship/runs/active.json', '.ghostship/runs/gateway.json', 'tasks/**'];
const ENFORCEMENT_ANYWHERE = [
  /(^|\/)\.claude\/settings(\.local)?\.json$/i,
  /(^|\/)\.claude\/agents\/ghostship-[^/]*\.md$/i,
  /(^|\/)\.claude\/skills\/ghostship-bridge\//i,
  /(^|\/)\.ghostship\/secrets$/i,
  /(^|\/)\.ghostship\/bridge\.key$/i,
];
// Files that hold secrets: never read, searched or listed into an agent's context.
const SECRET_RE = /(^|\/)(\.env(\.(?!example$|sample$|template$)[\w.-]+)?|[^/]+\.(pem|key|p12|pfx)|id_(rsa|ed25519|ecdsa)|\.ghostship\/secrets|\.ghostship\/bridge\.key|\.ghostship\/runs\/gateway\.json)$/i;
const FIXTURE_KEY = /(^|\/)(tests?|fixtures?|__fixtures__|testdata|spec)\/(.+\/)?[^/]+\.(pem|key|p12|pfx)$/i;
// A key or certificate under a test fixtures folder is test data, not a secret.
const SECRET_FILE = { test: (p) => SECRET_RE.test(p) && !FIXTURE_KEY.test(p) };
// Always writable scratch (excluded from tree hashes, so writing them never invalidates evidence).
const SCRATCH = ['.ghostship/drafts/**', '.ghostship/interview/**', '.ghostship/handoff/**', '.ghostship/runs/**', 'docs/11-memory/**'];
const WRITEISH = /(>|\btee\b|\brm\b|\bmv\b|\bcp\b|\bsed\b[^|;&]*\s-i|\bperl\b|\bpython3?\b|\bruby\b|\bnode\s+-e|\btruncate\b|\bdd\b|\bln\b|\bchmod\b|\btouch\b|\bunlink\b|\binstall\b|\brsync\b|\bgit\s+(checkout|restore|reset|clean|stash|rm|mv|apply|am)\b|Set-Content|Add-Content|Out-File|Remove-Item|Move-Item|Copy-Item|New-Item|Rename-Item|Clear-Content|\bdel\b|\berase\b|\brd\b|\brmdir\b)/i;
const GIT_MUTATE = /\bgit\s+(checkout|switch|reset|rebase|merge|commit|push|tag|stash|clean|branch\s+-[dDmM]|cherry-pick|revert|am|apply)\b/;

const deny = (reason) => ({ deny: true, reason });
const ALLOW = { deny: false };
const slashes = (s) => String(s || '').replace(/\\/g, '/');

function targetPaths(tool, input) {
  if (tool === 'NotebookEdit') return [input?.notebook_path];
  if (tool === 'MultiEdit' && Array.isArray(input?.edits) && !input.file_path) return input.edits.map((e) => e.file_path);
  return [input?.file_path];
}

function phase(state) {
  return {
    prdLocked: !!state.prd?.approved,
    accLocked: !!state.acceptance?.approved,
    testsLocked: !!state.acceptanceLock,
    lockedFiles: state.acceptanceLock?.files || {},
    amendPending: !!state.acceptanceLock && (state.acceptanceLock.rev || 1) < (state.acceptance?.rev || 1),
    act: activeTask(state),
  };
}

function shell(state, cmd, agent) {
  const { prdLocked, accLocked, testsLocked, amendPending } = phase(state);
  if (/runtime\/lib\/[\w-]+\.mjs/.test(cmd)) return deny('Call the Ghostship CLI (gs.mjs), not its library modules.');
  if (/\.ghostship\/secrets\b/.test(cmd)) return deny('~/.ghostship/secrets is never read or written by agents.');
  if (/bridge\.key\b|owner-key-stdin/.test(cmd)) return deny('The Bridge owner key is the owner\'s alone. Approvals from the Bridge are pressed by the owner in the pane.');
  if (/gateway\.json\b/.test(cmd)) return deny('The gateway key is read only by the gs CLI (gs gateway env, for the owner).');
  const scan = cmd
    .replace(/\d?>&\d/g, ' ').replace(/\d?>\s*\/dev\/null/g, ' ').replace(/\d?>\s*nul\b/gi, ' ')
    .replace(/\S*\.ghostship\/core\/runtime\/gs\.mjs/g, 'GS_CLI');
  const touches = /\.ghostship\/(state|evidence|core|learned|config\.yaml|VERSION)\b|\.ghostship\/runs\/(pause|active|gateway)\.json/.test(scan)
    || /(^|[\s'"=(])tasks\//.test(scan)
    || /\.claude\/settings(\.local)?\.json/i.test(scan)
    || /\.claude\/agents\/ghostship-/i.test(scan)
    || /\.claude\/skills\/ghostship-bridge/i.test(scan)
    || (prdLocked && scan.includes(DOCS.prd))
    || (accLocked && scan.includes(DOCS.acceptance))
    || (testsLocked && !amendPending && scan.includes(ACCEPTANCE_TESTS_DIR + '/'))
    || Object.keys(phase(state).lockedFiles).some((f) => scan.includes(f));
  if (touches && WRITEISH.test(scan)) return deny('Ghostship records, locked documents and enforcement config change only through the gs CLI.');
  const gs0 = /GS_CLI|\bgs(\.mjs)?\s/.test(scan) || /gs\.mjs\b/.test(scan) ? scan : '';
  // The role checks below read the command's words, not the prose an agent passes as a value: a quoted --text, --note or
  // --reason ("we go with numbers only") is blanked first. Only a value the shell cannot expand is blanked: single
  // quotes, or double quotes with no $ ` or \, so no command can hide inside one.
  const gs = gs0.replace(/--(text|note|reason)(\s+|=)("[^"$`\\]*"|'[^']*')/g, '--$1$2""');
  if (gs && /\bask\s+answer\b|\basks\s+deliver\b/.test(gs)) return deny('Only the owner answers the queue (Bridge pane, Harbor or their own terminal). File the need with `gs ask` and keep working.');
  if (agent === BUILDER || agent === JUDGE || agent === PLANNER) {
    if (GIT_MUTATE.test(cmd)) return deny('Branches and commits are managed by the gs CLI. Subagents never run mutating git commands.');
    if (gs && /\b(approve|decide|reopen|release|merge|import|dispatch|quota|gateway|go|pause|migrate|upgrade|github|ask|asks|autonomy|preflight)\b|\bconfig\s+set\b|\bchange\s+open\b|\brun\s+(stop|clear)\b/.test(gs)) return deny('Approvals, decisions, imports, merges and releases are not for subagents.');
  }
  if (agent === BUILDER && gs && (/\bverdict\b/.test(gs) || /--kind[ =]judge\b/.test(gs) || /\btask\s+(submit|reissue)\b/.test(gs))) {
    return deny('The builder cannot submit or judge. Report "ready to submit"; the orchestrator submits, so the judge token never reaches you.');
  }
  if (agent === JUDGE && gs && (/\btask\s+(start|submit|fail)\b|\bcodemap\b/.test(gs) || (/\bevidence\b/.test(gs) && !/--kind[ =]judge\b/.test(gs)))) {
    return deny('The judge only runs `gs evidence --kind judge` and `gs verdict`. It never builds or re-plans.');
  }
  return ALLOW;
}

export function evaluate(state, root, payload) {
  const tool = payload.tool_name;
  const input = payload.tool_input || {};
  const agent = payload.agent_type || '';
  if (SHELL_TOOLS.has(tool)) return shell(state, slashes(input.command), agent);
  if (tool === 'Read') {
    const p = slashes(input.file_path);
    if (SECRET_FILE.test(p)) return deny(`${p} holds credentials. Agents never read it.`);
    return ALLOW;
  }
  if (tool === 'Grep') {
    // A content search prints what it matches, so a search aimed at a secrets file reads it. (Glob only lists names.)
    const p = slashes(input.path || '');
    const g = slashes(input.glob || '');
    if (SECRET_FILE.test(p) || /(^|[/{,])\.env\b|\.ghostship\/(secrets|bridge\.key)|\*\.(pem|key)\b/i.test(g)) return deny('That search reaches a secrets file. Agents never read credentials; ask the owner for the value\'s name instead.');
    return ALLOW;
  }
  if (!WRITE_TOOLS.has(tool)) return ALLOW;
  const { prdLocked, accLocked, testsLocked, act, lockedFiles, amendPending } = phase(state);

  for (const raw of targetPaths(tool, input)) {
    const p = slashes(raw);
    if (!p) return deny(`${tool} without a target path`);
    if (ENFORCEMENT_ANYWHERE.some((re) => re.test(p))) return deny(`${p} is Ghostship enforcement or secrets. Agents never edit it.`);
    const rel = normRel(root, p);
    if (rel === null) continue; // outside the project
    if (matchesAny(rel, RECORDS)) return deny(`${rel} is written only by the gs CLI.`);
    if (agent === JUDGE) return deny('The judge is read-only. Put findings in the verdict; never repair.');
    if (matchesAny(rel, SCRATCH)) continue;
    if (rel === '.ghostship/config.yaml') return deny('Agents change config only through `gs config set` (commands, tier, routing). Agents, providers, launch templates and policy are the owner\'s to edit.');
    if (prdLocked && rel === DOCS.prd) return deny('The PRD is approved and locked. Changes go through /ghostship change.');
    if (accLocked && rel === DOCS.acceptance) return deny('Acceptance checks are approved and locked (STOP 1). Changes go through /ghostship change.');
    if (rel.startsWith(ACCEPTANCE_TESTS_DIR + '/')) {
      if (rel in lockedFiles) return deny('That acceptance test is locked. Weakening it to pass is refused; a changed check goes through /ghostship change.');
      if (testsLocked && !amendPending) return deny('Acceptance tests are locked. New ones are written only after a change to the checks is approved.');
      if (act) return deny('Acceptance tests are written outside tasks, before the lock.');
      continue;
    }
    if (!accLocked) continue; // before STOP 1: discovery, design and prototypes write freely
    if (act && act.status !== 'BUILDING') return deny(`${act.id} is ${act.status}; the tree is frozen until it is judged and merged.`);
    const docsFree = rel.startsWith('docs/') && !rel.startsWith(DOCS.releases + '/');
    if (!act) {
      if (docsFree) continue;
      return deny('No active task. After STOP 1, code changes go through a task: gs task start <id>.');
    }
    if (docsFree) continue;
    if (!matchesAny(rel, act.allowedPaths)) return deny(`${rel} is outside ${act.id} allowedPaths [${act.allowedPaths.join(', ')}]. Scope is never widened silently.`);
    if (Object.prototype.hasOwnProperty.call(act.locks || {}, rel)) return deny(`${rel} is a test locked at RED. If the test itself is wrong, say so and record a new RED.`);
  }
  return ALLOW;
}
