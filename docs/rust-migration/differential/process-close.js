'use strict';
const path = require('node:path');
const { main, waitForFixture } = require('./lib');
let upstreamText;
main({
  name: 'process-close', ready: waitForFixture,
  mount(app, { repo }) {
    const { exercise } = require(path.join(repo, 'tests/helpers/process-close-fixture'));
    const frozen = require(path.join(repo, 'tests/helpers/frozen-file-batch27/process-close'));
    app.post('/api/process-close-fixture', async (req, res) => res.json(await exercise(frozen, req.body)));
    upstreamText = `
const net = require('node:net'), http = require('node:http'), path = require('node:path');
const repo = ${JSON.stringify(repo)};
const express = require(require.resolve('express', { paths: [repo] }));
const { createAuthSecurity } = require(path.join(repo, 'src/native/binding')).authSecurity;
const { connectAuthControl } = require(path.join(repo, 'src/native/binding')).gatewayChild;
globalThis.__gatewayAuthSecurity = createAuthSecurity({ secret: process.env.ACCESS_TOKEN });
connectAuthControl(globalThis.__gatewayAuthSecurity);
process.stdin.on('end', () => process.exit(0)); process.stdin.resume();
const app = express();
app.use(require(path.join(repo, 'src/native/binding')).httpErrors.requestIdMiddleware,
 require(path.join(repo, 'src/native/binding')).jsonCompression.jsonCompression, express.json());
const { exercise } = require(path.join(repo, 'tests/helpers/process-close-fixture'));
const api = require(path.join(repo, 'src/native/binding')).getProcessCloser();
app.post('/api/process-close-fixture', async (req, res) => res.json(await exercise(api, req.body)));
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
    for (let mode = 0; mode < 8; mode++) for (let timeout = 0; timeout < 6; timeout++) {
      cases.push([`${mode}/${timeout}`, { method: 'POST', url: '/api/process-close-fixture',
        headers: { Host: 'localhost', 'Content-Type': 'application/json', 'X-Request-Id': 'process-close-fixture' }, body: JSON.stringify({ mode, timeout }) }]);
    }
    return cases;
  },
  finalize({ views }) {
    return { ok: views.length === 48 && views.every(v => v.node.status === 200 && v.rust.status === 200) };
  },
});
