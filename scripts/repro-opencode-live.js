#!/usr/bin/env node
'use strict';
/**
 * repro-opencode-live.js — 全链路复现「opencode 回应不自动展示、刷新才显示」
 *
 * 用 OPENCODE_CMD 环境变量把 opencode CLI 换成 stub（按真实事件形状吐 JSONL：
 * step_start → 若干个完整 text part → step_finish），在隔离数据目录起真实
 * server，走真实 WS 协议（/ws/chat?session=…, user_message），逐帧记录浏览器
 * 视角收到的 WS 事件，最后把录到的帧喂给前端 harness（真实
 * chat-event-controller/history-view + 假 DOM）验证直播渲染。
 *
 * 判定：
 *  A. server→WS：turn 进行期间 assistant(textSnapshot) 帧必须直播到达
 *  B. 前端：喂入录到的帧后，DOM 里必须出现含最终文本的 assistant 气泡
 *
 * 运行：node scripts/repro-opencode-live.js
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const STUB_SOURCE = `#!/usr/bin/env node
'use strict';
// Stub opencode CLI：按真实 opencode --format json 的事件形状输出。
// 每个 text 事件是一个【完整 part】（turn-engine 以 \\n\\n 拼接 part）。
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  const sid = 'ses_stub_' + Date.now();
  emit({ type: 'step_start', sessionID: sid, part: {} });
  const parts = [
    '第一部分：收到你的问题。',
    '第二部分：这是中间的分析过程，内容会逐渐变长变长变长。',
    '第三部分：最终回答——你好！这是完整回复。',
  ];
  for (const text of parts) {
    await sleep(300);
    emit({ type: 'text', sessionID: sid, part: { text } });
  }
  await sleep(120);
  emit({
    type: 'step_finish', sessionID: sid,
    part: { reason: 'stop', tokens: { input: 12, output: 34, cache: { read: 0, write: 0 } }, cost: 0 },
  });
})();
`;

async function api(base, method, p, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(base + p);
    const req = http.request({
      hostname: url.hostname, port: url.port, path: url.pathname + url.search,
      method, headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (_) {}
        resolve({ status: res.statusCode, json, text: data });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

function freePort() {
  return new Promise((resolve) => {
    const probe = require('net').createServer();
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

(async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-opencode-repro-'));
  const dataDir = path.join(tmpRoot, 'data');
  const projDir = path.join(tmpRoot, 'proj');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(projDir, { recursive: true });
  const stubPath = path.join(tmpRoot, 'stub-opencode.js');
  fs.writeFileSync(stubPath, STUB_SOURCE);
  fs.chmodSync(stubPath, 0o755);

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      MULTICC_DATA_DIR: dataDir,
      OPENCODE_CMD: stubPath,
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_CONFIG_SYSTEM: os.devNull,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  srv.stderr.on('data', c => { stderr += c; });
  const cleanup = (code) => { try { srv.kill('SIGINT'); } catch (_) {} process.exit(code); };
  process.on('SIGINT', () => cleanup(1));

  let up = false;
  for (let i = 0; i < 40; i++) {
    const r = await api(base, 'GET', '/api/directories').catch(() => ({ status: 0 }));
    if (r.status === 200) { up = true; break; }
    await sleep(500);
  }
  if (!up) { console.error('server did not come up\n' + stderr.slice(-2000)); cleanup(1); }
  console.log(`[repro] isolated server up on :${port} (stub opencode: ${stubPath})`);

  let r = await api(base, 'POST', '/api/directories', { name: 'repro', path: projDir });
  if (r.status !== 200 && r.status !== 201) { console.error('create directory failed', r.status, r.text); cleanup(1); }
  const dirId = r.json.id;
  r = await api(base, 'POST', `/api/directories/${dirId}/sessions`, { cli: 'opencode', kind: 'chat', label: 'repro-opencode' });
  if (r.status !== 200 && r.status !== 201) { console.error('create session failed', r.status, r.text); cleanup(1); }
  const sessionId = r.json.id;
  console.log(`[repro] session created: ${sessionId}`);

  // ── 浏览器视角：WS 连接，逐帧记录 ──
  const frames = [];
  const t0 = Date.now();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/chat?session=${encodeURIComponent(sessionId)}`);
  ws.on('message', (raw) => {
    let evt;
    try { evt = JSON.parse(raw.toString()); } catch (_) { return; }
    frames.push({ at: Date.now() - t0, evt });
  });
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
    setTimeout(() => reject(new Error('ws open timeout')), 5000);
  });
  console.log('[repro] ws open, sending user_message…');
  ws.send(JSON.stringify({ type: 'user_message', text: '你好，测试一下', clientMsgId: 'repro-c1' }));

  // 等 turn 收尾（result 帧）后再多等 1s
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 12000);
    const iv = setInterval(() => {
      if (frames.some(f => f.evt.type === 'result')) { clearInterval(iv); clearTimeout(timer); setTimeout(resolve, 1000); }
    }, 100);
  });
  ws.close();

  // ── 判定 A：server→WS 直播帧 ──
  const snapshots = frames.filter(f => f.evt.type === 'assistant'
    && f.evt.message && f.evt.message.textSnapshot === true);
  const resultFrame = frames.find(f => f.evt.type === 'result');
  const resultAt = resultFrame ? resultFrame.at : null;
  console.log(`\n[repro] frames total=${frames.length}`);
  for (const f of frames) {
    const summary = f.evt.type === 'assistant'
      ? `assistant textSnapshot=${f.evt.message?.textSnapshot === true} text=${JSON.stringify((f.evt.message?.content?.[0]?.text || '').slice(0, 40))}`
      : f.evt.type;
    console.log(`  +${String(f.at).padStart(5)}ms ${summary}`);
  }
  const liveSnapshots = resultAt === null ? snapshots : snapshots.filter(f => f.at < resultAt);
  const verdictA = liveSnapshots.length > 0;
  console.log(`\n[判定A] result 前到达的直播快照帧: ${liveSnapshots.length}/${snapshots.length} → ${verdictA ? 'PASS（server 直播正常）' : 'FAIL（turn 期间没有任何直播文本帧）'}`);

  // ── 判定 B：前端 harness 渲染 ──
  const { createRig, scanDuplicates } = require('./chat-dup-harness');
  const rig = createRig('opencode');
  const wsEvents = frames.map(f => f.evt).filter(e => e.type !== 'chat_history');
  rig.feed(wsEvents);
  const { findings, bubbles } = scanDuplicates(rig.messagesEl);
  const finalText = '第一部分：收到你的问题。\n\n第二部分：这是中间的分析过程，内容会逐渐变长变长变长。\n\n第三部分：最终回答——你好！这是完整回复。';
  const rendered = bubbles.filter(b => b.kind === 'assistant').map(b => b.text);
  const verdictB = rendered.some(t => t.includes('最终回答'));
  console.log(`\n[判定B] 前端 DOM 气泡: ${bubbles.map(b => `${b.kind}(${b.text.length}字)`).join(' → ') || '（空）'}`);
  console.log(`[判定B] 含最终文本的 assistant 气泡: ${verdictB ? 'PASS' : 'FAIL（直播帧喂完 DOM 里没有最终回答）'}`);
  if (findings.length) console.log(`[判定B] 重复检测: ${findings.join(' | ')}`);

  console.log(`\n[repro] server stderr tail: ${stderr.trim().split('\n').slice(-5).join(' | ') || '(clean)'}`);
  cleanup(verdictA && verdictB ? 0 : 2);
})();
