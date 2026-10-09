// The Bridge's drawings: the pane (queue, tasks, crew, log, menu), the band above the prompt, and the transcript row
// for an agent's ask. Pure: everything a press does goes through `Actions`, which register.tsx supplies.
import type { BridgeActivity, BridgeAsk, BridgeSnap, BridgeUi, Editing, View, StepEntry } from '../types'
import {
  LEGS, MODES, autonomyArgs, modeLook, ago, askMark, dur, legNote, phasesOf, spinAt, stepMark, attemptDots, bar, circled, clock, gateRun, gsCommand, legIndex, legProgress, plural, short, taskMark, untilText, usageTone,
} from './text'
import { deckBand, deckChips } from './deck'

export type Actions = {
  setView: (v: View) => void
  select: (id: string) => void
  move: (delta: number) => void
  pick: (ask: BridgeAsk, i: number) => void
  confirmYes: () => void
  confirmNo: () => void
  copy: (text: string, surface?: string) => void
  done: (ask: BridgeAsk) => void
  startEdit: (id: string, field: Editing['field']) => void
  stopEdit: () => void
  submitEdit: (id: string, field: Editing['field'], value: string) => void
  draft: (id: string, value: string) => void
  longAnswer: (id: string) => void
  sendNow: () => void
  command: (name: string, args?: string) => void
  pause: () => void
  resume: () => void
  handoff: () => void
  refresh: () => void
  hide: () => void
  chooser: (open: boolean) => void
  /** The headless runner: gs autopilot start | stop. */
  autopilot: (what: 'start' | 'stop') => void
  setMode: (mode: string, nightShift?: boolean) => void
}

/** What the owner reads as an ask's name: agents' asks keep their number, Ghostship's own (G-…) need none. */
const label = (ask: BridgeAsk) => (ask.id.startsWith('G-') ? ask.title : `#${ask.id} ${ask.title}`)

export type PaneData = {
  snap: BridgeSnap | null
  ui: BridgeUi
  act: BridgeActivity | null
  now: number
  drafts: Record<string, string>
  initialised: boolean
  focused: boolean
  cols: number
  canType: boolean
  history: StepEntry[]
}

const TABS: Array<{ view: View; key: string; label: string }> = [
  { view: 'roadmap', key: 'v', label: 'Roadmap' },
  { view: 'queue', key: 'q', label: 'Queue' },
  { view: 'tasks', key: 't', label: 'Tasks' },
  { view: 'crew', key: 'w', label: 'Crew' },
  { view: 'log', key: 'l', label: 'Log' },
  { view: 'menu', key: 'm', label: 'Menu' },
]
const FLASH_MS = 10000

// ===================================================================== pane
export function paneTree(el: any, d: PaneData, a: Actions) {
  const { Box, Text } = el
  if (!d.initialised) return welcome(el, d, a)
  const snap = d.snap
  if (!snap) return <Text dimColor>⛴ Reading the ship's log…</Text>
  const body = d.ui.view === 'roadmap' ? roadmapView(el, d)
    : d.ui.view === 'tasks' ? tasksView(el, d, a)
    : d.ui.view === 'crew' ? crewView(el, d, a)
    : d.ui.view === 'log' ? logView(el, d)
    : d.ui.view === 'menu' ? menuView(el, d, a)
    : queueView(el, d, a)
  return (
    <Box flexDirection="column">
      {masthead(el, d)}
      {header(el, d)}
      {voyage(el, snap, d.cols < 56, (d.ui.busy || Object.keys(d.act?.subs || {}).length > 0 || (snap.agents || []).length > 0) && !snap.paused ? spinAt(d.now) : null)}
      <Text key="next" dimColor wrap="wrap">{snap.paused ? '⏸ ' : '➜ '}{snap.nextStep?.say || snap.next}</Text>
      {tabs(el, d, a)}
      <Text key="rule" dimColor>{'─'.repeat(Math.max(10, Math.min(d.cols, 72)))}</Text>
      <Box key="body" flexDirection="column">{body}</Box>
      {flash(el, d)}
      {footer(el, d, a)}
    </Box>
  )
}

function welcome(el: any, d: PaneData, a: Actions) {
  const { Box, Text, Button } = el
  return (
    <Box flexDirection="column" rowGap={1}>
      <Box key="head" flexDirection="row" columnGap={1}>
        <Text color="claude" bold>⛴ Ghostship</Text>
        <Text dimColor>· the autonomous software factory</Text>
      </Box>
      <Text key="what" wrap="wrap">This folder isn't a Ghostship project yet. Set it up and Ghostship will interview you, design the product, get your OK on the acceptance checks (STOP 1), build every task test-first, and ask you before it ships (STOP 2).</Text>
      <Box key="go" flexDirection="column">
        <Button key="init" plain hotkey="1" autoFocus label="Set it up here  (/ghostship init)" onPress={() => a.command('init')} />
        <Button key="hide" plain dimColor hotkey="h" label="Not now" onPress={() => a.hide()} />
      </Box>
      <Text key="hint" dimColor>{d.focused ? 'Press 1 to start · Esc back to the prompt' : 'Click, or ctrl+x tab to use the keys'}</Text>
    </Box>
  )
}

/** The ship's masthead: wordmark, tagline and who built it. Shown once at the top of the pane. */
function masthead(el: any, d: PaneData) {
  const { Box, Text } = el
  const snap = d.snap!
  const tagline = snap.tagline || 'the autonomous software factory'
  return (
    <Box key="masthead" flexDirection="column" marginBottom={1}>
      <Box flexDirection="row">
        <Text color="claude" bold>╔═ ⛴ GHOSTSHIP ═╗</Text>
      </Box>
      <Text dimColor wrap="truncate-end">{tagline}</Text>
      {snap.author ? <Text dimColor wrap="truncate-end">Developed by <Text color="claude">{snap.author}</Text></Text> : null}
    </Box>
  )
}

function header(el: any, d: PaneData) {
  const { Box, Text } = el
  const snap = d.snap!
  const main = d.act?.main
  const state = snap.paused ? { text: '⏸ paused', color: 'warning' }
    : d.ui.busy ? { text: `● working${main ? ` · ${clock(d.now - main.at)}` : ''}`, color: 'claude' }
    : { text: '○ idle', color: undefined }
  return (
    <Box key="head" flexDirection="row" justifyContent="space-between">
      <Box flexDirection="row" columnGap={1}>
        <Text color="claude" bold>⛴ {snap.project}</Text>
        {snap.version ? <Text dimColor>v{snap.version}</Text> : null}
        {snap.autonomy ? <Text key="mode" color={modeLook(snap.autonomy.mode).color} dimColor={!modeLook(snap.autonomy.mode).color}>[{modeLook(snap.autonomy.mode).label}{snap.autonomy.nightShift ? ' ☾' : ''}]</Text> : null}
      </Box>
      <Text color={state.color} dimColor={!state.color}>{state.text}</Text>
    </Box>
  )
}

/** Discover ✓ ─ Design ✓ ─ ◉ Checks 3/6 ─ Plan ─ Build ─ Release, the stops marked ◆. */
export function voyage(el: any, snap: BridgeSnap, compact: boolean, spin: string | null = null) {
  const { Box, Text } = el
  const at = legIndex(snap.stage)
  const prog = legProgress(snap)
  const parts: any[] = []
  LEGS.forEach((leg, i) => {
    if (compact && Math.abs(i - at) > 1) return
    if (parts.length) parts.push(<Text key={`sep-${leg.key}`} dimColor>{i <= at ? ' ━ ' : ' ─ '}</Text>)
    if (i < at) parts.push(<Text key={leg.key} color="success" dimColor>✓ {leg.label}</Text>)
    else if (i === at) {
      parts.push(spin ? <Text key={leg.key} color="success" bold>{spin} {leg.label}</Text> : <Text key={leg.key} color="claude" bold>◉ {leg.label}</Text>)
      if (prog) {
        const b = bar(prog.total ? prog.done / prog.total : 0, compact ? 5 : 8)
        parts.push(<Text key={`${leg.key}-on`} color="claude">{' '}{b.on}</Text>)
        parts.push(<Text key={`${leg.key}-off`} dimColor>{b.off} {prog.done}/{prog.total}</Text>)
      }
    } else parts.push(<Text key={leg.key} dimColor>{leg.stop ? `◆ ${leg.label}` : `○ ${leg.label}`}</Text>)
  })
  return <Box key="voyage" flexDirection="row" flexWrap="wrap">{parts}</Box>
}

function tabs(el: any, d: PaneData, a: Actions) {
  const { Box, Button } = el
  const snap = d.snap!
  const asks = snap.asks.length
  const live = snap.tasks.filter((t) => t.status !== 'DROPPED')
  const count: Record<View, string> = {
    roadmap: '',
    queue: asks ? ` ${circled(asks)}` : '',
    tasks: live.length ? ` ${live.filter((t) => t.status === 'MERGED').length}/${live.length}` : '',
    crew: d.act && Object.keys(d.act.subs).length ? ` ${Object.keys(d.act.subs).length + 1}` : '',
    log: '',
    menu: '',
  }
  return (
    <Box key="tabs" flexDirection="row" flexWrap="wrap" columnGap={2}>
      {TABS.map((t) => (
        <Button key={`tab-${t.view}`} plain hotkey={t.key} dimColor={d.ui.view !== t.view}
          label={`${d.ui.view === t.view ? '▸' : ''}${t.label}${count[t.view]}`} onPress={() => a.setView(t.view)} />
      ))}
    </Box>
  )
}

function flash(el: any, d: PaneData) {
  const { Text } = el
  const f = d.ui.flash
  if (!f || d.now - f.at > FLASH_MS) return null
  const look = f.tone === 'ok' ? { g: '✓', c: 'success' } : f.tone === 'warn' ? { g: '⚠', c: 'warning' } : { g: '✗', c: 'error' }
  return <Text key="flash" color={look.c} wrap="wrap">{look.g} {f.text}</Text>
}

/** The meters at the foot of the pane: claude-deck's chips (limits with reset, context, spend), see ./deck.tsx. */
export function meters(el: any, snap: BridgeSnap, now: number, _where: 'pane' | 'band') {
  return deckChips(el, snap, now)
}

function footer(el: any, d: PaneData, a: Actions) {
  const { Box, Text, Button } = el
  return (
    <Box key="foot" flexDirection="row" flexWrap="wrap" columnGap={2}>
      <Text dimColor>{d.focused ? 'Esc: prompt · keys before each action' : 'Click, or ctrl+x tab for the keys'}</Text>
      <Button key="refresh" plain dimColor hotkey="f" label="Refresh" onPress={() => a.refresh()} />
      <Button key="hide" plain dimColor role="dismiss" hotkey="h" label="Hide" onPress={() => a.hide()} />
    </Box>
  )
}

// ===================================================================== queue: everything only you can do
function queueView(el: any, d: PaneData, a: Actions) {
  const { Box, Text, Button } = el
  const snap = d.snap!
  const asks = snap.asks
  const out: any[] = []
  if (d.ui.waiting.length) {
    out.push(
      <Box key="waiting" flexDirection="row" flexWrap="wrap" columnGap={2}>
        <Text color="suggestion">✉ {plural(d.ui.waiting.length, 'answer')} {d.ui.waiting.length === 1 ? 'waits' : 'wait'} for Claude's turn to end</Text>
        <Button key="send-now" plain hotkey="s" label="Send now" onPress={() => a.sendNow()} />
      </Box>,
    )
  }
  if (!asks.length) {
    out.push(<Text key="empty" color="success">✓ Nothing waiting for you.</Text>)
    out.push(<Text key="empty-2" dimColor wrap="wrap">Ghostship keeps sailing. When it needs a key, a choice or your OK, it lands here and you hear a ping.</Text>)
    return out
  }
  const selected = asks.find((x) => x.id === d.ui.selected) ?? asks[0]!
  out.push(
    <Box key="q-head" flexDirection="row" justifyContent="space-between">
      <Text bold color="warning">{plural(asks.length, 'thing')} only you can do</Text>
      {asks.length > 1 ? (
        <Box flexDirection="row" columnGap={2}>
          <Button key="next-ask" plain dimColor hotkey="j" label="next" onPress={() => a.move(1)} />
          <Button key="prev-ask" plain dimColor hotkey="k" label="prev" onPress={() => a.move(-1)} />
        </Box>
      ) : null}
    </Box>,
  )
  asks.forEach((ask) => {
    const mark = askMark(ask)
    const age = ask.at ? ago(d.now - Date.parse(ask.at)) : ''
    if (ask.id !== selected.id) {
      out.push(
        <Box key={`ask-${ask.id}`} flexDirection="row" columnGap={1}>
          <Text color={mark.color} dimColor>{mark.glyph}</Text>
          <Button key={`sel-${ask.id}`} plain dimColor label={short(label(ask), Math.max(20, d.cols - 12))} onPress={() => a.select(ask.id)} />
          {age ? <Text dimColor>{age}</Text> : null}
        </Box>,
      )
      return
    }
    out.push(
      <Box key={`ask-${ask.id}`} flexDirection="column" borderStyle="round" borderColor={mark.color} paddingX={1}>
        <Box key="t" flexDirection="row" justifyContent="space-between" columnGap={1}>
          <Box flexDirection="row" columnGap={1} flexShrink={1}>
            <Text color={mark.color} bold>{mark.glyph}</Text>
            <Text bold wrap="wrap">{label(ask)}</Text>
          </Box>
          <Text dimColor>{[age, ask.source === 'ghostship' ? 'Ghostship' : 'an agent'].filter(Boolean).join(' · ')}</Text>
        </Box>
        {ask.why ? <Text key="why" wrap="wrap">{ask.why}</Text> : null}
        {ask.doneWhen ? <Text key="dw" dimColor wrap="wrap">Done when: {ask.doneWhen}</Text> : null}
        {ask.command ? <Text key="cmd" color="suggestion" wrap="wrap">$ {ask.command}</Text> : null}
        <Box key="ctl" flexDirection="column" marginTop={1}>{controls(el, d, a, ask)}</Box>
      </Box>,
    )
  })
  return out
}

function controls(el: any, d: PaneData, a: Actions, ask: BridgeAsk) {
  const { Box, Text, Button } = el
  const ed = d.ui.editing
  if (d.ui.confirm?.askId === ask.id) return confirmBox(el, d, a, ask, d.ui.confirm.option)
  if (ed && ed.id === ask.id) return field(el, d, a, ed)
  const row: any[] = []
  if (ask.command) row.push(<Button key={`ask-${ask.id}-copy`} plain hotkey="c" label="Copy command" onPress={(e: any) => a.copy(ask.command!, e?.surface)} />)
  if (ask.kind === 'choose') {
    ask.options.forEach((o, i) => {
      const run = gateRun(ask, i)
      row.push(<Button key={`ask-${ask.id}-o${i + 1}`} plain hotkey={String(i + 1)} autoFocus={i === 0 ? true : undefined}
        label={`${o}${run && d.snap!.approvals === 'terminal' ? ' ↗' : ''}`} onPress={() => a.pick(ask, i)} />)
    })
    if (!ask.gate && d.canType) row.push(<Button key={`ask-${ask.id}-other`} plain hotkey="r" label="Other…" onPress={() => a.startEdit(ask.id, 'answer')} />)
  } else if (ask.kind === 'do') {
    row.push(<Button key={`ask-${ask.id}-done`} plain hotkey="d" autoFocus label="Done" onPress={() => a.done(ask)} />)
  } else if (d.canType) {
    row.push(<Button key={`ask-${ask.id}-answer`} plain hotkey="r" autoFocus label="Answer…" onPress={() => a.startEdit(ask.id, 'answer')} />)
    row.push(<Button key={`ask-${ask.id}-long`} plain hotkey="p" label="Long answer in the prompt…" onPress={() => a.longAnswer(ask.id)} />)
  } else {
    row.push(<Text key="no-field" dimColor>Answer in the prompt: ↳ Answer to #{ask.id}: …</Text>)
  }
  if (!ask.gate) {
    row.push(d.canType
      ? <Button key={`ask-${ask.id}-reject`} plain hotkey="x" label="Won't do…" onPress={() => a.startEdit(ask.id, 'reason')} />
      : <Button key={`ask-${ask.id}-reject`} plain hotkey="x" label="Won't do" onPress={() => a.submitEdit(ask.id, 'reason', '')} />)
  }
  const tip = ask.gate && d.snap!.approvals === 'terminal' && ask.options.some((_, i) => gateRun(ask, i))
    ? <Text key="tip" dimColor wrap="wrap">↗ runs in your own terminal (approvals: terminal)</Text> : null
  return [<Box key="row" flexDirection="row" flexWrap="wrap" columnGap={3}>{row}</Box>, tip]
}

function confirmBox(el: any, d: PaneData, a: Actions, ask: BridgeAsk, option: number) {
  const { Box, Text, Button } = el
  const run = gateRun(ask, option)
  if (!run) return null
  const mode = d.snap!.approvals
  if (mode === 'terminal') {
    const cmd = gsCommand(run.args)
    return (
      <Box flexDirection="column">
        <Text key="h" bold>{run.verb}: this one needs you at a terminal.</Text>
        <Text key="how" wrap="wrap">Run it in your own shell in this folder, then type yes:</Text>
        <Text key="cmd" color="suggestion" wrap="wrap">  $ {cmd}</Text>
        <Box key="btns" flexDirection="row" flexWrap="wrap" columnGap={3}>
          <Button key="copy" plain hotkey="c" autoFocus label="Copy the command" onPress={(e: any) => a.copy(cmd, e?.surface)} />
          <Button key="back" plain hotkey="n" label="Back" onPress={() => a.confirmNo()} />
        </Box>
        <Text key="tip" dimColor wrap="wrap">Tip: set approvals.mode: bridge in .ghostship/config.yaml to approve here with one press.</Text>
      </Box>
    )
  }
  return (
    <Box flexDirection="column">
      <Text key="h" bold color="claude">{run.verb}?</Text>
      <Text key="w" wrap="wrap">{run.warn}</Text>
      {mode === 'chat' ? <Text key="c" dimColor wrap="wrap">Your words go to Claude as the approval quote.</Text> : null}
      <Box key="btns" flexDirection="row" flexWrap="wrap" columnGap={3}>
        <Button key="yes" plain hotkey="y" autoFocus label="Yes, do it" onPress={() => a.confirmYes()} />
        <Button key="no" plain hotkey="n" label="Not now" onPress={() => a.confirmNo()} />
      </Box>
    </Box>
  )
}

const FIELD: Record<Editing['field'], { label: string; hint: string; submit: string }> = {
  answer: { label: 'Answer › ', hint: '', submit: 'send' },
  reason: { label: 'Why not? › ', hint: 'optional · Enter sends', submit: 'send' },
  add: { label: 'The feature › ', hint: 'what it should do, in a sentence or two', submit: 'start' },
  change: { label: 'The change › ', hint: 'what to alter in what you approved', submit: 'start' },
  solve: { label: 'The bug › ', hint: 'what happens, and what should', submit: 'start' },
}

function field(el: any, d: PaneData, a: Actions, ed: Editing) {
  const { Box, Text, Button, Input } = el
  if (!Input) return <Text dimColor>This surface has no text field. Type it in the prompt box instead.</Text>
  if (ed.held !== undefined) {
    return (
      <Box flexDirection="column">
        <Text key="w" color="warning" wrap="wrap">⚠ That looks like a secret. Claude and the transcript on disk would see it. Put it in ~/.ghostship/secrets (or .env) and answer Done instead.</Text>
        <Box key="b" flexDirection="row" columnGap={3}>
          <Button key="edit" plain hotkey="e" label="Edit" onPress={() => a.startEdit(ed.id, ed.field)} />
          <Button key="cancel" plain hotkey="n" label="Cancel" onPress={() => a.stopEdit()} />
        </Box>
      </Box>
    )
  }
  const f = FIELD[ed.field]
  const hint = ed.field === 'answer' ? (d.ui.busy ? 'Enter saves it; Claude gets it when this turn ends' : 'Enter sends it to Claude') : f.hint
  return (
    <Box flexDirection="column">
      <Input key={`field-${ed.field}-${ed.id}`} label={f.label} placeholder={hint} submitLabel={f.submit} autoFocus value={d.drafts[`${ed.field}:${ed.id}`] ?? ''}
        onInput={(v: string) => a.draft(`${ed.field}:${ed.id}`, v)} onSubmit={(v: string) => a.submitEdit(ed.id, ed.field, v)} />
      <Box key="b" flexDirection="row" columnGap={3}>
        {ed.field === 'answer' ? <Button key="long" plain label="Long answer in the prompt…" onPress={() => a.longAnswer(ed.id)} /> : null}
        <Button key="cancel" plain dimColor label="Cancel" onPress={() => a.stopEdit()} />
      </Box>
    </Box>
  )
}

// ===================================================================== roadmap: every stage, ✓ when done, a turning square while it runs
function roadmapView(el: any, d: PaneData) {
  const { Box, Text } = el
  const snap = d.snap!
  const at = legIndex(snap.stage)
  const working = (d.ui.busy || Object.keys(d.act?.subs || {}).length > 0 || (snap.agents || []).length > 0) && !snap.paused
  // The mark for the step in hand: a green square turning round while Claude works, still when idle.
  const nowMark = (key: string) => <Text key={key} color="success" bold>{working ? spinAt(d.now) : '◼'}</Text>
  const rows: any[] = []
  LEGS.forEach((leg, i) => {
    const state = i < at ? 'done' : i === at ? 'now' : 'next'
    rows.push(
      <Box key={`leg-${leg.key}`} flexDirection="row" columnGap={1}>
        {state === 'done' ? <Text color="success">✓</Text> : state === 'now' ? nowMark('m') : <Text dimColor>{leg.stop ? '◆' : '○'}</Text>}
        <Box width={9} flexShrink={0}><Text bold={state === 'now'} color={state === 'now' ? 'success' : undefined} dimColor={state === 'next'}>{leg.label}</Text></Box>
        <Box flexShrink={1}><Text dimColor wrap="truncate-end">{legNote(leg.key, snap, i, at)}</Text></Box>
      </Box>,
    )
    if (leg.key === 'build' && i <= at) {
      for (const p of phasesOf(snap.tasks)) {
        const b = bar(p.total ? p.done / p.total : 0, 6)
        rows.push(
          <Box key={`ph-${p.key}`} flexDirection="row" columnGap={1} paddingLeft={2}>
            {p.state === 'done' ? (p.parked ? <Text color="warning">⏸</Text> : <Text color="success">✓</Text>) : p.state === 'now' ? nowMark('pm') : <Text dimColor>○</Text>}
            <Box flexGrow={1} flexShrink={1}><Text bold={p.state === 'now'} dimColor={p.state === 'next'} wrap="truncate-end">{p.label}</Text></Box>
            <Text color="success">{b.on}</Text><Text dimColor>{b.off}</Text>
            <Text dimColor>{p.done}/{p.total}</Text>
            {p.parked ? <Text color="warning">{p.parked} parked</Text> : null}
          </Box>,
        )
        if (p.state === 'now' && p.current) {
          const t = p.current
          const look = t.status === 'NEEDS_DECISION' ? { g: '⚠', c: 'warning', w: 'needs your decision' } : t.status === 'JUDGING' ? { g: '⚖', c: 'suggestion', w: 'with the judge' } : { g: working ? spinAt(d.now + 250) : '◐', c: 'success', w: t.status === 'RETRY' ? 'retrying' : 'building' }
          rows.push(
            <Box key={`cur-${t.id}`} flexDirection="row" columnGap={1} paddingLeft={4}>
              <Text color={look.c}>{look.g}</Text>
              <Text bold>{t.id}</Text>
              <Box flexShrink={1}><Text dimColor wrap="truncate-end">{t.title}</Text></Box>
              <Text color={look.c}>{look.w}</Text>
              {t.setup ? <Text dimColor>setup</Text> : t.max ? <Text dimColor>{attemptDots(t.attempt, t.max)}</Text> : null}
            </Box>,
          )
        }
      }
    }
  })
  const parked = snap.tasks.filter((t) => t.status === 'PARKED')
  const tail = parked.length
    ? [<Text key="parked" color="warning" wrap="wrap">⏸ {plural(parked.length, 'task')} parked after their retries ({parked.map((t) => t.id).join(', ')}): you grant or drop them at STOP 2.</Text>]
    : []
  return [<Text key="h" bold>Roadmap</Text>, <Box key="rows" flexDirection="column" marginTop={1}>{rows}</Box>, ...tail]
}

// ===================================================================== tasks: the board
function tasksView(el: any, d: PaneData, a: Actions) {
  const { Box, Text, Button } = el
  const snap = d.snap!
  const tasks = snap.tasks
  if (!tasks.length) {
    return [
      <Text key="none" dimColor>No tasks yet.</Text>,
      <Text key="none-2" dimColor wrap="wrap">The planner writes them after STOP 1. Each one is built test-first by a fresh builder and checked by a fresh judge.</Text>,
    ]
  }
  const merged = new Set(tasks.filter((t) => t.status === 'MERGED').map((t) => t.id))
  const live = tasks.filter((t) => t.status !== 'DROPPED')
  const count = (s: string) => tasks.filter((t) => t.status === s).length
  const b = bar(live.length ? merged.size / live.length : 0, Math.max(10, Math.min(30, d.cols - 30)))
  const summary = [
    `${merged.size} of ${live.length} merged`,
    count('BUILDING') + count('RETRY') ? `${count('BUILDING') + count('RETRY')} building` : '',
    count('JUDGING') ? `${count('JUDGING')} judging` : '',
    count('NEEDS_DECISION') ? `${count('NEEDS_DECISION')} need you` : '',
    count('PARKED') ? `${count('PARKED')} parked` : '',
  ].filter(Boolean).join(' · ')
  const rows = tasks.map((t) => {
    const m = taskMark(t, merged)
    const busy = ['BUILDING', 'RETRY', 'JUDGING', 'NEEDS_DECISION'].includes(t.status)
    return (
      <Box key={`task-${t.id}`} flexDirection="row" columnGap={1}>
        <Text color={m.color} dimColor={m.dim}>{m.glyph}</Text>
        <Text bold={busy} dimColor={!busy && t.status !== 'MERGED'}>{t.id}</Text>
        <Box flexGrow={1} flexShrink={1}><Text dimColor={!busy} wrap="truncate-end">{t.title}</Text></Box>
        {busy && t.max ? <Text color={t.attempt >= t.max ? 'warning' : undefined} dimColor={t.attempt < t.max}>{attemptDots(t.attempt, t.max)}</Text> : null}
        {t.status === 'NEEDS_DECISION'
          ? <Button key={`decide-${t.id}`} plain label="Decide" onPress={() => { a.setView('queue'); a.select(`G-${t.id}`) }} />
          : <Text dimColor>{m.label}</Text>}
      </Box>
    )
  })
  return [
    <Box key="bar" flexDirection="row">
      <Text color="success">{b.on}</Text><Text dimColor>{b.off}</Text>
    </Box>,
    <Text key="sum" dimColor>{summary}</Text>,
    <Box key="rows" flexDirection="column" marginTop={1}>{rows}</Box>,
  ]
}

// ===================================================================== crew: who is doing what, now
function crewView(el: any, d: PaneData, a: Actions) {
  const { Box, Text, Button } = el
  const snap = d.snap!
  const main = d.act?.main
  const subs = Object.entries(d.act?.subs || {})
  const out: any[] = []
  out.push(
    <Box key="main" flexDirection="row" columnGap={1}>
      <Text color={main?.waiting ? 'warning' : d.ui.busy ? 'claude' : undefined} dimColor={!d.ui.busy}>{d.ui.busy ? '●' : '○'}</Text>
      <Text bold>Claude</Text>
      <Box flexShrink={1}><Text color={main?.waiting ? 'warning' : undefined} dimColor={!main?.waiting} wrap="truncate-end">{main ? `${main.label} · ${clock(d.now - main.at)}` : 'idle'}</Text></Box>
    </Box>,
  )
  for (const [id, s] of subs) {
    out.push(
      <Box key={`sub-${id}`} flexDirection="row" columnGap={1} paddingLeft={2}>
        <Text color={s.waiting ? 'warning' : 'suggestion'}>↳</Text>
        <Text>{s.name}</Text>
        <Box flexShrink={1}><Text color={s.waiting ? 'warning' : undefined} dimColor={!s.waiting} wrap="truncate-end">{s.label} · {clock(d.now - s.at)}</Text></Box>
      </Box>,
    )
  }
  const run = snap.run
  if (run) {
    out.push(
      <Box key="run" flexDirection="row" columnGap={1} marginTop={1}>
        <Text color={run.blocked ? 'warning' : run.status === 'running' ? 'merged' : undefined} dimColor={run.status !== 'running'}>◆</Text>
        <Text bold>{run.agentId}</Text>
        <Text dimColor wrap="truncate-end">{run.role}{run.task ? ` ${run.task}` : ''} · {run.status}{run.startedAt ? ` · ${clock(d.now - Date.parse(run.startedAt))}` : ''}</Text>
      </Box>,
    )
    if (run.blocked) out.push(<Text key="run-b" color="warning" wrap="wrap">  ⚠ waiting for you in its herdr tab</Text>)
  } else out.push(<Text key="run-none" dimColor>No outside agent running.</Text>)
  out.push(...runnerRows(el, d, a))
  out.push(
    <Box key="helm" flexDirection="row" flexWrap="wrap" columnGap={3} marginTop={1}>
      {snap.paused
        ? <Button key="go" plain hotkey="g" label="Resume work" onPress={() => a.resume()} />
        : <Button key="pause" plain hotkey="p" label="Pause after this step" onPress={() => a.pause()} />}
      <Button key="handoff" plain hotkey="o" label="Hand off & clear context" onPress={() => a.handoff()} />
    </Box>,
  )
  // What Claude has done this session, newest last (tzafrir/whats-agent-doing): each step with its outcome and how long.
  const hist = d.history || []
  if (hist.length) {
    out.push(<Box key="steps-h" marginTop={1}><Text bold>Recent steps</Text></Box>)
    for (const [i, e] of hist.slice(-12).entries()) {
      const m = stepMark(e)
      out.push(
        <Box key={`step-${i}`} flexDirection="row" columnGap={1}>
          <Text color={m.color} dimColor={m.dim}>{m.glyph}</Text>
          <Box flexGrow={1} flexShrink={1}><Text dimColor={e.kind !== 'end'} wrap="truncate-end">{e.label}</Text></Box>
          {e.durationMs !== null ? <Text dimColor>{dur(e.durationMs)}</Text> : null}
        </Box>,
      )
    }
  }
  return out
}

/** The headless autopilot runner (gs autopilot): its state, its current step, and Start/Stop. */
function runnerRows(el: any, d: PaneData, a: Actions) {
  const { Box, Text, Button } = el
  const ap = d.snap!.autopilot
  const look = !ap || ap.status === 'stopped' ? { g: '○', c: undefined, w: ap ? 'stopped' : 'not started' }
    : ap.status === 'running' ? { g: spinAt(d.now), c: 'success', w: 'running' }
    : ap.status === 'waiting-owner' ? { g: '◆', c: 'warning', w: 'waiting for you' }
    : ap.status === 'paused' ? { g: '⏸', c: 'warning', w: 'paused' }
    : { g: '✗', c: 'error', w: 'failed' }
  const alive = ap?.status === 'running' || ap?.status === 'waiting-owner' || ap?.status === 'paused'
  const since = ap?.lastStepAt ? ` · ${clock(d.now - Date.parse(ap.lastStepAt))}` : ''
  const out: any[] = [
    <Box key="runner" flexDirection="row" columnGap={1} marginTop={1}>
      <Text color={look.c} dimColor={!look.c}>{look.g}</Text>
      <Text bold>Autopilot runner</Text>
      <Text color={look.c} dimColor={!look.c}>{look.w}{ap?.step ? ` · step ${ap.step}` : ''}{since}</Text>
    </Box>,
  ]
  if (ap?.last?.say) out.push(<Box key="runner-last" paddingLeft={2} flexShrink={1}><Text color={ap.status === 'failed' ? 'error' : undefined} dimColor={ap.status !== 'failed'} wrap="wrap">{ap.status === 'failed' ? 'Why it stopped: ' : ''}{ap.last.say}</Text></Box>)
  out.push(
    <Box key="runner-btns" flexDirection="row" flexWrap="wrap" columnGap={3} paddingLeft={2}>
      {alive
        ? <Button key="ap-stop" plain hotkey="x" label="Stop autopilot" onPress={() => a.autopilot('stop')} />
        : <Button key="ap-start" plain hotkey="a" label="Run on autopilot (headless)" onPress={() => a.autopilot('start')} />}
    </Box>,
  )
  return out
}

// ===================================================================== log: what happened
function logView(el: any, d: PaneData) {
  const { Box, Text } = el
  const recent = d.snap!.recent
  if (!recent.length) return <Text dimColor>Quiet seas. Alerts land here: decisions, finished runs, a release waiting.</Text>
  return recent.slice().reverse().map((al, i) => {
    const look = al.level === 'action' ? { g: '◆', c: 'warning' } : al.level === 'warn' ? { g: '⚠', c: 'error' } : { g: '·', c: undefined }
    return (
      <Box key={`al-${i}`} flexDirection="row" columnGap={1}>
        <Text dimColor>{al.at.slice(11, 16)}</Text>
        <Text color={look.c} dimColor={!look.c}>{look.g}</Text>
        <Box flexShrink={1}><Text color={look.c} dimColor={al.level === 'info'} wrap="wrap">{al.alert}</Text></Box>
      </Box>
    )
  })
}

// ===================================================================== menu: every /ghostship command, one key each
const MENU: Array<{ key: string; label: string; cmd: string; field?: Editing['field'] }> = [
  { key: '1', label: 'Continue where we left off', cmd: 'resume' },
  { key: '2', label: 'Where are we?', cmd: 'bridge' },
  { key: '3', label: 'Add a feature…', cmd: 'add', field: 'add' },
  { key: '4', label: 'Change something approved…', cmd: 'change', field: 'change' },
  { key: '5', label: 'Report a bug…', cmd: 'solve', field: 'solve' },
  { key: '6', label: 'Agents and models', cmd: 'agents' },
]

const runnerAlive = (d: PaneData) => ['running', 'waiting-owner', 'paused'].includes(d.snap?.autopilot?.status || '')

function menuView(el: any, d: PaneData, a: Actions) {
  const { Box, Text, Button } = el
  const auto = d.snap!.autonomy
  if (d.ui.chooser) return modeChooser(el, d, a)
  const ed = d.ui.editing
  if (ed && (ed.field === 'add' || ed.field === 'change' || ed.field === 'solve')) {
    const item = MENU.find((m) => m.field === ed.field)!
    return [<Text key="h" bold>{item.label.replace('…', '')}</Text>, <Box key="f">{field(el, d, a, ed)}</Box>]
  }
  const rows = MENU.map((m) => (
    <Box key={`menu-${m.cmd}`} flexDirection="row" justifyContent="space-between" columnGap={2}>
      <Button key={`menu-${m.cmd}-b`} plain hotkey={m.key} label={m.label} onPress={() => (m.field ? a.startEdit('menu', m.field) : a.command(m.cmd))} />
      <Text dimColor>/ghostship {m.cmd}</Text>
    </Box>
  ))
  const harbor = 'node ~/.ghostship/core/runtime/gs.mjs harbor'
  const look = modeLook(auto?.mode)
  return [
    <Text key="h" bold>What next?</Text>,
    ...rows,
    <Box key="menu-mode" flexDirection="row" justifyContent="space-between" columnGap={2}>
      <Button key="menu-mode-b" plain hotkey="0" label={`Mode: ${look.label}${auto?.nightShift ? ' + night shift' : ''} — change`} onPress={() => a.chooser(true)} />
      <Text dimColor>autonomy</Text>
    </Box>,
    <Box key="menu-helm" flexDirection="row" justifyContent="space-between" columnGap={2}>
      {d.snap!.paused
        ? <Button key="menu-go" plain hotkey="7" label="Resume work" onPress={() => a.resume()} />
        : <Button key="menu-pause" plain hotkey="7" label="Pause after this step" onPress={() => a.pause()} />}
      <Text dimColor>helm</Text>
    </Box>,
    <Box key="menu-handoff" flexDirection="row" justifyContent="space-between" columnGap={2}>
      <Button key="menu-handoff-b" plain hotkey="8" label="Hand off & clear context now" onPress={() => a.handoff()} />
      <Text dimColor>keeper</Text>
    </Box>,
    <Box key="menu-harbor" flexDirection="row" justifyContent="space-between" columnGap={2}>
      <Button key="menu-harbor-b" plain hotkey="9" label="Copy the Harbor command" onPress={(e: any) => a.copy(harbor, e?.surface)} />
      <Text dimColor>all projects</Text>
    </Box>,
    <Box key="menu-autopilot" flexDirection="row" justifyContent="space-between" columnGap={2}>
      {runnerAlive(d)
        ? <Button key="menu-ap-stop" plain hotkey="x" label="Stop autopilot" onPress={() => a.autopilot('stop')} />
        : <Button key="menu-ap-start" plain hotkey="a" label="Run on autopilot (headless)" onPress={() => a.autopilot('start')} />}
      <Text dimColor>gs autopilot</Text>
    </Box>,
  ]
}

/** How much Ghostship asks you: one key per mode, night shift on n. A press is the owner's act (owner key, like an approval). */
function modeChooser(el: any, d: PaneData, a: Actions) {
  const { Box, Text, Button } = el
  const auto = d.snap!.autonomy
  const night = !!auto?.nightShift
  const rows = MODES.map((m, i) => (
    <Box key={`mode-${m.mode}`} flexDirection="row" columnGap={1}>
      <Text color={auto?.mode === m.mode ? 'success' : undefined} dimColor={auto?.mode !== m.mode}>{auto?.mode === m.mode ? '●' : '○'}</Text>
      <Button key={`mode-${m.mode}-b`} plain hotkey={String(i + 1)} autoFocus={auto?.mode === m.mode ? true : undefined} label={m.label} onPress={() => a.setMode(m.mode)} />
      <Box flexShrink={1}><Text dimColor wrap="truncate-end">{m.what}</Text></Box>
    </Box>
  ))
  const tip = d.snap!.approvals === 'terminal'
    ? [<Text key="t1" dimColor wrap="wrap">Approvals are terminal-only here, so a press copies the command for your shell:</Text>,
       <Text key="t2" color="suggestion" wrap="wrap">  $ {gsCommand(autonomyArgs(auto?.mode || 'autopilot', night))}</Text>]
    : []
  return [
    <Text key="h" bold>How much should Ghostship ask you?</Text>,
    <Box key="rows" flexDirection="column" marginTop={1}>{rows}</Box>,
    <Box key="night" flexDirection="row" columnGap={1} marginTop={1}>
      <Text color={night ? 'suggestion' : undefined} dimColor={!night}>☾</Text>
      <Button key="mode-night" plain hotkey="n" label={`Night shift: ${night ? 'on' : 'off'}`} onPress={() => a.setMode(auto?.mode || 'autopilot', !night)} />
      <Box flexShrink={1}><Text dimColor wrap="truncate-end">pause at {auto?.nightShiftAt ?? 90}% of the 5h plan, resume after the reset</Text></Box>
    </Box>,
    ...tip,
    <Button key="mode-back" plain dimColor hotkey="b" label="Back" onPress={() => a.chooser(false)} />,
  ]
}

// ===================================================================== band: one glance above the prompt
/** claude-deck's terminal panel (./deck.tsx): rows while Claude works or something needs you, one line of chips otherwise. */
export function bandTree(el: any, snap: BridgeSnap, act: BridgeActivity | null, busy: boolean, now: number, open: () => void, cols = 100) {
  return deckBand(el, { snap, act, busy, now, cols, open })
}

/** The transcript row for an agent's `gs ask`: what it asked you, and where to answer. */
export function askedRow(el: any, title: string) {
  const { Box, Text } = el
  return (
    <Box flexDirection="row">
      <Text color="warning">☐ </Text>
      <Text bold>Asked you: </Text>
      <Text wrap="truncate-end">{short(title, 80)}</Text>
      <Text dimColor>  · answer in /gs-bridge</Text>
    </Box>
  )
}
