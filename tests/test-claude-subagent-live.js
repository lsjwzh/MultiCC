'use strict';

const assert = require('assert');
const http = require('http');
const https = require('https');
const WebSocket = require('ws');

const baseUrl = process.env.MULTICC_URL || 'http://127.0.0.1:3000';
const sessionId = process.env.MULTICC_LIVE_SESSION || '';
const timeoutMs = Math.max(30_000, Number(process.env.MULTICC_LIVE_TIMEOUT_MS) || 240_000);
const marker = `ROUTED_SUB_OK_${Date.now()}`;

function api(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, baseUrl);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const lib = url.protocol === 'https:' ? https : http;
    const headers = { Accept: 'application/json' };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(payload.length);
    }
    if (process.env.MULTICC_TOKEN) headers.Authorization = `Bearer ${process.env.MULTICC_TOKEN}`;
    const req = lib.request(url, { method, headers, rejectUnauthorized: false }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let data;
        try { data = JSON.parse(raw); } catch (_) { data = raw; }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`${method} ${pathname}: HTTP ${res.statusCode} ${raw}`));
        }
        resolve(data);
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function bucketTotal(bucket) {
  if (!bucket) return 0;
  return (bucket.inputTokens || 0) + (bucket.outputTokens || 0)
    + (bucket.cacheWrite || 0) + (bucket.cacheRead || 0);
}

function todayKey() {
  const now = new Date();
  return now.getFullYear() + '-'
    + String(now.getMonth() + 1).padStart(2, '0') + '-'
    + String(now.getDate()).padStart(2, '0');
}

function ledgerBucket(ledger, role, providerId) {
  return ledger?.[todayKey()]?.[role]?.[providerId] || null;
}

function runTurn(prompt) {
  return new Promise((resolve, reject) => {
    const wsUrl = new URL(baseUrl);
    wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    wsUrl.pathname = '/ws/chat';
    wsUrl.searchParams.set('session', sessionId);
    if (process.env.MULTICC_TOKEN) wsUrl.searchParams.set('token', process.env.MULTICC_TOKEN);

    const ws = new WebSocket(wsUrl, { rejectUnauthorized: false });
    const toolNames = [];
    let assistantText = '';
    let resultEvent = null;
    let settled = false;
    const timer = setTimeout(() => finish(new Error(`live turn timed out after ${timeoutMs}ms`)), timeoutMs);

    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch (_) {}
      if (error) reject(error);
      else resolve({ toolNames, assistantText, resultEvent });
    }

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'user_message', text: prompt }));
    });
    ws.on('error', finish);
    ws.on('message', (raw) => {
      let event;
      try { event = JSON.parse(raw.toString()); } catch (_) { return; }
      if (event.type === 'error') {
        return finish(new Error(event.error || event.data || JSON.stringify(event)));
      }
      if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
        for (const block of event.message.content) {
          if (block.type === 'text') assistantText += block.text || '';
          if (block.type === 'tool_use') toolNames.push(block.name || '');
        }
      }
      if (event.type === 'result') resultEvent = event;
      if (event.type === 'stream_end') finish();
    });
    ws.on('close', () => {
      if (!settled) finish(new Error('WebSocket closed before stream_end'));
    });
  });
}

async function main() {
  if (!sessionId) {
    throw new Error('Set MULTICC_LIVE_SESSION to a Claude chat session with different main/subagent providers');
  }

  const sessionDetail = await api('GET', `/api/sessions/${encodeURIComponent(sessionId)}`);
  const sessionList = await api('GET', '/api/sessions');
  const listed = Array.isArray(sessionList) ? sessionList.find(item => item.id === sessionId) : null;
  const session = { ...(listed || {}), ...sessionDetail };
  assert.strictEqual(session.cli, 'claude', 'live session must use the claude CLI');
  assert.strictEqual(session.kind, 'chat', 'live session must be a chat session');
  assert.ok(session.provider, 'live session needs a main provider');
  assert.ok(session.subagent?.providerId, 'live session needs a subagent provider override');
  assert.notStrictEqual(session.provider, session.subagent.providerId,
    'main and subagent providers must differ for this test');

  const ledgerBefore = await api('GET', '/api/token-usage/by-role');
  const prompt = [
    '这是 MultiCC 子 Agent provider 路由验收测试。',
    '必须调用一次 foreground Agent 工具；不能自己模拟子 Agent 的结果。',
    `要求子 Agent 不使用任何工具，只返回精确字符串：${marker}`,
    `拿到它的结果后，你的最终回答只写：ROUTED_MAIN_OK ${marker}`,
  ].join('\n');

  console.log(`Running live subagent route test on ${sessionId}`);
  console.log(`  main: ${session.provider} / ${session.effectiveModel || session.model || 'default'}`);
  console.log(`  sub : ${session.subagent.providerId} / ${session.subagent.effectiveModel || session.subagent.model}`);
  const turn = await runTurn(prompt);
  assert.ok(turn.toolNames.some(name => name === 'Agent' || name === 'Task'),
    `main model did not invoke Agent/Task; tools seen: ${turn.toolNames.join(', ') || '(none)'}`);
  assert.match(turn.assistantText, /ROUTED_MAIN_OK/);
  assert.ok(turn.assistantText.includes(marker), 'final response did not contain the subagent marker');
  assert.ok(turn.resultEvent, 'missing result event');

  const runtime = await api('GET', `/api/token-usage/by-role?session=${encodeURIComponent(sessionId)}`);
  assert.ok(bucketTotal(runtime.main) > 0, `main usage missing: ${JSON.stringify(runtime)}`);
  assert.ok(bucketTotal(runtime.sub) > 0, `subagent usage missing: ${JSON.stringify(runtime)}`);
  const routedSub = runtime.subByProvider.find(item => item.providerId === session.subagent.providerId);
  assert.ok(routedSub, `sub provider bucket missing: ${JSON.stringify(runtime.subByProvider)}`);
  assert.ok(bucketTotal(routedSub) > 0, 'sub provider bucket has no tokens');

  const ledgerAfter = await api('GET', '/api/token-usage/by-role');
  const mainBefore = bucketTotal(ledgerBucket(ledgerBefore, 'main', session.provider));
  const mainAfter = bucketTotal(ledgerBucket(ledgerAfter, 'main', session.provider));
  const subBefore = bucketTotal(ledgerBucket(ledgerBefore, 'sub', session.subagent.providerId));
  const subAfter = bucketTotal(ledgerBucket(ledgerAfter, 'sub', session.subagent.providerId));
  assert.ok(mainAfter > mainBefore, `persistent main usage did not increase (${mainBefore} -> ${mainAfter})`);
  assert.ok(subAfter > subBefore, `persistent sub usage did not increase (${subBefore} -> ${subAfter})`);

  console.log('Live route passed');
  console.log(`  tools: ${turn.toolNames.join(', ')}`);
  console.log(`  main tokens: ${bucketTotal(runtime.main)}`);
  console.log(`  sub tokens : ${bucketTotal(runtime.sub)} (${routedSub.name} / ${routedSub.model})`);
  console.log(`  ledger main delta: ${mainAfter - mainBefore}`);
  console.log(`  ledger sub delta : ${subAfter - subBefore}`);
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
