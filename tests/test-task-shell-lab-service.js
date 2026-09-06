'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const WebSocket = require('ws');

const delay = ms => new Promise(r => setTimeout(r, ms));
async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port; }
async function wait(check) { for (let i = 0; i < 100; i++) { if (await check()) return; await delay(30); } throw new Error('timeout'); }

test('lab service owns HTTP/WS listener and forwards stop only to its Compose child', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-lab-service-'));
  const marker = path.join(temp, 'compose');
  const fake = path.join(temp, 'docker');
  fs.writeFileSync(fake, `#!${process.execPath}\nconst fs=require('fs');fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify(process.argv.slice(2)));setInterval(()=>{},1000);process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(marker)},'stopped');process.exit(0)});`, { mode: 0o755 });
  const backend = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    res.setHeader('Set-Cookie', 'multicc_auth=new-lab-cookie; Path=/; HttpOnly; SameSite=Lax');
    res.end(req.url + ':' + Buffer.concat(chunks) + ':' + req.headers.cookie);
  });
  const wss = new WebSocket.Server({ server: backend });
  wss.on('connection', (ws, req) => ws.on('message', data => ws.send(JSON.stringify({ cookie: req.headers.cookie, payload: String(data) }))));
  const backendPort = await listen(backend);
  const probe = http.createServer(); const port = await listen(probe); await new Promise(r => probe.close(r));
  const child = spawn(process.execPath, [path.join(__dirname, '../scripts/task-shell-lab-service.js')], {
    env: { ...process.env, PATH: temp + path.delimiter + process.env.PATH, MULTICC_LAB_PORT: String(port), MULTICC_LAB_BACKEND_PORT: String(backendPort) },
    stdio: 'ignore',
  });
  t.after(async () => {
    if (child.exitCode === null && !child.signalCode) { child.kill('SIGKILL'); await once(child, 'exit'); }
    for (const ws of wss.clients) ws.terminate();
    wss.close(); backend.closeAllConnections(); await new Promise(r => backend.close(r));
    fs.rmSync(temp, { recursive: true, force: true });
  });
  await wait(() => fs.existsSync(marker));
  assert.deepEqual(JSON.parse(fs.readFileSync(marker)).slice(-2), ['lab', 'gateway'], 'Compose must attach to both containers so stop covers dependencies');
  const cookie = 'multicc_auth=production-secret; multicc_docker_lab_auth=lab-cookie; unrelated=private';
  const response = await fetch(`http://127.0.0.1:${port}/echo?x=1`, { method: 'POST', body: 'body', headers: { cookie } });
  assert.equal(await response.text(), '/echo?x=1:body:multicc_auth=lab-cookie');
  assert.match(response.headers.get('set-cookie'), /^multicc_docker_lab_auth=new-lab-cookie;/);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie } }); await once(ws, 'open');
  const received = once(ws, 'message'); ws.send('payload');
  assert.deepEqual(JSON.parse(String((await received)[0])), { cookie: 'multicc_auth=lab-cookie', payload: 'payload' });
  ws.close(); await once(ws, 'close');
  const exited = once(child, 'exit'); child.kill('SIGTERM');
  assert.equal((await exited)[0], 0);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'stopped');
  assert.equal((await fetch(`http://127.0.0.1:${backendPort}/alive`)).status, 200, 'unrelated backend is not killed');
});
