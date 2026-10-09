// Harbor's single page: every project at a glance, one project in depth, and the owner's config editor.
export const HARBOR_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Harbor · Ghostship</title>
<style>
:root{--bg:#f6f5f2;--panel:#fff;--ink:#1d1f23;--sub:#5d636e;--line:#e4e2dc;--accent:#2f5d8a;--ok:#2e7d4f;--warn:#b26b00;--bad:#b3261e;--busy:#2f5d8a;--chip:#eef1f5;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{--bg:#121417;--panel:#1a1d21;--ink:#e7e9ec;--sub:#9aa1ab;--line:#2a2e34;--accent:#7fb0e0;--ok:#5cc08a;--warn:#e0a24a;--bad:#ef6b62;--busy:#7fb0e0;--chip:#232830}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
header{display:flex;align-items:center;gap:12px;padding:12px 20px;border-bottom:1px solid var(--line);background:var(--panel);position:sticky;top:0;z-index:2}
header h1{font-size:16px;margin:0;letter-spacing:.02em}header .sub{color:var(--sub);font-size:12px}
.wrap{display:grid;grid-template-columns:300px 1fr;min-height:calc(100vh - 50px)}
aside{border-right:1px solid var(--line);background:var(--panel);overflow:auto}
.proj{display:grid;grid-template-columns:14px 1fr auto;gap:8px;align-items:start;padding:10px 14px;border-bottom:1px solid var(--line);cursor:pointer}
.proj:hover,.proj.sel{background:var(--chip)}.proj b{display:block;font-weight:600}.proj small{color:var(--sub);display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:200px}
.dot{width:10px;height:10px;border-radius:50%;margin-top:5px;background:var(--sub)}.dot.action{background:var(--warn)}.dot.warn,.dot.error,.dot.missing{background:var(--bad)}.dot.busy{background:var(--busy)}.dot.idle{background:var(--ok)}.dot.paused{background:var(--sub)}
main{padding:20px 24px;overflow:auto}.empty{color:var(--sub);padding:40px}
.kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:14px 0}
.card{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px 14px}.card h3{margin:0 0 4px;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--sub);font-weight:600}.card .v{font-size:17px;font-weight:600}.card .s{color:var(--sub);font-size:12px}
.callout{border-left:3px solid var(--warn);background:var(--panel);padding:10px 14px;border-radius:4px;margin:10px 0}
.tabs{display:flex;gap:4px;border-bottom:1px solid var(--line);margin-top:18px}.tabs button{background:none;border:0;padding:8px 12px;color:var(--sub);cursor:pointer;font:inherit;border-bottom:2px solid transparent}.tabs button.on{color:var(--ink);border-color:var(--accent)}
table{width:100%;border-collapse:collapse;margin-top:10px;font-size:13px}th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--sub);font-weight:600;font-size:12px}
.chip{display:inline-block;padding:1px 7px;border-radius:10px;background:var(--chip);font-size:12px;margin-right:4px}
.st-MERGED,.st-PASSED{color:var(--ok)}.st-NEEDS_DECISION,.st-RETRY{color:var(--warn)}.st-DROPPED{color:var(--sub);text-decoration:line-through}.st-BUILDING,.st-JUDGING{color:var(--busy)}
textarea{width:100%;min-height:420px;font:12.5px/1.5 var(--mono);background:var(--panel);color:var(--ink);border:1px solid var(--line);border-radius:6px;padding:10px}
.btn{background:var(--accent);color:#fff;border:0;border-radius:6px;padding:7px 12px;cursor:pointer;font:inherit}.btn.ghost{background:none;color:var(--accent);border:1px solid var(--line)}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px}.err{color:var(--bad)}.okm{color:var(--ok)}
code,.mono{font-family:var(--mono);font-size:12.5px}.muted{color:var(--sub)}
@media (max-width:820px){.wrap{grid-template-columns:1fr}aside{max-height:40vh}.kpis{grid-template-columns:1fr 1fr}main{padding:16px}}
</style></head><body>
<header><h1>⛴ Harbor</h1><span class="sub" id="sum">loading…</span><span style="flex:1"></span><button class="btn ghost" id="add">Add project</button></header>
<div class="wrap"><aside id="list"></aside><main id="main"><div class="empty">Pick a project.</div></main></div>
<script>
const T = new URLSearchParams(location.search).get('t') || sessionStorage.getItem('harbor-t') || '';
try { sessionStorage.setItem('harbor-t', T); history.replaceState(null, '', '/'); } catch (e) {}
const H = { 'x-harbor-token': T, 'content-type': 'application/json' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const APPROVAL_HINT = { terminal: 'you type yes in your own terminal (default; a real TTY)', chat: 'you approve in words; Claude passes your exact quote', bridge: 'one press in the Bridge pane, proved by ~/.ghostship/bridge.key (opt-in; weaker than a TTY)' };
const api = async (p, body) => { const r = await fetch(p, body ? { method: 'POST', headers: H, body: JSON.stringify(body) } : { headers: H }); return r.json(); };
let sel = null, tab = 'overview', editing = false, last = null;
function listRow(p) {
  const d = p.active ? p.active.id + ' ' + p.active.status : p.stage || p.note || '';
  return '<div class="proj' + (sel === p.path ? ' sel' : '') + '" data-p="' + esc(p.path) + '"><span class="dot ' + esc(p.health) + '"></span><div><b>' + esc(p.name) + '</b><small>' + esc(d) + '</small><small>' + esc(p.next || '') + '</small></div><div class="muted">' + (p.needsDecision && p.needsDecision.length ? '⚑' : '') + '</div></div>';
}
async function loadList() {
  const ps = await api('/api/projects');
  if (!Array.isArray(ps)) { document.getElementById('sum').textContent = 'Not authorised: open the link Harbor printed.'; return; }
  const act = ps.filter((p) => p.health === 'action').length, busy = ps.filter((p) => p.health === 'busy').length;
  const usd = ps.reduce((a, p) => a + (p.spend ? p.spend.claudeUsd : 0), 0);
  document.getElementById('sum').textContent = ps.length + ' projects · ' + act + ' need you · ' + busy + ' working · Claude $' + usd.toFixed(2);
  document.getElementById('list').innerHTML = ps.map(listRow).join('') || '<div class="empty">No projects. Run /ghostship init in a folder.</div>';
  document.querySelectorAll('.proj').forEach((el) => el.onclick = () => { sel = el.dataset.p; tab = 'overview'; editing = false; loadList(); loadOne(); });
  if (!sel && ps[0]) { sel = ps[0].path; loadOne(); }
}
function kpi(t, v, s) { return '<div class="card"><h3>' + esc(t) + '</h3><div class="v">' + esc(v) + '</div><div class="s">' + esc(s || '') + '</div></div>'; }
function tableOf(head, rows) { return '<table><tr>' + head.map((h) => '<th>' + esc(h) + '</th>').join('') + '</tr>' + rows.join('') + '</table>'; }
function view(d) {
  if (d.health === 'missing' || d.health === 'error') return '<h2>' + esc(d.name) + '</h2><p class="err">' + esc(d.note) + '</p><button class="btn ghost" onclick="act(\\'/api/projects/remove\\')">Remove from Harbor</button>';
  let h = '<h2 style="margin:0">' + esc(d.name) + '</h2><div class="muted mono">' + esc(d.path) + '</div><div class="row"><span class="chip">core ' + esc(d.version) + '</span><span class="chip">' + esc(d.tier) + '</span><span class="chip">tracker: ' + esc(d.tracker) + '</span>' + (d.confidential ? '<span class="chip">confidential</span>' : '') + (d.paused ? '<span class="chip">paused</span>' : '') + '</div>';
  if (d.asks && d.asks.length) h += '<div class="callout"><b>For you (' + d.asks.length + '):</b>' + d.asks.map(function (a) { return '<div>☐ #' + esc(a.id) + ' ' + esc(a.title) + (a.why ? ' <span class="muted">— ' + esc(a.why) + '</span>' : '') + (a.options && a.options.length ? ' <span class="muted">[' + a.options.map(esc).join(' | ') + ']</span>' : '') + '</div>'; }).join('') + '<div class="muted">Answer in the Bridge pane (/gs-bridge) or <code>gs ask answer &lt;id&gt; …</code> in your terminal.</div></div>';
  if (d.claude && (d.claude.fiveHour || d.claude.sevenDay)) h += '<div class="muted">Claude plan: ' + (d.claude.fiveHour ? '5h ' + Math.round(d.claude.fiveHour.percent) + '%' : '') + (d.claude.sevenDay ? ' · 7d ' + Math.round(d.claude.sevenDay.percent) + '%' : '') + '</div>';
  if (d.needsDecision.length || d.release) h += '<div class="callout">' + (d.needsDecision.length ? '<b>Your decision:</b> ' + d.needsDecision.map(esc).join(', ') + ' — <code>gs decide &lt;id&gt; --grant 1 | --drop</code>' : '') + (d.release ? '<div><b>STOP 2:</b> v' + esc(d.release.version) + ' (' + esc(d.release.result) + ') waits for <code>gs release approve</code></div>' : '') + '</div>';
  const sp = d.spend || {};
  h += '<div class="kpis">' + kpi('Stage', d.stage, d.next) + kpi('Task', d.active ? d.active.id + ' ' + d.active.status : 'none', d.active ? 'attempt ' + d.active.attempt + '/' + d.active.max : Object.entries(d.counts || {}).map(([k, v]) => k + ' ' + v).join(' · ')) + kpi('Outside run', d.run ? d.run.agentId : 'none', d.run ? d.run.role + ' ' + (d.run.task || '') + ' · ' + d.run.status + (d.run.blocked ? ' · needs you' : '') : '') + kpi('Spend', 'Claude $' + (sp.claudeUsd ?? 0).toFixed(2), (sp.gateway ? sp.gateway.inputTokens + sp.gateway.outputTokens : 0) + ' gateway tokens · ' + (sp.outsideRuns ? sp.outsideRuns.minutes : 0) + ' min outside') + kpi('Approvals', d.approvals || 'terminal', APPROVAL_HINT[d.approvals || 'terminal'] || '') + '</div>';
  h += '<div class="row">' + (d.paused ? '<button class="btn" onclick="act(\\'/api/go\\')">Resume</button>' : '<button class="btn ghost" onclick="act(\\'/api/pause\\')">Pause</button>') + (d.session ? '<span class="muted">Claude session: ' + (d.session.percent != null ? Math.round(d.session.percent) + '% context · ' : '') + d.session.minutesAgo + ' min ago</span>' : '<span class="muted">No live Claude session</span>') + '</div>';
  const tabs = [['overview', 'Alerts'], ['tasks', 'Tasks'], ['agents', 'Agents'], ['activity', 'Activity'], ['config', 'Config']];
  h += '<div class="tabs">' + tabs.map(([k, l]) => '<button class="' + (tab === k ? 'on' : '') + '" onclick="tab=\\'' + k + '\\';render()">' + l + '</button>').join('') + '</div>';
  if (tab === 'overview') h += d.alerts.length ? tableOf(['when', 'alert'], d.alerts.map((a) => '<tr><td class="mono">' + esc(a.at.slice(5, 16).replace('T', ' ')) + '</td><td>' + esc(a.alert) + '</td></tr>')) : '<p class="muted">No alerts.</p>';
  if (tab === 'tasks') h += tableOf(['task', 'title', 'status', 'attempts', 'checks', 'tier'], d.tasks.map((t) => '<tr><td class="mono">' + esc(t.id) + '</td><td>' + esc(t.title) + '</td><td class="st-' + esc(t.status) + '">' + esc(t.status) + '</td><td>' + esc(t.attempts) + '</td><td>' + t.checks.map((c) => '<span class="chip">' + esc(c) + '</span>').join('') + '</td><td>' + esc(t.tier) + (t.risk === 'high' ? ' · high risk' : '') + '</td></tr>'));
  if (tab === 'agents') h += tableOf(['agent', 'harness', 'model', 'provider', 'runs as', 'status', ''], d.agents.map((a) => '<tr><td class="mono">' + esc(a.id) + '</td><td>' + esc(a.harness) + '</td><td>' + esc(a.model || '-') + '</td><td>' + esc(a.provider) + '</td><td>' + esc(a.runsAs) + '</td><td>' + esc(a.note) + '</td><td>' + (a.cooling ? '<button class="btn ghost" onclick="act(\\'/api/quota/clear\\',{agent:\\'' + String(a.id).replace(/[^\\w.-]/g, '') + '\\'})">Clear cooldown</button>' : '') + '</td></tr>')) + tableOf(['tier', 'agents in order'], Object.entries(d.tiers).map(([k, v]) => '<tr><td>' + esc(k) + '</td><td>' + v.map(esc).join(' → ') + '</td></tr>'));
  if (tab === 'activity') h += tableOf(['when', 'event', 'ref'], d.events.map((e) => '<tr><td class="mono">' + esc(e.at.slice(5, 19).replace('T', ' ')) + '</td><td>' + esc(e.type) + '</td><td>' + esc(e.ref || '') + '</td></tr>')) + '<h3>Outside runs</h3>' + tableOf(['run', 'agent', 'status', 'minutes'], d.runs.map((r) => '<tr><td class="mono">' + esc(r.runId) + '</td><td>' + esc(r.agentId) + '</td><td>' + esc(r.status) + '</td><td>' + Math.round((r.durationMs || 0) / 60000) + '</td></tr>')) + '<h3>Releases</h3>' + tableOf(['tag', 'when', 'result'], d.releases.map((r) => '<tr><td>' + esc(r.tag) + '</td><td>' + esc(r.at) + '</td><td>' + esc(r.result) + '</td></tr>'));
  if (tab === 'config') h += '<p class="muted">You own this file. Agents cannot edit it; changes are validated before saving. Secrets never go here: put the NAME of a line in ~/.ghostship/secrets.</p><p class="muted"><b>approvals.mode</b>: <code>terminal</code> — ' + esc(APPROVAL_HINT.terminal) + ' · <code>chat</code> — ' + esc(APPROVAL_HINT.chat) + ' · <code>bridge</code> — ' + esc(APPROVAL_HINT.bridge) + '</p><textarea id="cfg" spellcheck="false" oninput="editing=true">' + esc(d.configText) + '</textarea><div class="row"><button class="btn" onclick="saveCfg()">Validate and save</button><span id="cfgmsg"></span></div>';
  return h;
}
function render() { if (last) { document.getElementById('main').innerHTML = view(last); } }
async function loadOne() { if (!sel || (tab === 'config' && editing)) return; last = await api('/api/project?path=' + encodeURIComponent(sel)); render(); }
async function act(p, extra) { await api(p, Object.assign({ path: sel }, extra || {})); editing = false; await loadList(); await loadOne(); }
async function saveCfg() {
  const r = await api('/api/config', { path: sel, text: document.getElementById('cfg').value });
  const m = document.getElementById('cfgmsg');
  if (r.ok) { m.className = 'okm'; m.textContent = 'Saved.'; editing = false; } else { m.className = 'err'; m.innerHTML = (r.errors || [r.error]).map(esc).join('<br>'); }
}
document.getElementById('add').onclick = async () => { const p = prompt('Path of a folder with Ghostship (absolute):'); if (!p) return; const r = await api('/api/projects/add', { path: p }); if (r.error) alert(r.error); loadList(); };
loadList(); setInterval(() => { loadList(); loadOne(); }, 5000);
</script></body></html>`;
