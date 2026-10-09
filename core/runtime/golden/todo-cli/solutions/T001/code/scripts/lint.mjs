// Syntax-checks every module under bin, src, scripts and tests.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : p.endsWith('.mjs') ? [p] : []; });
let bad = 0;
for (const f of ['bin', 'src', 'scripts', 'tests'].flatMap((d) => { try { return walk(d); } catch { return []; } })) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) { bad++; console.error(r.stderr); }
}
console.log(bad ? `${bad} files with syntax errors` : 'lint clean');
process.exit(bad ? 1 : 0);
