'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { configure } = require('../../scripts/configure-command-code');

const config = configure();
console.log(`DeepSeek 模型：${config.model}；密钥${config.keyConfigured ? '已配置' : '未配置'}（健康检查不代表模型调用成功）`);
fs.mkdirSync(process.env.MULTICC_DATA_DIR, { recursive: true });
const server = spawn(process.execPath, ['server.js'], { stdio: 'inherit' });
let stopping = false;
let failed = false;
function stop() {
  if (stopping) return;
  stopping = true;
  server.kill('SIGTERM');
  setTimeout(() => server.kill('SIGKILL'), 15000).unref();
}
process.on('SIGTERM', stop); process.on('SIGINT', stop);
server.on('error', () => { process.exitCode = 1; });
server.on('exit', code => { process.exitCode = failed ? 1 : stopping ? 0 : code || 1; });
async function api(route, body) {
  const r = await fetch('http://127.0.0.1:3000' + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-access-token': process.env.ACCESS_TOKEN },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw Object.assign(new Error(`${route}: HTTP ${r.status}`), { status: r.status });
  return r.json();
}
async function seed() {
  let ready = false;
  for (let i = 0; i < 120 && !stopping; i++) {
    if (server.exitCode !== null || server.signalCode) throw new Error('服务启动失败');
    try { ready = (await fetch('http://127.0.0.1:3000/readyz', { signal: AbortSignal.timeout(1000) })).ok; } catch (_) {}
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (stopping) return;
  if (!ready) throw new Error('服务就绪超时');
  const project = '/var/lib/multicc/project';
  const dirs = await api('/api/directories');
  let dir = dirs.find(d => d.path === project);
  if (!dir) dir = await api('/api/directories', { name: 'Command Code · DeepSeek 集成测试', path: project, create: true });
  const sessions = await api('/api/sessions');
  let session = sessions.find(s => s.dirId === dir.id && s.label === 'Command Code · DeepSeek Flash');
  const seedFile = path.join(process.env.MULTICC_DATA_DIR, 'command-code-seed.json');
  if (!session && fs.existsSync(seedFile)) {
    const previous = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
    if (previous.directoryId === dir.id && previous.sessionId) {
      try { session = await api(`/api/sessions/${encodeURIComponent(previous.sessionId)}`); }
      catch (error) { if (error.status !== 404) throw error; }
    }
  }
  if (!session) session = await api(`/api/directories/${dir.id}/sessions`, {
    cli: 'commandcode', kind: 'chat', model: config.model, label: 'Command Code · DeepSeek Flash',
  });
  fs.writeFileSync(seedFile, JSON.stringify({ directoryId: dir.id, sessionId: session.id, model: config.model }));
  console.log(`Command Code 会话已就绪：/chat.html?session=${session.id}`);
}
seed().catch(error => { failed = true; console.error(error.message); stop(); });
