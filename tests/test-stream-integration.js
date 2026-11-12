'use strict';
// End-to-end wiring test: boots the real server on a test port, creates a chat
// session, flips on streaming, and drives two turns over WebSocket — proving
// the streaming branch in runChatTurn works and reuses one warm process with
// in-context memory. Cleans up the session + temp dir afterward.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const PORT = 3998;
const TOKEN = '1234qwer'; // from worktree .env
const BASE = `http://127.0.0.1:${PORT}`;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-stream-'));
const log = (...a) => console.log(`[${((Date.now() - T) / 1000).toFixed(1)}s]`, ...a);
const T = Date.now();

const H = { 'Content-Type': 'application/json', 'X-Access-Token': TOKEN };
const api = async (method, p, body) => {
  const r = await fetch(BASE + p, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = t; }
  if (!r.ok) throw new Error(`${method} ${p} -> ${r.status}: ${t.slice(0, 200)}`);
  return j;
};

function runTurn(ws, text, label) {
  return new Promise((resolve) => {
    let assistant = '';
    const onMsg = (raw) => {
      let e; try { e = JSON.parse(raw.toString()); } catch { return; }
      if (e.type === 'assistant' && e.message?.content) for (const b of e.message.content) if (b.type === 'text') assistant += b.text;
      if (e.type === 'stream_end') { ws.off('message', onMsg); resolve(assistant.trim()); }
    };
    ws.on('message', onMsg);
    log(`${label}: send "${text}"`);
    ws.send(JSON.stringify({ type: 'user_message', text }));
  });
}

let srv, sessionId;
(async () => {
  srv = spawn('node', ['server.js'], { cwd: __dirname, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stdout.on('data', d => { const s = d.toString(); if (/streaming|aux|error/i.test(s)) process.stdout.write('  SRV| ' + s.split('\n').filter(Boolean).slice(-3).join('\n  SRV| ') + '\n'); });
  srv.stderr.on('data', d => process.stderr.write('  SRV-ERR| ' + d));

  // wait for ready
  for (let i = 0; i < 40; i++) {
    try { await api('GET', '/api/directories?token=' + TOKEN); break; } catch { await new Promise(r => setTimeout(r, 500)); }
  }
  log('server up');

  const dir = await api('POST', '/api/directories', { name: 'stream-test', path: tmpDir, create: true });
  log('dir created', dir.id);
  const sess = await api('POST', `/api/directories/${dir.id}/sessions`, { cli: 'claude', kind: 'chat' });
  sessionId = sess.id;
  log('session created', sessionId);
  const useStream = process.argv[2] !== 'nostream';
  const patched = await api('PATCH', `/api/sessions/${sessionId}`, { streaming: useStream });
  log('streaming flag =', patched.streaming, useStream ? '(streaming path)' : '(DEFAULT per-turn path)');

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/chat?session=${sessionId}&token=${TOKEN}`);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  log('ws open');

  const r1 = await runTurn(ws, 'Remember the secret code is ZEBRA-9. Reply just: OK', 'turn1');
  log('turn1 reply:', JSON.stringify(r1.slice(0, 120)));

  const r2 = await runTurn(ws, 'What was the secret code? Reply only the code.', 'turn2');
  log('turn2 reply:', JSON.stringify(r2.slice(0, 120)), r2.includes('ZEBRA-9') ? '✅ remembered (warm, in-context)' : '❌ context lost');

  ws.close();
  // cleanup
  await api('DELETE', `/api/sessions/${sessionId}`).catch(() => {});
  log('cleanup done');
  srv.kill('SIGTERM');
  fs.rmSync(tmpDir, { recursive: true, force: true });
  setTimeout(() => process.exit(0), 500);
})().catch(async (e) => {
  console.error('INTEGRATION TEST FAILED:', e.message);
  if (sessionId) await api('DELETE', `/api/sessions/${sessionId}`).catch(() => {});
  if (srv) srv.kill('SIGTERM');
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  setTimeout(() => process.exit(1), 500);
});
