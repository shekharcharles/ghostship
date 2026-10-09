// State the Ghostship Bridge mod keeps for the session.
export type BridgeTask = { id: string; status: string; attempt: number; max: number }
export type BridgeTaskRow = { id: string; title: string; status: string; attempt: number; max: number; blockedBy: string[]; checks: string[]; phase?: string | null; /** A setup (skeleton) task: no failing test first, the build and tests must pass. */ setup?: boolean }
export type BridgeRun = { runId: string; role: string; task: string | null; agentId: string; mode: string; status: string; blocked: boolean; startedAt?: string | null }
export type BridgeAlert = { at: string; level: string; alert: string }
export type BridgeAsk = {
  id: string
  kind: 'do' | 'answer' | 'choose'
  title: string
  why: string
  doneWhen: string
  options: string[]
  source: string
  at: string | null
  /** For asks Ghostship raises itself: the command an option runs (prd, acceptance, release, go, decide). */
  gate: string | null
  task: string | null
  /** A shell command the owner runs for this ask, shown with a key that copies it. */
  command: string | null
}
export type PlanWindow = { percent: number; resetsAt: string | null; burnPerHour?: number | null }
export type ClaudePlan = { fiveHour?: PlanWindow; sevenDay?: PlanWindow }
export type BridgeSnap = {
  project: string
  stage: string
  next: string
  active: BridgeTask | null
  needsDecision: string[]
  run: BridgeRun | null
  paused: boolean
  recent: BridgeAlert[]
  contextPercent: number | null
  usd: number | null
  asks: BridgeAsk[]
  claude: ClaudePlan | null
  tasks: BridgeTaskRow[]
  interview: { closed: number; total: number } | null
  approvals: string
  version: string | null
  author: string
  tagline: string
  /** How much Ghostship asks the owner after the PRD (autonomy.mode), and the policy around it. */
  autonomy: Autonomy | null
  /** Tasks the engine parked after their retries; the owner sees them at STOP 2. */
  parked: string[]
  /** Builders, judges and planners seen working in the last 5 minutes, with their last step in words. */
  agents?: Array<{ role: string; step: string; at: number }>
  /** The headless autopilot runner (gs autopilot), when one has run. */
  autopilot: Autopilot | null
  /** The one next step, from gs next. */
  nextStep: NextStep | null
  /** Claude spend on this project from its first session to now. */
  spend: { usd: number; sessions: number } | null
}
export type Autopilot = { status: 'running' | 'waiting-owner' | 'paused' | 'stopped' | 'failed'; pid: number | null; step: number; lastStepAt: string | null; last: { id: string; say: string } | null }
export type NextStep = { kind: 'do' | 'agent' | 'owner' | 'wait' | 'done'; id: string; say: string; why: string; command?: string; owner?: { gate: string; command: string } }
export type Autonomy = { mode: 'guided' | 'autopilot' | 'full'; nightShift: boolean; nightShiftAt: number; autoRetries: number }
export type Step = { label: string; at: number; waiting: boolean }
export type SubStep = Step & { name: string }
export type BridgeActivity = { main: Step | null; subs: Record<string, SubStep> }
export type KeeperPhase = 'idle' | 'asked' | 'clearing'
export type StepOutcome = 'ok' | 'error' | 'denied' | 'interrupted'
export type StepEntry = { kind: 'turn' | 'tool' | 'end'; label: string; durationMs: number | null; outcome: StepOutcome; at: number }

export type View = 'roadmap' | 'queue' | 'tasks' | 'crew' | 'log' | 'menu'
/** A field open in the pane: an answer or a reason for an ask, or the words for a menu command. */
export type Editing = { id: string; field: 'answer' | 'reason' | 'add' | 'change' | 'solve'; held?: string }
/** An approving option pressed once, waiting for y (or, in terminal mode, showing the command to run). */
export type Confirm = { askId: string; option: number }
export type Flash = { text: string; tone: 'ok' | 'warn' | 'err'; at: number }
export type BridgeUi = {
  view: View
  selected: string | null
  editing: Editing | null
  confirm: Confirm | null
  flash: Flash | null
  /** True while Claude's turn runs: answers wait for its end instead of interrupting. */
  busy: boolean
  /** Asks answered but not yet sent to Claude. */
  waiting: string[]
  /** The Menu's mode chooser is open. */
  chooser?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'ghostship-bridge': { snap: BridgeSnap | null; keeper: KeeperPhase; activity: BridgeActivity; ui: BridgeUi; initialised: boolean; history: StepEntry[] }
  }
}
