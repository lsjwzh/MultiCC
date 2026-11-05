'use strict';
// Tool-calling loop over a plain HTTP model endpoint (the same Aux target the
// classifier uses). No CLI process, no session state: the doctor must keep
// working when the sessions it is diagnosing are wedged, so it depends on
// nothing but one HTTP call per turn.

const http = require('http');
const https = require('https');
const { parseResponsesStream } = require('../aux-http');

const MAX_TOKENS = 8192;
// Turns are not capped (a hard problem can take many rounds), so old tool output
// is shrunk instead: only the newest KEEP_FULL results stay verbatim.
const KEEP_FULL = 8;
const STUB_CHARS = 240;

function shrinkOld(slots) {
  slots.slice(0, Math.max(0, slots.length - KEEP_FULL)).forEach(slot => {
    const text = slot.get();
    if (typeof text === 'string' && text.length > STUB_CHARS) slot.set(`${text.slice(0, STUB_CHARS)}…[earlier output trimmed]`);
  });
}

function postJson(target, body, headers, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(target.url); } catch (_) { return reject(new Error(`Doctor Provider URL 无效：${target.url || ''}`)); }
    const isHttps = url.protocol === 'https:';
    let settled = false, timer;
    const finish = (err, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (err) reject(err); else resolve(value);
    };
    const req = (isHttps ? https : http).request({
      hostname: url.hostname, port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search, method: 'POST', headers,
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => { data += c; if (data.length > 16 * 1024 * 1024) { const e = new Error('Doctor response too large'); finish(e); req.destroy(e); } });
      res.on('aborted', () => finish(new Error('Doctor response disconnected')));
      res.on('end', () => {
        if (res.statusCode >= 400) {
          let msg = `HTTP ${res.statusCode}`;
          try { const p = JSON.parse(data); msg = (p.error && (p.error.message || JSON.stringify(p.error))) || p.message || msg; }
          catch (_) { msg += `: ${data.slice(0, 200).replace(/\n/g, ' ')}`; }
          return finish(new Error(msg));
        }
        try {
          // Some Responses relays return SSE with a JSON or missing media type.
          const sse = String(res.headers['content-type'] || '').includes('text/event-stream')
            || (target.wireApi === 'responses' && /^\s*(?:event:|data:)/.test(data));
          const parsed = sse ? parseResponsesStream(data) : JSON.parse(data);
          if (parsed.error) throw new Error(parsed.error.message || JSON.stringify(parsed.error));
          finish(null, parsed);
        } catch (e) { finish(e); }
      });
    });
    const onAbort = () => { const e = new Error('cancelled'); e.cancelled = true; finish(e); req.destroy(e); };
    if (signal) { if (signal.aborted) return onAbort(); signal.addEventListener('abort', onAbort); }
    req.on('error', finish);
    timer = setTimeout(() => { const e = new Error('timeout'); finish(e); req.destroy(e); }, timeoutMs);
    req.end(JSON.stringify(body));
  });
}

function parseArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  try { return JSON.parse(raw || '{}'); } catch (_) { return {}; }
}

// Each adapter hides one wire format behind: request(), absorb(response) ->
// { text, calls: [{id,name,args}] }, and addResults(results).
const ADAPTERS = {
  messages(model, system, tools, user) {
    const messages = [{ role: 'user', content: user }];
    return {
      headers: apiKey => ({ 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }),
      request: () => ({ model, max_tokens: MAX_TOKENS, system, messages,
        tools: tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters })) }),
      absorb(res) {
        const blocks = Array.isArray(res.content) ? res.content : [];
        messages.push({ role: 'assistant', content: blocks });
        return {
          text: blocks.filter(b => b.type === 'text').map(b => b.text || '').join('\n'),
          calls: blocks.filter(b => b.type === 'tool_use').map(b => ({ id: b.id, name: b.name, args: parseArgs(b.input) })),
        };
      },
      addResults: results => messages.push({ role: 'user',
        content: results.map(r => ({ type: 'tool_result', tool_use_id: r.id, content: r.output, is_error: r.error || undefined })) }),
      compact: () => shrinkOld(messages.filter(m => m.role === 'user' && Array.isArray(m.content))
        .flatMap(m => m.content).filter(b => b.type === 'tool_result')
        .map(b => ({ get: () => b.content, set: v => { b.content = v; } }))),
    };
  },
  chat_completions(model, system, tools, user) {
    const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
    return {
      headers: () => ({}),
      request: () => ({ model, max_tokens: MAX_TOKENS, messages,
        tools: tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) }),
      absorb(res) {
        const msg = res.choices && res.choices[0] && res.choices[0].message || {};
        messages.push(msg);
        const text = typeof msg.content === 'string' ? msg.content
          : Array.isArray(msg.content) ? msg.content.map(c => c.text || '').join('') : '';
        return { text, calls: (msg.tool_calls || []).map(c => ({ id: c.id, name: c.function && c.function.name, args: parseArgs(c.function && c.function.arguments) })) };
      },
      addResults: results => results.forEach(r => messages.push({ role: 'tool', tool_call_id: r.id, content: r.output })),
      compact: () => shrinkOld(messages.filter(m => m.role === 'tool')
        .map(m => ({ get: () => m.content, set: v => { m.content = v; } }))),
    };
  },
  responses(model, system, tools, user) {
    const input = [{ role: 'user', content: [{ type: 'input_text', text: user }] }];
    return {
      headers: () => ({}),
      request: () => ({ model, instructions: system, input, stream: true, store: false,
        tools: tools.map(t => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters })) }),
      absorb(res) {
        const out = Array.isArray(res.output) ? res.output : [];
        // reasoning items need encrypted state we did not ask for; drop them.
        for (const item of out) if (item.type !== 'reasoning') input.push(item);
        const text = out.filter(i => i.type === 'message').flatMap(i => i.content || [])
          .filter(c => c.type === 'output_text').map(c => c.text || '').join('');
        return { text, calls: out.filter(i => i.type === 'function_call').map(i => ({ id: i.call_id, name: i.name, args: parseArgs(i.arguments) })) };
      },
      addResults: results => results.forEach(r => input.push({ type: 'function_call_output', call_id: r.id, output: r.output })),
      compact: () => shrinkOld(input.filter(i => i.type === 'function_call_output')
        .map(i => ({ get: () => i.output, set: v => { i.output = v; } }))),
    };
  },
};

// tools: [{ name, description, parameters, run(args) -> string|object }]. A tool
// named `finish` ends the loop; its args are the structured report.
async function runToolLoop({ target, model, system, user, tools, maxTurns = 0, timeoutMs = 90000,
  signal, onEvent = () => {}, post = postJson }) {
  const make = ADAPTERS[target && target.wireApi];
  if (!make) throw new Error(`Doctor 不支持的 wire API：${target && target.wireApi}`);
  if (!model) throw new Error('Doctor Provider 没有可用模型');
  const adapter = make(model, system, tools, user);
  const byName = new Map(tools.map(t => [t.name, t]));
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${target.apiKey}`, ...adapter.headers(target.apiKey) };
  // maxTurns <= 0 means no cap; the run ends on finish, error or cancel.
  for (let turn = 1; !maxTurns || turn <= maxTurns; turn++) {
    const res = await post(target, adapter.request(), headers, timeoutMs, signal);
    const { text, calls } = adapter.absorb(res);
    if (text) onEvent({ type: 'thought', turn, text });
    if (!calls.length) return { finished: false, report: null, text, turns: turn };
    const results = [];
    let report = null;
    for (const call of calls) {
      const tool = byName.get(call.name);
      onEvent({ type: 'tool', turn, name: call.name, args: call.args });
      if (call.name === 'finish') { report = call.args; results.push({ id: call.id, output: 'ok' }); continue; }
      let output, error = false;
      try {
        if (!tool) throw new Error(`未知工具：${call.name}`);
        output = await tool.run(call.args);
        if (typeof output !== 'string') output = JSON.stringify(output, null, 1);
      } catch (e) { output = `ERROR: ${e && e.message || e}`; error = true; }
      results.push({ id: call.id, output, error });
      onEvent({ type: 'result', turn, name: call.name, error, preview: output.slice(0, 300) });
    }
    adapter.addResults(results);
    adapter.compact();
    if (report) return { finished: true, report, text, turns: turn };
  }
  return { finished: false, report: null, text: '', turns: maxTurns, exhausted: true };
}

module.exports = { runToolLoop, postJson, ADAPTERS };
