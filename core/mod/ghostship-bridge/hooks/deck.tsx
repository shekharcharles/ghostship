// The band above the prompt, drawn the way claude-deck draws its terminal panel (nvr0x5/claude-deck, MIT; see
// ../THIRD_PARTY_NOTICES.md): its palette (theme.js), its cell runs (runs/textCells), its bar styles and mini bars
// (styles-terminal.js: segments, line, solid, terminalMini), its rows (collectRows, activityRow, the limit rows with
// countdown and burn rate) and its two looks: expanded rows, or one collapsed line of chips (collapsedOrder + chips).
// Ghostship feeds it its own rows: the voyage or plan as a bar, what Claude is doing, what waits for the owner, and spend.
import type { BridgeActivity, BridgeSnap } from '../types'
import { LEGS, legIndex, phasesOf } from './text'

// ------------------------------------------------------------- palette (claude-deck theme.js)
export const STYLE = {
  run: { fill: '#9C95EC', on: '#26215C', glyph: '●' },
  ask: { fill: '#EBA83A', on: '#412402', glyph: '?' },
  hot: { fill: '#E2706F', on: '#501313', glyph: '!' },
  done: { fill: '#5DCAA5', on: '#04342C', glyph: '✓' },
  ok: { fill: '#5DCAA5', on: '#04342C', glyph: '◔' },
  warn: { fill: '#EBA83A', on: '#412402', glyph: '◑' },
} as const
export type StyleKey = keyof typeof STYLE
export const TRACK = '#3a3936'
export const TRACK_BG = '#2b2a28'
export const TICK_ON = '#f2f0ea'
export const TICK_OFF = '#55534e'
export const DIM = '#77756f'
export const MUTED = '#9a9893'
export const TEXT = '#e8e6e1'
export const SOFT = '#c9c7c1'

export type Cell = { ch: string; color: string; bg?: string; bold?: boolean }

export function trunc(s: unknown, n: number): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, Math.max(1, n - 1)) + '…' : t
}
export function textCells(s: string, color: string, bg?: string, bold?: boolean): Cell[] {
  return [...String(s)].map((ch) => ({ ch, color, ...(bg ? { bg } : {}), ...(bold ? { bold } : {}) }))
}
/** One Text per run of same-styled cells (claude-deck theme.js runs). */
export function runs(Text: any, cells: Cell[], key = 'r') {
  const out: Array<{ text: string; color: string; bg?: string; bold?: boolean }> = []
  for (const c of cells) {
    const cur = out[out.length - 1]
    if (cur && cur.color === c.color && cur.bg === c.bg && cur.bold === c.bold) cur.text += c.ch
    else out.push({ text: c.ch, color: c.color, ...(c.bg ? { bg: c.bg } : {}), ...(c.bold ? { bold: c.bold } : {}) })
  }
  return out.map((r, i) => <Text key={`${key}${i}`} color={r.color} backgroundColor={r.bg} bold={r.bold}>{r.text}</Text>)
}

// ------------------------------------------------------------- times (claude-deck register.js countdown, humanReset, elapsed)
// A reset time as ms, however it arrives: ISO string, epoch seconds, or epoch ms. NaN when there is none or it is junk.
function resetMs(v: string | number | null | undefined): number {
  if (v == null || v === '') return NaN
  if (typeof v === 'number') return Number.isFinite(v) ? (v < 1e12 ? v * 1000 : v) : NaN
  const t = Date.parse(v)
  if (!Number.isNaN(t)) return t
  const n = Number(v)
  return Number.isFinite(n) ? (n < 1e12 ? n * 1000 : n) : NaN
}
export function countdown(iso: string | null | undefined, now: number): string {
  const ms = resetMs(iso)
  if (!Number.isFinite(ms)) return ''
  let s = Math.max(0, Math.floor((ms - now) / 1000))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  s = s % 60
  if (d > 0) return `${d}d ${h}h ${String(m).padStart(2, '0')}m`
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}
export function humanReset(iso: string, now: number): string {
  const ms = resetMs(iso)
  if (!Number.isFinite(ms)) return ''
  const s = Math.max(0, Math.floor((ms - now) / 1000))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h${m}m` : `${m}m`
}
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}
/** claude-deck burnRate's text: "+3.1%/h", or per day for the weekly window. */
export function rateText(perHour: number | null | undefined, daily: boolean): string {
  if (perHour == null || !(perHour >= 0.05)) return ''
  const per = daily ? perHour * 24 : perHour
  return `+${per < 10 ? per.toFixed(1) : Math.round(per)}${daily ? '%/day' : '%/h'}`
}
const usd = (n: number) => `$${n < 100 ? n.toFixed(2) : Math.round(n)}`

// ------------------------------------------------------------- rows (claude-deck collectRows / barRow / activityRow)
export type Mark = { f: number; stage?: boolean }
export type DeckRow = {
  id: string
  kind: 'bar' | 'activity' | 'ask' | 'meter' | 'spend'
  style: StyleKey
  needsInput?: boolean
  limit?: boolean
  title: string
  pct: number
  marks: Mark[]
  name: string
  count: string
  right: string
  short: string
  animating?: boolean
  strips?: Array<{ id: string; title: string; tool: string; waiting: boolean; at: number }>
}

export function deckRows(snap: BridgeSnap, act: BridgeActivity | null, busy: boolean, now: number): DeckRow[] {
  const rows: DeckRow[] = []
  const asks = snap.asks
  // What needs the owner: claude-deck's needs_input state, first in every look.
  if (asks.length) {
    const first = asks[0]!
    const name = first.id.startsWith('G-') ? first.title : `#${first.id} ${first.title}`
    rows.push({ id: 'ask', kind: 'ask', style: 'ask', needsInput: true, title: `${asks.length} for you:`, pct: 100, marks: [], name: trunc(name, 48), count: asks.length > 1 ? `+${asks.length - 1}` : '', right: '/gs-bridge', short: `${asks.length} for you: ${trunc(name, 28)}` })
  }
  // The headless runner waits for the owner: it says what, as a row that needs input (after the queue's own row).
  const ap = snap.autopilot
  if (ap?.status === 'waiting-owner') {
    const what = snap.nextStep?.say || ap.last?.say || 'a gate only you can pass'
    rows.push({ id: 'autopilot', kind: 'ask', style: 'ask', needsInput: true, title: 'autopilot waits for you:', pct: 100, marks: [], name: trunc(what, 48), count: '', right: '/gs-bridge', short: `autopilot waits: ${trunc(what, 24)}` })
  }
  // The voyage as a plan bar: the plan's phases and tasks once there is a plan, else the six stages.
  const live = snap.tasks.filter((t) => t.status !== 'DROPPED')
  const at = legIndex(snap.stage)
  const leg = LEGS[at]!
  const stuck = snap.needsDecision.length > 0
  if (live.length && ['plan', 'build', 'release'].includes(snap.stage)) {
    const phases = phasesOf(snap.tasks)
    const merged = live.filter((t) => t.status === 'MERGED').length
    const marks: Mark[] = []
    let k = 0
    for (const p of phases) { for (let j = 0; j < p.total; j++) { if (k > 0) marks.push({ f: k / live.length, stage: j === 0 }); k++ } }
    const now_ = phases.find((p) => p.state === 'now')
    const cur = snap.active
    const done = merged === live.length
    rows.push({
      // Title: the stage. Inside the bar: the phase, or the task in hand. Count: tasks merged of all.
      id: 'bar:plan', kind: 'bar', style: done ? 'done' : stuck ? 'ask' : 'run', needsInput: stuck, title: leg.label,
      pct: done ? 100 : ((merged + (cur ? 0.4 : 0)) / live.length) * 100, marks,
      name: trunc(cur ? `${cur.id} ${now_?.current?.title ?? ''}` : now_ ? `phase ${now_.label} · ${now_.done}/${now_.total}` : leg.label, 34), count: `${merged}/${live.length} merged`,
      right: `${Math.round(done ? 100 : (merged / live.length) * 100)}%`, short: `${leg.label} ${merged}/${live.length}`, animating: busy && !done,
    })
  } else {
    const marks = LEGS.slice(1).map((l, i) => ({ f: (i + 1) / LEGS.length, stage: !!l.stop }))
    const inLeg = snap.interview?.total && at === 0 ? snap.interview.closed / snap.interview.total : 0.4
    rows.push({
      id: 'bar:voyage', kind: 'bar', style: stuck ? 'ask' : 'run', title: 'Voyage', pct: ((at + inLeg) / LEGS.length) * 100, marks,
      name: snap.interview?.total && at === 0 ? `${leg.label} · interview ${snap.interview.closed}/${snap.interview.total}` : leg.label,
      count: `${at + 1}/${LEGS.length}`, right: `${Math.round(((at + inLeg) / LEGS.length) * 100)}%`, short: `${leg.label} ${at + 1}/${LEGS.length}`, animating: busy,
    })
  }
  // What Claude is doing now (activityRow), its subagents as strips under it.
  // Claude's own turn may have ended while a background builder works: the row stays while any agent does.
  const strips = workingStrips(act, snap)
  const main = busy && act?.main ? act.main : null
  if (main || strips.length) {
    const since = main ? main.at : Math.min(...strips.map((x) => x.at))
    const ms = now - since
    const label = main ? main.label : `waiting on ${strips.length} agent${strips.length === 1 ? '' : 's'}`
    rows.push({
      id: 'activity', kind: 'activity', style: main?.waiting ? 'ask' : 'run', needsInput: !!main?.waiting, title: 'Claude',
      pct: 95 * (1 - Math.exp(-ms / 90000)), marks: [], name: trunc(main?.waiting ? 'Needs you' : label, 28),
      count: strips.length ? `${strips.length} agent${strips.length === 1 ? '' : 's'}` : '', right: elapsed(ms), short: trunc(label, 22), animating: true,
      strips,
    })
  }
  // Limits (5h/7d) and spend live in the status line under the prompt; the band stays on the work itself.
  if (snap.contextPercent !== null) {
    const p = snap.contextPercent
    rows.push({ id: 'context', kind: 'meter', style: p >= 80 ? 'hot' : p >= 60 ? 'warn' : 'run', title: 'Context', pct: p, marks: [{ f: 0.5 }, { f: 0.8 }],
      name: p >= 80 ? 'nearly full: the keeper hands off soon' : 'of the window', count: '', right: `${Math.round(p)}%`, short: `ctx ${Math.round(p)}%` })
  }
  return rows
}

/** claude-deck collapsedOrder: what needs you first, then limits, context, bars (Ghostship puts spend right after the limits). */
export function collapsedOrder(rows: DeckRow[]): DeckRow[] {
  const rank = (r: DeckRow) => (r.needsInput ? 0 : r.limit ? 1 : r.kind === 'spend' ? 2 : r.id === 'context' ? 3 : r.kind === 'bar' ? 4 : 5)
  return [...rows].sort((a, b) => rank(a) - rank(b))
}

// ------------------------------------------------------------- bars (claude-deck styles-terminal.js)
function labelCells(row: DeckRow, room: number): Cell[] {
  const st = STYLE[row.style]
  const name = trunc(row.name, Math.max(3, room - (row.count ? row.count.length + 1 : 0)))
  const cells = textCells(name, st.fill)
  if (row.count && name.length + row.count.length + 1 <= room) cells.push(...textCells(' ' + row.count, MUTED))
  return cells
}
function withLabel(bar: Cell[], row: DeckRow, W: number): Cell[] {
  const room = W - bar.length - 2
  const out = [...bar, ...textCells('  ', MUTED), ...labelCells(row, room)]
  while (out.length < W) out.push({ ch: ' ', color: MUTED })
  return out.slice(0, W)
}
const barWidth = (W: number) => Math.max(6, Math.min(W - 8, Math.max(10, Math.round(W * 0.58))))

/** segments: ▰▱ with gaps at stage marks and a pulsing head while it runs. */
export function segments(row: DeckRow, W: number, frame: number): Cell[] {
  const st = STYLE[row.style]
  const bw = barWidth(W)
  const fx = (bw * row.pct) / 100
  const gaps = new Set(row.marks.filter((m) => m.stage).map((m) => Math.round(bw * m.f)))
  const cells: Cell[] = []
  for (let x = 0; x < bw; x++) {
    if (gaps.has(x)) { cells.push({ ch: ' ', color: TRACK }); continue }
    const head = row.animating && x === Math.floor(fx)
    cells.push(x < Math.floor(fx) ? { ch: '▰', color: st.fill } : head ? { ch: '▰', color: frame % 4 < 2 ? st.fill : '#6e6aa8' } : { ch: '▱', color: TRACK })
  }
  return withLabel(cells, row, W)
}
/** line: ━ filled, ╸ head, ┼ marks. */
export function line(row: DeckRow, W: number, frame: number): Cell[] {
  const st = STYLE[row.style]
  const bw = barWidth(W)
  const full = Math.floor((bw * row.pct) / 100)
  const marks = new Set(row.marks.map((m) => Math.round(bw * m.f)))
  const cells: Cell[] = []
  for (let x = 0; x < bw; x++) {
    if (x < full) cells.push({ ch: '━', color: st.fill })
    else if (x === full && row.pct < 100) cells.push({ ch: '╸', color: row.animating && frame % 4 < 2 ? TICK_ON : st.fill })
    else cells.push({ ch: marks.has(x) ? '┼' : '─', color: marks.has(x) ? TICK_OFF : TRACK })
  }
  return withLabel(cells, row, W)
}
/** solid: the label printed inside a filled block, a shine sweeping while it runs. */
export function solid(row: DeckRow, W: number, frame: number): Cell[] {
  const st = STYLE[row.style]
  const f = Math.round((W * row.pct) / 100)
  const text = (' ' + row.name + (row.count ? ' · ' + row.count : '') + ' ').slice(0, W)
  const sweep = row.animating ? ((frame * 2) % (W + 12)) - 6 : -99
  const cells: Cell[] = []
  for (let x = 0; x < W; x++) {
    const ch = text[x] ?? ' '
    const inFill = x < f
    cells.push(inFill ? { ch, color: st.on, bg: Math.abs(x - sweep) < 2 ? '#cfc9f7' : st.fill, bold: true } : { ch, color: MUTED, bg: TRACK_BG })
  }
  return cells
}
export const BAR_STYLES = { segments, line, solid }
export type BarStyle = keyof typeof BAR_STYLES
/** A short bar for a chip (terminalMini). */
export function mini(style: BarStyle, row: DeckRow, W: number): Cell[] {
  const st = STYLE[row.style]
  const f = Math.round((W * row.pct) / 100)
  const cells: Cell[] = []
  for (let x = 0; x < W; x++) {
    if (style === 'solid') cells.push({ ch: ' ', color: st.fill, bg: x < f ? st.fill : TRACK_BG })
    else if (style === 'line') cells.push({ ch: x < f ? '━' : '─', color: x < f ? st.fill : TRACK })
    else cells.push({ ch: x < f ? '▰' : '▱', color: x < f ? st.fill : TRACK })
  }
  return cells
}

// ------------------------------------------------------------- the band
export type DeckBandData = { snap: BridgeSnap; act: BridgeActivity | null; busy: boolean; now: number; cols: number; open: () => void; style?: BarStyle }
const FRAME_MS = 250

/** Expanded while Claude works or something waits for the owner; one line of chips otherwise. */
/** Agents at work: the mod's own step line for each subagent, else (after a reload or /clear) the guard's heartbeat. */
export function workingStrips(act: BridgeActivity | null, snap: BridgeSnap): Array<{ id: string; title: string; tool: string; waiting: boolean; at: number }> {
  const subs = Object.entries(act?.subs || {})
  if (subs.length) return subs.map(([id, s]) => ({ id, title: s.name, tool: s.label, waiting: s.waiting, at: s.at }))
  return (snap.agents || []).map((a) => ({ id: a.role, title: a.role, tool: a.step, waiting: false, at: a.at }))
}

export function deckBand(el: any, d: DeckBandData) {
  const { Box, Text, Button } = el
  const rows = deckRows(d.snap, d.act, d.busy, d.now)
  const style: BarStyle = d.style ?? 'segments'
  const frame = Math.floor(d.now / FRAME_MS)
  const cols = Math.max(40, d.cols)
  const needs = rows.some((r) => r.needsInput)
  const open = d.busy || needs || workingStrips(d.act, d.snap).length > 0
  const s = d.snap
  const state = [s.paused ? '⏸ paused' : '', s.active ? `${s.active.id} ${s.active.status} ${s.active.attempt}/${s.active.max}` : '', s.run?.status === 'running' ? `run: ${s.run.agentId}${s.run.blocked ? ' ⚠ needs you' : ''}` : ''].filter(Boolean).join(' · ')
  const toggle = <Button key="open-bridge" plain dimColor label={`⛴ ${s.project} ${open ? '▾' : '▸'}`} onPress={() => d.open()} />

  if (!open) {
    // collapsed, chips: one line, what needs you first, then limits, context, bars (claude-deck chips)
    const chips: any[] = []
    let budget = cols - 14 - state.length
    let hidden = 0
    for (const row of collapsedOrder(rows)) {
      const w = row.short.length + (row.kind === 'spend' ? 4 : 10)
      if (w > budget) { hidden++; continue }
      budget -= w
      const st = STYLE[row.style]
      if (chips.length) chips.push(<Text key={`sep-${row.id}`} color={TRACK}>{' │ '}</Text>)
      chips.push(<Text key={`g-${row.id}`} color={st.fill}>{row.kind === 'spend' ? '$ ' : `${st.glyph} `}</Text>)
      chips.push(<Text key={`t-${row.id}`} color={row.needsInput ? st.fill : row.limit ? TEXT : SOFT} bold={row.limit}>{row.short + (row.kind === 'spend' ? '' : ' ')}</Text>)
      if (row.kind !== 'spend') chips.push(<Box key={`m-${row.id}`} flexDirection="row">{runs(Text, mini(style, row, 5), `m${row.id}`)}</Box>)
    }
    if (hidden) chips.push(<Text key="hidden" color={DIM}>{`  +${hidden}`}</Text>)
    return (
      <Box flexDirection="row" columnGap={1} alignItems="center">
        {toggle}
        <Box flexDirection="row" alignItems="center" flexShrink={1} overflow="hidden">{chips}</Box>
        {state ? <Text color={MUTED} wrap="truncate-end">{state}</Text> : null}
      </Box>
    )
  }

  // expanded: a header, then one row each: glyph, title, bar with its label, the right column; strips under the activity
  const labelW = Math.min(24, Math.max(12, Math.floor(cols * 0.2)))
  const rightW = 12
  // Two cells spare at the right edge, so no row reaches the band's edge and gets cut.
  const barW = Math.max(16, cols - labelW - rightW - 10)
  const lines: any[] = []
  for (const row of rows) {
    const st = STYLE[row.style]
    const glyph = row.kind === 'spend' ? '$' : row.animating && row.kind === 'activity' ? (frame % 6 < 3 ? '○' : '●') : st.glyph
    const body = row.kind === 'ask' || row.kind === 'spend'
      ? [...textCells(row.name, row.kind === 'ask' ? st.fill : TEXT, undefined, row.kind === 'ask'), ...(row.count ? textCells('  ' + row.count, MUTED) : [])]
      : BAR_STYLES[style](row, barW, frame)
    lines.push(
      <Box key={`row-${row.id}`} flexDirection="row" columnGap={1}>
        <Text color={st.fill}>{glyph}</Text>
        <Box width={labelW} flexShrink={0}><Text color={row.needsInput ? st.fill : TEXT} wrap="truncate-end">{trunc(row.title, labelW)}</Text></Box>
        <Box flexGrow={1} flexDirection="row">{runs(Text, body.slice(0, barW + 40), `b${row.id}`)}</Box>
        <Box width={rightW} flexShrink={0} justifyContent="flex-end"><Text color={row.needsInput ? st.fill : MUTED}>{row.right}</Text></Box>
      </Box>,
    )
    for (const ag of row.strips || []) {
      const ast = STYLE[ag.waiting ? 'ask' : 'run']
      lines.push(
        <Box key={`strip-${ag.id}`} flexDirection="row" columnGap={1}>
          <Text>{'  '}</Text>
          <Text color={ast.fill}>{!ag.waiting && frame % 6 < 3 ? '○' : '●'}</Text>
          <Box width={labelW - 1} flexShrink={0}><Text color={SOFT} wrap="truncate-end">{trunc(ag.title, labelW - 1)}</Text></Box>
          <Box flexShrink={1}><Text color={ast.fill} wrap="truncate-end">{ag.tool}</Text></Box>
          <Box flexGrow={1} />
          <Text color={DIM}>{elapsed(d.now - ag.at)}</Text>
        </Box>,
      )
    }
  }
  return (
    <Box flexDirection="column">
      <Box key="head" flexDirection="row" columnGap={1}>
        {toggle}
        {state ? <Text color={MUTED} wrap="truncate-end">{`· ${state}`}</Text> : null}
      </Box>
      {lines}
    </Box>
  )
}

/** The meters line the pane ends with: claude-deck's chips for limits, context and spend. */
export function deckChips(el: any, snap: BridgeSnap, now: number, style: BarStyle = 'segments') {
  const { Box, Text } = el
  const rows = collapsedOrder(deckRows(snap, null, false, now)).filter((r) => r.kind === 'meter' || r.kind === 'spend')
  if (!rows.length) return null
  const chips: any[] = []
  for (const row of rows) {
    const st = STYLE[row.style]
    chips.push(
      <Box key={`chip-${row.id}`} flexDirection="row">
        <Text color={st.fill}>{row.kind === 'spend' ? '$ ' : `${st.glyph} `}</Text>
        <Text color={row.limit ? TEXT : SOFT} bold={row.limit}>{row.short + (row.kind === 'spend' ? '' : ' ')}</Text>
        {row.kind !== 'spend' ? runs(Text, mini(style, row, 5), `c${row.id}`) : null}
      </Box>,
    )
  }
  return <Box key="meters" flexDirection="row" flexWrap="wrap" columnGap={3} marginTop={1}>{chips}</Box>
}
