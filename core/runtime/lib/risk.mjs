// Which changed paths make a task risky (the owner sees it before it merges) and which make it visible (a UX lens).
// Risky: the owner's judge.risk-paths keywords (auth, payment, …) plus the categories no one should merge unseen:
// dependency manifests, CI, deploy and hosting config, database migrations. Visible: UI files a person looks at.
import { matchesAny } from './util.mjs';

export const RISK_CATEGORIES = {
  dependency: ['**/package.json', '**/package-lock.json', '**/npm-shrinkwrap.json', '**/yarn.lock', '**/pnpm-lock.yaml', '**/bun.lockb',
    '**/requirements*.txt', '**/pyproject.toml', '**/Pipfile', '**/Pipfile.lock', '**/poetry.lock', '**/uv.lock', '**/setup.py', '**/setup.cfg',
    '**/go.mod', '**/go.sum', '**/Cargo.toml', '**/Cargo.lock', '**/Gemfile', '**/Gemfile.lock', '**/composer.json', '**/composer.lock',
    '**/pom.xml', '**/build.gradle', '**/build.gradle.kts', '**/*.csproj', '**/packages.config'],
  ci: ['.github/**', '.gitlab-ci.yml', '.gitlab/**', '.circleci/**', 'Jenkinsfile', 'azure-pipelines.yml', '.buildkite/**', 'bitbucket-pipelines.yml'],
  deploy: ['**/Dockerfile', '**/Dockerfile.*', '**/*.dockerfile', '**/docker-compose*.yml', '**/docker-compose*.yaml', '**/compose.yml', '**/compose.yaml',
    '**/*.tf', '**/*.tfvars', '**/k8s/**', '**/helm/**', '**/fly.toml', '**/vercel.json', '**/netlify.toml', '**/Procfile', '**/app.yaml',
    '**/serverless.yml', '**/firebase.json', '**/*.rules', '**/deploy*.sh', '**/deploy/**'],
  migration: ['**/migrations/**', '**/migrate/**', '**/*.migration.*', '**/schema.prisma', '**/schema.sql'],
};

export const UI_GLOBS = ['**/*.html', '**/*.htm', '**/*.css', '**/*.scss', '**/*.sass', '**/*.less', '**/*.vue', '**/*.svelte',
  '**/*.jsx', '**/*.tsx', '**/*.astro', '**/*.erb', '**/*.hbs', '**/*.ejs', '**/*.njk', '**/*.twig', '**/*.liquid'];

// A keyword matches a whole word of the path (split on / . _ - and camelCase), with the endings words take:
// auth → auth, authentication, authorization; payment → payments; migration → migrations. `author.js` does not match.
const ENDINGS = '(s|es|ed|ing|ation|ations|entication|orization|orizations)?';
const words = (p) => p.split(/[\\/._\-\s]+|(?<=[a-z0-9])(?=[A-Z])/).filter(Boolean).map((w) => w.toLowerCase());
const keywordHit = (p, kw) => { const re = new RegExp(`^${kw.toLowerCase().replace(/[^a-z0-9]/g, '')}${ENDINGS}$`); return words(p).some((w) => re.test(w)); };

/**
 * Changed paths that need the owner before they merge: [{ path, why }], one entry per path (the first reason found).
 * A setup task (skeleton, kind: setup) creates the toolchain the approved design names, so its dependency manifests
 * are expected; its CI, deploy, migration and risk-path changes still count.
 */
export function riskyPaths(cfg, paths, { setup = false } = {}) {
  const own = (cfg?.judge?.['risk-paths'] || []).map(String).filter(Boolean);
  const globs = own.filter((k) => /[*/]/.test(k));
  const keywords = own.filter((k) => !/[*/]/.test(k));
  const out = [];
  for (const p of paths || []) {
    const cat = Object.entries(RISK_CATEGORIES).find(([k, g]) => !(setup && k === 'dependency') && matchesAny(p, g));
    if (cat) { out.push({ path: p, why: cat[0] }); continue; }
    const kw = keywords.find((k) => keywordHit(p, k));
    if (kw) { out.push({ path: p, why: `risk-paths: ${kw}` }); continue; }
    if (globs.length && matchesAny(p, globs)) out.push({ path: p, why: 'risk-paths' });
  }
  return out;
}

/** Changed paths a person sees (UI templates, components, styles): these get a UX lens. */
export function uiPaths(cfg, paths) {
  const globs = cfg?.judge?.['ui-paths'] || UI_GLOBS;
  return (paths || []).filter((p) => matchesAny(p, globs));
}

/** The lenses a judge must report on for this submission, besides the task's checks: SECURITY, UX. */
export function lensesFor(cfg, submit) {
  const on = new Set(cfg?.judge?.lenses || ['security', 'ux']);
  const out = [];
  if (on.has('security') && submit?.risky?.length) out.push('SECURITY');
  if (on.has('ux') && submit?.ui?.length) out.push('UX');
  return out;
}

/** The dev-server and browser port for a task and role, so two runs never share one: 5100 + 10n (+1 for the judge). */
export function portFor(taskId, role) {
  const n = parseInt(String(taskId || '').replace(/\D/g, ''), 10) || 0;
  return 5100 + 10 * (n % 400) + (role === 'judge' ? 1 : 0);
}
