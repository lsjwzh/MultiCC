'use strict';
// The application stays on an internal network with no default route. Only this
// fixed-destination TCP relay joins the port-publishing network (Docker Desktop
// does not publish ports of a container attached solely to an internal network).
const net = require('node:net');
const sockets = new Set();
const track = socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); };
const server = net.createServer(client => {
  const upstream = net.connect(3000, 'lab');
  track(client); track(upstream);
  client.pipe(upstream); upstream.pipe(client);
  client.on('error', () => upstream.destroy()); upstream.on('error', () => client.destroy());
  client.on('close', () => upstream.destroy()); upstream.on('close', () => client.destroy());
});
server.listen(3000, '0.0.0.0');
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  server.close(); for (const socket of sockets) socket.destroy();
});
