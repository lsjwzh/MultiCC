'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { getNative } = require('../src/native/binding');
const test = require('node:test');

function harness(getChildProxyEnv, proxyForUrl = async () => 'http://proxy.test:8080') {
  const calls = [];
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = signal => calls.push({ signal });
  const tts = getNative().ttsServiceApi({
    env: process.env, WebSocket: require('ws'), https: require('node:https'),
    getChildProxyEnv, outboundAgent: {}, policy: { proxyForUrl },
    console: { log() {}, error() {}, warn() {} },
    spawn(command, args, options) {
      calls.push({ command, args, options });
      return child;
    },
  });
  const socket = new EventEmitter();
  socket.readyState = 1;
  socket.messages = [];
  socket.send = message => socket.messages.push(message);
  tts.handleTtsWs(socket, {});
  return { socket, calls, child };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

test('Edge 语音子进程等待统一代理并显式传给 WebSocket 客户端', async () => {
  let resolveProxy;
  const { socket, calls, child } = harness(() => new Promise(resolve => { resolveProxy = resolve; }));
  socket.emit('message', JSON.stringify({ type: 'start', text: '你好', provider: 'edge' }));
  assert.equal(calls.length, 0);
  resolveProxy({ https_proxy: 'http://proxy.test:8080', no_proxy: 'localhost,127.0.0.1' });
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.env.https_proxy, 'http://proxy.test:8080');
  assert.deepEqual(Array.from(calls[0].args.slice(-2)), ['--proxy', 'http://proxy.test:8080']);
  child.stdout.emit('data', Buffer.from('audio'));
  child.emit('close', 0);
  assert.equal(JSON.parse(socket.messages.at(-1)).type, 'done');
});

test('Edge 代理准备期间停止会阻止后续派生', async () => {
  let resolveProxy;
  const { socket, calls } = harness(() => new Promise(resolve => { resolveProxy = resolve; }));
  socket.emit('message', JSON.stringify({ type: 'start', text: '你好', provider: 'edge' }));
  socket.emit('message', JSON.stringify({ type: 'stop' }));
  resolveProxy({ https_proxy: 'http://proxy.test:8080' });
  await flush();
  assert.equal(calls.length, 0);
  assert.equal(socket.messages.length, 0);
});

test('Edge 代理准备失败明确报错且不尝试直连', async () => {
  const { socket, calls } = harness(async () => { throw new Error('代理发现失败'); });
  socket.emit('message', JSON.stringify({ type: 'start', text: '你好', provider: 'edge' }));
  await flush();
  assert.equal(calls.length, 0);
  assert.equal(JSON.parse(socket.messages[0]).type, 'error');
});

test('Edge 直连规则生效时不强塞代理参数', async () => {
  const { socket, calls } = harness(async () => ({ https_proxy: 'http://proxy.test:8080' }), async url => {
    assert.equal(url, 'wss://speech.platform.bing.com');
    return '';
  });
  socket.emit('message', JSON.stringify({ type: 'start', text: '你好', provider: 'edge' }));
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.includes('--proxy'), false);
});
