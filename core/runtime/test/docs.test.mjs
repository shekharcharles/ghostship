// Docs system: Markdown safety, OpenAPI page, code explorer index, site build with Mermaid, tar.gz, scaffold/check/trace, CI file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { renderMarkdown } from '../lib/markdown.mjs';
import { renderOpenApi } from '../lib/openapi.mjs';
import { parseYaml } from '../lib/yaml.mjs';
import { indexRepo, explorerHtml } from '../lib/explorer.mjs';
import { buildSite, packSite } from '../lib/docsite.mjs';
import * as DOC from '../lib/docs.mjs';
import { projectAtBuild, put, CORE, GS, git } from './project.mjs';

test('markdown: GFM tables, tasks, nested lists, fences; raw HTML and javascript: links neutralised', () => {
  const r = renderMarkdown('# Hi there\n\n<img src=x onerror=alert(1)> [x](javascript:alert(1))\n\n| a | b |\n|:-:|---|\n| 1 | 2 |\n\n- [ ] todo\n  - sub\n\n```mermaid\ngraph TD; A-->B\n```\n');
  assert.match(r.html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(r.html, /<a href="#">x<\/a>/);
  assert.match(r.html, /<th style="text-align:center">a<\/th>/);
  assert.match(r.html, /<li class="task"><input type="checkbox" disabled> todo<ul><li>sub<\/li><\/ul><\/li>/);
  assert.match(r.html, /<pre class="mermaid">graph TD; A--&gt;B<\/pre>/);
  assert.deepEqual(r.headings, [{ level: 1, text: 'Hi there', id: 'hi-there' }]);
});

test('OpenAPI YAML with block scalars and $refs renders an API reference', () => {
  const doc = parseYaml(`openapi: 3.0.3
info:
  title: Math API
  version: "1.0"
  description: |
    Adds and subtracts.
paths:
  /add:
    post:
      summary: Add two numbers
      parameters:
        - name: trace
          in: header
          schema: {type: string}
      requestBody:
        content:
          application/json:
            schema: {$ref: "#/components/schemas/Pair"}
      responses:
        "200":
          description: The sum
components:
  schemas:
    Pair:
      type: object
      required: [a, b]
      properties:
        a: {type: number}
        b: {type: number}
`);
  const r = renderOpenApi(doc);
  assert.equal(r.operations, 1);
  assert.match(r.html, /<span class="verb verb-post">POST<\/span>/);
  assert.match(r.html, /<code>a<\/code><\/td><td>number<\/td><td>yes/);
  assert.match(r.html, /id="schema-Pair"/);
});

test('explorer index: symbols, purposes, imports both ways; the page embeds data safely', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gs-ex-'));
  try {
    git(tmpdir(), 'init', '-q', dir);
    put(dir, 'src/a.js', "// Entry point.\nimport { b } from './b.js';\nimport fs from 'node:fs';\nexport function main() { return b(); }\nclass Thing {}\n");
    put(dir, 'src/b.js', "// Helper with </script> in it.\nexport const b = () => 1;\n");
    put(dir, 'app/models.py', '"""Data models."""\nclass User:\n    def name(self):\n        pass\n');
    put(dir, 'node_modules/x/index.js', 'skip me');
    const idx = indexRepo(dir);
    const a = idx.files.find((f) => f.path === 'src/a.js');
    assert.deepEqual(a.symbols.map((s) => s.name), ['main', 'Thing']);
    assert.deepEqual(a.imports, ['src/b.js']);
    assert.deepEqual(a.external, ['node:fs']);
    assert.deepEqual(idx.files.find((f) => f.path === 'src/b.js').importedBy, ['src/a.js']);
    assert.deepEqual(idx.files.find((f) => f.path === 'app/models.py').symbols.map((s) => s.name), ['User', 'name']);
    assert.ok(!idx.files.some((f) => f.path.includes('node_modules')));
    const html = explorerHtml(idx, { title: 'x' });
    assert.ok(!html.includes('Helper with </script>'), 'data cannot close the script tag');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('docs: scaffold for the tier, check finds TODOs, trace, site with diagrams + API + explorer, tar.gz, CI file', () => {
  const dir = projectAtBuild();
  try {
    assert.ok(existsSync(join(dir, 'docs/05-code/DEVELOPER-GUIDE.md')), 'scaffolded at design');
    let c = DOC.check(dir);
    assert.equal(c.ok, false);
    assert.ok(c.unfilled.includes('docs/05-code/DEVELOPER-GUIDE.md'));
    for (const f of [...c.unfilled]) put(dir, f, `# ${f}\n\nFilled in.\n\n\`\`\`mermaid\ngraph LR; A-->B\n\`\`\`\n`);
    c = DOC.check(dir);
    assert.equal(c.ok, true, JSON.stringify(c));
    put(dir, 'docs/02-design/api/openapi.yaml', 'openapi: 3.0.3\ninfo:\n  title: Math\n  version: "1"\npaths:\n  /add:\n    get:\n      summary: Add\n      responses:\n        "200":\n          description: ok\n');
    const t = DOC.traceability(dir);
    assert.equal(t.rows.length, 2);
    assert.equal(t.rows[0].requirement, 'add');
    const r = buildSite(dir, { out: 'docs-site', version: 'v0.1.0', coreDirs: [CORE] });
    assert.equal(r.api, true);
    assert.equal(r.mermaid, true, 'bundled Mermaid found in the core');
    const html = readFileSync(join(dir, 'docs-site/index.html'), 'utf8');
    assert.match(html, /<title>math docs v0\.1\.0<\/title>/);
    assert.match(html, /API reference/);
    assert.match(html, /Traceability/);
    assert.ok(html.length > 1e6, 'Mermaid is inlined, so the site works offline');
    assert.ok(existsSync(join(dir, 'docs-site/explorer.html')));
    const p = packSite(dir, 'docs-site', 'docs-site/math-docs.tar.gz', 'math-docs');
    const list = spawnSync('tar', ['tzf', join(dir, p.path)], { encoding: 'utf8' }).stdout.trim().split('\n');
    assert.deepEqual(list, ['math-docs/explorer.html', 'math-docs/index.html']);
    const ci = spawnSync(process.execPath, [GS, 'ci', 'init'], { cwd: dir, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: '' } });
    assert.match(ci.stdout, /\.github\/workflows\/ghostship\.yml/);
    const yml = readFileSync(join(dir, '.github/workflows/ghostship.yml'), 'utf8');
    assert.match(yml, /run: node scripts\/unit\.mjs/);
    assert.match(yml, /run: node scripts\/acc\.mjs tests\/acceptance\/\*/);
    assert.match(yml, /gs\.mjs audit/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
