'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const { channel } = require('node:diagnostics_channel');
const { scheduleRequestTimer } = require('../native/request-timer');

// Node HTTP 与 Undici 的公共诊断事件用于连接计时；不替换全局网络方法。
// 只有准入模型请求的异步作用域会启动计时器，连接完成后不计首 token 等待。
const scope = new AsyncLocalStorage();
const pending = new WeakMap();

function begin(request) {
  const context = scope.getStore();
  const ms = Number(context?.attempt?.connectTimeoutMs);
  if (!request || !context?.stall?.isArmed() || !(ms > 0)) return;
  end(request);
  let active = true;
  const done = () => end(request);
  const timer = scheduleRequestTimer(() => {
    if (!active) return; // The timeout may already be queued when connect wins.
    done();
    context.stall.connectTimeout();
  }, ms);
  context.response.once('close', done);
  context.response.once('finish', done);
  pending.set(request, () => {
    active = false;
    timer.cancel();
    context.response.removeListener('close', done);
    context.response.removeListener('finish', done);
  });
}

function end(request) {
  pending.get(request)?.();
  pending.delete(request);
}

channel('undici:request:create').subscribe(({ request }) => begin(request));
// 请求一旦离开连接阶段就必须撤销计时器。sendHeaders 只有 HTTP/1 路径会发布；
// cli-provider-router 的上游传输固定 allowH2:true，借道走 HTTPS 隧道时协商 h2，
// 那条路径只会发布 bodySent（整个请求发完）与 headers（响应头到达）。漏掉它们，
// 计时器就会在第 30 秒把仍在进行的长流式请求误判成连接超时并掐断。
channel('undici:client:sendHeaders').subscribe(({ request }) => end(request));
channel('undici:request:bodySent').subscribe(({ request }) => end(request));
channel('undici:request:headers').subscribe(({ request }) => end(request));
channel('undici:request:error').subscribe(({ request }) => end(request));
channel('http.client.request.start').subscribe(({ request }) => {
  if (!scope.getStore()?.stall?.isArmed()) return;
  const watchSocket = socket => {
    if (!socket.connecting) return; // 已建立的复用连接不再等待连接事件。
    begin(request);
    const done = () => {
      end(request);
      socket.removeListener('connect', done);
      socket.removeListener('secureConnect', done);
      socket.removeListener('error', done);
      socket.removeListener('close', done);
    };
    socket.once(socket.encrypted ? 'secureConnect' : 'connect', done);
    socket.once('error', done);
    socket.once('close', done);
  };
  if (request.socket) watchSocket(request.socket);
  else request.once('socket', watchSocket);
  request.once('error', () => end(request));
  request.once('close', () => end(request));
});

function withModelConnectWatch(context, fn) {
  return scope.run(context, fn);
}

module.exports = { withModelConnectWatch };
