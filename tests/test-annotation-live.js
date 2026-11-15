'use strict';
// Tests for src/annotation-live.js — the process-local half of the realtime
// annotation relay. The two public routes (/api/annotation-live GET|POST) are
// answered by the Rust front door (native/gateway/src/app/event_routes.rs),
// including the DTO normalization; this process keeps config loading/matching
// against an isolated MULTICC_DATA_DIR and the awaited webhook forwarding whose
// { refresh, text } reply the host port hands back to the front door (via a
// stubbed global fetch). Real state files are never touched.
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

test('host relay forwards the (already normalized) payload and surfaces handler replies', async () => {
  writeCfg([{ match: { session: 's1' }, url: 'http://127.0.0.1:8899/annotation' }],
    new Date('2026-10-03T11:00:00Z'));

  const sent = [];
  const realFetch = global.fetch;
  global.fetch = (url, init) => {
    sent.push({ url, init });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, refresh: true, text: '正中' }) });
  };

  try {
    // The front door normalizes the request body (numbers, nulls, key order) and
    // hands this op the finished DTO; the relay must forward it verbatim.
    const payload = {
      sessionId: 's1', src: '/a/demo-shot.png', width: 1000, height: 1434,
      kind: 'arrow', a: { x: 1, y: 2 }, b: { x: 3, y: 2 },
    };
    const res = await live.relay(payload);
    assert.deepEqual(res, { relayed: 1, results: [{ ok: true, refresh: true, text: '正中' }] });
    const res2 = await live.relay({ sessionId: 'other-session', src: '/a/demo-shot.png' });
    assert.deepEqual(res2, { relayed: 0, results: [] });  // 无命中：不转发

    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, 'http://127.0.0.1:8899/annotation');
    assert.equal(sent[0].init.method, 'POST');
    assert.equal(sent[0].init.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(sent[0].init.body), payload);
  } finally {
    global.fetch = realFetch;
  }
});

test('host relay reports unreachable / non-JSON handlers per result', async () => {
  writeCfg([{ url: 'http://127.0.0.1:1/dead' }], new Date('2026-10-03T12:00:00Z'));
  const realFetch = global.fetch;
  global.fetch = () => Promise.reject(new Error('ECONNREFUSED'));
  try {
    const res = await live.relay({ sessionId: 's1', kind: 'point', a: { x: 0, y: 0 } });
    assert.equal(res.relayed, 1);
    assert.equal(res.results[0].ok, false);
    assert.equal(res.results[0].refresh, false);
    assert.match(res.results[0].error, /ECONNREFUSED/);
    // 非 JSON 回包：照样 ok（HTTP 200），但不 refresh、无文案。
    global.fetch = () => Promise.resolve({ ok: true, json: () => Promise.reject(new SyntaxError('bad')) });
    const res2 = await live.relay({ sessionId: 's1', kind: 'arrow' });
    assert.deepEqual(res2.results, [{ ok: true, refresh: false, text: '' }]);
  } finally {
    global.fetch = realFetch;
  }
});
