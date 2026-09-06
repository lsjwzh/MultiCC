#!/usr/bin/env node
'use strict';

// Own the visible TCP listener so the service registry stops THIS lab, never
// Docker Desktop's shared port-forwarding process. Compose remains foreground.
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const port = Number(process.env.MULTICC_LAB_PORT || 3300);
const backend = Number(process.env.MULTICC_LAB_BACKEND_PORT || 3301);
if (![port, backend].every(p => Number.isInteger(p) && p > 1024 && p < 65536) || port === backend) {
  throw new Error('Lab ports must be distinct integers between 1025 and 65535');
}
const root = path.resolve(__dirname, '..');
const sockets = new Set();
// Cookies are scoped by hostname, not port. Isolate the lab's login from the
// production UI on 127.0.0.1:3000 and never forward its cookie into the lab.
function proxyHeaders(headers) {
  const copy = { ...headers };
  delete copy.cookie;
  const cookie = String(headers.cookie || '').split(';').map(s => s.trim())
    .find(s => s.startsWith('multicc_docker_lab_auth='));
  if (cookie) copy.cookie = cookie.replace(/^multicc_docker_lab_auth=/, 'multicc_auth=');
  return copy;
}
const server = http.createServer((req, res) => {
  const proxy = http.request({ hostname: '127.0.0.1', port: backend, method: req.method, path: req.url, headers: proxyHeaders(req.headers) }, reply => {
    const headers = { ...reply.headers };
    if (headers['set-cookie']) headers['set-cookie'] = headers['set-cookie'].map(s => s.replace(/^multicc_auth=/, 'multicc_docker_lab_auth='));
    res.writeHead(reply.statusCode, headers); reply.pipe(res);
  });
  proxy.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('Docker lab is starting'); });
  req.on('aborted', () => proxy.destroy());
  res.on('close', () => proxy.destroy());
  req.pipe(proxy);
});
const track = socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); };
server.on('connection', track);
server.on('upgrade', (req, socket, head) => {
  const upstream = net.connect(backend, '127.0.0.1', () => {
    const headers = Object.entries(proxyHeaders(req.headers)).map(([key, value]) => `${key}: ${value}`);
    upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${headers.join('\r\n')}\r\n\r\n`);
    if (head.length) upstream.write(head);
    upstream.pipe(socket); socket.pipe(upstream);
  });
  track(upstream);
  upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy());
  socket.on('close', () => upstream.destroy()); upstream.on('close', () => socket.destroy());
});
let compose, stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  server.close(); for (const socket of sockets) socket.destroy();
  if (compose && compose.exitCode === null && !compose.signalCode) compose.kill('SIGTERM');
}
process.on('SIGINT', stop); process.on('SIGTERM', stop);
server.on('error', error => { console.error(error.message); process.exitCode = 1; stop(); });
// Claim the visible port before starting containers; an occupied port causes no
// container side effect. Requests return 502 until Compose has started the lab.
server.listen(port, '127.0.0.1', () => {
  compose = spawn('docker', ['compose', '-f', 'docker/task-shell/compose.yaml', 'up', '--abort-on-container-exit', 'lab', 'gateway'],
    { cwd: root, stdio: 'inherit' });
  compose.once('error', error => { console.error(error.message); process.exitCode = 1; stop(); });
  compose.once('exit', code => { if (!stopping) process.exitCode = code || 1; stop(); });
  console.log(`Docker lab: http://127.0.0.1:${port}/manage (password: multicc-docker-lab)`);
});
