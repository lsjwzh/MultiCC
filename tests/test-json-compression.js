'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const zlib = require('zlib');
const express = require('express');
const { createJsonCompression } = require('../src/http/json-compression');

const BIG = { items: Array.from({ length: 400 }, (_, i) => ({ id: `item-${i}`, label: '运行配置 provider 列表' })) };

function startApp() {
  const app = express();
  app.use(createJsonCompression({ minBytes: 1024 }));
  app.get('/api/big', (req, res) => res.json(BIG));
  app.get('/api/small', (req, res) => res.json({ ok: true }));
  app.get('/api/html', (req, res) => res.type('html').send(`<p>${'x'.repeat(4000)}</p>`));
  app.get('/api/encoded', (req, res) => {
    res.set('Content-Encoding', 'identity').type('json').send(JSON.stringify(BIG));
  });
  app.get('/api/streamed', (req, res) => {
    res.type('json');
    res.write('{"items":[');
    res.end(`${JSON.stringify(BIG.items).slice(1)}}`);
  });
  app.get('/api/sse', (req, res) => {
    res.set('Content-Type', 'text/event-stream');
    res.write(`data: ${JSON.stringify(BIG)}\n\n`);
    res.end();
  });
  app.get('/api/error', (req, res) => res.status(500).json({ error: 'x'.repeat(3000) }));
  app.get('/proxy/big', (req, res) => res.json(BIG));
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function request(server, path, { method = 'GET', headers = {} } = {}) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

const GZIP = { 'Accept-Encoding': 'gzip, deflate, br' };

test('large /api JSON is gzipped for clients that accept it and decodes to the same body', async t => {
  const server = await startApp();
  t.after(() => server.close());
  const res = await request(server, '/api/big', { headers: GZIP });
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-encoding'], 'gzip');
  assert.match(res.headers.vary, /Accept-Encoding/);
  assert.equal(Number(res.headers['content-length']), res.body.length);
  assert.deepEqual(JSON.parse(zlib.gunzipSync(res.body).toString('utf8')), BIG);
  assert.ok(res.body.length < Buffer.byteLength(JSON.stringify(BIG)) / 4);
});

test('clients without gzip get the plain body (still marked Vary)', async t => {
  const server = await startApp();
  t.after(() => server.close());
  const res = await request(server, '/api/big');
  assert.equal(res.headers['content-encoding'], undefined);
  assert.match(res.headers.vary, /Accept-Encoding/);
  assert.deepEqual(JSON.parse(res.body.toString('utf8')), BIG);
});

test('ETag revalidation still answers 304 with an empty body', async t => {
  const server = await startApp();
  t.after(() => server.close());
  const first = await request(server, '/api/big', { headers: GZIP });
  assert.ok(first.headers.etag);
  const again = await request(server, '/api/big', { headers: { ...GZIP, 'If-None-Match': first.headers.etag } });
  assert.equal(again.status, 304);
  assert.equal(again.headers['content-encoding'], undefined);
  assert.equal(again.body.length, 0);
});

test('small, non-JSON, pre-encoded, streamed, SSE and non-/api responses pass through untouched', async t => {
  const server = await startApp();
  t.after(() => server.close());
  for (const path of ['/api/small', '/api/html', '/api/encoded', '/api/streamed', '/api/sse', '/proxy/big']) {
    const res = await request(server, path, { headers: GZIP });
    assert.notEqual(res.headers['content-encoding'], 'gzip', path);
    assert.ok(res.body.length > 0, path);
  }
  const streamed = await request(server, '/api/streamed', { headers: GZIP });
  assert.deepEqual(JSON.parse(streamed.body.toString('utf8')), BIG);
});

test('error bodies are compressed too; HEAD is never compressed', async t => {
  const server = await startApp();
  t.after(() => server.close());
  const error = await request(server, '/api/error', { headers: GZIP });
  assert.equal(error.status, 500);
  assert.equal(error.headers['content-encoding'], 'gzip');
  assert.equal(JSON.parse(zlib.gunzipSync(error.body).toString('utf8')).error.length, 3000);
  const head = await request(server, '/api/big', { method: 'HEAD', headers: GZIP });
  assert.equal(head.status, 200);
  assert.equal(head.headers['content-encoding'], undefined);
  assert.equal(head.body.length, 0);
});
