// Every path Ghostship uses inside a project, in one place.
export const GS_DIR = '.ghostship';
export const STATE_DIR = '.ghostship/state';
export const EVIDENCE_DIR = '.ghostship/evidence';
export const INTERVIEW_DIR = '.ghostship/interview';
export const CORE_DIR = '.ghostship/core';
export const LEARNED_DIR = '.ghostship/learned';
export const DRAFTS_DIR = '.ghostship/drafts';
export const RUNS_DIR = '.ghostship/runs';
export const HANDOFF_DIR = '.ghostship/handoff';
export const CONFIG_FILE = '.ghostship/config.yaml';
export const VERSION_FILE = '.ghostship/VERSION';

export const DOCS = {
  requirements: 'docs/01-requirements',
  prd: 'docs/01-requirements/PRD.md',
  prdDraft: 'docs/01-requirements/PRD.draft.md',
  traceability: 'docs/01-requirements/TRACEABILITY.md',
  design: 'docs/02-design',
  acceptance: 'docs/03-acceptance/ACCEPTANCE-CHECKS.md',
  acceptanceDraft: 'docs/03-acceptance/ACCEPTANCE-CHECKS.draft.md',
  roadmap: 'docs/04-plan/ROADMAP.md',
  codemap: 'docs/05-code/CODEMAP.md',
  releases: 'docs/10-releases',
  changelog: 'docs/10-releases/CHANGELOG.md',
  memory: 'docs/11-memory',
  research: 'docs/research',
  archive: 'docs/archive',
};

export const TASKS_DIR = 'tasks';
export const BOARD_FILE = 'tasks/BOARD.md';
export const ACCEPTANCE_TESTS_DIR = 'tests/acceptance';

// Paths whose churn must never invalidate code evidence (written by the CLI/orchestrator, not product code).
export const TREE_EXCLUDES = ['.ghostship/state', '.ghostship/evidence', '.ghostship/runs', '.ghostship/handoff',
  '.ghostship/interview', '.ghostship/drafts', '.ghostship/usage', '.ghostship/learned', 'tasks', 'docs/11-memory'];
