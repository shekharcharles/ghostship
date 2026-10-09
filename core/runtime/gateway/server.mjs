#!/usr/bin/env node
// Ghostship gateway: a localhost-only bridge so Claude Code (Anthropic API) can drive OpenAI-compatible or local models,
// and OpenAI-style clients can use an Anthropic API key. Never forwards a subscription login; never listens beyond 127.0.0.1.
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { writeFileSync, mkdirSync, appendFileSync, rmSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../lib/config.mjs';
import { secret } from '../lib/secrets.mjs';
import { RUNS_DIR } from '../lib/paths.mjs';
import {
  anthropicToOpenAIRequest, openAIToAnthropicResponse, openAIStreamToAnthropic,
  openAIToAnthropicRequest, anthropicToOpenAIResponse, anthropicStreamToOpenAI, sseParser,
} from './convert.mjs';

const HOST = '127.0.0.1';
const MAX_BODY = 20 * 1024 * 1024;
const OAUTH = /^sk-ant-oat/; // Claude subscription OAuth tokens: never wrapped
const isLoopback = (u) => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/.test(u);

export class RouteError extends Error { constructor(status, type, msg) { super(msg); this.status = status; this.type = type; } }

/** Resolve a requested model name to an upstream { kind, baseUrl, headers, model }. */
export function resolveRoute(cfg, requested, { getSecret = secret } = {}) {
  const routes = cfg.gateway?.routes || {};
  const r = routes[requested] || routes['*'];
  if (!r) throw new RouteError(404, 'not_found_error', `No gateway route for model "${requested}". Add gateway.routes in .ghostship/config.yaml.`);
  const p = cfg.providers?.[r.provider];
  if (!p) throw new RouteError(500, 'api_error', `Route ${requested}: provider "${r.provider}" is not defined`);
  const headers = {};
  const key = p.key ? getSecret(p.key) : null;
  if (key && OAUTH.test(key)) throw new RouteError(403, 'permission_error', `Provider ${r.provider} holds a subscription OAuth token. The gateway only uses API keys.`);
  if (p.type === 'local') {
    if (!isLoopback(p.baseUrl || '')) throw new RouteError(500, 'api_error', `Provider ${r.provider} is "local" but not on localhost`);
    if (key) headers.authorization = `Bearer ${key}`;
    return { kind: 'openai', baseUrl: p.baseUrl.replace(/\/$/, ''), headers, model: r.model, provider: r.provider };
  }
  if (p.type === 'openai-compatible') {
    if (!p.baseUrl) throw new RouteError(500, 'api_error', `Provider ${r.provider} needs baseUrl`);
    if (key) headers.authorization = `Bearer ${key}`;
    return { kind: 'openai', baseUrl: p.baseUrl.replace(/\/$/, ''), headers, model: r.model, provider: r.provider };
  }
  if (p.type === 'anthropic-api-key') {
    if (!key) throw new RouteError(500, 'api_error', `Provider ${r.provider} needs key: the NAME of its line in ~/.ghostship/secrets`);
    headers['x-api-key'] = key;
    headers['anthropic-version'] = '2023-06-01';
    return { kind: 'anthropic', baseUrl: (p.baseUrl || 'https://api.anthropic.com').replace(/\/$/, ''), headers, model: r.model, provider: r.provider };
  }
  throw new RouteError(403, 'permission_error', `Provider type ${p.type} cannot sit behind the gateway (only local, openai-compatible and anthropic-api-key).`);
}

function readBody(req) {
  return new Promise((ok, bad) => {
    let size = 0; const parts = [];
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { bad(new RouteError(413, 'request_too_large', 'Request body over 20 MB')); req.destroy(); } else parts.push(c); });
    req.on('end', () => ok(Buffer.concat(parts).toString('utf8')));
    req.on('error', bad);
  });
}

const anthropicError = (res, status, type, message) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type, message } })); };
const openaiError = (res, status, type, message) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { type, message } })); };

async function* textChunks(body) {
  const dec = new TextDecoder();
  for await (const c of body) yield dec.decode(c, { stream: true });
}

export function createGateway({ root, cfg = loadConfig(root), clientKey = randomBytes(24).toString('hex'), getSecret = secret, fetchImpl = fetch, log = () => {} } = {}) {
  const want = Buffer.from(clientKey);
  const authed = (req) => {
    const h = req.headers['x-api-key'] || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const got = Buffer.from(String(h || ''));
    return got.length === want.length && timingSafeEqual(got, want);
  };

  async function upstream(route, path, payload) {
    const r = await fetchImpl(`${route.baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...route.headers }, body: JSON.stringify(payload) });
    if (!r.ok) {
      const text = await r.text();
      throw new RouteError(r.status === 429 ? 429 : 502, r.status === 429 ? 'rate_limit_error' : 'api_error', `Upstream ${route.provider} answered ${r.status}: ${text.slice(0, 500)}`);
    }
    return r;
  }

  async function messages(req, res, body) {
    const route = resolveRoute(cfg, body.model, { getSecret });
    const t0 = Date.now();
    if (route.kind === 'anthropic') {
      const r = await upstream(route, '/v1/messages', { ...body, model: route.model });
      res.writeHead(200, { 'content-type': r.headers.get('content-type') || 'application/json' });
      for await (const t of textChunks(r.body)) res.write(t);
      res.end();
      log({ api: 'messages', model: body.model, route: route.provider, ms: Date.now() - t0 });
      return;
    }
    const oreq = anthropicToOpenAIRequest(body, route.model);
    const r = await upstream(route, '/chat/completions', oreq);
    if (!body.stream) {
      const out = openAIToAnthropicResponse(await r.json(), body.model);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
      log({ api: 'messages', model: body.model, route: route.provider, ...out.usage, ms: Date.now() - t0 });
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const conv = openAIStreamToAnthropic(body.model);
    const parse = sseParser();
    for await (const t of textChunks(r.body)) {
      for (const ev of parse(t)) {
        if (ev.data.trim() === '[DONE]') { res.write(conv.push('[DONE]')); continue; }
        try { res.write(conv.push(JSON.parse(ev.data))); } catch { /* skip malformed chunk */ }
      }
    }
    res.write(conv.end());
    res.end();
    log({ api: 'messages', model: body.model, route: route.provider, ...conv.usage(), ms: Date.now() - t0, stream: true });
  }

  async function chat(req, res, body) {
    const route = resolveRoute(cfg, body.model, { getSecret });
    const t0 = Date.now();
    if (route.kind === 'openai') {
      const r = await upstream(route, '/chat/completions', { ...body, model: route.model });
      res.writeHead(200, { 'content-type': r.headers.get('content-type') || 'application/json' });
      for await (const t of textChunks(r.body)) res.write(t);
      res.end();
      log({ api: 'chat', model: body.model, route: route.provider, ms: Date.now() - t0 });
      return;
    }
    const areq = openAIToAnthropicRequest(body, route.model);
    const r = await upstream(route, '/v1/messages', areq);
    if (!body.stream) {
      const a = await r.json();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(anthropicToOpenAIResponse(a, body.model)));
      log({ api: 'chat', model: body.model, route: route.provider, input_tokens: a.usage?.input_tokens, output_tokens: a.usage?.output_tokens, ms: Date.now() - t0 });
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const conv = anthropicStreamToOpenAI(body.model);
    const parse = sseParser();
    for await (const t of textChunks(r.body)) for (const ev of parse(t)) { try { res.write(conv.push(JSON.parse(ev.data))); } catch { /* skip */ } }
    res.write(conv.end());
    res.end();
    log({ api: 'chat', model: body.model, route: route.provider, ...conv.usage(), ms: Date.now() - t0, stream: true });
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${HOST}`);
    const isChat = url.pathname === '/v1/chat/completions';
    const err = isChat ? openaiError : anthropicError;
    try {
      if (req.method === 'GET' && url.pathname === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true}'); }
      if (!authed(req)) return err(res, 401, 'authentication_error', 'Missing or wrong gateway key (see gs gateway env).');
      if (req.method === 'GET' && url.pathname === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data: Object.keys(cfg.gateway?.routes || {}).filter((k) => k !== '*').map((id) => ({ id, object: 'model', type: 'model', display_name: id })) }));
      }
      if (req.method !== 'POST') return err(res, 404, 'not_found_error', `${req.method} ${url.pathname} is not served`);
      const body = JSON.parse(await readBody(req) || '{}');
      if (url.pathname === '/v1/messages/count_tokens') {
        const chars = JSON.stringify([body.system || '', body.messages || [], body.tools || []]).length;
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ input_tokens: Math.ceil(chars / 4) }));
      }
      if (url.pathname === '/v1/messages') return await messages(req, res, body);
      if (isChat) return await chat(req, res, body);
      return err(res, 404, 'not_found_error', `${url.pathname} is not served`);
    } catch (e) {
      if (res.headersSent) { try { res.end(); } catch { /* closed */ } return; }
      if (e instanceof SyntaxError) return err(res, 400, 'invalid_request_error', 'Body is not valid JSON');
      return err(res, e.status || 500, e.type || 'api_error', e.message);
    }
  });
  return { server, clientKey, listen: (port = 0) => new Promise((ok, bad) => { server.once('error', bad); server.listen(port, HOST, () => ok(server.address().port)); }) };
}

// Run as a process: `node gateway/server.mjs <projectRoot>`
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]) && process.argv[2]) {
  const root = process.argv[2];
  const cfg = loadConfig(root);
  const usage = join(root, '.ghostship', 'usage', 'gateway.jsonl');
  mkdirSync(join(root, '.ghostship', 'usage'), { recursive: true });
  const g = createGateway({ root, cfg, log: (e) => { try { appendFileSync(usage, JSON.stringify({ at: new Date().toISOString(), ...e }) + '\n'); } catch { /* best effort */ } } });
  const port = await g.listen(Number(process.env.GS_GATEWAY_PORT ?? cfg.gateway?.port ?? 8787));
  const info = join(root, RUNS_DIR, 'gateway.json');
  mkdirSync(join(root, RUNS_DIR), { recursive: true });
  writeFileSync(info, JSON.stringify({ pid: process.pid, port, clientKey: g.clientKey, startedAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
  try { chmodSync(info, 0o600); } catch { /* Windows */ }
  const stop = () => { rmSync(info, { force: true }); process.exit(0); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
