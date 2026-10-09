#!/usr/bin/env node
// gs: the Ghostship CLI. The only door to state, evidence, approvals, merges and releases.
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import * as E from './lib/engine.mjs';
import { initProject } from './lib/init.mjs';
import { load, exists } from './lib/store.mjs';
import { loadConfig, validateConfig, saveConfig, settable, setKey, autonomyOf, AUTONOMY_MODES } from './lib/config.mjs';
import { parseScalar } from './lib/yaml.mjs';
import { detect, CATALOG } from './lib/harness.mjs';
import { tierFor, pickAgent, loadQuota, markQuota, clearQuota, modeFor, policyBlocks } from './lib/routing.mjs';
import * as D from './lib/dispatch.mjs';
import { readActive, liveRun, clearActive, history, alive } from './lib/runs.mjs';
import { available as herdrAvailable } from './lib/herdr.mjs';
import * as B from './lib/bridge.mjs';
import * as HB from './lib/harbor.mjs';
import * as DOC from './lib/docs.mjs';
import { buildSite, packSite } from './lib/docsite.mjs';
import { writeExplorer } from './lib/explorer.mjs';
import * as MEM from './lib/memory.mjs';
import * as LEARN from './lib/learn.mjs';
import * as UP from './lib/upgrade.mjs';
import * as UPD from './lib/update.mjs';
import * as MIG from './lib/migrate.mjs';
import * as GH from './lib/github.mjs';
import * as ASK from './lib/asks.mjs';
import { next as nextStep, text as nextText } from './lib/next.mjs';
import * as PF from './lib/preflight.mjs';
import { FactoryError } from './lib/util.mjs';

const CORE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = readFileSync(join(CORE, 'VERSION'), 'utf8').trim();

function parse(argv) {
  const pos = [], opt = {}, multi = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const [k, inline] = a.slice(2).split(/=(.*)/s);
    const v = inline !== undefined ? inline : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true);
    if (k === 'check' || k === 'option') (multi[k] = multi[k] || []).push(v); else opt[k] = v;
  }
  return { pos, opt, multi };
}

const HELP = `Ghostship ${VERSION} — gs <command>

  init [--name N] [--tier light|standard|full] [--tracker local|github|both] [--approvals terminal|chat|bridge]
  status [--json]                        where the project stands and what happens next
  next [--json]                          the ONE next step: do it, dispatch it, or wait for the owner (the loop runs on this)
  autopilot start [--once] [--max-steps N] | stop | status | log [--tail N]   the headless runner: runs gs next in a loop with claude -p agents
  scorecard [--json]                     how autonomous the project has been: gates, asks, retries, parked, time and spend per task
  interview init|status|mark <area> <open|answered|na|assumption> [--note "…"]
  prd approve [--quote "…"]              approve PRD.draft.md (needs every coverage area closed)
  design done                            design files for the tier exist
  acceptance lint|approve [--auto]|lock  STOP 1 is approve (--auto: autonomy full, lint clean); lock proves acceptance tests fail first
  autonomy [autopilot|full|guided] [--night-shift on|off] [--night-shift-at 90] [--auto-retries 1] [--quote "…"]   how much runs without you (owner)
  preflight [--fix] [--allow-global] [--name "N"] [--email "E"]   git, identity, first commit, node, gh: fixed once, before the build
  task import|list|start <id>|submit <id>|reissue <id>|merge <id>|fail <id> --reason "…"
  evidence --task <id> --kind red|green|acceptance|regression|lint|typecheck|judge [--token T] [--command C (judge only)]
  verdict --task <id> --result PASS|FAIL --token T --check "C1=PASS why" … [--check "SECURITY=PASS …"] [--reason "…"]
  assume --task <id> --text "…" [--product]   record a decision the request left open (--product: the owner sees it before the merge)
  decide <id> --grant 1..3 [--note "…"] | --merge | --drop [--quote "…"]   --merge: a passed task held for you (risky change, product assumption)
  codemap                                regenerate docs/05-code/CODEMAP.md
  release candidate | approve [--override] [--quote "…"]     STOP 2 is approve
  audit                                  verify the event chain, evidence, locks
  config check | set <key> <value> [--quote "…"]   only commands.*, project.tier, judge.depth, routing.*
  agents [--json]                        installed agent CLIs, configured agents, and whether each can run here
  route --role builder|judge|planner [--task <id>]   who would do this work, and how (nothing starts)
  dispatch --role builder|judge|planner [--task <id>] [--token T] [--depth light|full] [--agent <id>]
  run status|wait [--timeout SEC]|stop|clear|history     the one outside agent run in flight
  quota mark <agent> [--minutes 60] | clear <agent>
  pause [--reason "…"] | go [--quote "…"]   helm: stop starting new work / carry on (go needs the owner)
  watch [--interval 10] [--once]         live band + alerts in a terminal (when the Bridge mod is not loaded)
  bridge tick [--data JSON] | handoff [--note "…"] | band     what the Bridge mod reads and writes
  spend [--json]                         what this project has used: Claude cost, gateway tokens, outside runs
  brief --role builder|judge|planner [--task <id>] [--token T] [--depth d]   the brief for an in-session subagent (memory + learned rules)
  change open --scope prd|acceptance --reason "…" [--quote "…"] | status     /ghostship add and change: reopen approved documents
  memory add <memory|decision|failed|lesson|baseline> "…" [--task <id>] | search "…" | promote "…"
  migrate list | apply [--items 1,3|all] [--keep 4] [--archive 5] [--quote "…"]   other tools' files → docs/archive/ (nothing deleted)
  upgrade check | apply [--from DIR] | rollback      move this project to the installed core at a safe point
  update check | apply [--force]         update Ghostship itself from its public GitHub repo, then gs upgrade apply per project
  github sync | status                   mirror tasks, release PR and releases to GitHub (tracker github|both)
  ask --kind do|answer|choose --title "…" [--why "…"] [--done-when "…"] [--option "…"]… [--command "…"]   hand the owner something only they can do
  asks [--json] | ask answer <id> --option N|--done|--text "…"|--reject "…" | ask withdraw <id> | asks deliver
  limits [--json]                        Claude plan 5h/7d use, reset time and burn rate (from the session)
  learn status                           rules learned from repeated failures, their prediction and verdict
  docs scaffold|check|trace|build [--out docs-site] [--no-mermaid]|explorer   the SDLC docs, the offline site and code explorer
  ci init                                write .github/workflows/ghostship.yml from the project's commands
  harbor [--port 8788] | harbor --tui [--once]   every project on this machine (web on 127.0.0.1, or a terminal table)
  gateway start|stop|status|env          localhost bridge: Claude Code ⇄ OpenAI-compatible/local models
Approvals: at a terminal you type "yes"; in chat mode pass --quote with the owner's exact words.`;

async function gate(root, opt, what) {
  if (opt['owner-key-stdin']) {
    // A press in the Bridge pane: the mod passes the owner key on stdin. Only honoured when the owner chose approvals.mode bridge.
    if (loadConfig(root).approvals?.mode !== 'bridge') throw new FactoryError('HUMAN_GATE', 'Approving from the Bridge is off. The owner turns it on with approvals.mode: bridge in .ghostship/config.yaml.');
    if (process.stdin.isTTY) throw new FactoryError('HUMAN_GATE', '--owner-key-stdin is for the Bridge pane. At your own terminal, run the command without it and type yes.');
    let key = '';
    try { key = readFileSync(0, 'utf8'); } catch { /* none */ }
    if (!B.ownerKeyOk(key)) throw new FactoryError('HUMAN_GATE', 'The Bridge could not prove this press came from the owner. Reinstall Ghostship to recreate ~/.ghostship/bridge.key.');
    return { via: 'bridge', confirmed: true };
  }
  if (typeof opt.quote === 'string') return { via: 'chat', quote: opt.quote };
  if (process.stdin.isTTY && process.stdout.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ans = await new Promise((r) => rl.question(`Approve ${what}? Type yes: `, r));
    rl.close();
    return { via: 'tty', confirmed: ans.trim().toLowerCase() === 'yes' };
  }
  return {};
}

function table(rows) {
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  const line = (r) => '| ' + r.map((c, i) => String(c).padEnd(w[i])).join(' | ') + ' |';
  return [line(rows[0]), '|' + w.map((n) => '-'.repeat(n + 2)).join('|') + '|', ...rows.slice(1).map(line)].join('\n');
}

function initReport(r) {
  const h = r.detection.harnesses;
  const rows = [['check', 'result'],
    ['Ghostship core', `v${r.version} → .ghostship/core`],
    ['folder', r.folderState],
    ['node', r.detection.node],
    ['branch', r.detection.branch || '(none)'],
    ['agent CLIs found', h.filter((x) => x.name !== 'herdr').map((x) => x.name).join(', ') || 'none besides this session'],
    ['herdr', h.some((x) => x.name === 'herdr') ? (process.env.HERDR_ENV === '1' ? 'yes — agent tabs open here' : 'installed — start Claude inside herdr for agent tabs') : 'not found (agents run headless or in this session)'],
    ['hooks', '.claude/settings.json (guard, stop, session)'],
    ['subagents', 'ghostship-planner, -builder, -judge'],
    ['Bridge mod', (() => { try { readFileSync(join(process.env.GHOSTSHIP_HOME || (process.env.HOME || process.env.USERPROFILE || ''), '.claude/skills/ghostship-bridge/hooks/register.tsx')); return 'installed (band, pane, alerts, keeper, riskhold)'; } catch { return 'not installed — run node install.mjs'; } })()],
    ['status line', (() => { try { return JSON.parse(readFileSync(join(r.root || '.', '.claude/settings.json'), 'utf8')).statusLine?.command?.includes('statusline.mjs') ? 'Ghostship band' : 'yours kept'; } catch { return 'yours kept'; } })()],
    ['Harbor', 'registered: run gs harbor in a terminal'],
    ['other tools found', r.migration.length ? r.migration.map((m) => `${m.path} (${m.action})`).join(', ') : 'none'],
    ['approvals', (() => {
      const mode = (() => { try { return loadConfig(r.root || '.').approvals?.mode || 'terminal'; } catch { return 'terminal'; } })();
      if (mode === 'terminal') return 'terminal — you type yes in your own shell';
      if (mode === 'chat') return 'chat — your exact words are the quote';
      return existsSync(B.ownerKeyPath()) ? 'bridge — one press in the Bridge pane (owner key found)' : 'bridge — owner key missing: run node install.mjs to create the owner key';
    })()],
    ['permission bypass', r.skipPermissions ? 'ON — agents launch with --dangerously-skip-permissions (launch.skipPermissions); the guard + riskhold hooks still apply' : 'off — set launch.skipPermissions: true to enable'],
    ['preflight', PF.preflightSummary(r.preflight)],
    ['committed', r.committed ? 'yes (chore: ghostship init)' : 'no — see preflight'],
  ];
  const out = [table(rows)];
  if (r.migration.length) out.push('', 'Migration plan written to .ghostship/migration-plan.md. Nothing was moved.');
  for (const w of r.warnings) out.push(`! ${w}`);
  out.push('', 'If you want Claude to run without permission prompts, that is your call: launch it yourself (e.g. `claude --dangerously-skip-permissions`) in a sandbox you trust. The guard hooks still apply.');
  out.push(`Next: /ghostship ${r.next}`);
  return out.join('\n');
}

function statusText(s) {
  const out = [`stage: ${s.stage}   approvals: ${s.approvals}`];
  if (s.active) out.push(`active: ${s.active.id} ${s.active.status} (attempt ${s.active.attempt}/${s.active.max})`);
  if (Object.keys(s.counts).length) out.push(`tasks: ${Object.entries(s.counts).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  if (s.frontier.length) out.push(`ready: ${s.frontier.join(', ')}`);
  if (s.needsDecision.length) out.push(`needs your decision: ${s.needsDecision.join(', ')}`);
  if (s.uncovered.length) out.push(`run checks without a task: ${s.uncovered.join(', ')}`);
  if (s.release) out.push(`release candidate: v${s.release.version} (${s.release.result})`);
  out.push(`next: ${s.next}`);
  return out.join('\n');
}

// Agents started by `gs dispatch` carry GHOSTSHIP_ROLE. Each role may run only its own commands.
const ROLE_ALLOW = {
  builder: (c, s, o) => ['status', 'next', 'codemap', 'audit', 'help', 'version', 'assume'].includes(c) || (c === 'docs' && ['check', 'trace'].includes(s)) || (c === 'memory' && ['add', 'search'].includes(s)) || (c === 'learn') || (c === 'evidence' && o.kind !== 'judge') || (c === 'task' && ['fail', 'list'].includes(s)) || (c === 'acceptance' && s === 'lint'),
  judge: (c, s, o) => ['status', 'next', 'audit', 'verdict', 'help', 'version', 'assume'].includes(c) || (c === 'memory' && s === 'search') || (c === 'evidence' && o.kind === 'judge') || (c === 'task' && s === 'list'),
  planner: (c, s) => ['status', 'next', 'audit', 'help', 'version'].includes(c) || (c === 'memory' && s === 'search') || (c === 'task' && s === 'list') || (c === 'acceptance' && s === 'lint'),
};
function roleGate(role, c, s, o) {
  if (!role) return;
  const ok = ROLE_ALLOW[role];
  if (!ok || !ok(c, s, o)) throw new FactoryError('ROLE_FORBIDDEN', `A ${role || 'subagent'} run may not use \`gs ${[c, s].filter(Boolean).join(' ')}\`. Report back instead; the orchestrator does this.`);
}

function agentsTable(root) {
  const cfg = loadConfig(root);
  const detected = detect({ extra: Object.fromEntries(Object.entries(cfg.harnesses || {}).map(([k, v]) => [k, { bins: v.bins || (v.bin ? [v.bin] : undefined) }])) });
  const herdr = cfg.herdr?.use !== 'off' && herdrAvailable(process.env);
  const quota = loadQuota(root);
  const agents = Object.entries(cfg.agents || {}).map(([id, a]) => {
    const pol = policyBlocks(cfg, a);
    const m = modeFor(cfg, a, { detected, herdr });
    const q = quota[id] && Date.parse(quota[id].until) > Date.now() ? `cooling until ${quota[id].until}` : '';
    return { id, harness: a.harness, model: a.model || '-', provider: a.provider, mode: pol ? '-' : m.mode || '-', status: pol || q || m.reason || 'ready' };
  });
  const tiers = Object.entries(cfg.routing?.tiers || {}).map(([t, list]) => ({ tier: t, agents: list.join(' → ') }));
  return { herdr, detected: Object.keys(detected), agents, tiers };
}

const show = (o, json) => (json || typeof o !== 'string' ? JSON.stringify(o, null, 2) : o);

async function main() {
  const { pos, opt, multi } = parse(process.argv.slice(2));
  const root = resolve(opt.root || process.env.CLAUDE_PROJECT_DIR || process.cwd());
  const [cmd, sub, arg, arg2] = pos;
  const json = !!opt.json;
  const out = (o) => process.stdout.write(show(o, json) + '\n');
  roleGate(process.env.GHOSTSHIP_ROLE, cmd, sub, opt);

  switch (cmd) {
    case undefined: case 'help': case '--help': return out(HELP);
    case 'version': return out(VERSION);
    case 'init': {
      const r = initProject(root, { name: opt.name, coreSrc: CORE, tier: opt.tier, tracker: opt.tracker, approvals: opt.approvals });
      try { HB.registerProject(undefined, { name: loadConfig(root).project?.name, path: root }); } catch { /* Harbor list is best effort */ }
      return out(json ? r : initReport({ ...r, root }));
    }
    case 'autonomy': {
      const cfg = loadConfig(root);
      const show = (a) => `autonomy: ${a.mode} · auto-retries ${a.autoRetries} · night shift ${a.nightShift ? `on at ${a.nightShiftAt}%` : 'off'}\n` + ({
        autopilot: 'You approve the PRD, STOP 1 and STOP 2. Everything else runs: a task that uses its attempts gets more by policy, then is parked for STOP 2.',
        full: 'You approve the PRD and STOP 2. STOP 1 passes by itself once the checks pass lint; parked tasks wait for STOP 2.',
        guided: 'You approve every gate: PRD, STOP 1, each stuck task, resuming, STOP 2.',
      })[a.mode];
      const nsArg = typeof opt['night-shift'] === 'string' ? opt['night-shift'] : null;
      const wants = sub || nsArg !== null || opt['auto-retries'] !== undefined || opt['night-shift-at'] !== undefined;
      if (!wants) return out(json ? autonomyOf(cfg) : show(autonomyOf(cfg)));
      if (sub && !AUTONOMY_MODES.includes(sub)) throw new FactoryError('BAD_MODE', `autonomy is ${AUTONOMY_MODES.join(', ')}`);
      if (nsArg !== null && !['on', 'off'].includes(nsArg)) throw new FactoryError('BAD_VALUE', '--night-shift on|off');
      // How much runs without the owner is the owner's call: the same gate as any approval.
      const g = E.humanGate(cfg, await gate(root, opt, `autonomy ${[sub, nsArg !== null ? `night shift ${nsArg}` : ''].filter(Boolean).join(', ') || 'settings'}`));
      const next = { ...(cfg.autonomy || {}) };
      if (sub) next.mode = sub;
      if (nsArg !== null) next['night-shift'] = nsArg === 'on';
      if (opt['auto-retries'] !== undefined) next['auto-retries'] = Number(opt['auto-retries']);
      if (opt['night-shift-at'] !== undefined) next['night-shift-at'] = Number(opt['night-shift-at']);
      const updated = { ...cfg, autonomy: next };
      const errs = validateConfig(updated);
      if (errs.length) throw new FactoryError('BAD_CONFIG', errs.join('; '));
      saveConfig(root, updated);
      E.commitConfig(root, `chore: autonomy ${next.mode || autonomyOf(updated).mode}`);
      try { MEM.add(root, 'decision', `owner set autonomy: ${JSON.stringify(next)} (via ${g.via})`); } catch { /* best effort */ }
      return out(json ? autonomyOf(updated) : `${show(autonomyOf(updated))}\n(approved via ${g.via})`);
    }
    case 'preflight': {
      const r = PF.preflight(root, { fix: !!opt.fix, allowGlobal: !!opt['allow-global'], name: typeof opt.name === 'string' ? opt.name : undefined, email: typeof opt.email === 'string' ? opt.email : undefined, tracker: exists(root) ? loadConfig(root).tracker?.mode : (typeof opt.tracker === 'string' ? opt.tracker : undefined) });
      process.exitCode = r.ok ? 0 : 1;
      if (json) return out(r);
      return out([table([['check', 'result', 'fix'], ...r.checks.map((c) => [c.id, `${c.ok ? '✓' : '✗'} ${c.detail}${c.fixed ? ' (fixed)' : ''}`, c.ok ? '' : c.fix || '-'])]), r.ok ? 'Preflight OK.' : 'Preflight found problems. Fix them once now, so the build never stops for them.'].join('\n'));
    }
    case 'next': { const n = nextStep(root); return out(json ? n : nextText(n)); }
    case 'autopilot': {
      // The headless runner lives in lib/autopilot.mjs; loaded on demand so a missing module never breaks the rest of the CLI.
      let AP;
      try { AP = await import('./lib/autopilot.mjs'); } catch (e) { throw new FactoryError('NO_AUTOPILOT', `The headless runner is not in this core (${e.message}).`); }
      return AP.cli(root, sub, opt, out);
    }
    case 'scorecard': {
      let SC;
      try { SC = await import('./lib/scorecard.mjs'); } catch (e) { throw new FactoryError('NO_SCORECARD', `The scorecard is not in this core (${e.message}).`); }
      const r = SC.scorecard(root);
      return out(json ? r : SC.text(r));
    }
    case 'status': { try { E.settleDecisions(root); } catch { /* read-only status still prints */ } const s = E.status(root); return out(json ? s : statusText(s)); }
    case 'interview':
      if (sub === 'init') return out(E.interviewInit(root, { tier: opt.tier }));
      if (sub === 'status') return out(E.interviewStatus(root));
      if (sub === 'mark') return out(E.interviewMark(root, arg, arg2, opt.note === true ? '' : opt.note || ''));
      break;
    case 'prd':
      if (sub === 'approve') { E.prdApprove(root, await gate(root, opt, 'the PRD')); return out('PRD approved and locked. Next: design.'); }
      break;
    case 'design':
      if (sub === 'done') { E.designDone(root); return out('Design complete. Next: acceptance checks (STOP 1).'); }
      break;
    case 'acceptance':
      if (sub === 'lint') { const r = E.acceptanceLint(root); return out(json ? r : r.ok ? `OK — ${r.contract.checks.length} checks` : 'Lint failed:\n- ' + r.errors.join('\n- ')); }
      if (sub === 'approve' && opt.auto) { E.acceptanceApprove(root, {}, { auto: true }); return out('STOP 1 passed by full autonomy (lint clean): acceptance checks approved and locked. Next: plan.'); }
      if (sub === 'approve') { E.acceptanceApprove(root, await gate(root, opt, 'the acceptance checks (STOP 1)')); return out('STOP 1 passed: acceptance checks approved and locked. Next: plan.'); }
      if (sub === 'lock') { const r = E.acceptanceLock(root); return out(json ? r : `Acceptance tests locked (${Object.keys(r.files).length} files, all failing as they should).`); }
      break;
    case 'task':
      if (sub === 'import') { const r = E.taskImport(root); return out(json ? r : `Imported ${r.imported.join(', ')}${r.uncovered.length ? `. Run checks with no task yet: ${r.uncovered.join(', ')}` : ''}`); }
      if (sub === 'list') { const st = load(root); return out(Object.values(st.tasks || {}).map((t) => ({ id: t.id, title: t.title, status: t.status, attempts: `${t.attempt}/${t.maxAttempts}`, checks: t.checks }))); }
      if (sub === 'start') { const t = E.taskStart(root, arg); return out(json ? t : `${t.id} BUILDING on ${t.branch} (attempt ${t.attempt}/${t.maxAttempts})`); }
      if (sub === 'fail') { const t = E.taskFail(root, arg, opt.reason === true ? '' : opt.reason || ''); return out(`${t.id} → ${t.status}`); }
      if (sub === 'submit') {
        const r = E.taskSubmit(root, arg);
        const notes = [r.risky.length ? `risky: ${r.risky.map((x) => `${x.path} (${x.why})`).join(', ')} — full judge, and the owner decides the merge` : '', r.lenses.length ? `lenses the judge reports: ${r.lenses.join(', ')}` : '', r.conflicts.length ? `already conflicts with develop in: ${r.conflicts.join(', ')}` : ''].filter(Boolean);
        return out(json ? r : `${arg} submitted for judging.\njudge token: ${r.token}\n(Pass it only to a fresh judge.)${notes.length ? `\n${notes.join('\n')}` : ''}`);
      }
      if (sub === 'reissue') { const r = E.taskReissue(root, arg); return out(json ? r : `${arg}: new judge token: ${r.token}\n(The old token no longer works. Pass this one only to a fresh judge.)`); }
      if (sub === 'merge') { const r = E.taskMerge(root, arg); return out(json ? r : r.merged ? `${arg} merged: ${r.message}` : `${arg} not merged: ${r.reason}${r.held ? `\nThe owner decides: gs decide ${arg} --merge | --grant 1 --note "…" | --drop` : ''}`); }
      break;
    case 'evidence': {
      const r = E.evidence(root, { task: opt.task, kind: opt.kind, command: typeof opt.command === 'string' ? opt.command : undefined, token: opt.token });
      out(json ? r : `${r.id} ${r.kind} exit ${r.exitCode} → ${r.accepted ? 'ACCEPTED' : `REJECTED: ${r.rejectReason}`}\nlog: ${r.dir}/output.log`);
      process.exitCode = r.accepted ? 0 : 3;
      return;
    }
    case 'verdict': {
      const checks = {};
      for (const c of multi.check || []) { const m = /^(C\d+|security|ux)\s*[=:]\s*(.+)$/is.exec(c); if (m) checks[m[1].toUpperCase()] = m[2].trim(); }
      const t = E.verdict(root, { task: opt.task, result: opt.result, token: opt.token, checks, reason: opt.reason === true ? '' : opt.reason || '' });
      return out(`${t.id} → ${t.status}`);
    }
    case 'decide': {
      const g = await gate(root, opt, `the decision on ${sub}`);
      const r = E.decide(root, { task: sub, grant: opt.grant, drop: !!opt.drop, merge: !!opt.merge, note: opt.note === true ? '' : opt.note, ...g });
      if (opt.merge) return out(json ? r : `${sub}: ${r.merged ? `merged: ${r.message}` : `not merged: ${r.reason}`}${r.candidateDropped ? '\nThe release candidate predates this merge: gs next prepares a new one.' : ''}`);
      return out(`${sub}: decision recorded.`);
    }
    case 'assume': {
      const a = E.assume(root, { task: opt.task, text: opt.text === true ? '' : opt.text, product: !!opt.product });
      return out(`${opt.task}: assumption recorded${a.product ? ' (a product decision: the owner sees it before this merges)' : ''}.`);
    }
    case 'codemap': { const r = E.codemap(root); return out(`Wrote ${r.path}`); }
    case 'release':
      if (sub === 'candidate') { const r = E.releaseCandidate(root); return out(json ? r : `v${r.version} candidate: ${r.result}. Review ${r.packet}, then STOP 2: gs release approve`); }
      if (sub === 'approve') { const r = E.releaseApprove(root, { override: !!opt.override, ...(await gate(root, opt, 'this release (STOP 2)')) }); return out(`Released ${r.tag} (${r.commit.slice(0, 10)}).`); }
      break;
    case 'audit': { const r = E.audit(root); out(json ? r : r.ok ? `OK — ${r.events} events verified` : 'AUDIT FAILED:\n- ' + r.problems.join('\n- ')); process.exitCode = r.ok ? 0 : 4; return; }
    case 'agents': {
      const r = agentsTable(root);
      if (json) return out(r);
      const rows = [['agent', 'harness', 'model', 'provider', 'runs as', 'status'], ...r.agents.map((a) => [a.id, a.harness, a.model, a.provider, a.mode, a.status])];
      return out([`installed: ${r.detected.join(', ') || 'none'} · herdr: ${r.herdr ? 'yes' : 'no (start Claude inside herdr for tabs)'}`, '', table(rows), '', table([['tier', 'agents in order'], ...r.tiers.map((t) => [t.tier, t.agents])])].join('\n'));
    }
    case 'route': {
      const p = D.plan(root, { task: opt.task, role: opt.role, token: 'preview', depth: opt.depth, agent: opt.agent, preview: true });
      return out(json ? p : p.agentId ? `${p.role}${p.task ? ` ${p.task}` : ''}: tier ${p.tier} → ${p.agentId} (${p.harness}${p.model ? ` ${p.model}` : ''}) as ${p.mode}${p.skipped.length ? `\nskipped: ${p.skipped.map((x) => `${x.agent} (${x.reason})`).join('; ')}` : ''}${p.note ? `\n${p.note}` : ''}`
        : `No agent can do this now (tier ${p.tier}): ${p.skipped.map((x) => `${x.agent} (${x.reason})`).join('; ')}`);
    }
    case 'dispatch': {
      const p = D.plan(root, { task: opt.task, role: opt.role, token: opt.token, depth: opt.depth, agent: opt.agent });
      if (p.mode === 'in-session') return out(json ? p : `${p.agentId} runs in this session. ${p.note}`);
      const r = D.start(root, p);
      return out(json ? r : `Started ${r.runId}: ${r.agentId} (${r.harness}${r.model ? ` ${r.model}` : ''}) as ${r.mode}. Wait with: gs run wait --timeout 540${r.bypassNote ? `\nnotice: ${r.bypassNote}` : ''}`);
    }
    case 'run': {
      if (sub === 'status') { const r = readActive(root); return out(json || !r ? (r || 'No run.') : `${r.runId}: ${r.status}${r.status === 'running' && !alive(r.supervisorPid) ? ' (supervisor gone: lost)' : ''} · ${r.agentId} ${r.mode} · log ${r.log}${r.report ? ` · report ${r.report}` : ''}`); }
      if (sub === 'wait') {
        const until = Date.now() + Number(opt.timeout || 540) * 1000;
        let r = liveRun(root);
        while (r && r.status === 'running' && Date.now() < until) { await new Promise((ok) => setTimeout(ok, 2000)); r = liveRun(root); }
        r = readActive(root);
        const st = r?.status === 'running' && !alive(r.supervisorPid) ? 'lost' : r?.status;
        out(json ? { ...r, status: st } : !r ? 'No run.' : `${r.runId}: ${st}${r.report ? ` · report ${r.report}` : ''}${st === 'running' ? ' (still running — wait again)' : ''}`);
        process.exitCode = st === 'running' ? 5 : 0;
        return;
      }
      if (sub === 'stop') {
        const r = readActive(root);
        if (!r) return out('No run.');
        for (const pid of [r.childPid, r.supervisorPid]) if (alive(pid)) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
        return out(`Stop sent to ${r.runId}.`);
      }
      if (sub === 'clear') {
        const r = liveRun(root);
        if (r && r.status === 'running') throw new FactoryError('RUN_ACTIVE', `${r.runId} is still running; gs run stop first.`);
        clearActive(root); return out('Cleared.');
      }
      if (sub === 'history') return out(history(root).slice(-(Number(opt.last) || 20)));
      break;
    }
    case 'gateway': {
      const fs = await import('node:fs');
      const { spawn } = await import('node:child_process');
      const info = join(root, '.ghostship', 'runs', 'gateway.json');
      const read = () => { try { return JSON.parse(fs.readFileSync(info, 'utf8')); } catch { return null; } };
      const healthy = async (g) => { try { return (await fetch(`http://127.0.0.1:${g.port}/health`)).ok; } catch { return false; } };
      if (sub === 'start') {
        const cur = read();
        if (cur && alive(cur.pid) && await healthy(cur)) return out(`Gateway already running on 127.0.0.1:${cur.port}.`);
        const errs = validateConfig(loadConfig(root));
        if (errs.length) throw new FactoryError('BAD_CONFIG', errs.join('; '));
        if (!Object.keys(loadConfig(root).gateway?.routes || {}).length) throw new FactoryError('NO_ROUTES', 'Add gateway.routes to .ghostship/config.yaml first (model name → provider + model).');
        fs.rmSync(info, { force: true });
        const child = spawn(process.execPath, [join(CORE, 'runtime', 'gateway', 'server.mjs'), root], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, ...(opt.port ? { GS_GATEWAY_PORT: String(opt.port) } : {}) } });
        child.unref();
        for (let i = 0; i < 50; i++) { const g = read(); if (g && await healthy(g)) return out(`Gateway on 127.0.0.1:${g.port}. Point a Claude session at it with: gs gateway env`); await new Promise((ok) => setTimeout(ok, 100)); }
        throw new FactoryError('GATEWAY_FAILED', 'Gateway did not start within 5 s (port in use? try --port).');
      }
      const g = read();
      if (sub === 'status') return out(json ? { running: !!(g && alive(g.pid) && await healthy(g)), port: g?.port || null } : g && alive(g.pid) && await healthy(g) ? `Running on 127.0.0.1:${g.port} (pid ${g.pid}).` : 'Not running.');
      if (sub === 'stop') { if (g && alive(g.pid)) process.kill(g.pid, 'SIGTERM'); fs.rmSync(info, { force: true }); return out('Gateway stopped.'); }
      if (sub === 'env') {
        if (!g) throw new FactoryError('NOT_RUNNING', 'Start it first: gs gateway start');
        const sh = process.platform === 'win32' && !process.env.SHELL ? (k, v) => `$env:${k}="${v}"` : (k, v) => `export ${k}=${v}`;
        return out([sh('ANTHROPIC_BASE_URL', `http://127.0.0.1:${g.port}`), sh('ANTHROPIC_AUTH_TOKEN', g.clientKey), '# A Claude session started with these talks to the gateway routes, not your Claude plan. Remote Control does not work in such a session.'].join('\n'));
      }
      break;
    }
    case 'brief': {
      const st = load(root);
      const t = opt.task ? st.tasks?.[opt.task] : null;
      if (opt.task && !t) throw new FactoryError('UNKNOWN_TASK', `No task ${opt.task}`);
      const report = `.ghostship/runs/${opt.task || '_plan'}/a${t?.attempt || 1}-${opt.role}.report.md`;
      const rel = D.writeBrief(root, { state: st, task: t, role: opt.role, attempt: t?.attempt || 1, token: opt.token, depth: opt.depth, changed: t?.submit?.changed, report });
      const text = (await import('node:fs')).readFileSync(join(root, rel), 'utf8');
      return out(opt.role === 'judge' && typeof opt.token === 'string' ? text.replace('- token: in your prompt (never written to disk)', `- token: ${opt.token}`) : text);
    }
    case 'change': {
      if (sub === 'open') {
        const g = await gate(root, opt, `reopening the ${opt.scope === 'prd' ? 'PRD' : 'acceptance checks'}`);
        const r = E.changeOpen(root, { scope: opt.scope, reason: opt.reason === true ? '' : opt.reason, ...g });
        return out(`Reopened. Edit ${r.draft}, then follow /ghostship ${opt.scope === 'prd' ? 'change (PRD → design → checks)' : 'change (checks)'}.`);
      }
      if (sub === 'status') { const st = load(root); return out(json ? { open: st.change || null, history: st.changes || [] } : st.change ? `Open ${st.change.scope} change since ${st.change.at}: ${st.change.reason}` : `No open change. ${(st.changes || []).length} closed.`); }
      break;
    }
    case 'memory': {
      if (sub === 'add') { const r = MEM.add(root, arg, arg2 ?? '', { task: typeof opt.task === 'string' ? opt.task : null }); return out(r.duplicate ? 'Already recorded.' : `Added to ${r.path}.`); }
      if (sub === 'search') { const r = MEM.search(root, [arg, arg2].filter(Boolean).join(' ')); return out(json ? r : r.map((h) => `(${h.kind}) ${h.line}`).join('\n') || 'Nothing relevant.'); }
      if (sub === 'promote') { const r = MEM.promote(root, arg, { project: loadConfig(root).project?.name }); return out(`Shared with every project: ${r.line}`); }
      break;
    }
    case 'migrate': {
      if (sub === 'list') { const r = MIG.list(root); return out(json ? r : r.length ? r.map((m) => `${m.n}. ${m.path} — ${m.tool} (${m.kind}) → ${m.action}${m.status && m.status !== 'planned' ? ` [${m.status}]` : ''}`).join('\n') : 'Nothing to migrate.'); }
      if (sub === 'apply') {
        const ids = (v) => (typeof v === 'string' ? v.split(',').map(Number).filter(Boolean) : []);
        const decisions = {};
        for (const n of ids(opt.keep)) decisions[n] = 'keep';
        for (const n of ids(opt.archive)) decisions[n] = 'archive';
        const which = !opt.items || opt.items === 'all' ? 'all' : ids(opt.items);
        const g = await gate(root, opt, 'moving other tools\' files into docs/archive/');
        const r = MIG.apply(root, { which, decisions, ...g });
        return out(json ? r : r.map((d) => `${d.n}. ${d.status}${d.to ? ` → ${d.to}` : ''}${d.note ? ` (${d.note})` : ''}`).join('\n'));
      }
      break;
    }
    case 'upgrade': {
      if (sub === 'check') { const c = UP.check(root, { from: typeof opt.from === 'string' ? opt.from : undefined }); const sp = UP.safePoint(root); return out(json ? { ...c, safe: sp } : `project ${c.project} · installed ${c.available || 'none'}${c.newer ? ' (newer)' : ''}${c.rollback ? ` · rollback to ${c.rollback} kept` : ''} · ${sp.ok ? 'safe point now' : `not now: ${sp.reasons.join('; ')}`}`); }
      if (sub === 'apply') { const r = UP.apply(root, { from: typeof opt.from === 'string' ? opt.from : undefined, force: !!opt.force }); out(json ? r : r.ok ? `Upgraded ${r.from} → ${r.to}. The old core is kept for gs upgrade rollback.` : `Not upgraded: ${r.reason}${r.errors ? `\n- ${r.errors.join('\n- ')}` : ''}`); process.exitCode = r.ok ? 0 : 1; return; }
      if (sub === 'rollback') { const r = UP.rollback(root); out(r.ok ? `Rolled back ${r.from} → ${r.to}.` : `Not rolled back: ${r.reason}`); process.exitCode = r.ok ? 0 : 1; return; }
      break;
    }
    case 'update': {
      if (sub === 'check') {
        const c = await UPD.check({});
        if (c.error) { process.exitCode = 1; return out(json ? c : `update check failed: ${c.error}`); }
        return out(json ? c : `installed ${c.installed || 'none'} · published ${c.remote} [${c.repo}@${c.branch}] — ${c.newer ? 'newer available: run gs update' : 'up to date'}`);
      }
      if (sub === undefined || sub === 'apply') {
        const r = UPD.apply({ force: !!opt.force });
        if (!r.ok) { process.exitCode = 1; return out(json ? r : `Not updated: ${r.reason}`); }
        return out(json ? r : `Updated Ghostship ${r.from || 'none'} → ${r.to} from ${r.repo}@${r.branch}.\nThe old core is kept for rollback. In each project, run \`gs upgrade apply\` at a safe point to adopt it.`);
      }
      break;
    }
    case 'github': {
      if (sub === 'status') { const r = GH.ready(root); return out(r.ok ? 'GitHub sync is ready.' : `GitHub sync is off: ${r.reason}`); }
      if (sub === 'sync') { const did = GH.sync(root, { push: !opt['no-push'] }); return out(did.length ? did.join('\n') : 'Nothing to sync.'); }
      break;
    }
    case 'ask': {
      if (sub === 'answer') { const r = ASK.answer(root, arg, { option: multi.option?.[0] ?? opt.option, done: !!opt.done, text: typeof opt.text === 'string' ? opt.text : undefined, reject: typeof opt.reject === 'string' ? opt.reject : undefined, applied: !!opt.applied }); return out(json ? r : `#${r.id} answered: ${r.response}`); }
      if (sub === 'withdraw') { ASK.withdraw(root, arg); return out(`#${arg} withdrawn.`); }
      const options = Array.isArray(multi.option) ? multi.option : [];
      const r = ASK.add(root, { kind: opt.kind || 'do', title: opt.title === true ? '' : opt.title, why: typeof opt.why === 'string' ? opt.why : '', doneWhen: typeof opt['done-when'] === 'string' ? opt['done-when'] : '', options, command: typeof opt.command === 'string' ? opt.command : '' });
      return out(json ? r : r.duplicate ? `Already waiting as #${r.id}.` : `Asked the owner (#${r.id}). Keep working; the answer comes back as a message.`);
    }
    case 'asks': {
      if (sub === 'deliver') { const m = ASK.deliver(root); return out(m || ''); }
      const r = ASK.list(root);
      return out(json ? r : r.length ? r.map((a) => `#${a.id} [${a.kind}] ${a.title}${a.why ? ` — ${a.why}` : ''}${a.options?.length ? `\n     ${a.options.map((o, i) => `${i + 1}) ${o}`).join('  ')}` : ''}`).join('\n') : 'Nothing waiting for the owner.');
    }
    case 'limits': {
      const l = B.claudeLimits(root);
      if (json) return out(l || {});
      if (!l) return out('No reading yet (the Bridge mod or status line records it during a Claude session).');
      const row = (n, v) => v ? `${n} ${Math.round(v.percent)}%${v.resetsAt ? ` · resets in ${B.untilText(v.resetsAt)}` : ''}${v.burnPerHour ? ` · +${v.burnPerHour}%/h` : ''}` : null;
      const cfg = loadConfig(root);
      return out([row('5h', l.fiveHour), row('7d', l.sevenDay), `routing spares Claude for ${(cfg.routing['spare-claude-tiers'] || []).join(', ')} work above ${cfg.routing['claude-limit-pct']}%`].filter(Boolean).join('\n'));
    }
    case 'learn':
      if (sub === 'status') { const r = LEARN.rules(root); return out(json ? r : r.length ? r.map((x) => `${x.id} [${x.status}] ${x.text}\n     predicted: ${x.prediction}${x.after !== undefined ? ` · measured ${x.after.toFixed(2)}` : ''}`).join('\n') : `No learned rules yet (${LEARN.attempts(root)} task attempts seen).`); }
      break;
    case 'docs': {
      if (sub === 'scaffold') { const c = DOC.scaffold(root, join(root, '.ghostship/core')); return out(c.length ? `Created: ${c.join(', ')}` : 'Every doc for this tier already exists.'); }
      if (sub === 'check') { const r = DOC.check(root); out(json ? r : r.ok ? `Docs complete${r.openapi ? ` · API spec ${r.openapi}` : ''}.` : [...r.missing.map((m) => `missing: ${m}`), ...r.unfilled.map((m) => `still TODO: ${m}`)].join('\n')); process.exitCode = r.ok ? 0 : 1; return; }
      if (sub === 'trace') { const r = DOC.traceability(root); return out(`Wrote ${r.path} (${r.rows.length} checks${r.uncoveredSections.length ? `; PRD sections with no check: ${r.uncoveredSections.join(', ')}` : ''}).`); }
      if (sub === 'build') {
        const o = typeof opt.out === 'string' ? opt.out : 'docs-site';
        const r = buildSite(root, { out: o, version: DOC.currentVersion(root), mermaid: !opt['no-mermaid'], coreDirs: [CORE] });
        return out(json ? r : `Built ${o}/index.html (${r.pages} pages${r.api ? ', API reference' : ''}${r.mermaid ? ', diagrams' : ', diagrams as text (Mermaid not installed)'}) and ${o}/explorer.html (${r.explorer.files} files, ${r.explorer.symbols} symbols).`);
      }
      if (sub === 'explorer') { const r = writeExplorer(root, typeof opt.out === 'string' ? opt.out : 'docs-site/explorer.html', { title: `${loadConfig(root).project?.name} — code explorer` }); return out(`Wrote ${r.path} (${r.stats.files} files).`); }
      break;
    }
    case 'ci':
      if (sub === 'init') { const r = DOC.ciWorkflow(root); return out(`Wrote ${r.path}. Commit it with the next task or release.`); }
      break;
    case 'harbor': {
      if (opt.tui) {
        for (;;) {
          process.stdout.write((opt.once ? '' : '\x1b[2J\x1b[H') + `⛴ Harbor  ${new Date().toLocaleTimeString()}\n\n` + HB.tuiTable() + '\n');
          if (opt.once) return;
          await new Promise((ok) => setTimeout(ok, 5000));
        }
      }
      if (!process.stdin.isTTY) throw new FactoryError('HUMAN_GATE', 'Harbor edits owner settings, so it starts only from your own terminal. Agents can use gs harbor --tui --once (read-only).');
      const h = HB.createHarbor({});
      const port = await h.listen(Number(opt.port ?? 8788));
      out(`Harbor on http://127.0.0.1:${port}/?t=${h.token}\nOpen that link (the token is new each launch). Ctrl+C stops it.`);
      await new Promise(() => {});
      return;
    }
    case 'pause': { const v = B.pause(root, opt.reason === true || !opt.reason ? 'paused by the owner' : opt.reason); return out(`Paused: ${v.reason}. Running work finishes; nothing new starts. Resume with gs go.`); }
    case 'go': {
      if (!B.paused(root)) return out('Not paused.');
      E.humanGate(loadConfig(root), await gate(root, opt, 'resuming work'));
      B.go(root); return out('Resumed.');
    }
    case 'spend': { const r = B.spend(root); return out(json ? r : `Claude: $${r.claudeUsd} over ${r.sessions} session(s) · gateway: ${r.gateway.calls} calls, ${r.gateway.inputTokens} in / ${r.gateway.outputTokens} out tokens · outside agents: ${r.outsideRuns.runs} runs, ${r.outsideRuns.minutes} min`); }
    case 'bridge': {
      if (sub === 'tick') { const d = typeof opt.data === 'string' ? JSON.parse(opt.data) : {}; return out(JSON.stringify(B.tick(root, { ...d, since: Number(opt.since || 0) }))); }
      if (sub === 'handoff') { const r = B.handoff(root, { note: opt.note === true ? '' : opt.note || '', reason: typeof opt.reason === 'string' ? opt.reason : 'context limit' }); return out(`Wrote ${r.path}. Next: /clear, then /ghostship resume.`); }
      if (sub === 'band') return out(B.band(B.tick(root, {})));
      break;
    }
    case 'watch': {
      const every = Math.max(2, Number(opt.interval || 10)) * 1000;
      let since = B.alertsSince(root, 0).cursor;
      for (;;) {
        const snap = B.tick(root, { since, source: 'watch' });
        since = snap.cursor ?? since;
        const lines = [`\x1b[2K\r${B.band(snap)}`];
        for (const a of snap.alerts || []) lines.push(`\n\x07${a.level === 'action' ? '⚑' : a.level === 'warn' ? '⚠' : '•'} ${a.at.slice(11, 19)} ${a.alert}`);
        process.stdout.write(lines.join('') + (snap.alerts?.length ? '\n' : ''));
        if (opt.once) { process.stdout.write('\n'); return; }
        await new Promise((ok) => setTimeout(ok, every));
      }
    }
    case 'quota':
      if (sub === 'mark') return out(markQuota(root, arg, Number(opt.minutes || 60), opt.reason === true ? 'manual' : opt.reason || 'manual'));
      if (sub === 'clear') { clearQuota(root, arg); return out(`${arg}: available again.`); }
      break;
    case 'config':
      if (sub === 'set') {
        if (!settable(arg)) throw new FactoryError('NOT_SETTABLE', `${arg} is owner-only. Edit .ghostship/config.yaml yourself (or in Harbor). Settable: commands.*, project.tier, judge.depth, routing.tiers.*, routing.activities.*`);
        const st = exists(root) ? load(root) : null;
        let g = null;
        if (st?.acceptance?.approved) g = E.humanGate(loadConfig(root), await gate(root, opt, `changing ${arg} after STOP 1`));
        const value = arg.startsWith('routing.tiers.') ? String(arg2 ?? '').split(',').map((x) => x.trim()).filter(Boolean) : parseScalar(String(arg2 ?? ''));
        const cfg = setKey(loadConfig(root), arg, value);
        const errs = validateConfig(cfg);
        if (errs.length) throw new FactoryError('BAD_CONFIG', errs.join('; '));
        saveConfig(root, cfg);
        E.commitConfig(root, `chore: config ${arg}`);
        return out(`${arg} = ${JSON.stringify(value)}${g ? ` (approved via ${g.via})` : ''}`);
      }
      if (sub === 'check') { const errs = validateConfig(loadConfig(root)); out(errs.length ? 'Config problems:\n- ' + errs.join('\n- ') : 'Config OK'); process.exitCode = errs.length ? 1 : 0; return; }
      break;
    case 'state': if (exists(root)) return out(load(root)); break;
  }
  throw new FactoryError('BAD_COMMAND', `Unknown command: ${pos.join(' ')}\n\n${HELP}`);
}

function learnFrom(e) {
  try {
    if (!LEARN.LEARNABLE.has(e.code)) return;
    const { pos, opt } = parse(process.argv.slice(2));
    const root = resolve(opt.root || process.env.CLAUDE_PROJECT_DIR || process.cwd());
    const task = typeof opt.task === 'string' ? opt.task : pos[0] === 'task' ? pos[2] : null;
    if (!task || !exists(root)) return;
    const rule = LEARN.observe(root, { code: e.code, task, text: e.message });
    if (rule) process.stderr.write(`Ghostship learned ${rule.id}: ${rule.text}\n`);
  } catch { /* learning never blocks */ }
}

main().catch((e) => {
  learnFrom(e);
  process.stderr.write(`✗ ${e.code || 'ERROR'}: ${e.message}\n`);
  process.exitCode = e.code === 'BAD_COMMAND' ? 64 : 1;
});
