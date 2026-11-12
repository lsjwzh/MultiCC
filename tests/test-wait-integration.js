'use strict';
// End-to-end: real server + streaming session + B(poll) wait. Registers a poll
// wait whose condition is a flag file; flips the file mid-test; verifies the
// injector polls, matches, and auto-continues the session with the polled data.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const PORT = 3998, TOKEN = '1234qwer', BASE = `http://127.0.0.1:${PORT}`;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-wait-'));
const flag = path.join(tmpDir, 'flag.txt');
const T = Date.now();
const log = (...a) => console.log(`[${((Date.now() - T) / 1000).toFixed(1)}s]`, ...a);
const H = { 'Content-Type': 'application/json', 'X-Access-Token': TOKEN };
const api = async (m, p, b) => {
  const r = await fetch(BASE + p, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  if (!r.ok) throw new Error(`${m} ${p} -> ${r.status}: ${t.slice(0, 200)}`);
  return j;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

let srv, sessionId, ws;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; log('✅', m); } else { fail++; log('❌', m); } };

function turn(text) {
  return new Promise((resolve) => {
    let a = '';
    const on = (raw) => { let e; try { e = JSON.parse(raw); } catch { return; }
      if (e.type === 'assistant' && e.message?.content) for (const b of e.message.content) if (b.type === 'text') a += b.text;
      if (e.type === 'stream_end') { ws.off('message', on); resolve(a.trim()); } };
    ws.on('message', on);
    ws.send(JSON.stringify({ type: 'user_message', text }));
  });
}
// Wait for the NEXT injected turn (a stream_end not triggered by us).
function awaitInjectedTurn(timeoutMs) {
  return new Promise((resolve) => {
    let a = '';
    const on = (raw) => { let e; try { e = JSON.parse(raw); } catch { return; }
      if (e.type === 'assistant' && e.message?.content) for (const b of e.message.content) if (b.type === 'text') a += b.text;
      if (e.type === 'stream_end') { ws.off('message', on); resolve(a.trim()); } };
    ws.on('message', on);
    setTimeout(() => { ws.off('message', on); resolve(null); }, timeoutMs);
  });
}

(async () => {
  srv = spawn('node', ['server.js'], { cwd: __dirname, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stdout.on('data', d => { const s = d.toString(); if (/wait\]|poll|inject/i.test(s)) process.stdout.write('  SRV| ' + s.split('\n').filter(Boolean).join('\n  SRV| ') + '\n'); });
  for (let i = 0; i < 40; i++) { try { await api('GET', '/api/directories?token=' + TOKEN); break; } catch { await sleep(500); } }
  log('server up');

  const dir = await api('POST', '/api/directories', { name: 'wait-test', path: tmpDir, create: true });
  const sess = await api('POST', `/api/directories/${dir.id}/sessions`, { cli: 'claude', kind: 'chat', model: 'haiku' });
  sessionId = sess.id;
  await api('PATCH', `/api/sessions/${sessionId}`, { streaming: true });
  log('session', sessionId, 'streaming on, model haiku');

  ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/chat?session=${sessionId}&token=${TOKEN}`);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  await turn('Reply with exactly: READY'); // warm the stream process
  log('warmed');

  // B: register a poll wait whose condition is the flag file containing GO.
  const reg = await api('POST', `/api/sessions/${sessionId}/wait`, {
    mode: 'poll',
    pollCmd: `cat "${flag}" 2>/dev/null || true`,
    untilContains: 'GO',
    intervalSec: 3, maxChecks: 20,
    injectPrefix: '后台任务返回了，请只回复其中的数字：',
  });
  ok(reg.ok && reg.id, 'poll wait registered');
  const waits = await api('GET', `/api/sessions/${sessionId}/waits`);
  ok(waits.waits.length === 1, 'wait listed for session');

  await sleep(4000); // ~1 poll, file absent → no match yet
  const stillWaiting = await api('GET', `/api/sessions/${sessionId}/waits`);
  ok(stillWaiting.waits.length === 1, 'still waiting before flag set');

  log('setting flag file → GO result=99');
  fs.writeFileSync(flag, 'GO result=99\n');
  const injectedReply = await awaitInjectedTurn(25000);
  ok(injectedReply !== null, 'session auto-continued after poll matched');
  ok(injectedReply && injectedReply.includes('99'), `injected turn saw polled data (reply: ${JSON.stringify((injectedReply || '').slice(0, 60))})`);
  const after = await api('GET', `/api/sessions/${sessionId}/waits`);
  ok(after.waits.length === 0, 'wait cleared after match');

  ws.close();
  await api('DELETE', `/api/sessions/${sessionId}`).catch(() => {});
  srv.kill('SIGTERM');
  fs.rmSync(tmpDir, { recursive: true, force: true });
  log(`\n${fail === 0 ? '✅ ALL PASS' : '❌ FAIL'} (${pass} pass, ${fail} fail)`);
  setTimeout(() => process.exit(fail === 0 ? 0 : 1), 500);
})().catch(async (e) => {
  console.error('FAILED:', e.message);
  if (sessionId) await api('DELETE', `/api/sessions/${sessionId}`).catch(() => {});
  if (srv) srv.kill('SIGTERM');
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  setTimeout(() => process.exit(1), 500);
});
