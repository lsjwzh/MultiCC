'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { load } = require('./helpers/frozen-runtime-batch18/load');
const binding = require('../src/native/binding');
const native = binding.getNative();
const oracle = load('codex-usage');
const candidate = native.codexUsageApi(() => () => ({}));
const aux = binding.auxHttp;
const oldAux = load('aux-http');
const frozenRoot = path.join(__dirname, 'helpers/frozen-runtime-batch18');

function fixedClock(run) {
  const Original = global.Date;
  global.Date = class extends Original {
    constructor(...args) { super(...(args.length ? args : ['2026-11-28T00:00:00.000Z'])); }
    static now() { return 1795824000000; }
  };
  try { return run(); } finally { global.Date = Original; }
}
function vaultFixture(t, migrated, seed = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-b18-vault-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'secrets.json');
  fs.writeFileSync(file, JSON.stringify(seed));
  const calls = [], fault = { write: false, start: false, finish: false };
  const audit = { call(operation, context, names, action) {
    if (fault.start) throw new Error('audit-start');
    calls.push([operation, context, names]);
    const value = action();
    if (fault.finish) throw new Error('audit-finish');
    return value;
  } };
  const write = (target, data) => {
    if (fault.write) throw new Error('write-failure');
    fs.writeFileSync(target, JSON.stringify(data, null, 2), { mode: 0o600 });
  };
  const vault = migrated ? native.secretsVaultApi({ STORE: file, write, audit }) : load('secrets-vault', {
    appPaths: { createPaths: () => ({ secretsFile: file }) }, runtimeSecurity: { atomicWriteJson: write }, secretAudit: audit,
  });
  return { vault, calls, fault, disk: () => JSON.parse(fs.readFileSync(file, 'utf8')) };
}

test('authority bytes stay frozen and production imports all three native owners', () => {
  const manifest = require('./helpers/frozen-runtime-batch18/manifest.json');
  for (const [file, hash] of Object.entries(manifest.sources)) {
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(frozenRoot, file))).digest('hex'), hash);
  }
  for (const gone of ['src/secrets-vault.js', 'src/aux-http.js', 'src/codex/usage.js']) {
    assert.equal(fs.existsSync(path.join(__dirname, '..', gone)), false, gone);
  }
  for (const [api, method] of [['secretsVault', 'reveal'], ['auxHttp', 'executeAuxHttp'], ['codexUsage', 'projectHistoryUsage']]) {
    assert.equal(typeof binding[api][method], 'function');
  }
});

test('vault old data, object identity, UTF-16, env projection and failed writes match independently', t => {
  const seed = [null, { name: 'legacy.name', value: '', description: '旧'.repeat(510), source: '', createdAt: 0 },
    { name: 42, value: 'numeric' }, { name: 'A_KEY', value: 'old' }, { name: 'A_KEY', value: 'last' }];
  const scenario = migrated => fixedClock(() => {
    const f = vaultFixture(t, migrated, seed), v = f.vault, result = [];
    result.push(v.list());
    const created = v.upsert({ name: ' TOKEN ', value: 'synthetic', description: '😀'.repeat(251), sessionId: 'turn' });
    assert.equal(created.entry, v.reveal('TOKEN').entry);
    created.entry.value = 'changed-by-reference';
    v._saveForTests();
    result.push(v.rename('legacy.name', 'RENAMED'), v.rename('RENAMED', 'RENAMED'));
    const env = Object.assign(Object.create({ TOKEN: 'inherited' }), { MULTICC_SESSION_ID: 's', A_KEY: '' });
    assert.equal(v.applyEnvOverlay(env, { turnId: 't' }), env);
    assert.equal(env.TOKEN, 'inherited');
    const count = f.calls.length;
    result.push(v.envDigest(env));
    assert.equal(f.calls.length, count, 'polling does not audit');
    result.push(v.envOverlay(), { ...env }, f.disk());
    const before = f.disk();
    f.fault.write = true;
    assert.throws(() => v.upsert({ name: 'AFTER_FAILURE', value: 'kept-in-memory' }), /write-failure/);
    assert.equal(v.has('AFTER_FAILURE'), true);
    assert.deepEqual(f.disk(), before);
    f.fault.write = false;
    f.fault.start = true;
    assert.throws(() => v.remove('TOKEN'), /audit-start/);
    assert.equal(v.has('TOKEN'), true);
    f.fault.start = false;
    f.fault.finish = true;
    assert.throws(() => v.remove('TOKEN'), /audit-finish/);
    assert.equal(v.has('TOKEN'), false);
    f.fault.finish = false;
    result.push(v.list(), f.disk(), f.calls);
    return result;
  });
  assert.deepEqual(scenario(true), scenario(false));
});

test('vault env iteration permits reentrant native writes without borrowing the store across getters', t => {
  const scenario = migrated => fixedClock(() => {
    const { vault: v } = vaultFixture(t, migrated);
    const entry = v.upsert({ name: 'FIRST', value: 'initial' }).entry;
    let inserted = false;
    Object.defineProperty(entry, 'value', { configurable: true, get() {
      if (!inserted) { inserted = true; v.upsert({ name: 'LATER', value: 'late' }); }
      return 'first';
    } });
    return v.envOverlay();
  });
  assert.deepEqual(scenario(true), scenario(false));
});

test('over-capacity legacy stores survive reload and updates, invalid new names stay invalid', t => {
  const seed = Array.from({ length: 501 }, (_, i) => ({ name: `K_${i}`, value: 'v' }));
  const scenario = migrated => fixedClock(() => {
    const { vault: v } = vaultFixture(t, migrated, seed);
    const result = [v.list().length, v.upsert({ name: 'NEW', value: 'v' }), v.upsert({ name: 'K_0', value: 'update' }).created];
    for (const name of ['1BAD', 'bad.name', '', 'x'.repeat(65)]) result.push(v.upsert({ name, value: 'v' }));
    v._loadForTests(); result.push(v.list().length, v.reveal('K_0'));
    return result;
  });
  assert.deepEqual(scenario(true), scenario(false));
});

test('three Aux codecs and full SSE responses match the independent frozen parser', () => {
  for (const wireApi of ['messages', 'responses', 'chat_completions']) {
    const target = { wireApi, apiKey: 'synthetic' }, input = { model: 'm', prompt: 'hello', systemPrompt: 'system' };
    const actual = aux.buildAuxHttpRequest(target, input), expected = oldAux.buildAuxHttpRequest(target, input);
    assert.deepEqual(actual.body, expected.body); assert.deepEqual(actual.headers, expected.headers);
    for (const response of [{}, { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
      { output: [{ content: [{ type: 'output_text', text: 'a' }, { type: 'text', text: 'b' }] }] },
      { choices: [{ message: { content: [{ text: 'a' }, { text: 'b' }] } }] }, { output_text: 'direct' }]) {
      assert.deepEqual(actual.parse(response), expected.parse(response));
    }
  }
  const frame = 'event: response.completed\r\ndata: {"type":"response.completed","response":{"output":[{"type":"function_call","name":"finish"}]}}\r\n\r\ndata: [DONE]\r\n\r\n';
  assert.deepEqual(aux.parseResponsesStream(frame), oldAux.parseResponsesStream(frame));
  for (const frame of ['data: [DONE]\n\n', 'data: {"type":"response.failed","response":{"error":{"message":"quota"}}}\n\n', 'data: invalid\n\n']) {
    let expected; try { oldAux.parseResponsesStream(frame); } catch (e) { expected = e; }
    assert.throws(() => aux.parseResponsesStream(frame), e => e.constructor === expected.constructor && e.message === expected.message);
  }
});

test('native Aux IO preserves protocol options, original errors and one settlement', async () => {
  let reply = { status: 200, contentType: 'application/json', body: '{"output_text":"ok"}' };
  const scenario = async migrated => {
    const seen = [];
    const io = { request(options, onResponse) {
      const req = new EventEmitter();
      req.destroy = error => { queueMicrotask(() => req.emit('error', error)); };
      req.end = body => { seen.push({ options, body }); queueMicrotask(() => {
        const res = new EventEmitter(); res.setEncoding = value => assert.equal(value, 'utf8');
        res.statusCode = reply.status; res.headers = { 'content-type': reply.contentType };
        onResponse(res); res.emit('data', reply.body); res.emit('end');
      }); };
      return req;
    } };
    const api = migrated ? native.auxHttpApi({ http: io, https: io }) : load('aux-http', {}, { http: io, https: io });
    const input = { target: { wireApi: 'responses', apiKey: 'synthetic', url: 'http://user:ignored@127.0.0.1:9123/path?q=1#fragment' }, model: 'm', prompt: 'p', timeoutMs: 50 };
    try { return { seen, result: await api.executeAuxHttp(input) }; }
    catch (error) { return { seen, error: { name: error.name, message: error.message } }; }
  };
  for (const body of ['{"output_text":"ok"}', '{"status":"incomplete"}', '{"error":{"message":"quota"}}']) {
    reply = { ...reply, body };
    assert.deepEqual(await scenario(true), await scenario(false));
  }
  reply = { ...reply, status: 429, body: 'null' };
  assert.deepEqual(await scenario(true), await scenario(false));
  const original = Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
  const io = { request() { const req = new EventEmitter(); req.destroy = () => {}; req.end = () => queueMicrotask(() => req.emit('error', original)); return req; } };
  await assert.rejects(native.auxHttpApi({ http: io, https: io }).executeAuxHttp({ target: { wireApi: 'responses', url: 'http://127.0.0.1' }, model: 'm', prompt: 'p' }), error => error === original);
});

function usage(input, cached, output, reasoning = 0) {
  return { input_tokens: input, cache_read_input_tokens: cached, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: reasoning, extra: { kept: true } };
}
test('Codex vectors, empty epochs, stale snapshots and per-turn accounting match', () => {
  for (const raw of [null, {}, [], usage(10, 20, 3), { input_tokens: '42', cached_input_tokens: '12' },
    { input_tokens: Number.MAX_SAFE_INTEGER, cache_read_input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 }]) {
    assert.deepEqual(candidate.normalizeCodexCumulative(raw), oracle.normalizeCodexCumulative(raw));
    for (const cliSessionId of ['', null, 'thread']) for (const perTurn of [false, true]) {
      const value = { usage: raw, cliSessionId, perTurn, history: [{ role: 'assistant', usageCumulative: usage(50, 40, 20), usageEpoch: oracle.usageEpochForSessionId(cliSessionId) }] };
      const result = candidate.normalizeCodexTurnUsage(value);
      assert.deepEqual(result, oracle.normalizeCodexTurnUsage(value)); assert.equal(Object.isFrozen(result), true);
    }
  }
  for (const api of [candidate, oracle]) {
    const reads = [], values = [2, '7', null];
    assert.deepEqual(api.normalizeCodexCumulative({ input_tokens: 9, get cache_read_input_tokens() { reads.push('read'); return values.shift(); } }), { fresh: 2, cached: 7, cacheWrite: 0, output: 0, reasoning: 0 });
    assert.equal(reads.length, 3);
    const thrown = new Error('counter');
    assert.throws(() => api.normalizeCodexCumulative({ get output_tokens() { throw thrown; } }), e => e === thrown);
  }
});

test('Codex history is copy-on-write and projection never copies content or modifies source', () => {
  const make = () => [{ role: 'user', content: { large: 'same reference' } },
    { role: 'assistant', content: { text: 'a' }, usage: usage(10, 20, 5) },
    { role: 'assistant', content: { text: 'b' }, usage: usage(15, 30, 8) },
    { role: 'assistant', content: 'current', usage: usage(1, 2, 1), usageCumulative: usage(16, 32, 9), usageEpoch: 'epoch' }];
  for (const perTurn of [false, true]) {
    const source = make(), snapshot = JSON.stringify(source), result = candidate.projectHistoryUsage(source, { perTurn });
    assert.deepEqual(result, oracle.projectHistoryUsage(make(), { perTurn }));
    assert.equal(result[0], source[0]); assert.equal(result[1].content, source[1].content);
    assert.equal(JSON.stringify(source), snapshot);
    assert.equal(result[3].usage, source[3].usage); assert.equal(result[3].usageCumulative, undefined);
    assert.deepEqual(candidate.summarizeHistoryUsage(source), oracle.summarizeHistoryUsage(make()));
  }
});

async function completionTrace(api, durable) {
  const trace = [], cs = { currentAssistantText: 'done', currentToolCalls: [], chatTurnCount: 2, turnStartedAt: 10 };
  const host = api.createCodexUsageHost({ now: () => 100, timelineField: (id, state, at) => { trace.push(['timeline', id, state === cs, at]); return { timeline: true }; },
    clearIncrementalSave: id => trace.push(['clear', id]), loadHistory: () => { trace.push(['load']); return []; },
    reconcileRole: (id, u) => trace.push(['role', id, u]),
    persistFinalAssistantResult: (...args) => { trace.push(['persist', args[4], args[5]]); return durable === 'throw' ? Promise.reject(new Error('persist')) : Promise.resolve(durable); },
    recordDurableTurnUsage: (id, runner, u) => trace.push(['ledger', id, u]), recordResultEvent: () => trace.push(['empty']),
  });
  try {
    const result = await host.complete({ evt: { usage: usage(10, 5, 2) }, cs, persisted: { cli: 'codex-exp' }, sessionName: 's', turn: {}, runner: {}, forward: value => trace.push(['forward', value]) });
    trace.push(['return', result, cs.chatTurnCount]);
  } catch (e) { trace.push(['error', e.message]); }
  return trace;
}
test('complete preserves awaited persist, durable-only accounting, timeline and failure ordering', async () => {
  for (const outcome of [true, false, 'throw']) assert.deepEqual(await completionTrace(candidate, outcome), await completionTrace(oracle, outcome));
});
