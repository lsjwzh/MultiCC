'use strict';

// 升级期间替正式服务占住端口的工作线程。主线程在同步迁移里被占满，这里有自己的事件
// 循环：/readyz 等接口回 503 + 进度 JSON（启动器据此继续等待），网页回自动刷新的进度页。
// 只暴露阶段、百分比和磁盘字节数，不含任何用户数据。
const http = require('node:http');
const fs = require('node:fs');
const { parentPort, workerData } = require('node:worker_threads');
const { describeMigration } = require('./migration-progress');

const signal = new Int32Array(workerData.signal);
let failure = null;
// 同一次尝试里百分比只增不减：阶段交接的瞬间（例如备份刚改名）读到的文件可能落后一步。
let floor = 0;
function settle(value) { Atomics.store(signal, 0, value); Atomics.notify(signal, 0); }
function statSize(file) { try { return fs.statSync(file).size; } catch { return 0; } }
function snapshot() {
  let state = null;
  try { state = JSON.parse(fs.readFileSync(workerData.progressFile, 'utf8')); } catch {}
  const migration = describeMigration(state, { statSize, failure });
  if (migration.state === 'running') migration.percent = floor = Math.max(floor, migration.percent);
  return migration;
}
const LABELS = {
  starting: ['正在准备升级', 'Preparing'], backup: ['正在备份原数据', 'Backing up'],
  migrate: ['正在转换任务数据', 'Converting task data'], vacuum: ['正在整理数据文件', 'Compacting'],
};
const gb = n => `${(n / 1024 ** 3).toFixed(1)} GB`;
function page(m) {
  let detail;
  if (m.state === 'failed' && m.error.needBytes) {
    detail = `磁盘空间不足：升级需要至少 ${gb(m.error.needBytes)} 可用空间，当前只有 ${gb(m.error.freeBytes)}。数据没有任何改动；腾出空间后会自动继续。<br>`
      + `Not enough disk space: the upgrade needs ${gb(m.error.needBytes)} free, ${gb(m.error.freeBytes)} available. Nothing was changed; it resumes once space is freed.`;
  } else if (m.state === 'failed') {
    detail = `升级未完成（${m.error.code}），数据已整体回滚、没有改动。请查看日志。<br>The upgrade did not finish (${m.error.code}); nothing was changed. See the log.`;
  } else {
    const [zh, en] = LABELS[m.step] || LABELS.starting;
    detail = `${zh} ${m.percent}%（已用 ${Math.round(m.elapsedMs / 1000)} 秒）<br>${en} ${m.percent}%`;
  }
  const bar = m.state === 'failed' ? '' : `<div style="background:#eee;border-radius:4px;height:8px"><div style="background:#4f7cff;border-radius:4px;height:8px;width:${m.percent}%"></div></div>`;
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>MultiCC</title><noscript><meta http-equiv="refresh" content="5"></noscript>`
    // 不用 meta refresh：迁移结束到正式服务开始监听之间有几秒连不上，那一下刷新会落在
    // 浏览器的错误页上、再也不会自己回来。轮询 /readyz，连不上就接着等。
    + `<script>(function tick(){setTimeout(function(){fetch('/readyz',{cache:'no-store'}).then(function(r){`
    + `return r.json().catch(function(){return {};}).then(function(b){if(b.phase==='data-migration'||r.ok)location.reload();else tick();});`
    + `},tick);},2000);})();</script>`
    + `<body style="font-family:system-ui,sans-serif;max-width:560px;margin:15vh auto;padding:0 20px;color:#222">`
    + `<h2>MultiCC 正在升级任务数据（仅此一次）</h2><p style="color:#666">Upgrading task data (one time only)</p>`
    + `${bar}<p>${detail}</p></body>`;
}
const server = http.createServer((req, res) => {
  const migration = snapshot();
  const wantsPage = req.method === 'GET' && !/^\/(readyz|healthz|api\/|ws)/.test(req.url || '')
    && /text\/html/.test(req.headers.accept || '');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Retry-After', '2');
  if (wantsPage) {
    res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page(migration));
    return;
  }
  res.writeHead(503, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'not_ready', phase: 'data-migration', migration }));
});
server.on('error', () => settle(2));
if (workerData.behindGateway) {
  // The front door owns the public port; this worker must listen on the one
  // loopback port it reserved and parse the PROXY line just like server.js.
  require('../gateway-child').listenBehindGateway(server, {
    port: workerData.port,
    logger: { info() {}, warn() {}, error() {} },
    onListening: () => settle(1),
  });
} else {
  server.listen(workerData.port, workerData.host, () => settle(1));
}
parentPort.on('message', message => {
  if (message?.type === 'failure') { failure = message.failure; floor = 0; }
  if (message?.type !== 'stop') return;
  server.close(() => { settle(3); parentPort.close(); });
  server.closeAllConnections();
});
