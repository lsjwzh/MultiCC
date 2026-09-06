'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
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
  const notifications = [];
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on('line', line => {
    const message = JSON.parse(line);
    if (message.id == null) {
      notifications.push(message);
      return;
    }
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
  return { call, notifications, stop };
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
      if (req.url.endsWith('/dispatch_master') && JSON.parse(body).arguments?.mode === 'sync') {
        res.setHeader('content-type', 'application/x-ndjson');
        res.write(`${JSON.stringify({ type: 'progress', progress: { kind: 'reasoning', message: 'worker thought' } })}\n`);
        res.write(`${JSON.stringify({ type: 'progress', progress: { kind: 'text', message: 'worker delta' } })}\n`);
        res.end(`${JSON.stringify({ type: 'result', result: { ok: true, mode: 'sync', result: 'worker final' } })}\n`);
        return;
      }
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
    'wait_for_external_result', 'get_external_wait', 'cancel_external_wait',
    'route_task', 'dispatch_cancel', 'dispatch_status', 'dispatch_master',
    'dispatch_slave',
  ]);
  const questionTool = listed.result.tools[0];
  assert.deepEqual(questionTool.inputSchema.required, ['question']);
  assert.equal(questionTool.inputSchema.properties.options.maxItems, 12);
  assert.match(questionTool.description, /blocking question/);
  const externalWaitTool = listed.result.tools
    .find(tool => tool.name === 'wait_for_external_result');
  assert.deepEqual(externalWaitTool.inputSchema.properties.mode.enum, [
    'callback', 'delay',
  ]);
  assert.equal(externalWaitTool.annotations.idempotentHint, false);
  for (const forbidden of [
    'session_id', 'pollCmd', 'pollUrl', 'cwd', 'injectPrefix', 'message',
  ]) {
    assert.equal(forbidden in externalWaitTool.inputSchema.properties, false);
  }
  const waitStatusTool = listed.result.tools
    .find(tool => tool.name === 'get_external_wait');
  assert.deepEqual(waitStatusTool.inputSchema.required, ['wait_id']);
  assert.equal(waitStatusTool.annotations.readOnlyHint, true);
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
  const routeTool = listed.result.tools.find(tool => tool.name === 'route_task');
  assert.match(routeTool.description, /busy.*available|available.*busy/i);
  assert.match(routeSchema.properties.target_session_id.description, /busy.*available|available.*busy/i);
  assert.match(routeSchema.properties.message.description, /objective/i);
  assert.match(routeSchema.properties.message.description, /constraints/i);
  assert.match(routeSchema.properties.message.description, /acceptance/i);
  assert.match(routeSchema.properties.message.description, /necessary/i);
  assert.match(routeSchema.properties.message.description, /redact|secret/i);
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
  const masterTool = listed.result.tools.find(tool => tool.name === 'dispatch_master');
  assert.deepEqual(masterTool.inputSchema.required, ['target_session_id', 'message', 'mode']);
  assert.deepEqual(masterTool.inputSchema.properties.mode.enum, ['sync', 'async']);
  assert.match(masterTool.description, /do not poll/i);
  assert.match(masterTool.description, /dispatch_status/);
  assert.match(masterTool.description, /busy.*available|available.*busy/i);
  const dispatchStatusTool = listed.result.tools.find(tool => tool.name === 'dispatch_status');
  assert.equal(dispatchStatusTool.annotations.readOnlyHint, true);
  assert.equal(dispatchStatusTool.inputSchema.required, undefined);
  assert.match(dispatchStatusTool.description, /terminated stream/);
  const sync = await plain.call('tools/call', {
    name: 'dispatch_master',
    arguments: {
      target_session_id: 'worker', message: 'sync work', mode: 'sync',
    },
    _meta: { progressToken: 'progress-1' },
  });
  assert.equal(sync.result.structuredContent.result, 'worker final');
  assert.deepEqual(plain.notifications[0], {
    jsonrpc: '2.0',
    method: 'notifications/progress',
    params: { progressToken: 'progress-1', progress: 1, message: 'worker thought' },
  });
  assert.deepEqual(plain.notifications[1], {
    jsonrpc: '2.0',
    method: 'notifications/progress',
    params: { progressToken: 'progress-1', progress: 2, message: 'worker delta' },
  });

  const dispatched = clientFor(port, 'op-origin');
  t.after(() => dispatched.stop());
  const dispatchedList = await dispatched.call('tools/list');
  assert.deepEqual(dispatchedList.result.tools.map(tool => tool.name), [
    'wait_for_user_answer', 'request_user_input',
    'wait_for_external_result', 'get_external_wait', 'cancel_external_wait',
    'route_task', 'dispatch_cancel', 'dispatch_status', 'dispatch_master',
    'dispatch_slave',
  ]);
});

test('an incomplete sync stream returns an explicit dispatch_status recovery contract', async t => {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.setHeader('content-type', 'application/x-ndjson');
      res.end(`${JSON.stringify({
        type: 'progress', progress: { kind: 'text', message: 'admitted then disconnected' },
      })}\n`);
    });
  });
  const port = await listen(server);
  t.after(() => close(server));
  const client = clientFor(port);
  t.after(() => client.stop());
  const response = await client.call('tools/call', {
    name: 'dispatch_master',
    arguments: { target_session_id: 'worker', message: 'long task', mode: 'sync' },
  });
  assert.equal(response.result.isError, true);
  assert.equal(response.result.structuredContent.code, 'router_call_interrupted');
  assert.equal(response.result.structuredContent.recovery_tool, 'dispatch_status');
  assert.match(response.result.structuredContent.message, /does not cancel/);
});

test('host prompt prefers scoped durable wait tools and keeps raw polling privileged', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(source, /优先用它登记持久等待/);
  assert.match(source, /wait_for_external_result/);
  assert.match(source, /get_external_wait/);
  assert.match(source, /cancel_external_wait/);
  assert.match(source, /只有必须由宿主机执行命令或查询 URL 时/);
  assert.doesNotMatch(source, /-d '\{\"mode\":\"callback\"\}'/);
});
