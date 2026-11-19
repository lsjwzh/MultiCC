'use strict';
const { WebSocket } = require('ws');

// SDK bridge: the Rust transport supplies a validated one-use destination and
// pinned DNS answers. No persistent remote credential reaches this module.
function bridgeMachineSocket(ws, url, { authSecurity }) {
  if (!url.pathname.startsWith('/ws/machines/')) return false;
  const ticket = authSecurity.consumeWsTicket(url.searchParams.get('ticket'), url.pathname);
  if (!ticket?.machineId || url.pathname !== `/ws/machines/${ticket.machineId}` || !ticket.upstream?.addresses?.length) {
    ws.close(4003, '电脑连接票据无效'); return true;
  }
  const { addresses, url: upstreamUrl } = ticket.upstream;
  const upstream = new WebSocket(upstreamUrl, {
    handshakeTimeout: 10000, maxPayload: 48 * 1024 * 1024, followRedirects: false,
    lookup: (_host, options, callback) => {
      const selected = addresses.filter(a => !options.family || options.family === a.family);
      if (!selected.length) return callback(new Error('电脑地址不可用'));
      if (options.all) callback(null, selected);
      else callback(null, selected[0].address, selected[0].family);
    },
  });
  let bytes = 0;
  const queue = [];
  const fail = () => { upstream.terminate(); if (ws.readyState === WebSocket.OPEN) ws.close(1011, '电脑实时连接中断'); };
  function send(target, data, binary) {
    if (target.readyState !== WebSocket.OPEN || target.bufferedAmount > 8 * 1024 * 1024) return fail();
    target.send(data, { binary }, error => { if (error) fail(); });
  }
  ws.on('message', (data, binary) => {
    if (upstream.readyState === WebSocket.CONNECTING) {
      bytes += data.length;
      if (bytes > 1024 * 1024) return fail();
      queue.push([data, binary]);
    } else send(upstream, data, binary);
  });
  upstream.on('open', () => {
    if (ws.readyState !== WebSocket.OPEN) return upstream.close();
    for (const [data, binary] of queue.splice(0)) send(upstream, data, binary);
    bytes = 0;
  });
  upstream.on('message', (data, binary) => send(ws, data, binary));
  upstream.on('error', fail);
  ws.on('error', fail);
  upstream.on('close', code => { if (ws.readyState === WebSocket.OPEN) ws.close(code === 4003 ? 4003 : 1012, '电脑连接已关闭'); });
  ws.on('close', () => upstream.terminate());
  return true;
}
module.exports = { bridgeMachineSocket };
