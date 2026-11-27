'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const {
  createCodexProxyTrace, markStage, traceParts, traceRoute,
} = require('../src/native/binding').codexProxyTrace;

const CAPABILITY = 'pr1.dGFzay04OGE5NjkzNTNjMGI3MTY2MzZiNzE0YjMwMjQ4M2EzOQ.cHJveHktcm91dGVfN2FiY2U5YjMtODRhNy00MTBmLWFmYWYtYTJjN2U5MzgzYWNi';

function fakeRequest(url, options = {}) {
  return { method: 'POST', url, originalUrl: url, id: options.id, headers: {}, body: options.body };
}

// Only what the trace touches: Node's response events plus the three reads.
class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.statusCode = 200;
    this.writableFinished = true;
    this.locals = {};
    this.headers = {};
  }
  getHeader(name) { return this.headers[name]; }
}

test('the route label keeps the identity and redacts the capability', () => {
  const url = `/codex-proxy/codex-official/${CAPABILITY}/main/responses?stream=true`;
  assert.equal(traceRoute(url), '/codex-proxy/codex-official/pr1.<redacted>/main/responses');
  assert.deepEqual(traceParts(url), { providerId: 'codex-official', session: 'pr1.<redacted>', role: 'main' });
  // The session-less compatibility route and unknown sub-paths stay readable.
  assert.deepEqual(traceParts('/codex-proxy/codex-official/responses'),
    { providerId: 'codex-official', session: null, role: null });
  assert.deepEqual(traceParts('/codex-proxy/codex-official/quota'),
    { providerId: 'codex-official', session: 'quota', role: null });
  assert.deepEqual(traceParts('/not-the-prefix'), { providerId: null, session: null, role: null });
});

test('a request that reached the prefix is recorded with the stage that answered', () => {
  const trace = createCodexProxyTrace({ now: () => 1000 });
  const req = fakeRequest(`/codex-proxy/codex-official/${CAPABILITY}/main/responses`, { id: 'req-1', body: { model: 'gpt-6-astra' } });
  const res = new FakeResponse();
  res.locals.requestId = 'req-1';
  res.headers['x-powered-by'] = 'Express';
  let forwarded = false;
  trace.middleware(req, res, value => { forwarded = true; return value; });
  assert.equal(forwarded, true, 'the trace never holds a request back');
  assert.equal(trace.snapshot()[0].status, null, 'still open until the response settles');

  res.statusCode = 404;
  res.emit('finish');
  const [entry] = trace.snapshot();
  assert.equal(entry.requestId, 'req-1');
  assert.equal(entry.method, 'POST');
  assert.equal(entry.model, 'gpt-6-astra');
  assert.equal(entry.status, 404);
  assert.equal(entry.stage, 'proxy', 'a mounted proxy route answered');
  assert.equal(entry.expressResponded, true);
  assert.equal(entry.aborted, false);
  assert.match(entry.route, /pr1\.<redacted>\/main\/responses$/);
  assert.equal(entry.route.includes('dGFzay04'), false, 'the capability never lands in the trace');
});

test('each stage labels itself, and a request no route accepted is named', () => {
  const trace = createCodexProxyTrace();
  const url = `/codex-proxy/codex-official/${CAPABILITY}/main/responses`;

  const relayed = new FakeResponse();
  assert.equal(markStage(relayed, 'official-relay'), 'official-relay');
  trace.middleware(fakeRequest(url), relayed, () => {});
  relayed.statusCode = 200;
  relayed.emit('finish');
  assert.equal(trace.snapshot()[0].stage, 'official-relay');

  const guarded = new FakeResponse();
  markStage(guarded, 'guard');
  trace.middleware(fakeRequest(url), guarded, () => {});
  guarded.statusCode = 409;
  guarded.emit('finish');
  assert.equal(trace.snapshot()[0].stage, 'guard');

  const missed = new FakeResponse();
  let nextCalled = false;
  trace.middleware(fakeRequest('/codex-proxy/codex-official/unknown/route'), missed, () => {});
  trace.unmatched({}, missed, () => { nextCalled = true; });
  assert.equal(nextCalled, true, 'Express still answers the 404 exactly as before');
  missed.statusCode = 404;
  missed.emit('finish');
  assert.equal(trace.snapshot()[0].stage, 'unmatched');
});

test('a closed connection settles the entry instead of leaving it open', () => {
  const trace = createCodexProxyTrace();
  const res = new FakeResponse();
  res.writableFinished = false;
  trace.middleware(fakeRequest('/codex-proxy/codex-official/responses'), res, () => {});
  res.emit('close');
  const [entry] = trace.snapshot();
  assert.equal(entry.ended, true);
  assert.equal(entry.aborted, true);
});

test('completed proxy 404 responses log their responding stage once without leaking capabilities', () => {
  const warnings = [];
  const trace = createCodexProxyTrace({ logger: { warn: (...args) => warnings.push(args) } });
  for (const stage of ['proxy', 'official-relay']) {
    const res = new FakeResponse();
    trace.middleware(fakeRequest(`/codex-proxy/codex-official/${CAPABILITY}/main/responses`, {
      id: `missing-${stage}`, body: { model: 'gpt-6-astra' },
    }), res, () => {});
    markStage(res, stage);
    res.statusCode = 404;
    res.emit('finish');
    res.emit('close');
  }
  assert.equal(warnings.length, 2, 'finish followed by close must not duplicate the warning');
  assert.deepEqual(warnings.map(([, entry]) => [entry.requestId, entry.status, entry.stage, entry.aborted]), [
    ['missing-proxy', 404, 'proxy', false],
    ['missing-official-relay', 404, 'official-relay', false],
  ]);
  assert.equal(JSON.stringify(warnings).includes(CAPABILITY), false);
  assert.equal(warnings[0][1].route, '/codex-proxy/codex-official/pr1.<redacted>/main/responses');
});

test('the window is bounded and only anomalies reach the logger', () => {
  const warnings = [];
  const trace = createCodexProxyTrace({ capacity: 3, logger: { warn: (...args) => warnings.push(args) } });
  for (let i = 0; i < 5; i++) {
    const res = new FakeResponse();
    trace.middleware(fakeRequest(`/codex-proxy/codex-official/s${i}/main/responses`), res, () => {});
    res.statusCode = 200;
    res.emit('finish');
  }
  const entries = trace.snapshot();
  assert.equal(entries.length, 3, 'capacity keeps the newest requests only');
  assert.deepEqual(entries.map(entry => entry.session), ['s4', 's3', 's2']);
  assert.equal(warnings.length, 0, 'a healthy request is not logged');

  const failing = new FakeResponse();
  trace.middleware(fakeRequest('/codex-proxy/codex-official/x/main/responses'), failing, () => {});
  failing.statusCode = 502;
  failing.emit('finish');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][0], 'codex_proxy_trace');
  assert.equal(warnings[0][1].status, 502);
});

test('an evicted pending request still settles once with the current logger', () => {
  const trace = createCodexProxyTrace({ capacity: 1, now: () => 100 });
  const first = new FakeResponse();
  trace.middleware(fakeRequest('/codex-proxy/p/first', { id: 'first' }), first);
  trace.middleware(fakeRequest('/codex-proxy/p/second', { id: 'second' }), new FakeResponse());

  const warnings = [];
  trace.attachLogger({ warn: (name, entry) => warnings.push([name, entry.requestId]) });
  first.statusCode = 502;
  first.emit('finish');
  first.emit('close');
  assert.deepEqual(warnings, [['codex_proxy_trace', 'first']]);
  assert.deepEqual(trace.snapshot().map(entry => [entry.requestId, entry.ended]), [['second', false]]);
});

require('node:test')('67f54869 differential: codex/proxy-trace', async () => {
  const { compare } = require('./helpers/compare-leaf-hosts');
  await compare('codex/proxy-trace.js', api => {
    const rows = [];
    const trace = api.createCodexProxyTrace({ capacity: 2, now: () => 42, logger: { warn: (...args) => rows.push(args) } });
    for (const url of ['/not-a-prefix', '/codex-proxy/p/pr1.abc.def/main/responses?foo=2', '/codex-proxy/p/🚀/quota']) {
      const res = new FakeResponse();
      trace.middleware(fakeRequest(url), res, () => {});
      res.statusCode = 404;
      res.emit('close');
      res.emit('finish');
      rows.push(api.traceParts(url), trace.snapshot());
    }
    return rows;
  }, require('../src/native/binding').codexProxyTrace);
});
