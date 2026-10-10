// OpenRouter 全球 Token 使用量图表服务 — 零依赖 Node HTTP 静态服务
// 数据来源: MacroMicro chart 148532, GET https://en.macromicro.me/charts/data/148532
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.CHART_PORT || 3312); // 不读 PORT：宿主环境注入 PORT=3000 会撞 multicc
const ROOT = __dirname;
const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');

  // 手动刷新: 重新抓取 MacroMicro 数据。6 小时新鲜度闸门防滥用(公开路由), ?force=1 跳过。
  if (req.method === 'POST' && url.pathname === '/refresh') {
    const dataPath = path.join(ROOT, 'public', 'data.json');
    const freshMs = 6 * 3600 * 1000;
    let age = Infinity;
    try { age = Date.now() - fs.statSync(dataPath).mtimeMs; } catch (_) {}
    const force = url.searchParams.get('force') === '1';
    if (age < freshMs && !force) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      let last = '';
      try { last = JSON.parse(fs.readFileSync(dataPath, 'utf8')).dates.slice(-1)[0]; } catch (_) {}
      res.end(JSON.stringify({ ok: true, skipped: 'fresh', ageHours: (age / 3600000).toFixed(1), lastDate: last }));
      return;
    }
    const child = spawn(process.execPath, [path.join(ROOT, 'fetch.js')], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', c => out += c); child.stderr.on('data', c => err += c);
    const timer = setTimeout(() => child.kill('SIGKILL'), 150000);
    child.on('close', code => {
      clearTimeout(timer);
      let last = '';
      try { last = JSON.parse(fs.readFileSync(dataPath, 'utf8')).dates.slice(-1)[0]; } catch (_) {}
      const ok = code === 0;
      res.writeHead(ok ? 200 : 500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok, lastDate: last, log: (out + err).split('\n').filter(Boolean).slice(-4) }));
    });
    return;
  }

  let file = url.pathname === '/' ? '/public/index.html' : '/public' + url.pathname;
  // 只允许 public/ 内的文件
  const abs = path.normalize(path.join(ROOT, file));
  if (!abs.startsWith(path.join(ROOT, 'public'))) { res.writeHead(404); res.end('not found'); return; }
  fs.readFile(abs, (err, buf) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`openrouter-usage chart listening on http://127.0.0.1:${PORT}/`);
});
