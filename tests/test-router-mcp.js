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
    'wait_for_user_answer', 'request_user_input',
    'route_task', 'dispatch_master', 'dispatch_slave',
  ]);
  const questionTool = listed.result.tools[0];
  assert.deepEqual(questionTool.inputSchema.required, ['question']);
  assert.equal(questionTool.inputSchema.properties.options.maxItems, 12);
  assert.match(questionTool.description, /blocking question/);
  const asked = await plain.call('tools/call', {
    name: 'wait_for_user_answer',
    arguments: {
      question: '选择发布环境',
      options: ['测试环境', '生产环境'],
    },
  });
  assert.equal(asked.result.isError, false);
  assert.equal(requests[0].url, '/api/internal/router-tools/wait_for_user_answer');
  assert.deepEqual(requests[0].body.arguments.options, ['测试环境', '生产环境']);
  const routeSchema = listed.result.tools.find(tool => tool.name === 'route_task').inputSchema;
  assert.deepEqual(routeSchema.properties.allow_terminal, {
    type: 'boolean',
    default: false,
    description: 'Set true only when the originating user message names this terminal session by its exact id or complete label. Mentioning terminal/CLI software is not sufficient.',
  });
  const called = await plain.call('tools/call', {
    name: 'route_task',
    arguments: { target_session_id: 'worker', message: 'do it' },
  });
  assert.equal(called.result.isError, false);
  assert.equal(called.result.structuredContent.operation_id, 'op-1');
  assert.equal(requests[1].url, '/api/internal/router-tools/route_task');
  assert.equal(requests[1].capability, 'cap-test');
  assert.deepEqual(requests[1].body.arguments, {
    target_session_id: 'worker',
    message: 'do it',
  });

  const dispatched = clientFor(port, 'op-origin');
  t.after(() => dispatched.stop());
  const dispatchedList = await dispatched.call('tools/list');
  assert.deepEqual(dispatchedList.result.tools.map(tool => tool.name), [
    'wait_for_user_answer', 'request_user_input',
    'route_task', 'dispatch_master', 'dispatch_slave',
  ]);
});
