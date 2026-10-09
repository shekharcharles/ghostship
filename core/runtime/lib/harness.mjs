// Agent CLIs Ghostship knows how to find and start. Ghostship never adds a permission-bypass flag:
// headless runs use each tool's own scoped/sandboxed mode; anything else runs in a visible herdr tab.
import { execFileSync } from 'node:child_process';

// headless: argv builder for a non-interactive run, or null when the tool has no safe scoped mode.
// tab: extra args after herdr's canonical executable for an interactive run.
export const CATALOG = {
  claude: {
    bins: ['claude'], herdrKind: 'claude', agentsMd: true,
    headless: (o) => ['-p', o.prompt, '--model', o.model, ...(o.skipPermissions ? ['--dangerously-skip-permissions'] : ['--permission-mode', 'acceptEdits', '--allowedTools', ...allowedTools(o.role)]), '-n', o.name],
    tab: (o) => ['--model', o.model, ...(o.remoteControl ? ['--remote-control', o.name] : ['-n', o.name])],
  },
  codex: {
    bins: ['codex'], herdrKind: 'codex', agentsMd: true,
    headless: (o) => ['exec', '-m', o.model, '--sandbox', 'workspace-write', '--ask-for-approval', 'never', '-C', o.root, o.prompt],
    tab: (o) => ['-m', o.model, '--sandbox', 'workspace-write'],
  },
  gemini: { bins: ['gemini'], herdrKind: 'gemini', agentsMd: false, headless: null, tab: (o) => (o.model ? ['-m', o.model] : []) },
  qwen: { bins: ['qwen'], herdrKind: 'qwen', agentsMd: false, headless: null, tab: (o) => (o.model ? ['-m', o.model] : []) },
  opencode: { bins: ['opencode'], herdrKind: 'opencode', agentsMd: true, headless: null, tab: () => [] },
  agy: { bins: ['agy', 'antigravity'], herdrKind: 'agy', agentsMd: true, headless: null, tab: () => [] },
  kimi: { bins: ['kimi'], herdrKind: 'kimi', agentsMd: true, headless: null, tab: () => [] },
  pi: { bins: ['pi'], herdrKind: 'pi', agentsMd: true, headless: null, tab: () => [] },
  copilot: { bins: ['copilot'], herdrKind: 'copilot', agentsMd: true, headless: null, tab: () => [] },
  cursor: { bins: ['cursor-agent'], herdrKind: 'cursor', agentsMd: true, headless: null, tab: () => [] },
  droid: { bins: ['droid'], herdrKind: 'droid', agentsMd: true, headless: null, tab: () => [] },
  // No herdr kind and no published flags Ghostship can rely on: the owner supplies `harnesses.<id>.headless`.
  'prime-agent': { bins: ['prime-agent', 'prime'], herdrKind: null, agentsMd: true, headless: null, tab: null },
  dsh: { bins: ['dsh', 'deepsea'], herdrKind: null, agentsMd: true, headless: null, tab: null },
};

export const BYPASS = /--dangerously|--yolo\b|bypassPermissions|--auto\b|--approval-mode[ =]yolo|danger-full-access|--skip-permissions/i;

const GS = 'node .ghostship/core/runtime/gs.mjs';
export function allowedTools(role) {
  const read = ['Read', 'Glob', 'Grep', 'Bash(git status *)', 'Bash(git diff *)', 'Bash(git log *)', 'Bash(ls *)', `Bash(${GS} *)`];
  if (role === 'judge') return [...read, 'Bash(cp *)'];
  if (role === 'planner') return [...read, 'Write'];
  return [...read, 'Edit', 'Write', 'MultiEdit'];
}

function defaultWhich(bin) {
  try { return execFileSync(process.platform === 'win32' ? 'where' : 'which', [bin], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(/\r?\n/)[0] || null; } catch { return null; }
}

export function detect({ which = defaultWhich, extra = {} } = {}) {
  const out = {};
  const ids = new Set([...Object.keys(CATALOG), ...Object.keys(extra)]);
  for (const id of ids) {
    const bins = extra[id]?.bins || CATALOG[id]?.bins || [id];
    for (const b of bins) { const p = which(b); if (p) { out[id] = { bin: b, path: p }; break; } }
  }
  return out;
}

/** Split a template like `prime run -m {model} {prompt}` into argv, then substitute (no shell, no injection). */
export function fromTemplate(tpl, vars) {
  const parts = String(tpl).match(/"[^"]*"|'[^']*'|\S+/g) || [];
  return parts.map((p) => p.replace(/^(["'])(.*)\1$/, '$2').replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? '')));
}

/**
 * The command to run one agent. Returns { bin, args, mode, ownerTemplate, bypassNote } or { error }.
 * mode: 'headless' | 'tab'. Owner templates in config win; Ghostship's defaults never bypass permissions.
 */
export function commandFor({ harness, cfgHarness = {}, mode, vars }) {
  const cat = CATALOG[harness] || {};
  const bin = cfgHarness.bin || cat.bins?.[0] || harness;
  if (mode === 'headless') {
    if (cfgHarness.headless) {
      const argv = fromTemplate(cfgHarness.headless, vars);
      const bypass = argv.find((a) => BYPASS.test(a));
      return { bin: argv[0], args: argv.slice(1), mode, ownerTemplate: true, bypassNote: bypass ? `your harnesses.${harness}.headless template contains ${bypass}` : null };
    }
    if (!cat.headless) return { error: `${harness} has no safe non-interactive mode Ghostship can use; run it in a herdr tab, or set harnesses.${harness}.headless in config` };
    return { bin, args: cat.headless(vars), mode, ownerTemplate: false, bypassNote: null };
  }
  if (cfgHarness.args) {
    const args = cfgHarness.args.map((a) => String(a).replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? '')));
    const bypass = args.find((a) => BYPASS.test(a));
    return { bin, herdrKind: cat.herdrKind, args, mode, ownerTemplate: true, bypassNote: bypass ? `your harnesses.${harness}.args contain ${bypass}` : null };
  }
  if (!cat.herdrKind) return { error: `${harness} cannot run in a herdr tab; set harnesses.${harness}.headless in config` };
  return { bin, herdrKind: cat.herdrKind, args: cat.tab(vars), mode, ownerTemplate: false, bypassNote: null };
}
