'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
async function sdkFixture(t, reply, { authorize, onRequest } = {}) {
  t.mock.method(console, 'error', () => {});
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-claude-exp-sdk-'));
  const cwd = path.join(root, 'project');
  const configDir = path.join(root, 'claude');
  fs.mkdirSync(cwd); fs.mkdirSync(configDir);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // Parent history checks and SDK subprocesses use the SAME isolated store.
  const previousConfig = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = configDir;
  t.after(() => { if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previousConfig; });
  const requests = [];
  const upstream = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    if (authorize && !authorize(req, res)) return;
    if (req.url.includes('count_tokens')) { res.end(JSON.stringify({ input_tokens: 20 })); return; }
    if (!/\/v1\/messages(?:\?|$)/.test(req.url)) { res.writeHead(404); res.end('{}'); return; }
    const input = JSON.parse(body); requests.push(input);
    onRequest?.({ req, res, input });
    const block = await reply?.({ input, index: requests.length, cwd, req, res })
      || { type: 'text', text: `sdk-answer-${requests.length}` };
    const stopReason = block.type === 'tool_use' ? 'tool_use' : 'end_turn';
    const message = { id: `msg_test_${requests.length}`, type: 'message', role: 'assistant',
      model: input.model, content: [block], stop_reason: stopReason, stop_sequence: null,
      usage: { input_tokens: 20, output_tokens: 5 } };
    if (!input.stream) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(message)); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    event('message_start', { message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 20, output_tokens: 0 } } });
    event('content_block_start', { index: 0, content_block: block.type === 'tool_use'
      ? { ...block, input: {} } : { type: 'text', text: '' } });
    event('content_block_delta', { index: 0, delta: block.type === 'tool_use'
      ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) }
      : { type: 'text_delta', text: block.text } });
    event('content_block_stop', { index: 0 });
    event('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 5 } });
    event('message_stop', {}); res.end();
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  // No inherited provider credentials, routing env, or user settings.
  const env = { PATH: process.env.PATH, HOME: root, TMPDIR: root,
    CLAUDE_CONFIG_DIR: configDir, ANTHROPIC_API_KEY: 'isolated-test-only',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstream.address().port}`,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' };
  return { root, cwd, configDir, env, requests };
}

module.exports = sdkFixture;
