'use strict';

const { getNative } = require('../native/binding');
const zlib = require('zlib');

const DEFAULT_MIN_BYTES = 1024;

const headers = {
  get: (res, key) => res.getHeader(key),
  set: (res, key, value) => res.setHeader(key, value),
  below200: value => value < 200,
};

function compressible(res, chunk, encoding, minBytes) {
  if (!getNative().responseJsonEligible(res, chunk, headers)) return false;
  const size = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk), encoding || 'utf8');
  return size >= minBytes;
}

function createJsonCompression({ minBytes = DEFAULT_MIN_BYTES, level = zlib.constants.Z_DEFAULT_COMPRESSION } = {}) {
  return function jsonCompression(req, res, next) {
    if (req.method === 'HEAD' || !req.path.startsWith('/api/')) return next();
    const gzip = getNative().responseAcceptsGzip(req.headers['accept-encoding']);
    const end = res.end;
    res.end = function endMaybeCompressed(chunk, encoding, callback) {
      res.end = end;
      if (typeof chunk === 'function') return end.call(res, chunk);
      if (typeof encoding === 'function') { callback = encoding; encoding = undefined; }
      getNative().responseJsonVary(res, headers);
      if (!gzip || !compressible(res, chunk, encoding, minBytes)) return end.call(res, chunk, encoding, callback);
      const body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), encoding || 'utf8');
      // 异步压缩：900KB 的快照同步 gzip 要十几毫秒，不该卡住事件循环。
      zlib.gzip(body, { level }, (error, compressed) => {
        if (error || res.headersSent) return end.call(res, body, callback);
        res.setHeader('Content-Encoding', 'gzip');
        res.setHeader('Content-Length', compressed.length);
        end.call(res, compressed, callback);
      });
      return res;
    };
    next();
  };
}

const jsonCompression = createJsonCompression();

module.exports = { createJsonCompression, jsonCompression, DEFAULT_MIN_BYTES };
