// Coverage map for /ghostship new (software preset, 22 areas). Tracks which areas are closed.

export const SOFTWARE_AREAS = [
  'vision', 'purpose', 'users-stakeholders', 'current-state-market', 'scope', 'features-flows', 'data',
  'integrations', 'platform-ux', 'non-functional', 'security-privacy', 'test', 'tech-constraints',
  'business-model', 'operations', 'timeline-delivery', 'risks-unknowns', 'success-acceptance',
  'ai-llm', 'localisation-currency', 'legal-compliance', 'analytics-observability',
];

const LIGHT_NA = {
  'business-model': 'light tier: not a commercial product decision',
  'legal-compliance': 'light tier: no regulated data assumed',
  'analytics-observability': 'light tier: no production analytics',
  'localisation-currency': 'light tier: single locale',
  'operations': 'light tier: no operational runbook needed',
};

const STATES = new Set(['open', 'answered', 'na', 'assumption']);

export function newCoverage(tier = 'standard') {
  const areas = {};
  for (const a of SOFTWARE_AREAS) areas[a] = { state: 'open', note: '' };
  if (tier === 'light') for (const [a, why] of Object.entries(LIGHT_NA)) areas[a] = { state: 'na', note: why };
  return { preset: 'software', tier, areas };
}

export function markArea(cov, area, state, note = '') {
  if (!cov.areas[area]) throw new Error(`unknown area "${area}". Areas: ${Object.keys(cov.areas).join(', ')}`);
  if (!STATES.has(state)) throw new Error(`state must be one of ${[...STATES].join(', ')}`);
  if (state === 'na' && !String(note).trim()) throw new Error('marking an area N/A needs a reason');
  if (state === 'assumption' && !String(note).trim()) throw new Error('an assumption needs a note saying what was assumed');
  return { ...cov, areas: { ...cov.areas, [area]: { state, note: String(note).trim() } } };
}

export function coverageSummary(cov) {
  const entries = Object.entries(cov.areas);
  return {
    open: entries.filter(([, v]) => v.state === 'open').map(([k]) => k),
    answered: entries.filter(([, v]) => v.state === 'answered').map(([k]) => k),
    na: entries.filter(([, v]) => v.state === 'na').map(([k, v]) => ({ area: k, reason: v.note })),
    assumptions: entries.filter(([, v]) => v.state === 'assumption').map(([k, v]) => ({ area: k, note: v.note })),
  };
}
