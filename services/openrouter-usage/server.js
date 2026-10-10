// OpenRouter 全球 Token 使用量图表服务 — 零依赖 Node HTTP 静态服务
// 数据来源: MacroMicro chart 148532, GET https://en.macromicro.me/charts/data/148532
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.CHART_PORT || 3312); // 不读 PORT：宿主环境注入 PORT=3000 会撞 multicc
const ROOT = __dirname;
const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
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
