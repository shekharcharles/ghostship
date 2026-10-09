// Pure helpers the band and the pane draw with: the voyage (stages), bars, glyphs, ages, the step line's words,
// and which gs command an option of a Ghostship ask runs. No $, so the tests and both drawings share them.
import type { Autonomy, BridgeAsk, BridgeSnap, BridgeTaskRow, StepEntry } from '../types'

// ------------------------------------------------------------- the voyage: Ghostship's stages, two of them stops
export type Leg = { key: string; label: string; stages: string[]; stop?: 1 | 2 }
export const LEGS: Leg[] = [
  { key: 'discover', label: 'Discover', stages: ['new', 'adopt'] },
  { key: 'design', label: 'Design', stages: ['design'] },
  { key: 'checks', label: 'Checks', stages: ['acceptance'], stop: 1 },
  { key: 'plan', label: 'Plan', stages: ['plan'] },
  { key: 'build', label: 'Build', stages: ['build'] },
  { key: 'release', label: 'Release', stages: ['release'], stop: 2 },
]
export const legIndex = (stage: string) => Math.max(0, LEGS.findIndex((l) => l.stages.includes(stage)))

/** Progress inside the current leg, when Ghostship can tell: interview areas, or tasks merged. */
export function legProgress(snap: BridgeSnap): { done: number; total: number } | null {
  if ((snap.stage === 'new' || snap.stage === 'adopt') && snap.interview?.total) return { done: snap.interview.closed, total: snap.interview.total }
  if (snap.stage === 'build' || snap.stage === 'plan' || snap.stage === 'release') {
    const live = snap.tasks.filter((t) => t.status !== 'DROPPED')
    if (live.length) return { done: live.filter((t) => t.status === 'MERGED').length, total: live.length }
  }
  return null
}

// ------------------------------------------------------------- bars and numbers
export function bar(fraction: number, width: number): { on: string; off: string } {
  const w = Math.max(1, Math.round(width))
  const n = Math.max(0, Math.min(w, Math.round(Math.max(0, Math.min(1, fraction)) * w)))
  return { on: '▰'.repeat(n), off: '▱'.repeat(w - n) }
}
/** The theme key a usage figure is drawn in: calm, then warning, then error. */
export const usageTone = (pct: number) => (pct >= 85 ? 'error' : pct >= 65 ? 'warning' : 'success')

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 45) return s < 5 ? 'now' : `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h${m % 60 ? String(m % 60).padStart(2, '0') : ''}` : `${Math.floor(h / 24)}d`
}
export function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`
}
export function untilText(iso: string | null | undefined, now: number): string {
  if (!iso) return ''
  const m = Math.max(0, Math.round((Date.parse(iso) - now) / 60000))
  return m >= 60 ? `↻${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}` : `↻${m}m`
}
export const short = (s: unknown, n = 48) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t }
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const CIRCLED = ['⓪', '①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨']
export const circled = (n: number) => (n >= 0 && n < CIRCLED.length ? CIRCLED[n]! : `(${n})`)

// ------------------------------------------------------------- glyphs
export type Mark = { glyph: string; color?: string; dim?: boolean; label: string }
export function taskMark(t: BridgeTaskRow, merged: Set<string>): Mark {
  switch (t.status) {
    case 'MERGED': return { glyph: '✓', color: 'success', label: 'merged' }
    case 'PASSED': return { glyph: '✓', color: 'merged', label: 'passed, merging' }
    case 'JUDGING': return { glyph: '⚖', color: 'suggestion', label: 'with the judge' }
    case 'BUILDING': return { glyph: '◐', color: 'claude', label: 'building' }
    case 'RETRY': return { glyph: '↻', color: 'warning', label: 'retrying' }
    case 'NEEDS_DECISION': return { glyph: '⚠', color: 'warning', label: 'needs your decision' }
    case 'DROPPED': return { glyph: '✗', dim: true, label: 'dropped' }
    case 'PARKED': return { glyph: '⏸', color: 'warning', label: 'parked — at STOP 2' }
    default: return t.blockedBy.some((b) => !merged.has(b))
      ? { glyph: '⧗', dim: true, label: `waits for ${t.blockedBy.filter((b) => !merged.has(b)).join(', ')}` }
      : { glyph: '○', dim: true, label: 'ready' }
  }
}
export function askMark(a: BridgeAsk): Mark {
  if (a.gate === 'prd' || a.gate === 'acceptance' || a.gate === 'release') return { glyph: '◆', color: 'claude', label: 'approval' }
  if (a.gate) return { glyph: '◆', color: 'warning', label: 'decision' }
  if (a.kind === 'choose') return { glyph: '◇', color: 'suggestion', label: 'choice' }
  if (a.kind === 'answer') return { glyph: '✎', color: 'suggestion', label: 'answer' }
  return { glyph: '☐', color: 'warning', label: 'to do' }
}
export const attemptDots = (used: number, max: number) => (max > 0 && max <= 6 ? '●'.repeat(Math.min(used, max)) + '○'.repeat(Math.max(0, max - used)) : `${used}/${max}`)

// ------------------------------------------------------------- options that run a gs command
export type GateRun = { args: string[]; verb: string; warn: string }
/**
 * What pressing option `i` (0-based) of a Ghostship ask does in the CLI. `null` means the option is only words
 * for Claude ("Change them first"), so it goes back as an answer like any other.
 */
export function gateRun(a: BridgeAsk, i: number): GateRun | null {
  switch (a.gate) {
    case 'prd': return i === 0 ? { args: ['prd', 'approve'], verb: 'Approve the PRD', warn: 'It locks. Later changes go through /ghostship change.' } : null
    case 'acceptance': return i === 0 ? { args: ['acceptance', 'approve'], verb: 'Approve the acceptance checks (STOP 1)', warn: 'They lock, and so do their tests once proven to fail.' } : null
    case 'release': return i === 0 ? { args: ['release', 'approve'], verb: 'Ship this release (STOP 2)', warn: 'Ghostship tags and merges it to main.' } : null
    case 'go': return i === 0 ? { args: ['go'], verb: 'Resume work', warn: 'New work starts again.' } : null
    case 'decide':
      if (!a.task) return null
      return i === 0 ? { args: ['decide', a.task, '--grant', '1'], verb: `Give ${a.task} one more attempt`, warn: 'The builder tries again.' }
        : i === 1 ? { args: ['decide', a.task, '--drop'], verb: `Drop ${a.task}`, warn: 'The task leaves the plan.' } : null
    default: return null
  }
}
export const gsCommand = (args: string[]) => `node .ghostship/core/runtime/gs.mjs ${args.join(' ')}`

// Files that hold secrets. A key or certificate under a test fixtures folder is test data, not a secret.
const SECRET_PATH = /(^|\/)(\.env(\.(?!example|sample|template)[\w.-]+)?|[^/]+\.(pem|key|p12|pfx)|id_(rsa|ed25519|ecdsa)|\.ghostship\/secrets|\.ghostship\/bridge\.key)$/i
const FIXTURE_KEY = /(^|\/)(tests?|fixtures?|__fixtures__|testdata|spec)\/(.+\/)?[^/]+\.(pem|key|p12|pfx)$/i
export const isSecretPath = (p: string) => SECRET_PATH.test(p) && !FIXTURE_KEY.test(p)

// The same test the CLI applies, so a secret is caught before it leaves the pane.
export const SECRETISH = /(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|gh[ousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY|xox[abprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.|\b[A-Za-z0-9_\-+/]{40,}\b)/

/** "↳ Answer to #3: …" typed or pasted in the prompt box is the answer to ask #3. */
export const ANSWER_PREFIX = (id: string) => `↳ Answer to #${id}: `
export function answerIn(text: string): { id: string; answer: string } | null {
  const m = /^↳ Answer to #([\w-]+):\s?([\s\S]*)$/.exec(text)
  return m ? { id: m[1]!, answer: m[2]!.trim() } : null
}

/** The title an agent gave `gs ask --title "…"`, for the transcript row. */
export function askTitleIn(cmd: string): string | null {
  if (!/gs\.mjs\s+ask\s+(?!answer\b|withdraw\b)/.test(cmd)) return null
  const m = /--title[ =](?:"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+))/.exec(cmd)
  return m ? (m[1] ?? m[2] ?? m[3] ?? '').replace(/\\"/g, '"') : null
}

// ------------------------------------------------------------- step line: what each agent is doing, in words
// The wording follows the idea of tzafrir/whats-agent-doing (MIT): say in plain words what each agent is doing.
const base = (p: unknown) => String(p || '').replace(/\\/g, '/').split('/').filter(Boolean).pop() || 'a file'
export function stepOf(ev: any): string {
  const tool = String(ev.tool || '')
  switch (tool) {
    case 'Bash': case 'PowerShell': {
      const cmd = String(ev.command || '')
      const g = cmd.match(/gs\.mjs\s+([a-z-]+)(?:\s+([a-z-]+))?(?:\s+(T\d+|[\w.-]+))?/)
      if (g) return `Ghostship: ${[g[1], g[2], g[3]].filter(Boolean).join(' ')}`
      return ev.description ? short(ev.description) : `Running ${short(cmd, 40)}`
    }
    case 'Read': return `Reading ${base(ev.file_path)}`
    case 'Edit': case 'MultiEdit': return `Editing ${base(ev.file_path)}`
    case 'Write': return `Writing ${base(ev.file_path)}`
    case 'NotebookEdit': return `Editing ${base(ev.notebook_path)}`
    case 'Grep': return `Searching for ${short(ev.pattern, 30)}`
    case 'Glob': return `Finding ${short(ev.pattern, 30)}`
    case 'WebFetch': { try { return `Reading ${new URL(String(ev.url)).host}` } catch { return 'Reading a web page' } }
    case 'WebSearch': return `Searching the web: ${short(ev.query, 36)}`
    case 'Agent': case 'Task': return `Running an agent: ${short(ev.description || ev.subagent_type || 'subagent', 40)}`
    case 'TodoWrite': case 'TaskCreate': case 'TaskUpdate': return 'Updating the task list'
    default: return `Using ${tool.replace(/^mcp__/, '').replace(/__/g, ' ')}`
  }
}

/** The one line under the prompt: where the voyage is, what is being built, and what waits for the owner. */
export function statusLine(snap: BridgeSnap, waiting: number, runBlocked: boolean): string {
  const leg = LEGS[legIndex(snap.stage)]!
  const prog = legProgress(snap)
  const bits = [`⛴ ${snap.project}`, `◉ ${leg.label}${prog ? ` ${prog.done}/${prog.total}` : ''}`]
  if (snap.paused) bits.push('⏸ paused')
  if (snap.active) bits.push(`${snap.active.id} ${snap.active.status === 'JUDGING' ? '⚖' : '◐'} ${snap.active.attempt}/${snap.active.max}`)
  if (snap.asks.length) bits.push(`☐ ${snap.asks.length} for you · /gs-bridge`)
  else if (waiting) bits.push(`✉ ${waiting} not sent yet`)
  else if (runBlocked) bits.push('⚠ an agent tab needs you')
  return bits.join(' · ')
}

// ------------------------------------------------------------- roadmap: every stage, and the plan's phases inside Build
/** A square turning round while work runs; one frame each half second. */
export const SPIN = ['◰', '◳', '◲', '◱']
export const spinAt = (now: number) => SPIN[Math.floor(now / 500) % SPIN.length]!

export type PhaseRow = { key: string; label: string; done: number; parked: number; total: number; current: BridgeTaskRow | null; state: 'done' | 'now' | 'next' }
/** The plan's phases in order ("1-live-mvp" → "1 · live mvp"), each with its tasks merged and the task in hand. */
export function phasesOf(tasks: BridgeTaskRow[]): PhaseRow[] {
  const order: string[] = []
  const by: Record<string, BridgeTaskRow[]> = {}
  for (const t of tasks) {
    if (t.status === 'DROPPED') continue
    const k = t.phase || 'tasks'
    if (!by[k]) { by[k] = []; order.push(k) }
    by[k]!.push(t)
  }
  order.sort((a, b) => (parseInt(a, 10) || 999) - (parseInt(b, 10) || 999) || a.localeCompare(b))
  const rows = order.map((k) => {
    const list = by[k]!
    const done = list.filter((t) => t.status === 'MERGED').length
    const parked = list.filter((t) => t.status === 'PARKED').length
    const current = list.find((t) => ['BUILDING', 'RETRY', 'JUDGING', 'PASSED', 'NEEDS_DECISION'].includes(t.status)) || null
    const m = /^(\d+)[-_ ]?(.*)$/.exec(k)
    const label = m ? `${m[1]} · ${(m[2] || 'phase').replace(/[-_]+/g, ' ')}` : k.replace(/[-_]+/g, ' ')
    // A phase is finished once nothing in it can still be built: merged, or parked for STOP 2.
    return { key: k, label, done, parked, total: list.length, current, state: (done + parked === list.length ? 'done' : 'next') as PhaseRow['state'] }
  })
  // The phase being worked on: the one with a task in hand, else the first one not finished.
  const now = rows.find((r) => r.current && r.state !== 'done') ?? rows.find((r) => r.state !== 'done')
  if (now) now.state = 'now'
  return rows
}

/** What each stage of the voyage says about itself on the roadmap. */
export function legNote(key: string, snap: BridgeSnap, i: number, at: number): string {
  if (key === 'discover') return snap.interview?.total && i === at ? `interview ${snap.interview.closed}/${snap.interview.total}` : i < at ? 'interview done · PRD approved' : 'interview, then the PRD'
  if (key === 'design') return i < at ? 'blueprint written' : 'blueprint and decisions'
  if (key === 'checks') return i < at ? 'STOP 1 approved' : 'STOP 1: you approve the checks'
  if (key === 'plan') return i < at || snap.tasks.length ? `${plural(snap.tasks.filter((t) => t.status !== 'DROPPED').length, 'task')}` : 'tasks from the checks'
  if (key === 'build') { const p = legProgress(snap); return p && i >= at ? `${p.done}/${p.total} merged` : 'test-first, judged, merged' }
  return i < at ? 'shipped' : 'STOP 2: you approve the release'
}

// ------------------------------------------------------------- autonomy: the mode chip and the command that changes it
export const MODES: Array<{ mode: Autonomy['mode']; label: string; what: string }> = [
  { mode: 'guided', label: 'Guided', what: 'asks you at every gate' },
  { mode: 'autopilot', label: 'Autopilot', what: 'after the PRD, only STOP 1 and STOP 2' },
  { mode: 'full', label: 'Full auto', what: 'after the PRD, only STOP 2' },
]
export const modeLook = (mode: string | undefined) => (mode === 'full' ? { label: 'full auto', color: 'claude' } : mode === 'guided' ? { label: 'guided', color: undefined } : { label: 'autopilot', color: 'success' })
export const autonomyArgs = (mode: string, nightShift?: boolean) => ['autonomy', mode, ...(nightShift === undefined ? [] : ['--night-shift', nightShift ? 'on' : 'off'])]

/** ✓ done · ✗ failed · ⊘ denied · ■ interrupted · › the prompt (tzafrir/whats-agent-doing, MIT). */
export function stepMark(e: StepEntry): Mark {
  if (e.kind === 'turn') return { glyph: '›', dim: true, label: 'prompt' }
  if (e.outcome === 'error') return { glyph: '✗', color: 'error', label: 'failed' }
  if (e.outcome === 'denied') return { glyph: '⊘', color: 'warning', label: 'denied' }
  if (e.outcome === 'interrupted') return { glyph: '■', color: 'warning', label: 'interrupted' }
  return { glyph: '✓', color: 'success', label: 'done' }
}
/** 0.6s · 12s · 1m 48s */
export function dur(ms: number | null): string {
  if (ms === null || ms < 0) return ''
  if (ms < 10000) return `${(ms / 1000).toFixed(1)}s`
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}
