// Runs every unit test file under tests/unit and reports the count.
import { readdirSync } from 'node:fs';
const files = readdirSync('tests/unit').filter((f) => f.endsWith('.test.mjs')).sort();
for (const f of files) await import('../tests/unit/' + f);
console.log(files.length ? `${files.length} files passed` : 'no tests found');
