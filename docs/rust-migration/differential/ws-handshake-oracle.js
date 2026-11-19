'use strict';

// Freeze responses from the same `ws` noServer handler used by server.js.
// Run from the repository root: node docs/rust-migration/differential/ws-handshake-oracle.js
const { Duplex } = require('node:stream');
const { WebSocketServer } = require('ws');

const valid = { method: 'GET', upgrade: 'websocket', key: 'dGhlIHNhbXBsZSBub25jZQ==', version: '13' };
const cases = [
  valid,
  { ...valid, upgrade: 'WebSocket', protocol: 'chat, superchat' },
  { ...valid, version: '8' }, { ...valid, version: '13.0' },
  { ...valid, method: 'POST' }, { ...valid, upgrade: 'not-websocket' },
  { ...valid, upgrade: undefined }, { ...valid, key: undefined },
  { ...valid, key: 'bad' }, { ...valid, version: undefined },
  { ...valid, version: '12' }, ...['', ' chat', 'chat ', 'chat,,other', 'chat, chat', 'chat;other', 'chat\tother', 'chat,other', 'chat, other'].map(protocol => ({ ...valid, protocol })),
];

function response(input) {
  const chunks = [];
  const socket = new Duplex({ read() {}, write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
  socket.setTimeout = () => socket;
  socket.setNoDelay = () => socket;
  const server = new WebSocketServer({ noServer: true });
  const headers = {};
  for (const [field, header] of [['upgrade', 'upgrade'], ['key', 'sec-websocket-key'],
    ['version', 'sec-websocket-version'], ['protocol', 'sec-websocket-protocol']]) {
    if (input[field] !== undefined) headers[header] = input[field];
  }
  server.handleUpgrade({ method: input.method, headers, url: '/ws/chat' }, socket, Buffer.alloc(0), ws => ws.terminate());
  return Buffer.concat(chunks).toString('base64');
}
process.stdout.write(JSON.stringify(cases.map(input => ({ ...input, response: response(input) })), null, 2) + '\n');
