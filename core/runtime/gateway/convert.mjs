// Pure translation between the Anthropic Messages API and the OpenAI Chat Completions API, both directions,
// including tools, images and streaming. Written for Ghostship; the approach follows CLIProxyAPI (MIT), no code copied.
import { randomBytes } from 'node:crypto';

const rid = (p) => `${p}${randomBytes(12).toString('hex')}`;
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (b.type === 'text' ? b.text : '')).join('') : '');
const safeJson = (s) => { try { return s ? JSON.parse(s) : {}; } catch { return { _raw: s }; } };

// ---------------------------------------------------------------- Anthropic request → OpenAI request

function imagePart(b) {
  if (b.source?.type === 'base64') return { type: 'image_url', image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } };
  if (b.source?.type === 'url') return { type: 'image_url', image_url: { url: b.source.url } };
  return null;
}

export function anthropicToOpenAIRequest(req, model) {
  const messages = [];
  const sys = typeof req.system === 'string' ? req.system : textOf(req.system);
  if (sys) messages.push({ role: 'system', content: sys });
  for (const m of req.messages || []) {
    if (typeof m.content === 'string') { messages.push({ role: m.role, content: m.content }); continue; }
    const blocks = m.content || [];
    if (m.role === 'assistant') {
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
      const calls = blocks.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      messages.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    // user: tool results become `tool` messages, placed first so they follow the assistant's tool calls
    for (const b of blocks.filter((x) => x.type === 'tool_result')) {
      const content = typeof b.content === 'string' ? b.content : textOf(b.content);
      messages.push({ role: 'tool', tool_call_id: b.tool_use_id, content: b.is_error ? `ERROR: ${content}` : content });
    }
    const parts = [];
    for (const b of blocks) {
      if (b.type === 'text') parts.push({ type: 'text', text: b.text });
      else if (b.type === 'image') { const p = imagePart(b); if (p) parts.push(p); }
    }
    if (parts.length) messages.push({ role: 'user', content: parts.every((p) => p.type === 'text') ? parts.map((p) => p.text).join('\n') : parts });
  }
  const out = { model, messages, max_tokens: req.max_tokens, stream: !!req.stream };
  if (req.stream) out.stream_options = { include_usage: true };
  if (req.temperature !== undefined) out.temperature = req.temperature;
  if (req.top_p !== undefined) out.top_p = req.top_p;
  if (req.stop_sequences?.length) out.stop = req.stop_sequences;
  if (req.tools?.length) {
    out.tools = req.tools.filter((t) => t.input_schema || !t.type || t.type === 'custom').map((t) => ({ type: 'function', function: { name: t.name, description: t.description || '', parameters: t.input_schema || { type: 'object', properties: {} } } }));
    const tc = req.tool_choice;
    if (tc?.type === 'any') out.tool_choice = 'required';
    else if (tc?.type === 'tool') out.tool_choice = { type: 'function', function: { name: tc.name } };
    else if (tc?.type === 'none') out.tool_choice = 'none';
    else if (tc?.type === 'auto') out.tool_choice = 'auto';
  }
  return out;
}

// ---------------------------------------------------------------- OpenAI response → Anthropic response

const STOP_O2A = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', function_call: 'tool_use', content_filter: 'end_turn' };

export function openAIToAnthropicResponse(res, model) {
  const ch = res.choices?.[0] || {};
  const msg = ch.message || {};
  const content = [];
  const text = typeof msg.content === 'string' ? msg.content : textOf(msg.content);
  if (text) content.push({ type: 'text', text });
  for (const c of msg.tool_calls || []) content.push({ type: 'tool_use', id: c.id || rid('toolu_'), name: c.function?.name, input: safeJson(c.function?.arguments) });
  return {
    id: rid('msg_'), type: 'message', role: 'assistant', model, content,
    stop_reason: (msg.tool_calls?.length ? 'tool_use' : STOP_O2A[ch.finish_reason]) || 'end_turn', stop_sequence: null,
    usage: { input_tokens: res.usage?.prompt_tokens || 0, output_tokens: res.usage?.completion_tokens || 0 },
  };
}

const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`;

/** Feed OpenAI SSE `data:` payloads (already JSON-parsed, or the string "[DONE]"); get Anthropic SSE text back. */
export function openAIStreamToAnthropic(model) {
  let started = false, block = null, index = -1, stop = null, usage = { input_tokens: 0, output_tokens: 0 }, finished = false;
  const tools = new Map(); // openai tool index → anthropic block index
  const open = (kind, data) => { index += 1; block = kind; return sse('content_block_start', { index, content_block: data }); };
  const close = () => { if (block === null) return ''; const s = sse('content_block_stop', { index }); block = null; return s; };
  const head = () => {
    if (started) return '';
    started = true;
    return sse('message_start', { message: { id: rid('msg_'), type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
  };
  const end = () => {
    if (finished) return '';
    finished = true;
    return head() + close() + sse('message_delta', { delta: { stop_reason: stop || 'end_turn', stop_sequence: null }, usage: { output_tokens: usage.output_tokens, input_tokens: usage.input_tokens } }) + sse('message_stop', {});
  };
  return {
    push(chunk) {
      if (chunk === '[DONE]') return end();
      let out = head();
      if (chunk.usage) usage = { input_tokens: chunk.usage.prompt_tokens || 0, output_tokens: chunk.usage.completion_tokens || 0 };
      const ch = chunk.choices?.[0];
      if (!ch) return out;
      const d = ch.delta || {};
      if (typeof d.content === 'string' && d.content) {
        if (block !== 'text') out += close() + open('text', { type: 'text', text: '' });
        out += sse('content_block_delta', { index, delta: { type: 'text_delta', text: d.content } });
      }
      for (const tc of d.tool_calls || []) {
        const k = tc.index ?? 0;
        if (!tools.has(k)) {
          out += close() + open(`tool${k}`, { type: 'tool_use', id: tc.id || rid('toolu_'), name: tc.function?.name || '', input: {} });
          tools.set(k, index);
        }
        if (tc.function?.arguments) out += sse('content_block_delta', { index: tools.get(k), delta: { type: 'input_json_delta', partial_json: tc.function.arguments } });
      }
      if (ch.finish_reason) stop = STOP_O2A[ch.finish_reason] || 'end_turn';
      return out;
    },
    end,
    usage: () => usage,
  };
}

// ---------------------------------------------------------------- OpenAI request → Anthropic request

function anthropicImage(url) {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(url || '');
  return m ? { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } } : { type: 'image', source: { type: 'url', url } };
}

export function openAIToAnthropicRequest(req, model) {
  const system = [];
  const messages = [];
  const push = (role, blocks) => {
    const last = messages.at(-1);
    if (last && last.role === role) last.content.push(...blocks); else messages.push({ role, content: [...blocks] });
  };
  for (const m of req.messages || []) {
    if (m.role === 'system' || m.role === 'developer') { system.push(typeof m.content === 'string' ? m.content : textOf(m.content)); continue; }
    if (m.role === 'tool') { push('user', [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: typeof m.content === 'string' ? m.content : textOf(m.content) }]); continue; }
    const blocks = [];
    if (typeof m.content === 'string') { if (m.content) blocks.push({ type: 'text', text: m.content }); }
    else for (const p of m.content || []) {
      if (p.type === 'text') blocks.push({ type: 'text', text: p.text });
      else if (p.type === 'image_url') blocks.push(anthropicImage(p.image_url?.url));
    }
    for (const c of m.tool_calls || []) blocks.push({ type: 'tool_use', id: c.id, name: c.function?.name, input: safeJson(c.function?.arguments) });
    if (blocks.length) push(m.role === 'assistant' ? 'assistant' : 'user', blocks);
  }
  const out = { model, messages, max_tokens: req.max_tokens || req.max_completion_tokens || 4096 };
  if (system.length) out.system = system.join('\n\n');
  if (req.stream) out.stream = true;
  if (req.temperature !== undefined) out.temperature = req.temperature;
  if (req.top_p !== undefined) out.top_p = req.top_p;
  if (req.stop) out.stop_sequences = Array.isArray(req.stop) ? req.stop : [req.stop];
  if (req.tools?.length) {
    out.tools = req.tools.filter((t) => t.type === 'function').map((t) => ({ name: t.function.name, description: t.function.description || '', input_schema: t.function.parameters || { type: 'object', properties: {} } }));
    const tc = req.tool_choice;
    if (tc === 'required') out.tool_choice = { type: 'any' };
    else if (tc === 'none') out.tool_choice = { type: 'none' };
    else if (tc?.type === 'function') out.tool_choice = { type: 'tool', name: tc.function.name };
    else if (tc === 'auto') out.tool_choice = { type: 'auto' };
  }
  return out;
}

// ---------------------------------------------------------------- Anthropic response → OpenAI response

const STOP_A2O = { end_turn: 'stop', max_tokens: 'length', tool_use: 'tool_calls', stop_sequence: 'stop', pause_turn: 'stop', refusal: 'content_filter' };

export function anthropicToOpenAIResponse(res, model) {
  const text = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const calls = (res.content || []).filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
  const input = (res.usage?.input_tokens || 0) + (res.usage?.cache_read_input_tokens || 0) + (res.usage?.cache_creation_input_tokens || 0);
  return {
    id: rid('chatcmpl-'), object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, message: { role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) }, finish_reason: STOP_A2O[res.stop_reason] || 'stop' }],
    usage: { prompt_tokens: input, completion_tokens: res.usage?.output_tokens || 0, total_tokens: input + (res.usage?.output_tokens || 0) },
  };
}

/** Feed Anthropic SSE event payloads (JSON-parsed); get OpenAI SSE text back. */
export function anthropicStreamToOpenAI(model) {
  const id = rid('chatcmpl-');
  const created = Math.floor(Date.now() / 1000);
  const toolIndex = new Map(); // anthropic block index → openai tool index
  let usage = { prompt_tokens: 0, completion_tokens: 0 }, done = false;
  const chunk = (delta, finish = null, extra = {}) => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
  return {
    push(ev) {
      switch (ev.type) {
        case 'message_start': usage.prompt_tokens = ev.message?.usage?.input_tokens || 0; return chunk({ role: 'assistant', content: '' });
        case 'content_block_start':
          if (ev.content_block?.type === 'tool_use') {
            const k = toolIndex.size; toolIndex.set(ev.index, k);
            return chunk({ tool_calls: [{ index: k, id: ev.content_block.id, type: 'function', function: { name: ev.content_block.name, arguments: '' } }] });
          }
          return '';
        case 'content_block_delta':
          if (ev.delta?.type === 'text_delta') return chunk({ content: ev.delta.text });
          if (ev.delta?.type === 'input_json_delta') return chunk({ tool_calls: [{ index: toolIndex.get(ev.index) ?? 0, function: { arguments: ev.delta.partial_json } }] });
          return '';
        case 'message_delta':
          usage.completion_tokens = ev.usage?.output_tokens || 0;
          return chunk({}, STOP_A2O[ev.delta?.stop_reason] || 'stop', { usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens } });
        case 'message_stop': done = true; return 'data: [DONE]\n\n';
        default: return '';
      }
    },
    end() { return done ? '' : 'data: [DONE]\n\n'; },
    usage: () => ({ input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens }),
  };
}

/** Split an SSE byte stream into events: yields { event, data } with data as the raw string. */
export function sseParser() {
  let buf = '';
  return (text) => {
    buf += text;
    const out = [];
    let i;
    while ((i = buf.search(/\r?\n\r?\n/)) !== -1) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i).replace(/^\r?\n\r?\n/, '');
      let event = null; const data = [];
      for (const line of raw.split(/\r?\n/)) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (data.length) out.push({ event, data: data.join('\n') });
    }
    return out;
  };
}
