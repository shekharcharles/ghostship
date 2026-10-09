// Claude Code's status line in claude-deck's look (nvr0x5/claude-deck, MIT; see core/mod/ghostship-bridge/THIRD_PARTY_NOTICES.md):
// its collapsed "chips" line — a glyph, a short text and a mini bar per chip, separated by │, ordered by what matters
// (what needs you, the 5h and 7d limits with their reset, spend, context, the plan) — in its palette, as 24-bit colour.

// claude-deck theme.js
const STYLE = {
  run: { fill: '#9C95EC', glyph: '●' },
  ask: { fill: '#EBA83A', glyph: '?' },
  hot: { fill: '#E2706F', glyph: '!' },
  done: { fill: '#5DCAA5', glyph: '✓' },
  ok: { fill: '#5DCAA5', glyph: '◔' },
  warn: { fill: '#EBA83A', glyph: '◑' },
};
const TRACK = '#3a3936';
const DIM = '#77756f';
const MUTED = '#9a9893';
const TEXT = '#e8e6e1';
const SOFT = '#c9c7c1';
const ACCENT = '#d97757';
const LEGS = [['Discover', ['new', 'adopt']], ['Design', ['design']], ['Checks', ['acceptance']], ['Plan', ['plan']], ['Build', ['build']], ['Release', ['release']]];

const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
function painter(color) {
  return (text, hex, { bold = false } = {}) => {
    if (!color) return text;
    const [r, g, b] = rgb(hex);
    return `${bold ? '\x1b[1m' : ''}\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
  };
}
const trunc = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, Math.max(1, n - 1))}…` : t; };

// A reset time as ms, however it arrives: ISO string, epoch seconds, or epoch ms. NaN when there is none or it is junk.
function resetMs(v) {
  if (v == null || v === '') return NaN;
  if (typeof v === 'number') return Number.isFinite(v) ? (v < 1e12 ? v * 1000 : v) : NaN;
  const t = Date.parse(v);
  if (!Number.isNaN(t)) return t;
  const n = Number(v);
  return Number.isFinite(n) ? (n < 1e12 ? n * 1000 : n) : NaN;
}
// claude-deck register.js humanReset: "1h7m", "3d 5h", "42m"; '' when there is no real reset time (never "NaNm").
function humanReset(iso, now) {
  const ms = resetMs(iso);
  if (!Number.isFinite(ms)) return '';
  const s = Math.max(0, Math.floor((ms - now) / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h${m}m` : `${m}m`;
}
const usd = (n) => `$${n < 100 ? n.toFixed(2) : Math.round(n)}`;

/** The chips, in claude-deck's collapsedOrder (Ghostship puts spend right after the limits). */
export function deckChips(snap, usage = {}, now = Date.now()) {
  const s = snap.status || {};
  const chips = [];
  const asks = snap.asks || [];
  if (asks.length) {
    const first = asks[0];
    const name = first.id.startsWith('G-') ? first.title : `#${first.id} ${first.title}`;
    chips.push({ rank: 0, style: 'ask', needsInput: true, short: `${asks.length} for you: ${trunc(name, 28)}` });
  }
  const c = snap.claude;
  const limit = (tag, w) => {
    const p = w.percent;
    const r = humanReset(w.resetsAt, now);
    chips.push({ rank: 1, limit: true, style: p >= 80 ? 'hot' : p >= 50 ? 'warn' : 'ok', pct: Math.min(100, p), short: `${tag} ${Math.round(p)}%${r ? ` ↻${r}` : ''}` });
  };
  if (c?.fiveHour) limit('5h', c.fiveHour);
  if (c?.sevenDay) limit('7d', c.sevenDay);
  const session = usage.cost?.usd;
  // The project total includes this session; before the first tick records it, never show less than the session.
  const project = snap.spend?.usd != null ? Math.max(snap.spend.usd, session ?? 0) : null;
  if (session != null || project != null) chips.push({ rank: 2, spend: true, style: 'done', short: [session != null ? `${usd(session)} session` : '', project != null ? `${usd(project)} project` : ''].filter(Boolean).join(' · ') });
  // Context % is shown in the band above the prompt, not here, to avoid repeating it.
  const at = Math.max(0, LEGS.findIndex(([, st]) => st.includes(s.stage)));
  const live = (snap.tasks || []).filter((t) => t.status !== 'DROPPED');
  const stuck = (s.needsDecision || []).length > 0;
  if (live.length && ['plan', 'build', 'release'].includes(s.stage)) {
    const merged = live.filter((t) => t.status === 'MERGED').length;
    chips.push({ rank: 4, style: merged === live.length ? 'done' : stuck ? 'ask' : 'run', needsInput: stuck, pct: (merged / live.length) * 100, short: `${LEGS[at][0]} ${merged}/${live.length}` });
  } else {
    chips.push({ rank: 4, style: stuck ? 'ask' : 'run', pct: ((at + 0.4) / LEGS.length) * 100, short: `${LEGS[at][0]} ${at + 1}/${LEGS.length}` });
  }
  return chips.sort((a, b) => (a.needsInput ? 0 : a.rank) - (b.needsInput ? 0 : b.rank));
}

/** One status line: ⛴ project ▸ then the chips, then the task in hand. */
export function deckLine(snap, usage = {}, { color = !process.env.NO_COLOR, now = Date.now() } = {}) {
  if (!snap?.active) return '';
  const P = painter(color);
  const s = snap.status || {};
  const parts = [];
  for (const chip of deckChips(snap, usage, now)) {
    const st = STYLE[chip.style];
    let t = P(chip.spend ? '$ ' : `${st.glyph} `, st.fill) + P(chip.short, chip.needsInput ? st.fill : chip.limit ? TEXT : SOFT, { bold: !!chip.limit });
    if (chip.pct != null) {
      // claude-deck terminalMini, segments style: ▰ filled, ▱ track, five cells
      const f = Math.round((5 * Math.max(0, Math.min(100, chip.pct))) / 100);
      t += ' ' + P('▰'.repeat(f), st.fill) + P('▱'.repeat(5 - f), TRACK);
    }
    parts.push(t);
  }
  const state = [snap.paused ? '⏸ paused' : '', s.active ? `${s.active.id} ${s.active.status.toLowerCase()} ${s.active.attempt}/${s.active.max}` : '', snap.run?.status === 'running' ? `run: ${snap.run.agentId}${snap.run.blocked ? ' ⚠ needs you' : ''}` : ''].filter(Boolean).join(' · ');
  // What each Ghostship agent is doing right now, from the guard's heartbeat: "◆ builder: Editing parser.ts · 12s".
  const doing = (snap.agents || []).map((a) => `${P('◆', STYLE.run.fill)} ${P(`${a.role}:`, TEXT, { bold: true })} ${P(a.step, SOFT)} ${P(`· ${Math.max(0, Math.round((now - a.at) / 1000))}s`, MUTED)}`);
  return `${P(`⛴ ${snap.project || 'ghostship'}`, ACCENT, { bold: true })} ${P('▸', DIM)}  ${parts.join(P(' │ ', TRACK))}${state ? `  ${P(state, MUTED)}` : ''}${doing.length ? `\n${doing.join(P('   ', MUTED))}` : ''}`;
}
