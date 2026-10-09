// herdr adapter: one workspace per project, one named tab per agent run, agents started and watched through herdr's CLI.
// Every call goes through an injectable `run` so tests can replace the real binary.
import { spawnSync } from 'node:child_process';

export function realRun(args, { timeoutMs = 600000 } = {}) {
  const r = spawnSync('herdr', args, { encoding: 'utf8', timeout: timeoutMs + 5000, windowsHide: true });
  return { status: typeof r.status === 'number' ? r.status : 1, stdout: r.stdout || '', stderr: r.stderr || (r.error ? r.error.message : '') };
}

export class HerdrError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

function json(r, what) {
  if (r.status !== 0) {
    let code = 'herdr_error';
    try { code = JSON.parse(r.stderr).error?.code || JSON.parse(r.stderr).code || code; } catch { /* plain text */ }
    throw new HerdrError(`herdr ${what} failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`, code);
  }
  try { return JSON.parse(r.stdout); } catch { return { raw: r.stdout }; }
}

/** herdr is usable when this process runs inside a herdr pane (HERDR_ENV=1) and the binary is on PATH. */
export function available(env = process.env, which) {
  return env.HERDR_ENV === '1' && (!which || !!which('herdr'));
}

// What a run is doing, as a verb a person reads at a glance.
const VERB = { builder: 'build', judge: 'judge', planner: 'plan' };
const slug = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
/** herdr agent id: safe characters only, but still says what it is: gs-t004-build-add-two-numbers (attempt > 1 adds -try2). */
export const agentName = (task, role, attempt, title = '') =>
  ['gs', task && task !== 'plan' ? slug(task) : '', VERB[role] || role, slug(title), attempt > 1 ? `try${attempt}` : ''].filter(Boolean).join('-').replace(/-+/g, '-').slice(0, 56).replace(/-$/, '');
/** The name a person sees on the tab, the Claude session and the subagent: "⛴ T004 build · Add two numbers · try 2". */
export function runLabel({ task, role, attempt = 1, title = '' } = {}) {
  const what = `${task ? `${task} ` : ''}${VERB[role] || role}`;
  const t = String(title || '').replace(/\s+/g, ' ').trim();
  return `⛴ ${what}${t ? ` · ${t.length > 48 ? `${t.slice(0, 47)}…` : t}` : ''}${attempt > 1 ? ` · try ${attempt}` : ''}`;
}

export function createHerdr({ run = realRun, env = process.env } = {}) {
  return {
    /** Tabs go into the orchestrator's own workspace when it runs inside herdr; otherwise into a project workspace. */
    workspace(root, label) {
      if (env.HERDR_WORKSPACE_ID) return env.HERDR_WORKSPACE_ID;
      const created = json(run(['workspace', 'create', '--cwd', root, '--label', label, '--no-focus']), 'workspace create');
      return created.result?.workspace?.workspace_id;
    },
    openTab({ workspace, cwd, label, env: vars = {} }) {
      const args = ['tab', 'create', '--cwd', cwd, '--label', label, '--no-focus'];
      if (workspace) args.splice(2, 0, '--workspace', workspace);
      for (const [k, v] of Object.entries(vars)) args.push('--env', `${k}=${v}`);
      const r = json(run(args), 'tab create');
      return { tabId: r.result?.tab?.tab_id, paneId: r.result?.root_pane?.pane_id };
    },
    startAgent({ name, kind, paneId, args = [], timeoutMs = 60000 }) {
      return json(run(['agent', 'start', name, '--kind', kind, '--pane', paneId, '--timeout', String(timeoutMs), '--', ...args], { timeoutMs }), 'agent start').result?.agent;
    },
    runInPane({ paneId, command }) {
      return json(run(['pane', 'run', paneId, command]), 'pane run');
    },
    /** Sends the prompt and waits until the agent settles. Returns the agent status: idle | done | blocked | unknown. */
    prompt({ name, text, timeoutMs }) {
      const r = json(run(['agent', 'prompt', name, text, '--wait', '--timeout', String(timeoutMs)], { timeoutMs }), 'agent prompt');
      return r.result?.agent?.status || r.result?.agent?.state || 'unknown';
    },
    wait({ name, until = ['idle', 'done'], timeoutMs }) {
      const args = ['agent', 'wait', name, ...until.flatMap((u) => ['--until', u]), '--timeout', String(timeoutMs)];
      const r = json(run(args, { timeoutMs }), 'agent wait');
      return r.result?.agent?.status || r.result?.agent?.state || 'unknown';
    },
    read({ name, lines = 80 }) {
      const r = run(['agent', 'read', name, '--source', 'recent-unwrapped', '--lines', String(lines)]);
      return r.status === 0 ? r.stdout : '';
    },
    closeTab(tabId) {
      return run(['tab', 'close', tabId]).status === 0;
    },
  };
}
