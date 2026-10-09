// Ghostship Bridge: the project's live status inside Claude Code. Inert outside a Ghostship project, save /gs-bridge,
// which offers to set the folder up.
// pane (queue · tasks · crew · log · menu) · band · footer button · alerts + ping · owner queue · approvals from the pane
// step line · plan limits · keeper (handoff → /clear → resume) · riskhold · heartbeat + logbook
// The owner queue's shape follows tzafrir/human-in-the-loop (MIT); the step line's wording, tzafrir/whats-agent-doing (MIT);
// the bars and footer button, nvr0x5/claude-deck (MIT).
import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { BridgeActivity, BridgeAlert, BridgeAsk, BridgeSnap, BridgeUi, Editing, KeeperPhase, Step, View } from '../types'
import { ANSWER_PREFIX, SECRETISH, answerIn, autonomyArgs, modeLook, askTitleIn, gateRun, gsCommand, isSecretPath, short, statusLine, stepOf } from './text'
import { askedRow, bandTree, paneTree } from './view'
import type { Actions } from './view'

const PANE = 'ghostship-bridge'
const PANE_TITLE = '⛴ Ghostship'
const POLL_MS = 20000
const BATCH_MS = 800
const snapAtom = atom({ plugin: 'ghostship-bridge', key: 'snap' } as const, null)
const keeperAtom = atom({ plugin: 'ghostship-bridge', key: 'keeper' } as const, 'idle')
const activityAtom = atom({ plugin: 'ghostship-bridge', key: 'activity' } as const, { main: null, subs: {} })
const UI0: BridgeUi = { view: 'roadmap', selected: null, editing: null, confirm: null, flash: null, busy: false, waiting: [] }
const uiAtom = atom({ plugin: 'ghostship-bridge', key: 'ui' } as const, UI0)
const historyAtom = atom({ plugin: 'ghostship-bridge', key: 'history' } as const, [])
const initAtom = atom({ plugin: 'ghostship-bridge', key: 'initialised' } as const, false)

// Riskhold: secrets are never read; a few commands are never run from a Ghostship session.
const SECRET_IN_CMD = /(^|[\s'"=/])(\.env(\.(?!example|sample|template)[\w.-]+)?|[\w.-]+\.(pem|key|p12|pfx)|id_(rsa|ed25519|ecdsa)|\.ghostship\/secrets)(?=$|[\s'";|&)])/i
const RISKY: Array<[RegExp, string]> = [
  [/\bgit\s+push\b[^;&|]*\s(--force\b|-f\b|--force-with-lease\b)/, 'force-pushing rewrites shared history'],
  [/\brm\s+-[a-z]*r[a-z]*f?[a-z]*\s+(\/|~|\$HOME)(\s|$|\/\s|\/\*)/i, 'deleting from the filesystem root or home'],
  [/\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z)?sh\b/, 'piping a download into a shell'],
  [/\bsudo\b/, 'running as root'],
  [/\bchmod\s+-R\s+777\b/, 'making everything world-writable'],
  [/\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f)/, 'discarding work Ghostship tracks (it uses revert instead)'],
  [/bridge\.key\b|--owner-key-stdin\b/, 'the Bridge owner key is the owner\'s alone; approvals from the Bridge are pressed in the pane'],
]

// Module state: rebuilt on a reload; values drawings read live in atoms.
let root = ''
let active = false
let activating: Promise<boolean> | null = null
let cursor = 0
let startedAt = 0
let tools = 0
let askedAt = 0
let turnsSinceAsk = 0
let limits = { soft: 150000, hard: 200000 }
let keeperMode = 'auto'
let seenAsks: Set<string> | null = null
let batch: { cancel: () => void } | null = null
let ticker: { cancel: () => void } | null = null
const drafts: Record<string, string> = {}
/** The last autopilot failure already announced (its lastStepAt), so a failure pings once. */
let failedAt: string | null = null
/** Things done from the pane that Claude must hear (an approval pressed here), sent with the next delivery. */
const notes: string[] = []

async function gs($: any, args: string[], opts: { timeoutMs?: number; stdin?: string } = {}) {
  try {
    return await $.process.run(['node', `${root}/.ghostship/core/runtime/gs.mjs`, ...args], { cwd: root, timeoutMs: opts.timeoutMs ?? 20000, ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}) })
  } catch (err) {
    return { exitCode: 1, stdout: '', stderr: String(err) }
  }
}
const firstLine = (r: any, dflt: string) => String(r.stderr || r.stdout || dflt).split('\n').find((l: string) => l.trim())?.replace(/^.*?✗\s*[A-Z_]+:\s*/, '').replace(/^Error:\s*/, '') || dflt

// Step history (tzafrir/whats-agent-doing, MIT): the prompt, each tool call with its outcome and time, the turn's end.
const outcomeOf = (r: any) => (r?.deny !== undefined ? 'denied' : r?.isError ? 'error' : 'ok') as 'ok' | 'error' | 'denied' | 'interrupted'
async function remember($: any, entry: any) { try { await update($, historyAtom, (list: any[]) => [...list, entry].slice(-60)) } catch { /* a nicety */ } }

async function setUi($: any, fn: (u: BridgeUi) => BridgeUi) { try { await update($, uiAtom, fn) } catch { /* drawing state only */ } }
async function flash($: any, text: string, tone: 'ok' | 'warn' | 'err' = 'ok') { const at = await $.clock.now(); await setUi($, (u) => ({ ...u, flash: { text, tone, at } })) }

// ------------------------------------------------------------- step line
async function setStep($: any, agentId: string | undefined, label: string, waiting = false) {
  try {
    const at = await $.clock.now()
    await update($, activityAtom, (a: BridgeActivity) => {
      const step: Step = { label, at, waiting }
      return agentId === undefined ? { ...a, main: step } : { ...a, subs: { ...a.subs, [agentId]: { ...step, name: a.subs[agentId]?.name || agentId.slice(0, 8) } } }
    })
    if (agentId !== undefined && !ticker) await syncTicker($)
  } catch { /* the step line is a nicety */ }
}
async function nameSub($: any, agentId: string, name: string) {
  try { await update($, activityAtom, (a: BridgeActivity) => ({ ...a, subs: { ...a.subs, [agentId]: { label: a.subs[agentId]?.label || 'starting', at: a.subs[agentId]?.at || 0, waiting: false, name } } })) } catch { /* nicety */ }
}
async function dropSub($: any, agentId: string) {
  try { await update($, activityAtom, (a: BridgeActivity) => { const subs = { ...a.subs }; delete subs[agentId]; return { ...a, subs } }) } catch { /* nicety */ }
  await syncTicker($)
}

// ------------------------------------------------------------- ping: sound + toast + the pane, for things that need the owner
async function ping($: any, text: string) {
  $.ui.toast(`⛴ ${text}`, { timeoutMs: 12000 })
  try { await $.audio.play({ asset: 'sounds/ping.wav' }) } catch { /* no player on this platform */ }
  await windowsChime($)
  try { await $.ui.open({ id: PANE, title: PANE_TITLE }) } catch { /* too narrow: the toast and band still show it */ }
}

// Claude Code plays clips only on macOS; on Windows and WSL ask Windows for its own chime.
async function windowsChime($: any) {
  try {
    const wsl = await $.env.get('WSL_DISTRO_NAME')
    const win = (await $.env.get('OS')) === 'Windows_NT'
    if (!wsl && !win) return
    void $.process.run([win ? 'powershell' : 'powershell.exe', '-NoProfile', '-NonInteractive', '-Command', '[System.Media.SystemSounds]::Exclamation.Play()'], { timeoutMs: 5000 }).catch(() => undefined)
  } catch { /* no chime: the toast and the pane still show it */ }
}

// ------------------------------------------------------------- reading the ship
async function refresh($: any, turn?: { seconds: number; tools: number }) {
  try { return await refreshNow($, turn) } catch { return null }
}

async function refreshNow($: any, turn?: { seconds: number; tools: number }) {
  if (!active) return null
  const u = await $.session.usage()
  const data = JSON.stringify({ usage: { context: u.context, cost: u.cost, rateLimits: u.rateLimits }, sessionId: await $.session.id(), source: 'mod', ...(turn ? { turn } : {}) })
  const r = await gs($, ['bridge', 'tick', '--since', String(cursor), '--data', data])
  if (r.exitCode !== 0) return null
  let t: any
  try { t = JSON.parse(r.stdout) } catch { return null }
  if (!t.active) return null
  cursor = t.cursor ?? cursor
  if (t.limits) limits = t.limits
  if (t.keeper) keeperMode = t.keeper
  const s = t.status || {}
  const fresh: BridgeAlert[] = (t.alerts || []).map((a: any) => ({ at: a.at, level: a.level, alert: a.alert }))
  const asks: BridgeAsk[] = (t.asks || []).map((a: any) => ({
    id: String(a.id), kind: a.kind, title: a.title, why: a.why || '', doneWhen: a.doneWhen || '', options: a.options || [], source: a.source,
    at: a.at ?? null, gate: a.gate ?? null, task: a.task ?? null, command: a.command ?? null,
  }))
  const firstReading = seenAsks === null
  const newAsks = asks.filter(a => !seenAsks?.has(a.id))
  seenAsks = new Set(asks.map(a => a.id))
  for (const a of fresh) if (a.level !== 'action') $.ui.toast(`⛴ ${a.alert}`, { timeoutMs: 6000 })
  const actions = fresh.filter(a => a.level === 'action')
  if (actions.length || (!firstReading && newAsks.length)) {
    if (!firstReading && newAsks.length) await setUi($, (ui) => ({ ...ui, view: 'queue', selected: newAsks[0]!.id }))
    await ping($, actions.length ? actions.map(a => a.alert).join(' · ') : `${newAsks.length === 1 ? newAsks[0]!.title : `${newAsks.length} new things for you`}`)
  }
  const prev = await read($, snapAtom)
  const snap: BridgeSnap = {
    project: t.project || 'ghostship', stage: s.stage || 'new', next: s.next || '', active: s.active || null, needsDecision: s.needsDecision || [],
    run: t.run || null, paused: !!t.paused, recent: [...(prev?.recent || []), ...fresh].filter((a, i, all) => all.findIndex((b) => b.at === a.at && b.alert === a.alert) === i).slice(-30), contextPercent: u.context?.percent ?? null, usd: u.cost?.usd ?? null,
    asks, claude: t.claude || null, agents: t.agents || [], author: t.author || '', tagline: t.tagline || '', tasks: t.tasks || [], interview: t.interview || null, approvals: t.approvals || s.approvals || 'terminal', version: t.version || null, spend: t.spend || null,
    autonomy: t.autonomy || null, parked: t.parked || [],
    autopilot: t.autopilot || null, nextStep: t.next && typeof t.next === 'object' && t.next.say ? t.next : null,
  }
  // The headless runner failed: an action alert once per failure (the step's time tells one failure from the next).
  if (snap.autopilot?.status === 'failed' && snap.autopilot.lastStepAt && snap.autopilot.lastStepAt !== failedAt) {
    failedAt = snap.autopilot.lastStepAt
    await ping($, `Autopilot stopped: ${snap.autopilot.last?.say || 'see the Crew tab'}`)
  }
  await update($, snapAtom, () => snap)
  // A selection, confirm or field for an ask that is gone (answered elsewhere, state moved on) closes.
  const ids = new Set(asks.map(a => a.id))
  await setUi($, (ui) => ({
    ...ui,
    selected: ui.selected && ids.has(ui.selected) ? ui.selected : (asks[0]?.id ?? null),
    confirm: ui.confirm && ids.has(ui.confirm.askId) ? ui.confirm : null,
    editing: ui.editing && (ui.editing.id === 'menu' || ids.has(ui.editing.id)) ? ui.editing : null,
  }))
  const waiting = (await read($, uiAtom)).waiting.length
  $.ui.status(statusLine(snap, waiting, !!t.run?.blocked))
  return t
}

// Turns the bridge on once the folder is a Ghostship project: at start, or later (after /ghostship init) on the next prompt
// or command. One activation at a time, and a failed first reading leaves it off, to try again.
function activate($: any): Promise<boolean> {
  if (active) return Promise.resolve(true)
  if (activating) return activating
  activating = (async () => {
    try {
      if (!root) root = await $.session.root()
      if (!(await $.fs.exists(`${root}/.ghostship/state/state.json`))) return false
      try {
        const t = JSON.parse((await gs($, ['bridge', 'tick'])).stdout)
        cursor = t.cursor ?? 0
        if (t.limits) limits = t.limits
      } catch { /* first tick below */ }
      active = true
      await update($, initAtom, () => true)
      await refresh($)
      $.clock.every(POLL_MS, () => { void refresh($) })
      return true
    } catch { active = false; return false } finally { activating = null }
  })()
  return activating
}

async function openPane($: any, focus = true) {
  try { await $.ui.open({ id: PANE, title: PANE_TITLE, ...(focus ? { focus: true } : {}) }) } catch { /* not seated: the band and status line still say it */ }
}

// ------------------------------------------------------------- owner queue: answer here, the answer reaches Claude as your words
async function answerAsk($: any, id: string, how: string[]): Promise<boolean> {
  const r = await gs($, ['ask', 'answer', id, ...how])
  if (r.exitCode !== 0) {
    const msg = firstLine(r, 'could not record the answer')
    $.ui.toast(`⛴ ${msg}`, { timeoutMs: 10000 })
    await flash($, msg, 'err')
    return false
  }
  for (const k of Object.keys(drafts)) if (k.endsWith(`:${id}`)) delete drafts[k]
  await setUi($, (u) => ({ ...u, editing: null, confirm: null, waiting: u.waiting.includes(id) ? u.waiting : [...u.waiting, id] }))
  await refresh($)
  const ui = await read($, uiAtom)
  if (ui.busy) await flash($, `Saved #${id}. Claude gets it when this turn ends (s: Send now).`, 'ok')
  else {
    await flash($, `Sent #${id} to Claude.`, 'ok')
    batch?.cancel()
    batch = $.clock.after(BATCH_MS, () => { void deliver($, 'prompt') })
  }
  return true
}

/** Sends every answer not yet sent, as one message in the owner's words: a prompt when Claude is idle, a row mid-turn. */
async function deliver($: any, how: 'prompt' | 'append') {
  batch?.cancel(); batch = null
  const d = await gs($, ['asks', 'deliver'])
  const answered = d.exitCode === 0 ? String(d.stdout || '').trim() : ''
  const done = notes.splice(0)
  const text = [answered || (done.length ? 'My responses to the Ghostship asks:' : ''), ...done].filter(Boolean).join('\n\n')
  await setUi($, (u) => ({ ...u, waiting: [] }))
  if (!text) return
  // A row joins a running turn; with no turn running nothing would read it until the next prompt, so idle means a prompt.
  if (how === 'append' && (await read($, uiAtom)).busy) {
    try {
      await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
      await flash($, 'Sent to Claude now; it reads it at its next step.', 'ok')
      return
    } catch { /* no running turn to join: a prompt of its own */ }
  }
  void $.prompt.submit({ text, asUser: true }).catch(() => $.ui.toast('⛴ Answer saved; it goes with your next message.', { timeoutMs: 8000 }))
}

/** The owner key a press carries to the CLI, read from ~/.ghostship/bridge.key; never shown, logged or put on a command line. */
async function ownerKey($: any): Promise<string | null> {
  try {
    const home = (await $.env.get('GHOSTSHIP_HOME')) || (await $.env.get('HOME')) || (await $.env.get('USERPROFILE'))
    if (!home) return null
    const k = String(await $.fs.read(`${home}/.ghostship/bridge.key`)).trim()
    return k.length >= 32 ? k : null
  } catch { return null }
}

async function applyGate($: any, ask: BridgeAsk, option: number) {
  const run = gateRun(ask, option)
  const snap = await read($, snapAtom)
  if (!run || !snap) return
  if (snap.approvals === 'chat') { await answerAsk($, ask.id, ['--option', String(option + 1)]); return }
  const key = await ownerKey($)
  if (!key) { await flash($, 'No owner key at ~/.ghostship/bridge.key. Run node install.mjs again to create it.', 'err'); return }
  const r = await gs($, [...run.args, '--owner-key-stdin'], { stdin: key, timeoutMs: 120000 })
  await setUi($, (u) => ({ ...u, confirm: null }))
  if (r.exitCode !== 0) { await flash($, firstLine(r, `${run.verb} failed`), 'err'); return }
  // The derived ask is gone now that the state moved on, so Claude hears it as a note in the owner's words.
  notes.push(`${ask.title}: I chose "${ask.options[option]}". I already did it from the Bridge (${gsCommand(run.args)}); carry on from there.`)
  await refresh($)
  if ((await read($, uiAtom)).busy) { await setUi($, (u) => ({ ...u, waiting: [...u.waiting, ask.id] })); await flash($, `${run.verb}: done. Claude hears it when this turn ends.`, 'ok') }
  else { await flash($, `${run.verb}: done. Claude carries on from there.`, 'ok'); await deliver($, 'prompt') }
}

/** The owner changes how much Ghostship asks them. Like an approval: the press carries the owner key on stdin. */
async function setMode($: any, mode: string, nightShift?: boolean) {
  const snap = await read($, snapAtom)
  const args = autonomyArgs(mode, nightShift)
  if (!snap || snap.approvals !== 'bridge') {
    const cmd = gsCommand(args)
    try { await $.ui.copy({ text: cmd }); await flash($, `Copied: run it in your own terminal and type yes. ${cmd}`, 'ok') } catch { await flash($, `Run in your terminal: ${cmd}`, 'warn') }
    return
  }
  const key = await ownerKey($)
  if (!key) { await flash($, 'No owner key at ~/.ghostship/bridge.key. Run node install.mjs again to create it.', 'err'); return }
  const r = await gs($, [...args, '--owner-key-stdin'], { stdin: key })
  if (r.exitCode !== 0) { await flash($, firstLine(r, 'could not change the mode'), 'err'); return }
  await setUi($, (u) => ({ ...u, chooser: false }))
  await refresh($)
  const now = (await read($, snapAtom))?.autonomy
  await flash($, `Mode: ${modeLook(now?.mode ?? mode).label}${now?.nightShift ? ', night shift on' : ''}.`, 'ok')
}

async function runCommand($: any, name: string, args?: string) {
  const text = `/ghostship ${name}${args ? ` ${args}` : ''}`
  await setUi($, (u) => ({ ...u, editing: null }))
  try {
    await $.command.run({ command: 'ghostship', ...(args || name ? { args: [name, args].filter(Boolean).join(' ') } : {}) })
  } catch {
    void $.prompt.submit({ text, asUser: true }).catch(() => $.ui.toast(`⛴ Type ${text} in the prompt.`, { timeoutMs: 8000 }))
  }
  await flash($, (await read($, uiAtom)).busy ? `${text} goes as soon as this turn ends.` : `${text} sent.`, 'ok')
}

function clearAndResume($: any) {
  $.clock.after(800, () => {
    void (async () => {
      try {
        await $.command.run({ command: 'clear' })
        $.clock.after(1500, () => { void $.command.run({ command: 'ghostship', args: 'resume' }).catch(() => $.prompt.submit({ text: '/ghostship resume', asUser: true })) })
      } catch {
        $.ui.toast('⛴ Handoff written. Run /clear, then /ghostship resume.', { timeoutMs: 15000 })
      }
      await update($, keeperAtom, () => 'idle' as KeeperPhase)
    })()
  })
}

async function setBusy($: any, busy: boolean) {
  await setUi($, (u) => (u.busy === busy ? u : { ...u, busy }))
  // While Claude works the roadmap's square turns and the timers tick (twice a second); idle, nothing redraws.
  await syncTicker($)
}

/** Redraw twice a second while Claude or any of its agents works; nothing redraws when all is quiet. */
async function syncTicker($: any) {
  let agents = 0
  try { agents = Object.keys((await read($, activityAtom)).subs || {}).length } catch { /* none */ }
  const run = (await read($, uiAtom)).busy || agents > 0
  if (run && !ticker) ticker = $.clock.every(500, () => { try { $.ui.invalidate('ui.render') } catch { /* nicety */ } })
  if (!run && ticker) { ticker.cancel(); ticker = null }
}

function actionsFor($: any): Actions {
  return {
    setView: (view: View) => { void setUi($, (u) => ({ ...u, view, confirm: null, chooser: false, editing: u.editing?.id === 'menu' && view !== 'menu' ? null : u.editing })) },
    select: (id) => { void setUi($, (u) => ({ ...u, selected: id, confirm: null, editing: null })) },
    move: (delta) => {
      void (async () => {
        const asks = (await read($, snapAtom))?.asks || []
        if (!asks.length) return
        await setUi($, (u) => {
          const i = Math.max(0, asks.findIndex((a) => a.id === u.selected))
          const next = asks[(i + delta + asks.length) % asks.length]!
          return { ...u, selected: next.id, confirm: null, editing: null }
        })
      })()
    },
    pick: (ask, i) => {
      void (async () => {
        if (gateRun(ask, i)) await setUi($, (u) => ({ ...u, confirm: { askId: ask.id, option: i } }))
        else await answerAsk($, ask.id, ['--option', String(i + 1)])
      })()
    },
    confirmYes: () => {
      void (async () => {
        const ui = await read($, uiAtom)
        const ask = (await read($, snapAtom))?.asks.find((a) => a.id === ui.confirm?.askId)
        if (ask && ui.confirm) await applyGate($, ask, ui.confirm.option)
      })()
    },
    confirmNo: () => { void setUi($, (u) => ({ ...u, confirm: null })) },
    copy: (text, surface) => {
      void (async () => {
        try { await $.ui.copy({ text, ...(surface ? { surface } : {}) }); await flash($, 'Copied. Paste it in your own terminal.', 'ok') } catch { await flash($, `Copy failed. The command: ${text}`, 'warn') }
      })()
    },
    done: (ask) => { void answerAsk($, ask.id, ['--done']) },
    startEdit: (id, field) => { void setUi($, (u) => ({ ...u, editing: { id, field }, confirm: null })) },
    stopEdit: () => { void setUi($, (u) => ({ ...u, editing: null })) },
    draft: (k, v) => { drafts[k] = v },
    submitEdit: (id, field, value) => {
      void (async () => {
        const v = String(value ?? '').trim()
        if (field === 'add' || field === 'change' || field === 'solve') {
          if (!v) { await flash($, 'Say a few words first.', 'warn'); return }
          delete drafts[`${field}:${id}`]
          await runCommand($, field, v)
          return
        }
        if (field === 'reason') { await answerAsk($, id, ['--reject', v || 'declined from the bridge']); return }
        if (!v) { await flash($, 'Type your answer first, or press Cancel.', 'warn'); return }
        if (SECRETISH.test(v)) { delete drafts[`answer:${id}`]; await setUi($, (u) => ({ ...u, editing: { id, field: 'answer', held: '' } })); return }
        await answerAsk($, id, ['--text', v])
      })()
    },
    longAnswer: (id) => {
      void (async () => {
        await setUi($, (u) => ({ ...u, editing: null }))
        try { await $.prompt.fill({ text: ANSWER_PREFIX(id), mode: 'replace' }) } catch { /* no box */ }
        await flash($, `Paste or type your answer after "${ANSWER_PREFIX(id).trim()}" in the prompt, then Enter.`, 'ok')
      })()
    },
    sendNow: () => { void deliver($, 'append') },
    command: (name, args) => { void runCommand($, name, args) },
    pause: () => { void gs($, ['pause', '--reason', 'paused from the bridge']).then(() => refresh($)).then(() => flash($, 'Paused: running work finishes, nothing new starts.', 'ok')) },
    resume: () => {
      void (async () => {
        const ask = (await read($, snapAtom))?.asks.find((a) => a.gate === 'go')
        if (ask) await setUi($, (u) => ({ ...u, view: 'queue', selected: ask.id, confirm: { askId: ask.id, option: 0 } }))
      })()
    },
    handoff: () => { void gs($, ['bridge', 'handoff', '--reason', 'requested by the owner']).then(() => { askedAt = 0; clearAndResume($) }) },
    refresh: () => { void refresh($).then((t) => flash($, t ? 'Up to date.' : 'Could not read the ship; is Ghostship set up here?', t ? 'ok' : 'warn')) },
    hide: () => { void $.ui.close({ id: PANE }).catch(() => undefined) },
    chooser: (open) => { void setUi($, (u) => ({ ...u, chooser: open, editing: null })) },
    autopilot: (what) => {
      void (async () => {
        const r = await gs($, ['autopilot', what], { timeoutMs: 30000 })
        await refresh($)
        await flash($, firstLine(r, what === 'start' ? 'Autopilot started.' : 'Autopilot stopped.'), r.exitCode === 0 ? 'ok' : 'err')
      })()
    },
    setMode: (mode, nightShift) => { void setMode($, mode, nightShift) },
  }
}

export const register: Register = on => {
  // ------------------------------------------------------------- heartbeat
  on('session.start', async ($, e, next) => {
    const out = await next(e)
    root = await $.session.root()
    // Always offered, so /gs-bridge exists even before /ghostship init; it activates itself once the project is set up.
    await $.command.register({ name: 'gs-bridge', description: 'Ghostship: open the bridge (your queue, tasks, crew, log, menu)' })
    await $.command.register({ name: 'gs-pause', description: 'Ghostship: pause — running work finishes, nothing new starts' })
    await $.command.register({ name: 'gs-handoff', description: 'Ghostship: write the handoff note now, then /clear and resume' })
    await activate($)
    return out
  })

  // ------------------------------------------------------------- logbook + keeper + step line; long answers typed in the prompt
  on('prompt.submit', async ($, e, next) => {
    if (!active) await activate($)
    const ev: any = e
    const mine = ev.origin?.kind === 'plugin' && ev.origin?.name === 'ghostship-bridge'
    if (active && !mine && typeof ev.text === 'string') {
      const given = answerIn(ev.text)
      if (given) {
        const ask = (await read($, snapAtom))?.asks.find((a) => a.id === given.id)
        if (ask && given.answer && SECRETISH.test(given.answer)) return { drop: `That looks like a secret, so it wasn't sent. Put it in ~/.ghostship/secrets (or .env), then mark #${ask.id} Done.` }
        if (ask && ask.kind === 'choose') {
          const n = /^\d$/.test(given.answer) ? Number(given.answer) : ask.options.findIndex((o) => o.toLowerCase() === given.answer.toLowerCase()) + 1
          if (n < 1 || n > ask.options.length) return { drop: `Pick one of: ${ask.options.map((o, i) => `${i + 1}) ${o}`).join('  ')}. Or press its key in /gs-bridge.` }
          if (gateRun(ask, n - 1)) return { drop: `"${ask.options[n - 1]}" runs a Ghostship command. Press it in /gs-bridge, or run it in your own terminal.` }
        }
        if (ask && given.answer) {
          const how = ask.kind === 'choose' ? ['--option', String(/^\d$/.test(given.answer) ? Number(given.answer) : ask.options.findIndex((o) => o.toLowerCase() === given.answer.toLowerCase()) + 1)]
            : ask.kind === 'do' ? (/^(done|did it|yes|ok)\.?$/i.test(given.answer) ? ['--done'] : ['--reject', given.answer])
            : ['--text', given.answer]
          const r = await gs($, ['ask', 'answer', ask.id, ...how])
          if (r.exitCode === 0) {
            const d = await gs($, ['asks', 'deliver'])
            await setUi($, (u) => ({ ...u, waiting: [] }))
            void refresh($)
            const text = String(d.stdout || '').trim()
            if (text) { startedAt = await $.clock.now(); tools = 0; await setBusy($, true); return next({ ...e, text } as any) }
          }
        }
      }
    }
    startedAt = await $.clock.now()
    tools = 0
    if (active) { await setBusy($, true); await setStep($, undefined, 'Thinking'); await remember($, { kind: 'turn', label: short(String((e as any).text || 'prompt'), 60), durationMs: null, outcome: 'ok', at: startedAt }) }
    return next(e)
  })

  on('classic.PermissionRequest', async ($, e, next) => {
    if (active) {
      const ev: any = e
      await setStep($, ev.agent_id, `Waiting for your approval: ${ev.tool_name}`, true)
    }
    return next(e)
  })

  on('classic.SubagentStop', async ($, e, next) => {
    if (active && (e as any).agent_id) await dropSub($, String((e as any).agent_id))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const out = await next(e)
    if (!active && (e as any).agentId === undefined) await activate($)
    if (!active) return out
    if ((e as any).agentId !== undefined) { await dropSub($, String((e as any).agentId)); return out }
    await setBusy($, false)
    await remember($, { kind: 'end', label: `Done in ${Math.round(((await $.clock.now()) - startedAt) / 1000)}s, ${tools} action${tools === 1 ? '' : 's'}`, durationMs: (await $.clock.now()) - startedAt, outcome: 'ok', at: startedAt })
    try { await update($, activityAtom, (a: BridgeActivity) => ({ ...a, main: null })) } catch { /* nicety */ }
    // Answers given while Claude worked go now, together, as the owner's words.
    if ((await read($, uiAtom)).waiting.length) await deliver($, 'prompt')
    const seconds = Math.round(((await $.clock.now()) - startedAt) / 1000)
    const t = await refresh($, { seconds, tools })
    const tokens = (await $.session.usage()).context?.tokens ?? 0
    const phase = await read($, keeperAtom)
    if (phase === 'idle' && tokens >= limits.soft) {
      askedAt = await $.clock.now()
      turnsSinceAsk = 0
      await update($, keeperAtom, () => 'asked' as KeeperPhase)
      $.ui.toast(`⛴ Context at ${Math.round(tokens / 1000)}k: handing off at the next safe point`, { timeoutMs: 10000 })
      await $.session.append({ message: { type: 'user', content: [{ type: 'text', text:
        `[Ghostship keeper] The context window holds ${tokens} tokens (soft limit ${limits.soft}; context degrades past ~${Math.round(limits.hard / 1000)}k, so it clears before then). Keep going until the current task merges — a task boundary is the safe point, since the next task starts fresh from disk and little carries over. Do not clear mid-task or while waiting on a subagent or an outside run. At that boundary run \`node .ghostship/core/runtime/gs.mjs bridge handoff --note "<what you were doing and the exact next step>"\` and end your turn; the keeper clears and resumes. If context is critical it will clear on its own.` }] } })
      return out
    }
    if (phase === 'asked') {
      turnsSinceAsk += 1
      const written = t?.handoff && t.handoff.mtimeMs >= askedAt
      // A boundary = no task mid-build. Clearing there loses nothing (the next task reloads from disk); mid-task it would
      // drop the orchestrator's working memory of dependent work, so below the hard limit the keeper waits for the boundary.
      const activeTask = t?.status?.active
      const atBoundary = !activeTask || activeTask.status === 'PASSED'
      const critical = tokens >= limits.hard && turnsSinceAsk >= 2
      if (!written && critical) {
        await gs($, ['bridge', 'handoff', '--reason', 'hard context limit; written by the keeper'])
      }
      const now = written || critical || (atBoundary && tokens >= limits.soft && turnsSinceAsk >= 1)
      if (now) {
        if (keeperMode === 'ask') { $.ui.toast('⛴ Handoff ready. Run /clear, then /ghostship resume.', { timeoutMs: 15000 }); await update($, keeperAtom, () => 'idle' as KeeperPhase); return out }
        await update($, keeperAtom, () => 'clearing' as KeeperPhase)
        clearAndResume($)
      }
    }
    return out
  })

  // ------------------------------------------------------------- riskhold (+ the step line, from the same call)
  on('tool.call', async ($, e, next) => {
    tools += 1
    if (!active) return next(e)
    const ev: any = e
    const tool = String(ev.tool)
    if (['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) {
      const p = String(ev.file_path || ev.notebook_path || '').replace(/\\/g, '/')
      if (isSecretPath(p)) return { deny: `Ghostship riskhold: ${p} holds secrets. Agents never read or write it; ask the owner for the value's name instead.` }
    }
    if (tool === 'Grep') {
      const p = String(ev.path || '').replace(/\\/g, '/')
      if (isSecretPath(p) || /(^|[/{,])\.env\b|\.ghostship\/(secrets|bridge\.key)/i.test(String(ev.glob || ''))) return { deny: 'Ghostship riskhold: that search reaches a secrets file. Agents never read secrets.' }
    }
    if (tool === 'Bash' || tool === 'PowerShell') {
      const cmd = String(ev.command || '')
      if (SECRET_IN_CMD.test(cmd)) return { deny: 'Ghostship riskhold: that command touches a secrets file. Agents never read secrets.' }
      for (const [re, why] of RISKY) if (re.test(cmd)) return { deny: `Ghostship riskhold: refused — ${why}. If the owner wants it, they run it themselves.` }
    }
    await setStep($, ev.agentId, stepOf(ev))
    const label = stepOf(ev)
    const startedStep = await $.clock.now()
    if ((tool === 'Agent' || tool === 'Task') && ev.agentId === undefined) {
      const res: any = await next(e)
      const id = res?.result?.agentId ?? res?.agentId
      if (id) await nameSub($, String(id), short(ev.description || ev.subagent_type || 'subagent', 44))
      if (ev.agentId === undefined) await remember($, { kind: 'tool', label, durationMs: (await $.clock.now()) - startedStep, outcome: outcomeOf(res), at: startedStep })
      return res
    }
    const res: any = await next(e)
    if (ev.agentId === undefined) await remember($, { kind: 'tool', label, durationMs: (await $.clock.now()) - startedStep, outcome: outcomeOf(res), at: startedStep })
    // An agent just filed an ask: read the queue now rather than at the next poll, so the ping comes at once.
    if ((tool === 'Bash' || tool === 'PowerShell') && askTitleIn(String(ev.command || ''))) void refresh($)
    return res
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'Ghostship riskhold could not check this call, so it is refused.' }))

  // ------------------------------------------------------------- commands
  on('command.run', { command: 'gs-bridge' }, async $ => {
    if (await activate($)) await refresh($)
    await openPane($, true)
    return { text: active ? 'Bridge open.' : 'Not a Ghostship project yet. The Bridge offers to run /ghostship init in this folder.' }
  })

  on('command.run', { command: 'gs-pause' }, async $ => {
    if (!(await activate($))) return { text: 'Not a Ghostship project yet. Run /ghostship init in this folder first.' }
    await gs($, ['pause', '--reason', 'paused from the bridge'])
    await refresh($)
    return { text: 'Paused: running work finishes, nothing new starts. Resume from the bridge queue, or `gs go` in a terminal.' }
  })

  on('command.run', { command: 'gs-handoff' }, async $ => {
    if (!(await activate($))) return { text: 'Not a Ghostship project yet. Run /ghostship init in this folder first.' }
    await gs($, ['bridge', 'handoff', '--reason', 'requested by the owner'])
    askedAt = 0
    await update($, keeperAtom, () => 'clearing' as KeeperPhase)
    clearAndResume($)
    return { text: 'Handoff written. Clearing and resuming.' }
  })

  // ------------------------------------------------------------- band
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const props: any = e.props
    if (active && typeof props.isWorking === 'boolean' && props.isWorking !== (await read($, uiAtom)).busy) $.clock.after(0, () => { void setBusy($, props.isWorking) })
    const snap = await read($, snapAtom)
    if (!active || !snap || props.hasSurvey) return next(e)
    const act = await read($, activityAtom)
    const ui = await read($, uiAtom)
    return bandTree($.ui.resolve(e), snap, act, ui.busy, await $.clock.now(), () => { void openPane($, true) }, Number(props.bodyColumns) || Number((e as any).viewport?.columns) || 100)
  })

  // ------------------------------------------------------------- footer: one button that opens the bridge
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const below = await next(e)
    if (!active) return below
    const snap = await read($, snapAtom)
    const { Box, Button } = $.ui.resolve(e)
    const n = snap?.asks.length || 0
    return (
      <Box flexDirection="row" alignItems="center" columnGap={1}>
        <Button key="gs-footer" plain dimColor={!n} label={n ? `⛴ ${n} for you` : '⛴ Bridge'} onPress={() => { void openPane($, true) }} />
        {below}
      </Box>
    )
  })

  // ------------------------------------------------------------- the transcript row for an agent's ask
  on('ui.render', { component: 'ToolUse', props: { tool: 'Bash' } }, ($, e, next) => {
    const p: any = e.props
    const title = active && !p.isErrored && !p.isInterrupted ? askTitleIn(String(p.input?.command || '')) : null
    return title ? askedRow($.ui.resolve(e), title) : next(e)
  })

  // ------------------------------------------------------------- bridge pane
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const el: any = $.ui.resolve(e)
    const props: any = e.props
    return paneTree(el, {
      snap: await read($, snapAtom),
      ui: await read($, uiAtom),
      act: await read($, activityAtom),
      now: await $.clock.now(),
      drafts,
      initialised: active || (await read($, initAtom)),
      history: await read($, historyAtom),
      focused: !!props.isFocused,
      cols: Number(props.bodyColumns) || 60,
      canType: 'Input' in el && !!el.Input,
    }, actionsFor($))
  })
}
