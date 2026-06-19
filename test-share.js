'use strict';
// End-to-end test for session sharing (view/password/operate) through the server.
const { spawn } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path');
const WebSocket = require('ws');

const PORT = 3998, TOKEN = '1234qwer', BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-share-'));
const T = Date.now(); const log = (...a) => console.log(`[${((Date.now() - T) / 1000).toFixed(1)}s]`, ...a);
const A = { 'Content-Type': 'application/json', 'X-Access-Token': TOKEN };           // admin
const api = async (m, p, b, hdr) => { const r = await fetch(BASE + p, { method: m, headers: hdr || A, body: b ? JSON.stringify(b) : undefined }); const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, j, headers: r.headers }; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const ok = (c, m) => { if (c) { pass++; log('✅', m); } else { fail++; log('❌', m); } };

// recipient calls: NO admin token
const REC = { 'Content-Type': 'application/json' };

function wsTurn(sessionId, shareToken, cookie, send, timeoutMs) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/chat?session=${sessionId}&share=${shareToken}`, { headers: cookie ? { Cookie: cookie } : {} });
    let got = false;
    ws.on('open', () => { if (send) ws.send(JSON.stringify({ type: 'user_message', text: send })); });
    ws.on('message', (raw) => { let e; try { e = JSON.parse(raw); } catch { return; } if (e.type === 'stream_end') { got = true; ws.close(); resolve(true); } });
    ws.on('error', () => {});
    setTimeout(() => { try { ws.close(); } catch {} if (!got) resolve(false); }, timeoutMs);
  });
}

let srv, sessionId;
(async () => {
  srv = spawn('node', ['server.js'], { cwd: __dirname, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stderr.on('data', () => {});
  for (let i = 0; i < 40; i++) { const r = await api('GET', '/api/server-info?token=' + TOKEN).catch(() => ({ status: 0 })); if (r.status === 200) break; await sleep(500); }
  log('server up');

  const dir = (await api('POST', '/api/directories', { name: 'sh', path: tmp, create: true })).j;
  const sess = (await api('POST', `/api/directories/${dir.id}/sessions`, { cli: 'claude', kind: 'chat', model: 'haiku' })).j;
  sessionId = sess.id;
  // seed one message into history so view has content
  log('session', sessionId);

  // ── public view share ──
  const pub = (await api('POST', `/api/sessions/${sessionId}/share`, { access: 'view' })).j;
  ok(pub.ok && pub.url && pub.url.includes('/share/'), 'created public view share with url');
  const pubGet = await api('GET', `/api/share/${pub.token}/session`, null, REC);
  ok(pubGet.status === 200 && pubGet.j.access === 'view', 'public share readable WITHOUT password or admin token');

  // ── password view share ──
  const pv = (await api('POST', `/api/sessions/${sessionId}/share`, { access: 'view', password: 's3cret' })).j;
  ok(pv.token, 'created password view share');
  const noPw = await api('GET', `/api/share/${pv.token}/session`, null, REC);
  ok(noPw.status === 401 && noPw.j.needPassword, 'password share → 401 needPassword without auth');
  const wrong = await api('POST', `/api/share/${pv.token}/auth`, { password: 'nope' }, REC);
  ok(wrong.status === 403, 'wrong password → 403');
  const right = await api('POST', `/api/share/${pv.token}/auth`, { password: 's3cret' }, REC);
  ok(right.status === 200, 'correct password → 200');
  const cookie = (right.headers.get('set-cookie') || '').split(';')[0];
  ok(/^multicc_share_/.test(cookie), 'auth set a per-share cookie');
  const withCookie = await api('GET', `/api/share/${pv.token}/session`, null, { ...REC, Cookie: cookie });
  ok(withCookie.status === 200, 'session readable with share cookie');

  // ── operate requires password ──
  const badOp = await api('POST', `/api/sessions/${sessionId}/share`, { access: 'operate' });
  ok(badOp.status === 400, 'operate share without password → 400');
  const op = (await api('POST', `/api/sessions/${sessionId}/share`, { access: 'operate', password: 'op-pw' })).j;
  ok(op.token, 'created operate share (with password)');
  const opAuth = await api('POST', `/api/share/${op.token}/auth`, { password: 'op-pw' }, REC);
  const opCookie = (opAuth.headers.get('set-cookie') || '').split(';')[0];

  // ── WS gate: view = read-only (no turn); operate = read-write (turn runs) ──
  log('WS: view share should NOT be able to drive a turn…');
  const viewDrove = await wsTurn(sessionId, pub.token, null, 'say hi', 8000);
  ok(viewDrove === false, 'view share CANNOT send messages (read-only)');
  log('WS: operate share SHOULD drive a turn (haiku, ~10s)…');
  const opDrove = await wsTurn(sessionId, op.token, opCookie, '只回复一个字：好', 30000);
  ok(opDrove === true, 'operate share CAN send messages and drive a turn');

  // ── revoke ──
  const del = await api('DELETE', `/api/sessions/${sessionId}/share/${pub.token}`);
  ok(del.j.ok, 'admin revoked a share');
  const afterDel = await api('GET', `/api/share/${pub.token}/session`, null, REC);
  ok(afterDel.status === 404, 'revoked share → 404');

  await api('DELETE', `/api/sessions/${sessionId}`).catch(() => {});
  srv.kill('SIGTERM'); fs.rmSync(tmp, { recursive: true, force: true });
  log(`\n${fail === 0 ? '✅ ALL PASS' : '❌ FAIL'} (${pass} pass, ${fail} fail)`);
  setTimeout(() => process.exit(fail === 0 ? 0 : 1), 500);
})().catch(async (e) => { console.error('FAILED:', e.message); if (sessionId) await api('DELETE', `/api/sessions/${sessionId}`).catch(() => {}); if (srv) srv.kill('SIGTERM'); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} setTimeout(() => process.exit(1), 500); });
