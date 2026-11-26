'use strict';
const path = require('node:path');
const { main, waitForFixture } = require('./lib');
let upstreamText;
main({
  name: 'monitor-control', ready: waitForFixture,
  mount(app, { repo }) {
    const { exercise } = require(path.join(repo, 'tests/helpers/monitor-control-fixture'));
    const frozen = require(path.join(repo, 'tests/helpers/frozen-file-batch28/monitor-control'));
    app.post('/api/monitor-control-fixture', async (req, res) => res.json(await exercise(frozen, req.body)));
    upstreamText = `
const net = require('node:net'), http = require('node:http'), path = require('node:path');
const repo = ${JSON.stringify(repo)};
const express = require(require.resolve('express', { paths: [repo] }));
const { createAuthSecurity } = require(path.join(repo, 'src/auth-security'));
const { connectAuthControl } = require(path.join(repo, 'src/gateway-child'));
globalThis.__gatewayAuthSecurity = createAuthSecurity({ secret: process.env.ACCESS_TOKEN });
connectAuthControl(globalThis.__gatewayAuthSecurity);
process.stdin.on('end', () => process.exit(0)); process.stdin.resume();
const app = express();
app.use(require(path.join(repo, 'src/http-errors')).requestIdMiddleware,
 require(path.join(repo, 'src/http/json-compression')).jsonCompression, express.json());
const { exercise } = require(path.join(repo, 'tests/helpers/monitor-control-fixture'));
const api = require(path.join(repo, 'src/native/runtime')).getMonitorControl();
app.post('/api/monitor-control-fixture', async (req, res) => res.json(await exercise(api, req.body)));
app.get('/__health', (_req, res) => res.type('text/plain').send('ok'));
const server = http.createServer(app);
const listener = net.createServer({ pauseOnConnect: true }, socket => {
 socket.on('error', () => {}); let buffered = Buffer.alloc(0);
 const onData = chunk => { buffered = Buffer.concat([buffered, chunk]);
  const end = buffered.indexOf('\\r\\n'); if (end < 0) return;
  socket.removeListener('data', onData); socket.pause();
  const rest = buffered.subarray(end + 2); if (rest.length) socket.unshift(rest);
  server.emit('connection', socket); socket.resume(); };
 socket.on('data', onData); socket.resume();
});
listener.listen(Number(process.env.MULTICC_GATEWAY_INTERNAL_PORT), '127.0.0.1');`;
  },
  get upstream() { return upstreamText; },
  corpus() {
    const cases = [];
    for (let mode = 0; mode < 8; mode++) for (let flag = 0; flag < 6; flag++) {
      cases.push([`${mode}/${flag}`, { method: 'POST', url: '/api/monitor-control-fixture',
        headers: { Host: 'localhost', 'Content-Type': 'application/json', 'X-Request-Id': 'monitor-control-fixture' }, body: JSON.stringify({ mode, flag }) }]);
    }
    return cases;
  },
  finalize({ views }) {
    return { ok: views.length === 48 && views.every(v => v.node.status === 200 && v.rust.status === 200) };
  },
});
