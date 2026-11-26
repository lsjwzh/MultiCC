'use strict';

// /api/* 的 JSON 响应按 Accept-Encoding 做 gzip。
//
// 为什么要它：手机经内网穿透隧道访问时带宽只有 ~250KB/s，而 /api/air 快照
// 未压缩 ~900KB（gzip 后 ~115KB）、/api/providers ~33KB（gzip 后 ~6KB）。不压缩时
// 一次快照就占满隧道好几秒，排在后面的运行配置读取/保存跟着一起等。
//
// 只拦 res.end 的「一次性整包」响应（res.json / res.send 走的就是这条）：
// - 已经 write 过（流式、SSE、代理转发）的响应 headersSent 为真，原样放行；
// - 已带 Content-Encoding 的（上游已压缩的转发）原样放行；
// - 只认 application/json，HTML/JS/图片等静态资源不在这里处理；
// - ETag/304 由 Express 在 end 之前按未压缩正文算好，这里不动（弱 ETag 与编码无关）。
const zlib = require('zlib');

const DEFAULT_MIN_BYTES = 1024;

function acceptsGzip(req) {
  return /\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''));
}

function appendVary(res) {
  const vary = String(res.getHeader('Vary') || '');
  if (/(^|,)\s*(accept-encoding|\*)\s*(,|$)/i.test(vary)) return;
  res.setHeader('Vary', vary ? `${vary}, Accept-Encoding` : 'Accept-Encoding');
}

function compressible(res, chunk, encoding, minBytes) {
  if (chunk == null || res.headersSent) return false;
  if (res.statusCode < 200 || res.statusCode === 204 || res.statusCode === 304) return false;
  if (res.getHeader('Content-Encoding')) return false;
  if (!/^application\/json\b/i.test(String(res.getHeader('Content-Type') || ''))) return false;
  const size = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk), encoding || 'utf8');
  return size >= minBytes;
}

function createJsonCompression({ minBytes = DEFAULT_MIN_BYTES, level = zlib.constants.Z_DEFAULT_COMPRESSION } = {}) {
  return function jsonCompression(req, res, next) {
    if (req.method === 'HEAD' || !req.path.startsWith('/api/')) return next();
    const gzip = acceptsGzip(req);
    const end = res.end;
    res.end = function endMaybeCompressed(chunk, encoding, callback) {
      res.end = end;
      if (typeof chunk === 'function') return end.call(res, chunk);
      if (typeof encoding === 'function') { callback = encoding; encoding = undefined; }
      if (!res.headersSent && /^application\/json\b/i.test(String(res.getHeader('Content-Type') || ''))) appendVary(res);
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
