'use strict';
// Test-only HTTP oracle adapter. Production has no injected fetch/DNS fallback.
const http = require('node:http');
async function serveRemote(t, reply) {
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const response = await reply(new URL(req.url, endpoint.origin).href, {
        method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString('utf8'),
      }, req, res);
      if (!response) return;
      res.statusCode = response.status;
      for (const name of ['content-type', 'content-length', 'content-encoding', 'cache-control',
        'x-multicc-request-id', 'x-request-id', 'x-correlation-id', 'location']) {
        const value = response.headers?.get(name);
        if (value != null) res.setHeader(name, value);
      }
      res.end(response.text ? await response.text() : response.arrayBuffer ? Buffer.from(await response.arrayBuffer()) : '');
    } catch (error) { res.destroy(error); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const endpoint = { server, origin: `http://127.0.0.1:${server.address().port}` };
  return endpoint;
}
module.exports = { serveRemote };
