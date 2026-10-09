// Gateway: protocol translation both ways, streaming, auth, localhost-only, and refusal to wrap subscription logins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  anthropicToOpenAIRequest, openAIToAnthropicResponse, openAIStreamToAnthropic,
  openAIToAnthropicRequest, anthropicToOpenAIResponse, anthropicStreamToOpenAI, sseParser,
} from '../gateway/convert.mjs';
import { createGateway, resolveRoute } from '../gateway/server.mjs';
import { defaultConfig, saveConfig } from '../lib/config.mjs';
import { initProject } from '../lib/init.mjs';
import { CORE, GS } from './project.mjs';

const TOOL_REQ = {
  model: 'qwen-coder', max_tokens: 500, system: [{ type: 'text', text: 'Be brief.' }],
  tools: [{ name: 'read_file', description: 'Read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }],
  tool_choice: { type: 'auto' },
  messages: [
    { role: 'user', content: 'Open a.txt' },
    { role: 'assistant', content: [{ type: 'text', text: 'Reading.' }, { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a.txt' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'hello' }] }, { type: 'text', text: 'Summarise.' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] },
  ],
};

test('Anthropic → OpenAI request: system, tool calls, tool results before user text, images, tools', () => {
  const o = anthropicToOpenAIRequest(TOOL_REQ, 'qwen2.5-coder');
  assert.equal(o.model, 'qwen2.5-coder');
  assert.deepEqual(o.messages[0], { role: 'system', content: 'Be brief.' });
  assert.deepEqual(o.messages[2].tool_calls[0], { id: 'toolu_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } });
  assert.deepEqual(o.messages[3], { role: 'tool', tool_call_id: 'toolu_1', content: 'hello' });
  assert.equal(o.messages[4].content[1].image_url.url, 'data:image/png;base64,AAAA');
  assert.equal(o.tools[0].function.parameters.properties.path.type, 'string');
  assert.equal(o.tool_choice, 'auto');
});

test('OpenAI → Anthropic response and stream (text then a tool call)', () => {
  const r = openAIToAnthropicResponse({ choices: [{ message: { content: 'Hi', tool_calls: [{ id: 'c1', function: { name: 'read_file', arguments: '{"path":"b"}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 7, completion_tokens: 3 } }, 'qwen-coder');
  assert.deepEqual(r.content, [{ type: 'text', text: 'Hi' }, { type: 'tool_use', id: 'c1', name: 'read_file', input: { path: 'b' } }]);
  assert.equal(r.stop_reason, 'tool_use');
  assert.deepEqual(r.usage, { input_tokens: 7, output_tokens: 3 });
  const s = openAIStreamToAnthropic('qwen-coder');
  let text = '';
  for (const c of [
    { choices: [{ delta: { role: 'assistant', content: 'He' } }] }, { choices: [{ delta: { content: 'llo' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c9', function: { name: 'read_file', arguments: '{"pa' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"x"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }, { choices: [], usage: { prompt_tokens: 5, completion_tokens: 9 } }, '[DONE]',
  ]) text += s.push(c);
  const evs = sseParser()(text).map((e) => ({ event: e.event, ...JSON.parse(e.data) }));
  assert.deepEqual(evs.map((e) => e.event), ['message_start', 'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop',
    'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
  assert.equal(evs[5].content_block.name, 'read_file');
  assert.equal(evs.filter((e) => e.delta?.type === 'input_json_delta').map((e) => e.delta.partial_json).join(''), '{"path":"x"}');
  assert.equal(evs[9].delta.stop_reason, 'tool_use');
  assert.equal(evs[9].usage.output_tokens, 9);
});

test('OpenAI → Anthropic request and Anthropic → OpenAI response/stream', () => {
  const a = openAIToAnthropicRequest({ model: 'x', messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'q' },
    { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }] },
    { role: 'tool', tool_call_id: 't1', content: 'r1' }, { role: 'user', content: 'next' }], tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object' } } }], tool_choice: 'required', stop: 'END' }, 'claude-sonnet-x');
  assert.equal(a.system, 'S');
  assert.equal(a.max_tokens, 4096);
  assert.deepEqual(a.messages[1].content[0], { type: 'tool_use', id: 't1', name: 'f', input: { a: 1 } });
  assert.deepEqual(a.messages[2].content.map((b) => b.type), ['tool_result', 'text'], 'tool result and next user text merge into one user turn');
  assert.deepEqual(a.tool_choice, { type: 'any' });
  assert.deepEqual(a.stop_sequences, ['END']);
  const o = anthropicToOpenAIResponse({ content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 't2', name: 'f', input: {} }], stop_reason: 'tool_use', usage: { input_tokens: 3, output_tokens: 2 } }, 'x');
  assert.equal(o.choices[0].finish_reason, 'tool_calls');
  assert.equal(o.usage.total_tokens, 5);
  const s = anthropicStreamToOpenAI('x');
  const out = [{ type: 'message_start', message: { usage: { input_tokens: 4 } } }, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } }, { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't3', name: 'f' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } }, { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 6 } }, { type: 'message_stop' }]
    .map((e) => s.push(e)).join('');
  const chunks = out.split('\n\n').filter(Boolean).map((l) => l.slice(6));
  assert.equal(chunks.at(-1), '[DONE]');
  const parsed = chunks.slice(0, -1).map((c) => JSON.parse(c));
  assert.equal(parsed[1].choices[0].delta.content, 'Hi');
  assert.equal(parsed[2].choices[0].delta.tool_calls[0].function.name, 'f');
  assert.equal(parsed.at(-1).choices[0].finish_reason, 'tool_calls');
});

test('routes: local must be loopback; subscription OAuth tokens and logins are refused', () => {
  const c = defaultConfig({ name: 'g' });
  c.providers.q = { type: 'local', baseUrl: 'http://127.0.0.1:1234/v1' };
  c.providers.evil = { type: 'local', baseUrl: 'http://10.0.0.5/v1' };
  c.providers.ant = { type: 'anthropic-api-key', key: 'ANT' };
  c.gateway.routes = { a: { provider: 'q', model: 'm' }, b: { provider: 'evil', model: 'm' }, c: { provider: 'ant', model: 'm' }, d: { provider: 'claude-subscription', model: 'opus' } };
  assert.equal(resolveRoute(c, 'a').baseUrl, 'http://127.0.0.1:1234/v1');
  assert.throws(() => resolveRoute(c, 'b'), /not on localhost/);
  assert.throws(() => resolveRoute(c, 'c', { getSecret: () => 'sk-ant-oat01-abc' }), /OAuth token/);
  assert.equal(resolveRoute(c, 'c', { getSecret: () => 'sk-ant-api03-abc' }).headers['x-api-key'], 'sk-ant-api03-abc');
  assert.throws(() => resolveRoute(c, 'd'), /cannot sit behind the gateway/);
  assert.throws(() => resolveRoute(c, 'zzz'), /No gateway route/);
});

function fakeOpenAI() {
  const seen = [];
  const srv = createServer(async (req, res) => {
    let b = ''; for await (const c of req) b += c;
    const body = JSON.parse(b);
    seen.push({ auth: req.headers.authorization || null, body });
    if (!body.stream) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ choices: [{ message: { content: `echo:${body.messages.at(-1).content}` }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1 } })); }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const t of ['Hel', 'lo']) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok({ srv, port: srv.address().port, seen })));
}

test('live gateway: Claude-style client → local OpenAI-compatible model, plain and streaming; key required', async () => {
  const up = await fakeOpenAI();
  const c = defaultConfig({ name: 'g' });
  c.providers.q = { type: 'local', baseUrl: `http://127.0.0.1:${up.port}/v1` };
  c.gateway.routes = { 'qwen-coder': { provider: 'q', model: 'qwen2.5-coder' } };
  const logs = [];
  const g = createGateway({ cfg: c, clientKey: 'k'.repeat(48), log: (e) => logs.push(e) });
  const port = await g.listen(0);
  const call = (path, body, key = 'k'.repeat(48)) => fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key }, body: JSON.stringify(body) });
  try {
    assert.equal(g.server.address().address, '127.0.0.1');
    assert.equal((await call('/v1/messages', { model: 'qwen-coder', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }, 'wrong')).status, 401);
    const r = await (await call('/v1/messages', { model: 'qwen-coder', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] })).json();
    assert.equal(r.content[0].text, 'echo:hi');
    assert.equal(r.model, 'qwen-coder');
    assert.equal(up.seen[0].body.model, 'qwen2.5-coder');
    assert.equal(up.seen[0].auth, null, 'the client key is never forwarded upstream');
    const st = await call('/v1/messages', { model: 'qwen-coder', max_tokens: 5, stream: true, messages: [{ role: 'user', content: 'hi' }] });
    const evs = sseParser()(await st.text()).map((e) => JSON.parse(e.data));
    assert.equal(evs.filter((e) => e.type === 'content_block_delta').map((e) => e.delta.text).join(''), 'Hello');
    assert.equal(evs.at(-1).type, 'message_stop');
    assert.deepEqual(logs.at(-1).output_tokens, 2);
    const ct = await (await call('/v1/messages/count_tokens', { messages: [{ role: 'user', content: 'x'.repeat(400) }] })).json();
    assert.ok(ct.input_tokens > 90);
    const miss = await call('/v1/messages', { model: 'nope', max_tokens: 5, messages: [] });
    assert.equal(miss.status, 404);
    assert.equal((await miss.json()).error.type, 'not_found_error');
  } finally { g.server.close(); up.srv.close(); }
});

test('gs gateway start/env/stop run a real localhost process', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gs-gw-'));
  try {
    initProject(dir, { name: 'g', coreSrc: CORE, gitIdentity: { name: 't', email: 't@t' }, which: () => null });
    const gs = (...a) => spawnSync(process.execPath, [GS, ...a], { cwd: dir, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: '' } });
    assert.match(gs('gateway', 'start').stderr, /NO_ROUTES/);
    const { loadConfig } = await import('../lib/config.mjs');
    const c = loadConfig(dir);
    c.providers.q = { type: 'local', baseUrl: 'http://127.0.0.1:9/v1' };
    c.gateway.routes = { 'qwen-coder': { provider: 'q', model: 'm' } };
    saveConfig(dir, c);
    const s = gs('gateway', 'start', '--port', '0');
    assert.match(s.stdout, /Gateway on 127\.0\.0\.1:\d+/, s.stderr);
    const info = JSON.parse(readFileSync(join(dir, '.ghostship/runs/gateway.json'), 'utf8'));
    if (process.platform !== 'win32') assert.equal((await import('node:fs')).statSync(join(dir, '.ghostship/runs/gateway.json')).mode & 0o777, 0o600);
    assert.match(gs('gateway', 'env').stdout, new RegExp(`ANTHROPIC_BASE_URL=http://127\\.0\\.0\\.1:${info.port}[\\s\\S]*Remote Control does not work`));
    const models = await (await fetch(`http://127.0.0.1:${info.port}/v1/models`, { headers: { authorization: `Bearer ${info.clientKey}` } })).json();
    assert.deepEqual(models.data.map((m) => m.id), ['qwen-coder']);
    assert.match(gs('gateway', 'stop').stdout, /stopped/);
    await new Promise((ok) => setTimeout(ok, 300));
    assert.match(gs('gateway', 'status').stdout, /Not running/);
    assert.ok(!existsSync(join(dir, '.ghostship/runs/gateway.json')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
