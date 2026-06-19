'use strict';
// Live e2e for A (callback) and D (auto-continue fallback) through the real server.
const { spawn } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path');
const WebSocket = require('ws');

const PORT = 3998, TOKEN = '1234qwer', BASE = `http://127.0.0.1:${PORT}`;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-live-'));
const T = Date.now();
const log = (...a) => console.log(`[${((Date.now() - T) / 1000).toFixed(1)}s]`, ...a);
const H = { 'Content-Type': 'application/json', 'X-Access-Token': TOKEN };
const api = async (m, p, b) => { const r = await fetch(BASE + p, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }); const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } if (!r.ok) throw new Error(`${m} ${p} -> ${r.status}: ${t.slice(0, 150)}`); return j; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const ok = (c, m) => { if (c) { pass++; log('✅', m); } else { fail++; log('❌', m); } };

let srv;
function openWs(sessionId) { const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/chat?session=${sessionId}&token=${TOKEN}`); return new Promise((res, rej) => { ws.on('open', () => res(ws)); ws.on('error', rej); }); }
function turn(ws, text) { return new Promise((resolve) => { let a = ''; const on = (raw) => { let e; try { e = JSON.parse(raw); } catch { return; } if (e.type === 'assistant' && e.message?.content) for (const b of e.message.content) if (b.type === 'text') a += b.text; if (e.type === 'stream_end') { ws.off('message', on); resolve(a.trim()); } }; ws.on('message', on); ws.send(JSON.stringify({ type: 'user_message', text })); }); }
function awaitTurn(ws, timeoutMs) { return new Promise((resolve) => { let a = ''; const on = (raw) => { let e; try { e = JSON.parse(raw); } catch { return; } if (e.type === 'assistant' && e.message?.content) for (const b of e.message.content) if (b.type === 'text') a += b.text; if (e.type === 'stream_end') { ws.off('message', on); resolve(a.trim()); } }; ws.on('message', on); setTimeout(() => { ws.off('message', on); resolve(null); }, timeoutMs); }); }
async function mkSession(extra) { const dir = await api('POST', '/api/directories', { name: 'live-' + Math.random().toString(36).slice(2, 6), path: fs.mkdtempSync(path.join(tmpDir, 's-')), create: true }); const s = await api('POST', `/api/directories/${dir.id}/sessions`, { cli: 'claude', kind: 'chat', model: 'haiku' }); await api('PATCH', `/api/sessions/${s.id}`, extra); return s.id; }

(async () => {
  srv = spawn('node', ['server.js'], { cwd: __dirname, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stdout.on('data', d => { const s = d.toString(); if (/wait\]|auto-continue|inject|classify/i.test(s)) process.stdout.write('  SRV| ' + s.split('\n').filter(Boolean).join('\n  SRV| ') + '\n'); });
  for (let i = 0; i < 40; i++) { try { await api('GET', '/api/server-info?token=' + TOKEN); break; } catch { await sleep(500); } }
  log('server up');

  // ── A: callback ──
  log('--- A: callback ---');
  const aId = await mkSession({ streaming: true });
  const wsA = await openWs(aId);
  await turn(wsA, 'Reply exactly: READY');
  const reg = await api('POST', `/api/sessions/${aId}/wait`, { mode: 'callback', injectPrefix: '外部系统返回了结果，请只回复其中的数字：' });
  ok(reg.ok && reg.callbackUrl, 'callback wait registered, got callbackUrl');
  // Hit the callback URL WITHOUT the access token (external caller) — relies on the per-wait token.
  const cbRes = await fetch(reg.callbackUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: '订单号=77' }) });
  ok(cbRes.status === 200, `callback POST without ACCESS_TOKEN accepted (status ${cbRes.status})`);
  const aReply = await awaitTurn(wsA, 25000);
  ok(aReply && aReply.includes('77'), `A: session auto-continued with callback data (reply: ${JSON.stringify((aReply || '').slice(0, 50))})`);
  wsA.close();

  // ── D: auto-continue fallback ──
  log('--- D: auto-continue (waits for 30s classify delay) ---');
  const dId = await mkSession({ streaming: true, autoContinue: true });
  const wsD = await openWs(dId);
  const t1 = await turn(wsD, '你已经启动了一个后台 CI 部署任务，现在必须等它跑完才能继续，完全不需要我做任何事、也不要问我任何问题。请用三四十个字说明：你已启动后台部署、正在等待它完成、完成后你会自动继续检查结果，现在先暂停。');
  log('D turn1:', JSON.stringify(t1.slice(0, 40)));
  log('waiting for classifier(30s)+auto-continue…');
  const t2 = await awaitTurn(wsD, 60000); // 30s classify + 2s + turn
  ok(t2 !== null, 'D: session auto-continued on its own (no user input)');
  log('D auto-continued turn:', JSON.stringify((t2 || '').slice(0, 60)));
  // stop any further auto-continue loop
  await api('PATCH', `/api/sessions/${dId}`, { autoContinue: false });
  wsD.close();

  // cleanup
  await api('DELETE', `/api/sessions/${aId}`).catch(() => {});
  await api('DELETE', `/api/sessions/${dId}`).catch(() => {});
  srv.kill('SIGTERM');
  fs.rmSync(tmpDir, { recursive: true, force: true });
  log(`\n${fail === 0 ? '✅ ALL PASS' : '❌ SOME FAIL'} (${pass} pass, ${fail} fail)`);
  setTimeout(() => process.exit(fail === 0 ? 0 : 1), 500);
})().catch(async (e) => { console.error('FAILED:', e.message); if (srv) srv.kill('SIGTERM'); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} setTimeout(() => process.exit(1), 500); });
