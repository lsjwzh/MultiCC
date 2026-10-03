'use strict';
// Tests for src/annotation-live.js — the realtime annotation relay route.
// Config loading/matching against an isolated MULTICC_DATA_DIR plus the route
// handler through a fake express app (payload normalization + awaited forwarding
// whose { refresh, text } reply is surfaced back, via a stubbed global fetch). Real state files are never touched.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('node:assert/strict');
const test = require('node:test');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'annotlive-test-'));
process.env.MULTICC_DATA_DIR = tmp;
const live = require('../src/annotation-live');
const { assertTestDir } = require('../src/paths');
assertTestDir(tmp);

const CFG = path.join(tmp, 'annotation-live.json');

function writeCfg(entries, stamp) {
  fs.writeFileSync(CFG, JSON.stringify(entries, null, 2));
  if (stamp) fs.utimesSync(CFG, stamp, stamp); // 确定性 mtime，钉死缓存失效
}

function fakeApp() {
  const handlers = {};
  return {
    handlers,
    get: (p, h) => { handlers['GET ' + p] = h; },
    post: (p, h) => { handlers['POST ' + p] = h; },
  };
}

async function invoke(handler, body) {
  const res = {
    statusCode: 200,
    body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(v) { this.body = v; return this; },
  };
  await handler({ body: body || {} }, res);
  return res;
}

test('config resolves inside the isolated data dir; missing file = relay off', () => {
  assert.equal(live.CONFIG, CFG);
  assert.deepEqual(live.loadTargets(CFG), []);
});

test('invalid entries are filtered, valid ones kept, hot-reload on mtime change', () => {
  writeCfg([
    { match: { session: '^s1$', src: 'demo-shot' }, url: 'http://127.0.0.1:8899/annotation' },
    { url: 'ftp://nope/x' },               // 非 http(s) → 丢弃
    { match: {} },                          // 缺 url → 丢弃
    'not-an-object',                        // 非对象 → 丢弃
  ], new Date('2026-10-03T08:00:00Z'));
  assert.deepEqual(live.loadTargets(CFG).map(t => t.url), ['http://127.0.0.1:8899/annotation']);
  // 同 mtime 走缓存；mtime 变更后热加载新内容。
  writeCfg([{ url: 'http://127.0.0.1:9000/x' }], new Date('2026-10-03T09:00:00Z'));
  assert.deepEqual(live.loadTargets(CFG).map(t => t.url), ['http://127.0.0.1:9000/x']);
  // 损坏 JSON = 通道关闭，而不是抛错。
  fs.writeFileSync(CFG, '{oops');
  assert.deepEqual(live.loadTargets(CFG), []);
});

test('matching: session/src regexes, absent = match-all, bad regex never matches', () => {
  writeCfg([
    { match: { session: '^s1$', src: 'demo-shot' }, url: 'http://h/1' },
    { url: 'http://h/catch-all' },                                     // 无 match = 全命中
    { match: { session: '([' }, url: 'http://h/bad-regex' },           // 坏正则 → 不命中
  ], new Date('2026-10-03T10:00:00Z'));
  const hit = (sessionId, src) => live.relayTargets({ sessionId, src }, CFG).map(t => t.url);
  assert.deepEqual(hit('s1', '/a/demo-shot.png'), ['http://h/1', 'http://h/catch-all']);
  assert.deepEqual(hit('s2', '/a/demo-shot.png'), ['http://h/catch-all']);   // session 不匹配
  assert.deepEqual(hit('s1', '/a/other.png'), ['http://h/catch-all']);       // src 不匹配
  assert.ok(!hit('s1', '/a/demo-shot.png').includes('http://h/bad-regex'));
});

test('route: normalizes payload, relays hits and surfaces handler replies', async () => {
  writeCfg([{ match: { session: 's1' }, url: 'http://127.0.0.1:8899/annotation' }],
    new Date('2026-10-03T11:00:00Z'));
  const app = fakeApp();
  live.mount(app);
  assert.ok(app.handlers['GET /api/annotation-live']);
  const post = app.handlers['POST /api/annotation-live'];

  const sent = [];
  const realFetch = global.fetch;
  global.fetch = (url, init) => {
    sent.push({ url, init });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, refresh: true, text: '正中' }) });
  };

  try {
    const res = await invoke(post, {
      sessionId: 's1', src: '/a/demo-shot.png', width: '1000', height: '1434',
      kind: 'arrow', a: { x: 1, y: 2 }, b: { x: 3, y: 2 },
    });
    assert.deepEqual(res.body, { ok: true, relayed: 1, results: [{ ok: true, refresh: true, text: '正中' }] });
    const res2 = await invoke(post, { sessionId: 'other-session' });  // 无命中：只回包，不转发
    assert.deepEqual(res2.body, { ok: true, relayed: 0, results: [] });

    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, 'http://127.0.0.1:8899/annotation');
    assert.equal(sent[0].init.method, 'POST');
    const body = JSON.parse(sent[0].init.body);
    assert.deepEqual(body, {
      sessionId: 's1', src: '/a/demo-shot.png', width: 1000, height: 1434,
      kind: 'arrow', a: { x: 1, y: 2 }, b: { x: 3, y: 2 },
    });
  } finally {
    global.fetch = realFetch;
  }
});

test('route: unreachable / non-JSON handler is reported per result, reply stays ok', async () => {
  writeCfg([{ url: 'http://127.0.0.1:1/dead' }], new Date('2026-10-03T12:00:00Z'));
  const app = fakeApp();
  live.mount(app);
  const realFetch = global.fetch;
  global.fetch = () => Promise.reject(new Error('ECONNREFUSED'));
  try {
    const post = app.handlers['POST /api/annotation-live'];
    const res = await invoke(post, { sessionId: 's1', kind: 'point', a: { x: 0, y: 0 } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.relayed, 1);
    assert.equal(res.body.results[0].ok, false);
    assert.equal(res.body.results[0].refresh, false);
    assert.match(res.body.results[0].error, /ECONNREFUSED/);
    // 非 JSON 回包：照样 ok（HTTP 200），但不 refresh、无文案。
    global.fetch = () => Promise.resolve({ ok: true, json: () => Promise.reject(new SyntaxError('bad')) });
    const res2 = await invoke(post, { sessionId: 's1', kind: 'arrow' });
    assert.deepEqual(res2.body.results, [{ ok: true, refresh: false, text: '' }]);
  } finally {
    global.fetch = realFetch;
  }
});
