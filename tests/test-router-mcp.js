'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const readline = require('readline');
const test = require('node:test');

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function close(server) {
  await new Promise(resolve => server.close(resolve));
}

function clientFor(port, originDispatchId = '') {
  const child = spawn(process.execPath, [
    path.join(__dirname, '..', 'scripts', 'multicc-router-mcp.js'),
  ], {
    env: {
      ...process.env,
      MULTICC_BASE_URL: `http://127.0.0.1:${port}`,
      MULTICC_ROUTER_CAPABILITY: 'cap-test',
      MULTICC_ORIGIN_DISPATCH_ID: originDispatchId,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on('line', line => {
    const message = JSON.parse(line);
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      waiter.resolve(message);
    }
  });
  let sequence = 0;
  function call(method, params = {}) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  async function stop() {
    child.stdin.end();
    await new Promise(resolve => {
      child.once('exit', resolve);
      setTimeout(() => {
        if (child.exitCode == null) child.kill('SIGTERM');
      }, 500).unref();
    });
  }
  return { call, stop };
}

test('stdio MCP advertises scoped tools and bridges calls with the capability', async t => {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      requests.push({
        url: req.url,
        capability: req.headers['x-multicc-router-capability'],
        body: JSON.parse(body),
      });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        ok: true,
        result: { ok: true, operation_id: 'op-1' },
      }));
    });
  });
  const port = await listen(server);
  t.after(() => close(server));

  const plain = clientFor(port);
  t.after(() => plain.stop());
  const initialized = await plain.call('initialize', { protocolVersion: '2025-06-18' });
  assert.equal(initialized.result.serverInfo.name, 'multicc-router');
  const listed = await plain.call('tools/list');
  assert.deepEqual(listed.result.tools.map(tool => tool.name), [
    'route_task', 'dispatch_master', 'dispatch_slave',
  ]);
  const called = await plain.call('tools/call', {
    name: 'route_task',
    arguments: { target_session_id: 'worker', message: 'do it' },
  });
  assert.equal(called.result.isError, false);
  assert.equal(called.result.structuredContent.operation_id, 'op-1');
  assert.equal(requests[0].url, '/api/internal/router-tools/route_task');
  assert.equal(requests[0].capability, 'cap-test');
  assert.deepEqual(requests[0].body.arguments, {
    target_session_id: 'worker',
    message: 'do it',
  });

  const dispatched = clientFor(port, 'op-origin');
  t.after(() => dispatched.stop());
  const dispatchedList = await dispatched.call('tools/list');
  assert.deepEqual(dispatchedList.result.tools.map(tool => tool.name), [
    'route_task', 'dispatch_master', 'dispatch_slave',
  ]);
});
