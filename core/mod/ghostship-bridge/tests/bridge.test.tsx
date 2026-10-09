// Bridge mod: riskhold, the band, the pane (queue, tasks, crew, log, menu), approvals from the pane, delivery of answers,
// and staying inert outside a Ghostship project.
import { test, expect, mock } from 'claude-code/testing'
import { countdown, humanReset } from '../hooks/deck'

const ASK_DO = { id: '1', kind: 'do', title: 'Add STRIPE_KEY to ~/.ghostship/secrets', why: 'payments step', doneWhen: 'gs config check passes', options: [], source: 'agent', at: '2026-10-06T09:58:00Z', gate: null, task: null }
const ASK_DECIDE = { id: 'G-T009', kind: 'choose', title: 'Decide T009: parser', why: '3/3 attempts used', doneWhen: '', options: ['Grant 1 more attempt', 'Drop the task'], source: 'ghostship', at: null, gate: 'decide', task: 'T009' }
const ASK_GIT = { id: '3', kind: 'do', title: 'Trust /workspace/test in git (safe.directory)', why: 'git refuses the folder', doneWhen: '', options: [], source: 'agent', at: null, gate: null, task: null, command: 'git config --global --add safe.directory /workspace/test' }
const ASK_NAME = { id: '2', kind: 'answer', title: 'Name the product', why: 'Used in the PRD', doneWhen: '', options: [], source: 'agent', at: null, gate: null, task: null }
const ASK_STOP1 = { id: 'G-stop1', kind: 'choose', title: 'STOP 1: approve the acceptance checks?', why: '6 checks', doneWhen: '', options: ['Approve the checks', 'Change them first'], source: 'ghostship', at: null, gate: 'acceptance', task: null }

const tick = (over: Record<string, unknown> = {}) => JSON.stringify({
  active: true, cursor: 1, limits: { soft: 150000, hard: 200000 }, keeper: 'auto', project: 'math', paused: null, run: null, handoff: null,
  status: { stage: 'build', next: 'gs task start T002', active: { id: 'T001', status: 'BUILDING', attempt: 1, max: 3 }, needsDecision: ['T009'] },
  alerts: [{ at: '2026-10-06T10:00:00Z', level: 'action', alert: 'T009 needs your decision' }],
  claude: { fiveHour: { percent: 62, resetsAt: null }, sevenDay: { percent: 31, resetsAt: null } },
  asks: [ASK_DO, ASK_DECIDE],
  tasks: [
    { id: 'T001', title: 'Add two numbers', status: 'BUILDING', attempt: 1, max: 3, blockedBy: [], checks: ['C1'], phase: '2-maths' },
    { id: 'T002', title: 'Subtract two numbers', status: 'TODO', attempt: 0, max: 3, blockedBy: ['T001'], checks: ['C2'], phase: '2-maths' },
    { id: 'T009', title: 'Parser', status: 'NEEDS_DECISION', attempt: 3, max: 3, blockedBy: [], checks: [], phase: '3-parsing' },
    { id: 'T000', title: 'Skeleton', status: 'MERGED', attempt: 1, max: 3, blockedBy: [], checks: [], phase: '1-skeleton' },
  ],
  interview: null, approvals: 'terminal', version: '1.2.0', spend: { usd: 41.2, sessions: 7 }, author: 'Shekhar', tagline: 'an agentic security platform',
  ...over,
})
const TICK = tick()

type Seen = { argv: string[]; stdin?: string }
function engine(onRaw: any, isGhostship = true, tokens = 1000, skip: string[] = [], tickJson = TICK) {
  const on = (name: string, fn: any) => { if (!skip.includes(name)) onRaw(name, fn) }
  on('session.root', () => ({ value: '/p' }))
  on('fs.exists', () => ({ value: isGhostship }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: tickJson, stderr: '' } }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens, window: 200000, percent: 12 }, rateLimits: [], cost: { usd: 0.5 } } }))
  on('session.id', () => ({ value: 's1' }))
  on('session.start', () => ({ cwd: '/p' }))
  on('command.register', (_$: any, e: any) => ({ value: { command: e.name } }))
  on('tool.call', () => ({ result: 'ran' }))
  on('clock.every', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('audio.play', () => ({ value: undefined }))
  on('clock.now', () => ({ value: Date.parse('2026-10-06T10:00:00Z') }))
}

/** A gs that answers the tick, records every call, and answers ask/deliver/approve like the CLI does. */
function fakeGs(on: any, tickJson = TICK, calls: Seen[] = [], delivered = false) {
  on('process.run', ((_$: any, e: any) => {
    const argv: string[] = [...(e.argv ?? [])]
    calls.push({ argv, stdin: e.init?.stdin })
    const a = argv.join(' ')
    if (/ask answer/.test(a)) return { value: { exitCode: 0, stdout: '#1 answered', stderr: '' } }
    if (/asks deliver/.test(a)) return { value: { exitCode: 0, stdout: delivered ? '' : 'My responses to the Ghostship asks:\n\n#1 Add STRIPE_KEY: Done.', stderr: '' } }
    if (/approve|decide|\bgo\b/.test(a) && !/bridge tick/.test(a)) return { value: { exitCode: 0, stdout: 'ok', stderr: '' } }
    return { value: { exitCode: 0, stdout: tickJson, stderr: '' } }
  }) as any)
  return calls
}
const flat = (calls: Seen[]) => calls.map((c) => c.argv.join(' '))
const START = { cwd: '/p', surface: 'terminal', isInteractive: true } as any
const paneRaw = ($: any) => $.ui.mount({ plugin: 'ghostship-bridge', surface: 'terminal', component: 'Pane', requestId: 'ghostship-bridge', props: { isFocused: true, bodyColumns: 70 } } as any)
const pane = async ($: any) => { const ui = await paneRaw($); try { await ui.press({ key: 'tab-queue' }) } catch { /* welcome screen has no tabs */ } return ui }

test('riskhold refuses secrets, the owner key and risky commands in a Ghostship project', async ($, on) => {
  engine(on)
  await $.session.start(START)
  expect(JSON.stringify(await $.tool.call({ tool: 'Read', file_path: '/p/.env' } as any))).toMatch(/riskhold/)
  expect(JSON.stringify(await $.tool.call({ tool: 'Bash', command: 'git push --force origin main' } as any))).toMatch(/force-pushing/)
  expect(JSON.stringify(await $.tool.call({ tool: 'Bash', command: 'cat ~/.ghostship/bridge.key' } as any))).toMatch(/riskhold/)
  expect(JSON.stringify(await $.tool.call({ tool: 'Bash', command: 'node .ghostship/core/runtime/gs.mjs go --owner-key-stdin' } as any))).toMatch(/owner key/)
  expect(JSON.stringify(await $.tool.call({ tool: 'Grep', pattern: 'KEY', path: '/p/.env' } as any))).toMatch(/riskhold/)
})

test('band (claude-deck look): the plan bar, the task, what waits for you, and context — no limits or spend (those are in the status line)', async ($, on) => {
  engine(on, true, 1000, ['ui.open'])
  const opened: any[] = []
  on('ui.open', ((_$: any, e: any) => { opened.push(e); return { value: { isPlaced: true } } }) as any)
  await $.session.start(START)
  opened.length = 0
  for (const surface of ['terminal', 'desktop'] as const) {
    // Something waits for the owner, so the band is expanded: one deck row each.
    const ui = await $.ui.mount({ plugin: 'ghostship-bridge', surface, component: 'AbovePrompt', props: {} } as any)
    expect(await ui.find({ type: 'Text', text: /^Build$/ })).toBeDefined()
    expect(JSON.stringify(await ui.drawn())).toMatch(/1\/4 merged/)
    expect(JSON.stringify(await ui.drawn())).not.toMatch(/ rows/)
    expect(await ui.find({ type: 'Text', text: /▰/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /T001 BUILDING 1\/3/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /2 for you:/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Context$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /5h · 62% used/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^Weekly · 7d$/ })).toBeUndefined()
    expect(JSON.stringify(await ui.drawn())).not.toMatch(/project/)
    await ui.press({ key: 'open-bridge' })
    await ui.unmount()
  }
  expect(opened.some((o) => o.id === 'ghostship-bridge' && o.focus === true)).toBe(true)
})

test('inert outside a Ghostship project', async ($, on) => {
  engine(on, false)
  await $.session.start(START)
  const env = await $.tool.call({ tool: 'Bash', command: 'sudo ls' } as any)
  expect(JSON.stringify(env)).not.toMatch(/riskhold/)
})

test('keeper: past the soft limit it starts the handoff once', async ($, on) => {
  engine(on, true, 160000, ['ui.toast'])
  const toasts: string[] = []
  on('ui.toast', (_$: any, e: any) => { toasts.push(String(e.text)); return { value: undefined } })
  on('turn.complete', (_$: any, e: any) => ({ text: e.answer ?? '' }))
  await $.session.start(START)
  const t = { answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as any
  await $.turn.complete(t)
  await $.turn.complete({ ...t, turnId: 't2' })
  expect(toasts.filter((t) => /handing off/.test(t)).length).toBe(1)
})

test('an action alert pings: sound, toast and the pane', async ($, on) => {
  engine(on, true, 1000, ['audio.play', 'ui.open', 'ui.toast'])
  const played: string[] = []
  const opened: string[] = []
  const toasts: string[] = []
  on('audio.play', (_$: any, e: any) => { played.push(JSON.stringify(e)); return { value: undefined } })
  on('ui.open', (_$: any, e: any) => { opened.push(String(e.id)); return { value: { isPlaced: true } } })
  on('ui.toast', (_$: any, e: any) => { toasts.push(String(e.text)); return { value: undefined } })
  await $.session.start(START)
  expect(played.join(' ')).toMatch(/sounds\/ping\.wav/)
  expect(opened).toContain('ghostship-bridge')
  expect(toasts.some((t) => /T009 needs your decision/.test(t))).toBe(true)
})

test('on WSL the ping also asks Windows for its chime', async ($, on) => {
  engine(on, true, 1000, ['process.run'])
  const runs: string[] = []
  on('env.get', ((_$: any, e: any) => ({ value: e.name === 'WSL_DISTRO_NAME' ? 'Ubuntu' : undefined })) as any)
  on('process.run', ((_$: any, e: any) => { runs.push([...(e.argv ?? [])].join(' ')); return { value: { exitCode: 0, stdout: TICK, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } }) as any)
  await $.session.start(START)
  expect(runs.some((r) => /powershell\.exe .*SystemSounds/.test(r))).toBe(true)
})

test('queue: the first ask is open with its keys; Done records it and, Claude idle, delivers it as the owner', async ($, on) => {
  engine(on, true, 1000, ['process.run', 'clock.now', 'clock.every'])
  const clock = mock.clock(on, { now: Date.parse('2026-10-06T10:00:00Z') })
  const calls = fakeGs(on)
  const submitted: any[] = []
  on('prompt.submit', ((_$: any, e: any) => { submitted.push(e); return { text: e.text } }) as any)
  await $.session.start(START)
  const ui = await pane($)
  expect(await ui.find({ type: 'Text', text: /Add STRIPE_KEY/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /2 things only you can do/ })).toBeDefined()
  expect(await ui.find({ key: 'sel-G-T009' })).toBeDefined()
  await ui.press({ key: 'ask-1-done' })
  await clock.advance(1000)
  await ui.unmount()
  expect(flat(calls).some((c) => /ask answer 1 --done/.test(c))).toBe(true)
  expect(flat(calls).some((c) => /asks deliver/.test(c))).toBe(true)
  expect(JSON.stringify(submitted)).toMatch(/My responses to the Ghostship asks/)
})

test('queue: answers given while Claude works wait for the turn to end, then go together', async ($, on) => {
  engine(on, true, 1000, ['process.run', 'clock.now', 'clock.every'])
  mock.clock(on, { now: Date.parse('2026-10-06T10:00:00Z') })
  const calls = fakeGs(on)
  const submitted: any[] = []
  on('prompt.submit', ((_$: any, e: any) => { submitted.push(e); return { text: e.text } }) as any)
  on('turn.complete', (_$: any, e: any) => ({ text: e.answer ?? '' }))
  await $.session.start(START)
  await $.prompt.submit({ text: 'carry on' } as any)
  submitted.length = 0
  const ui = await pane($)
  await ui.press({ key: 'ask-1-done' })
  expect(flat(calls).some((c) => /ask answer 1 --done/.test(c))).toBe(true)
  expect(flat(calls).some((c) => /asks deliver/.test(c))).toBe(false)
  expect(await ui.find({ type: 'Text', text: /waits for Claude's turn to end/ })).toBeDefined()
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as any)
  await ui.unmount()
  expect(flat(calls).some((c) => /asks deliver/.test(c))).toBe(true)
  expect(JSON.stringify(submitted)).toMatch(/My responses/)
})

test('queue: a typed answer goes as text; one that looks like a secret is held in the pane', async ($, on) => {
  engine(on, true, 1000, ['process.run', 'clock.now', 'clock.every'])
  mock.clock(on, { now: Date.parse('2026-10-06T10:00:00Z') })
  const calls = fakeGs(on, tick({ asks: [ASK_NAME] }))
  on('prompt.submit', ((_$: any, e: any) => ({ text: e.text })) as any)
  await $.session.start(START)
  const ui = await pane($)
  await ui.press({ key: 'ask-2-answer' })
  await ui.input({ key: 'field-answer-2', text: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz', kind: 'submit' })
  expect(await ui.find({ type: 'Text', text: /looks like a secret/ })).toBeDefined()
  expect(flat(calls).some((c) => /ask answer/.test(c))).toBe(false)
  await ui.press({ key: 'edit' })
  await ui.input({ key: 'field-answer-2', text: 'Abacus', kind: 'submit' })
  await ui.unmount()
  expect(flat(calls).some((c) => /ask answer 2 --text Abacus/.test(c))).toBe(true)
})

test('approvals: in bridge mode, STOP 1 asks once more, then runs the command with the owner key on stdin', async ($, on) => {
  engine(on, true, 1000, ['process.run', 'clock.now', 'clock.every'])
  mock.clock(on, { now: Date.parse('2026-10-06T10:00:00Z') })
  mock.env(on, { HOME: '/home/o' })
  const key = 'f'.repeat(64)
  on('fs.read', ((_$: any, e: any) => ({ value: String(e.path ?? e).includes('/home/o/.ghostship/bridge.key') ? `${key}\n` : '' })) as any)
  const calls = fakeGs(on, tick({ asks: [ASK_STOP1], approvals: 'bridge', status: { stage: 'acceptance', next: 'STOP 1', active: null, needsDecision: [] } }))
  const submitted: any[] = []
  on('prompt.submit', ((_$: any, e: any) => { submitted.push(e); return { text: e.text } }) as any)
  await $.session.start(START)
  const ui = await pane($)
  await ui.press({ key: 'ask-G-stop1-o1' })
  expect(await ui.find({ type: 'Text', text: /Approve the acceptance checks \(STOP 1\)\?/ })).toBeDefined()
  expect(flat(calls).some((c) => /acceptance approve/.test(c))).toBe(false)
  await ui.press({ key: 'yes' })
  await ui.unmount()
  const run = calls.find((c) => /acceptance approve --owner-key-stdin/.test(c.argv.join(' ')))
  expect(run).toBeDefined()
  expect(run!.stdin).toBe(key)
  expect(run!.argv.join(' ')).not.toContain(key)
  expect(flat(calls).some((c) => /ask answer G-stop1/.test(c))).toBe(false)
  expect(JSON.stringify(submitted)).toMatch(/STOP 1: approve the acceptance checks\?: I chose \\"Approve the checks\\". I already did it from the Bridge/)
})

test('approvals: in terminal mode the pane hands over the exact command, one key to copy it', async ($, on) => {
  engine(on, true, 1000, ['process.run', 'clock.now', 'clock.every'])
  mock.clock(on, { now: Date.parse('2026-10-06T10:00:00Z') })
  const copied: string[] = []
  on('ui.copy', ((_$: any, e: any) => { copied.push(e.text); return { value: { isCopied: true } } }) as any)
  const calls = fakeGs(on, tick({ asks: [ASK_STOP1], status: { stage: 'acceptance', next: 'STOP 1', active: null, needsDecision: [] } }))
  await $.session.start(START)
  const ui = await pane($)
  await ui.press({ key: 'ask-G-stop1-o1' })
  expect(await ui.find({ type: 'Text', text: /node \.ghostship\/core\/runtime\/gs\.mjs acceptance approve/ })).toBeDefined()
  await ui.press({ key: 'copy' })
  await ui.unmount()
  expect(copied).toEqual(['node .ghostship/core/runtime/gs.mjs acceptance approve'])
  expect(flat(calls).some((c) => /acceptance approve/.test(c))).toBe(false)
})

test('an option that is only words (Change them first) goes straight back to Claude', async ($, on) => {
  engine(on, true, 1000, ['process.run', 'clock.now', 'clock.every'])
  mock.clock(on, { now: Date.parse('2026-10-06T10:00:00Z') })
  const calls = fakeGs(on, tick({ asks: [ASK_STOP1], approvals: 'bridge' }))
  on('prompt.submit', ((_$: any, e: any) => ({ text: e.text })) as any)
  await $.session.start(START)
  const ui = await pane($)
  await ui.press({ key: 'ask-G-stop1-o2' })
  await ui.unmount()
  expect(flat(calls).some((c) => /ask answer G-stop1 --option 2$/.test(c))).toBe(true)
})

test('tabs: the task board shows progress, states and a Decide that jumps to the decision', async ($, on) => {
  engine(on, true, 1000, ['process.run'])
  fakeGs(on)
  await $.session.start(START)
  const ui = await pane($)
  await ui.press({ key: 'tab-tasks' })
  expect(await ui.find({ type: 'Text', text: /1 of 4 merged/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /waits for T001/ })).toBeDefined()
  await ui.press({ key: 'decide-T009' })
  expect(await ui.find({ key: 'ask-G-T009-o1' })).toBeDefined()
  await ui.unmount()
})

test('menu: Add a feature asks for the words, then runs /ghostship add with them', async ($, on) => {
  engine(on, true, 1000, ['process.run'])
  fakeGs(on)
  const ran: any[] = []
  on('command.run', ((_$: any, e: any) => { ran.push(e); return { text: 'ok' } }) as any)
  await $.session.start(START)
  const ui = await pane($)
  await ui.press({ key: 'tab-menu' })
  await ui.press({ key: 'menu-add-b' })
  await ui.input({ key: 'field-add-menu', text: 'Export totals as CSV', kind: 'submit' })
  await ui.unmount()
  expect(ran.some((r) => r.command === 'ghostship' && r.args === 'add Export totals as CSV')).toBe(true)
})

test('a long answer typed in the prompt as "↳ Answer to #2: …" is recorded and sent in the owner\'s words', async ($, on) => {
  engine(on, true, 1000, ['process.run'])
  const calls = fakeGs(on, tick({ asks: [ASK_NAME] }))
  const passed: any[] = []
  on('prompt.submit', ((_$: any, e: any) => { passed.push(e); return { text: e.text } }) as any)
  await $.session.start(START)
  await $.prompt.submit({ text: '↳ Answer to #2: Abacus, after the counting frame' } as any)
  expect(flat(calls).some((c) => /ask answer 2 --text Abacus, after the counting frame/.test(c))).toBe(true)
  expect(JSON.stringify(passed)).toMatch(/My responses to the Ghostship asks/)
})

test('step line names what the agent is doing', async ($, on) => {
  engine(on)
  on('prompt.submit', ((_$: any, e: any) => ({ text: e.text })) as any)
  await $.session.start(START)
  await $.prompt.submit({ text: 'go' } as any)
  await $.tool.call({ tool: 'Edit', file_path: '/p/src/parser.ts', old_string: 'a', new_string: 'b' } as any)
  const ui = await $.ui.mount({ plugin: 'ghostship-bridge', surface: 'terminal', component: 'AbovePrompt', props: {} } as any)
  expect(await ui.find({ type: 'Text', text: /Editing parser\.ts/ })).toBeDefined()
  await ui.unmount()
})

test('an agent\'s gs ask shows in the transcript as "Asked you"', async ($, on) => {
  engine(on)
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'ghostship-bridge', surface: 'terminal', component: 'ToolUse',
    props: { tool: 'Bash', input: { command: 'node .ghostship/core/runtime/gs.mjs ask --kind do --title "Add STRIPE_KEY" --why x' }, isRunning: false, isErrored: false, isInterrupted: false } } as any)
  expect(await ui.find({ type: 'Text', text: /Add STRIPE_KEY/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Asked you/ })).toBeDefined()
  await ui.unmount()
})

test('/gs-bridge before init offers to set the folder up, and turns on once it is, without a restart', async ($, on) => {
  engine(on, false, 1000, ['fs.exists', 'command.register', 'ui.open'])
  let initialised = false
  const registered: string[] = []
  const opened: string[] = []
  const ran: any[] = []
  on('fs.exists', (() => ({ value: initialised })) as any)
  on('command.register', ((_$: any, e: any) => { registered.push(e.name); return { value: { command: e.name } } }) as any)
  on('ui.open', ((_$: any, e: any) => { opened.push(String(e.id)); return { value: { isPlaced: true } } }) as any)
  on('command.run', ((_$: any, e: any, next: any) => { if (e.command === 'ghostship') { ran.push(e); return { text: 'ok' } } return next(e) }) as any)
  await $.session.start(START)
  expect(registered).toContain('gs-bridge')
  const before: any = await $.command.run({ command: 'gs-bridge' } as any)
  expect(JSON.stringify(before)).toMatch(/ghostship init/)
  expect(opened).toContain('ghostship-bridge')
  const ui = await pane($)
  expect(await ui.find({ type: 'Text', text: /isn't a Ghostship project yet/ })).toBeDefined()
  await ui.press({ key: 'init' })
  await ui.unmount()
  expect(ran.some((r) => r.args === 'init')).toBe(true)
  initialised = true
  const after: any = await $.command.run({ command: 'gs-bridge' } as any)
  expect(JSON.stringify(after)).toMatch(/Bridge open/)
})

test('an ask that carries a command shows it, one key copies it, and Done answers it', async ($, on) => {
  engine(on, true, 1000, ['process.run', 'clock.now', 'clock.every'])
  mock.clock(on, { now: Date.parse('2026-10-06T10:00:00Z') })
  const copied: string[] = []
  on('ui.copy', ((_$: any, e: any) => { copied.push(e.text); return { value: { isCopied: true } } }) as any)
  const calls = fakeGs(on, tick({ asks: [ASK_GIT] }))
  on('prompt.submit', ((_$: any, e: any) => ({ text: e.text })) as any)
  await $.session.start(START)
  const ui = await pane($)
  expect(await ui.find({ type: 'Text', text: /\$ git config --global --add safe\.directory \/workspace\/test/ })).toBeDefined()
  await ui.press({ key: 'ask-3-copy' })
  expect(copied).toEqual(['git config --global --add safe.directory /workspace/test'])
  await ui.press({ key: 'ask-3-done' })
  await ui.unmount()
  expect(flat(calls).some((c) => /ask answer 3 --done/.test(c))).toBe(true)
})

test('Ghostship\'s own asks read without their internal ids', async ($, on) => {
  engine(on, true, 1000, ['process.run'])
  fakeGs(on, tick({ asks: [ASK_DO, ASK_DECIDE] }))
  await $.session.start(START)
  const ui = await pane($)
  const row = await ui.find({ key: 'sel-G-T009' })
  expect(JSON.stringify(row)).toMatch(/Decide T009: parser/)
  expect(JSON.stringify(row)).not.toMatch(/#G-T009/)
  await ui.unmount()
})

test('a typed answer never becomes a choice or a Done it did not say', async ($, on) => {
  engine(on, true, 1000, ['process.run'])
  const calls = fakeGs(on, tick({ asks: [ASK_DO, ASK_STOP1] }))
  const passed: any[] = []
  on('prompt.submit', ((_$: any, e: any) => { passed.push(e); return { text: e.text } }) as any)
  await $.session.start(START)
  const r1: any = await $.prompt.submit({ text: '↳ Answer to #G-stop1: no, change C3 first' } as any)
  expect(JSON.stringify(r1)).toMatch(/Pick one of/)
  const r2: any = await $.prompt.submit({ text: '↳ Answer to #G-stop1: 1' } as any)
  expect(JSON.stringify(r2)).toMatch(/runs a Ghostship command/)
  await $.prompt.submit({ text: '↳ Answer to #1: I have no Stripe account' } as any)
  expect(flat(calls).some((c) => /ask answer 1 --reject I have no Stripe account/.test(c))).toBe(true)
  expect(flat(calls).some((c) => /ask answer G-stop1/.test(c))).toBe(false)
})

test('riskhold lets a test fixture key through, and the status line names the voyage', async ($, on) => {
  engine(on, true, 1000, ['ui.status'])
  const lines: any[] = []
  on('ui.status', ((_$: any, e: any) => { lines.push(e.text ?? e); return { value: undefined } }) as any)
  await $.session.start(START)
  expect(JSON.stringify(await $.tool.call({ tool: 'Read', file_path: '/p/tests/fixtures/server.key' } as any))).not.toMatch(/riskhold/)
  expect(JSON.stringify(await $.tool.call({ tool: 'Read', file_path: '/p/deploy/server.key' } as any))).toMatch(/riskhold/)
  expect(JSON.stringify(lines)).toMatch(/⛴ math · ◉ Build 1\/4 · T001 ◐ 1\/3 · ☐ 2 for you/)
})

test('roadmap: every stage and plan phase, ✓ when done, a green turning square on the step in hand while Claude works', async ($, on) => {
  engine(on, true, 1000, ['process.run', 'clock.now', 'clock.every'])
  const clock = mock.clock(on, { now: Date.parse('2026-10-06T10:00:00Z') })
  fakeGs(on)
  on('prompt.submit', ((_$: any, e: any) => ({ text: e.text })) as any)
  await $.session.start(START)
  const ui = await paneRaw($)
  expect(await ui.find({ type: 'Text', text: /^Roadmap$/ })).toBeDefined()
  for (const done of ['Discover', 'Design', 'Checks', 'Plan']) expect(await ui.find({ type: 'Text', text: new RegExp(`^${done}$`) })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1 · skeleton/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /2 · maths/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /STOP 2: you approve the release/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^◼$/ })).toBeDefined()
  await $.prompt.submit({ text: 'carry on' } as any)
  await ui.redraw({ isFocused: true, bodyColumns: 70 } as any)
  const a = JSON.stringify(await ui.drawn())
  await clock.advance(500)
  await ui.redraw({ isFocused: true, bodyColumns: 70 } as any)
  const b = JSON.stringify(await ui.drawn())
  expect(a).toMatch(/[◰◳◲◱]/)
  expect(a).not.toBe(b)
  await ui.unmount()
})

test('autonomy: the header shows the mode, a parked task shows on the roadmap and the board', async ($, on) => {
  engine(on, true, 1000, ['process.run'])
  const parkedTick = tick({
    autonomy: { mode: 'autopilot', nightShift: true, nightShiftAt: 90, autoRetries: 1 }, parked: ['T009'],
    tasks: [
      { id: 'T000', title: 'Skeleton', status: 'MERGED', attempt: 1, max: 3, blockedBy: [], checks: [], phase: '1-skeleton' },
      { id: 'T009', title: 'Parser', status: 'PARKED', attempt: 4, max: 4, blockedBy: [], checks: [], phase: '1-skeleton' },
      { id: 'T001', title: 'Add two numbers', status: 'BUILDING', attempt: 1, max: 3, blockedBy: [], checks: ['C1'], phase: '2-maths' },
    ],
  })
  fakeGs(on, parkedTick)
  await $.session.start(START)
  const ui = await paneRaw($)
  expect(await ui.find({ type: 'Text', text: /\[autopilot ☾\]/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1 parked/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /parked after their retries \(T009\)/ })).toBeDefined()
  await ui.press({ key: 'tab-tasks' })
  expect(await ui.find({ type: 'Text', text: /parked — at STOP 2/ })).toBeDefined()
  await ui.unmount()
})

test('autonomy: Menu → Mode runs gs autonomy with the owner key on stdin, never on argv', async ($, on) => {
  engine(on, true, 1000, ['process.run', 'clock.now', 'clock.every'])
  mock.clock(on, { now: Date.parse('2026-10-06T10:00:00Z') })
  mock.env(on, { HOME: '/home/o' })
  const key = 'e'.repeat(64)
  on('fs.read', ((_$: any, e: any) => ({ value: String(e.path ?? e).includes('/home/o/.ghostship/bridge.key') ? `${key}\n` : '' })) as any)
  const calls = fakeGs(on, tick({ approvals: 'bridge', autonomy: { mode: 'autopilot', nightShift: false, nightShiftAt: 90, autoRetries: 1 } }))
  await $.session.start(START)
  const ui = await paneRaw($)
  await ui.press({ key: 'tab-menu' })
  await ui.press({ key: 'menu-mode-b' })
  expect(await ui.find({ type: 'Text', text: /How much should Ghostship ask you\?/ })).toBeDefined()
  await ui.press({ key: 'mode-full-b' })
  await ui.press({ key: 'tab-menu' })
  await ui.press({ key: 'menu-mode-b' })
  await ui.press({ key: 'mode-night' })
  await ui.unmount()
  const full = calls.find((c) => /autonomy full --owner-key-stdin/.test(c.argv.join(' ')))
  expect(full).toBeDefined()
  expect(full!.stdin).toBe(key)
  expect(full!.argv.join(' ')).not.toContain(key)
  expect(calls.some((c) => /autonomy autopilot --night-shift on --owner-key-stdin/.test(c.argv.join(' ')))).toBe(true)
})

test('autonomy: in terminal approvals the mode switch copies the command instead', async ($, on) => {
  engine(on, true, 1000, ['process.run', 'clock.now', 'clock.every'])
  mock.clock(on, { now: Date.parse('2026-10-06T10:00:00Z') })
  const copied: string[] = []
  on('ui.copy', ((_$: any, e: any) => { copied.push(e.text); return { value: { isCopied: true } } }) as any)
  const calls = fakeGs(on, tick({ approvals: 'terminal', autonomy: { mode: 'autopilot', nightShift: false, nightShiftAt: 90, autoRetries: 1 } }))
  await $.session.start(START)
  const ui = await paneRaw($)
  await ui.press({ key: 'tab-menu' })
  await ui.press({ key: 'menu-mode-b' })
  await ui.press({ key: 'mode-guided-b' })
  await ui.unmount()
  expect(copied).toEqual(['node .ghostship/core/runtime/gs.mjs autonomy guided'])
  expect(calls.some((c) => /autonomy guided/.test(c.argv.join(' ')))).toBe(false)
})

test('band (claude-deck look) idle with nothing for you: one line of chips — the stage and context, never the limits or spend', async ($, on) => {
  engine(on, true, 1000, [], tick({ asks: [], status: { stage: 'build', next: 'gs task start T002', active: null, needsDecision: [] },
    claude: { fiveHour: { percent: 62, resetsAt: '2026-10-06T12:14:00Z' }, sevenDay: { percent: 31, resetsAt: null } } }))
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'ghostship-bridge', surface: 'terminal', component: 'AbovePrompt', props: {} } as any)
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toMatch(/Build 1\/4/)
  expect(drawn).toMatch(/ctx /)
  expect(drawn).not.toMatch(/5h /)
  expect(drawn).not.toMatch(/7d /)
  expect(drawn).not.toMatch(/project/)
  await ui.unmount()
})

test('a background builder stays on the band after Claude\'s own turn ends, with what it is doing', async ($, on) => {
  engine(on)
  on('prompt.submit', ((_$: any, e: any) => ({ text: e.text })) as any)
  on('turn.complete', (_$: any, e: any) => ({ text: e.answer ?? '' }))
  await $.session.start(START)
  await $.prompt.submit({ text: 'build T001' } as any)
  await $.tool.call({ tool: 'Edit', file_path: '/p/src/parser.ts', old_string: 'a', new_string: 'b', agentId: 'ag1' } as any)
  await $.turn.complete({ answer: 'waiting on the builder', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as any)
  const ui = await $.ui.mount({ plugin: 'ghostship-bridge', surface: 'terminal', component: 'AbovePrompt', props: { bodyColumns: 120 } } as any)
  expect(JSON.stringify(await ui.drawn())).toMatch(/Editing parser\.ts/)
  expect(JSON.stringify(await ui.drawn())).toMatch(/waiting on 1 agent/)
  await ui.unmount()
})

const AP_RUNNING = { status: 'running', pid: 4242, step: 7, lastStepAt: '2026-10-06T09:59:30Z', last: { id: 'builder', say: 'Builder on T001 (attempt 1/3)' } }
const NEXT_BUILDER = { kind: 'agent', id: 'builder', say: 'Build T001 with a fresh builder', why: 'T001 is BUILDING', role: 'builder', task: 'T001' }

test('autopilot runner: the Crew tab shows it with its step, Stop runs gs autopilot stop; the ➜ line comes from gs next', async ($, on) => {
  engine(on, true, 1000, ['process.run', 'clock.now', 'clock.every'])
  mock.clock(on, { now: Date.parse('2026-10-06T10:00:00Z') })
  const calls = fakeGs(on, tick({ autopilot: AP_RUNNING, next: NEXT_BUILDER }))
  await $.session.start(START)
  const ui = await paneRaw($)
  expect(await ui.find({ type: 'Text', text: /Build T001 with a fresh builder/ })).toBeDefined()
  await ui.press({ key: 'tab-crew' })
  expect(await ui.find({ type: 'Text', text: /^Autopilot runner$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /running · step 7 · 30s/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Builder on T001/ })).toBeDefined()
  expect(await ui.find({ key: 'ap-start' })).toBeUndefined()
  await ui.press({ key: 'ap-stop' })
  await ui.unmount()
  expect(flat(calls).some((c) => /gs\.mjs autopilot stop$/.test(c))).toBe(true)
})

test('autopilot runner: not started → Start runs gs autopilot start from the Crew tab and the Menu; a setup task shows "setup"', async ($, on) => {
  engine(on, true, 1000, ['process.run'])
  const calls = fakeGs(on, tick({
    autopilot: null, next: { kind: 'do', id: 'task.start', say: 'Start T001 (gs task start T001)', why: 'T001 is ready' },
    tasks: [{ id: 'T001', title: 'Set up the runners', status: 'BUILDING', attempt: 1, max: 3, blockedBy: [], checks: [], phase: '1-skeleton', setup: true }],
    status: { stage: 'build', next: 'x', active: { id: 'T001', status: 'BUILDING', attempt: 1, max: 3 }, needsDecision: [] }, asks: [],
  }))
  await $.session.start(START)
  const ui = await paneRaw($)
  expect(await ui.find({ type: 'Text', text: /^setup$/ })).toBeDefined()
  await ui.press({ key: 'tab-crew' })
  expect(await ui.find({ type: 'Text', text: /not started/ })).toBeDefined()
  await ui.press({ key: 'ap-start' })
  await ui.press({ key: 'tab-menu' })
  expect(await ui.find({ key: 'menu-ap-start' })).toBeDefined()
  await ui.press({ key: 'menu-ap-start' })
  await ui.unmount()
  expect(flat(calls).filter((c) => /gs\.mjs autopilot start$/.test(c)).length).toBe(2)
})

test('autopilot runner: waiting for the owner shows on the band as a row that needs you; a failure pings once', async ($, on) => {
  engine(on, true, 1000, ['process.run', 'audio.play', 'ui.toast'])
  const toasts: string[] = []
  on('audio.play', () => ({ value: undefined }))
  on('ui.toast', ((_$: any, e: any) => { toasts.push(String(e.text)); return { value: undefined } }) as any)
  let tickJson = tick({ asks: [], alerts: [], status: { stage: 'release', next: 'x', active: null, needsDecision: [] },
    autopilot: { ...AP_RUNNING, status: 'waiting-owner', last: { id: 'release.approve', say: 'Approve the release (STOP 2)' } },
    next: { kind: 'owner', id: 'release.approve', say: 'Approve the release (STOP 2)', why: 'the candidate is built', owner: { gate: 'release', command: 'gs release approve' } } })
  on('process.run', (() => ({ value: { exitCode: 0, stdout: tickJson, stderr: '' } })) as any)
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'ghostship-bridge', surface: 'terminal', component: 'AbovePrompt', props: { bodyColumns: 120 } } as any)
  expect(await ui.find({ type: 'Text', text: /autopilot waits for you:/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Approve the release \(STOP 2\)/ })).toBeDefined()
  await ui.unmount()
  expect(toasts.some((t) => /Autopilot stopped/.test(t))).toBe(false)
  tickJson = tick({ asks: [], alerts: [], autopilot: { ...AP_RUNNING, status: 'failed', lastStepAt: '2026-10-06T10:01:00Z', last: { id: 'builder', say: 'builder failed 3 times: no headless agent' } } })
  await $.command.run({ command: 'gs-bridge' } as any)
  await $.command.run({ command: 'gs-bridge' } as any)
  expect(toasts.filter((t) => /Autopilot stopped: builder failed 3 times/.test(t)).length).toBe(1)
  const pane = await paneRaw($)
  await pane.press({ key: 'tab-crew' })
  expect(await pane.find({ type: 'Text', text: /Why it stopped: builder failed 3 times/ })).toBeDefined()
  await pane.unmount()
})

test('the masthead shows the wordmark, tagline and who built it', async ($, on) => {
  engine(on)
  await $.session.start(START)
  const ui = await paneRaw($)
  expect(await ui.find({ type: 'Text', text: /GHOSTSHIP/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /an agentic security platform/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Shekhar/ })).toBeDefined()
  await ui.unmount()
})

test('keeper clears at a task boundary past the soft limit, not mid-task', async ($, on) => {
  // Mid-task (a task BUILDING) past soft: it asks but does not clear. At a boundary (no active task): it clears.
  engine(on, true, 160000, ['process.run', 'clock.now', 'clock.every'])
  const clock = mock.clock(on, { now: 1000 })
  let active: any = { id: 'T001', status: 'BUILDING', attempt: 1, max: 3 }
  on('process.run', ((_$: any, e: any) => {
    const a = [...(e.argv ?? [])].join(' ')
    if (/bridge tick/.test(a)) return { value: { exitCode: 0, stdout: tick({ status: { stage: 'build', next: 'x', active, needsDecision: [] } }), stderr: '' } }
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  }) as any)
  const ran: string[] = []
  on('command.run', ((_$: any, e: any) => { ran.push(e.command); return { value: { ok: true } } }) as any)
  on('turn.complete', (_$: any, e: any) => ({ text: e.answer ?? '' }))
  on('prompt.submit', ((_$: any, e: any) => ({ text: e.text })) as any)
  await $.session.start(START)
  const t = { answer: 'ok', durationMs: 1, isAborted: false, reason: 'answer' } as any
  await $.turn.complete({ ...t, turnId: 'm1' })           // idle -> asked
  await $.turn.complete({ ...t, turnId: 'm2' })           // asked, mid-task: must NOT clear
  expect(ran).not.toContain('clear')
  active = null                                            // the task merged: a boundary
  await $.turn.complete({ ...t, turnId: 'm3' })
  await clock.advance(3000)                                // clearAndResume schedules clear then resume
  expect(ran).toContain('clear')
  await clock.advance(3000)
})

test('step history: the prompt, each tool call with its outcome, and the turn end show in the Crew tab', async ($, on) => {
  engine(on)
  on('prompt.submit', ((_$: any, e: any) => ({ text: e.text })) as any)
  on('turn.complete', (_$: any, e: any) => ({ text: e.answer ?? '' }))
  await $.session.start(START)
  await $.prompt.submit({ text: 'fix the cart total' } as any)
  await $.tool.call({ tool: 'Edit', file_path: '/p/src/cart.ts', old_string: 'a', new_string: 'b' } as any)
  await $.tool.call({ tool: 'Read', file_path: '/p/src/coupon.ts' } as any)
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as any)
  const ui = await paneRaw($)
  await ui.press({ key: 'tab-crew' })
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toMatch(/Recent steps/)
  expect(drawn).toMatch(/fix the cart total/)   // the prompt (› turn)
  expect(drawn).toMatch(/Editing cart\.ts/)     // a tool step
  expect(drawn).toMatch(/actions/)              // the turn end: "Done in Ns, N actions"
  await ui.unmount()
})

test('deck countdown/humanReset: real countdown for ISO or epoch, empty (never NaN) for junk or missing', async () => {
  const now = Date.parse('2026-10-06T10:00:00Z')
  expect(countdown(new Date(now + 3600000).toISOString(), now)).toBe('1:00:00')
  expect(countdown(Math.floor(now / 1000) + 3600, now as any)).toBe('1:00:00')   // epoch seconds
  expect(humanReset(new Date(now + 2 * 86400000).toISOString(), now)).toBe('2d 0h')
  expect(humanReset(Math.floor(now / 1000) + 3600 as any, now)).toBe('1h0m')     // epoch seconds
  for (const bad of ['not-a-date', '', null, undefined]) {
    expect(countdown(bad as any, now)).toBe('')
    expect(humanReset(bad as any, now)).toBe('')
  }
})
