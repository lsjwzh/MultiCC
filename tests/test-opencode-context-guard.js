'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const readerApi = require('../src/chat/opencode-context');
const { createOpencodeContextReader, clampThreshold, resolveThreshold,
  createOpencodeContextGuard, enforceOpencodeContextForTurn } = readerApi;
const { getNative } = require('../src/native/runtime');

function fixture(t, catalog = { provider: { models: { model: { limit: { context: 1000, output: 100 } } } } }) {
  assert.equal(typeof getNative().readOpencodeContext, 'function', '必须使用当前源码的原生模块');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-opencode-ctx-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dbPath = path.join(root, 'opencode.db');
  const cachePath = path.join(root, 'models.json');
  fs.writeFileSync(cachePath, JSON.stringify(catalog));
  const db = new Database(dbPath);
  db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)');
  t.after(() => db.close());
  const insert = db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)');
  let n = 0;
  function add(data, sid = 's1') {
    const id = `m${String(++n).padStart(5, '0')}`;
    insert.run(id, sid, n, JSON.stringify(data));
  }
  const reader = createOpencodeContextReader({ dbPath, cachePath });
  return { root, dbPath, cachePath, db, add, reader, guard: createOpencodeContextGuard({ contextReader: reader }) };
}
const measured = (input = 900, extra = {}) => ({ role: 'assistant', modelID: 'model', providerID: 'provider',
  tokens: { input, output: 10, reasoning: 2, cache: { read: 5, write: 3 } }, ...extra });
const record = () => ({ kind: 'chat', cli: 'opencode', cliSessionId: 's1', model: null });

test('读取最近有效用量：用户消息、失败零值和缺失 total 不会清空水位', async t => {
  const f = fixture(t);
  f.add(measured());
  f.add(measured(0, { tokens: { input: 0, output: 0 }, error: { name: 'MessageAbortedError' } }));
  f.add({ role: 'user', model: { providerID: 'provider', modelID: 'model' } });
  f.add(measured(10), 'sibling');
  const before = fs.readFileSync(f.dbPath);
  const usage = await f.reader.read('s1', null);
  assert.equal(usage.tokens.total, 918);
  assert.equal(usage.limit.source, 'models.dev');
  assert.equal(usage.modelId, 'provider/model');
  assert.equal(usage.wouldRotate, true);
  assert.equal((await f.guard.enforce(record())).action, 'rotate');
  assert.equal((await f.reader.read('sibling')).wouldRotate, false);
  assert.deepEqual(fs.readFileSync(f.dbPath), before, '只读查询不得改写原生历史');
});

test('默认模型、带供应商前缀与模型自身含斜杠都能找到真实窗口', async t => {
  const f = fixture(t, { a: { models: {
    model: { limit: { context: 1000 } }, 'org/model': { limit: { context: 2000 } },
    outputOnly: { limit: { output: 100 } },
  } } });
  f.add(measured());
  assert.equal((await f.reader.read('s1', 'custom/model')).limit.context, 1000);
  assert.equal((await f.reader.read('s1', 'org/model')).limit.context, 2000);
  assert.equal((await f.reader.read('s1', 'custom/org/model')).limit.context, 2000);
  assert.equal((await f.reader.read('s1', 'outputOnly')).limit.source, 'fallback');
  assert.equal((await f.reader.read('s1', 'unknown')).wouldRotate, false);
});

test('确认超限可覆盖未知窗口与低旧水位，最近成功压缩后的用量解除旧错误', async t => {
  const f = fixture(t, {});
  f.add(measured(10));
  f.add(measured(0, { tokens: { input: 0, output: 0 }, error: { name: 'ContextOverflowError',
    data: { message: 'Conversation history too large to compact - exceeds model context limit' } } }));
  const usage = await f.reader.read('s1');
  assert.equal(usage.tokens.total, 28);
  assert.equal(usage.overflow, true);
  assert.equal((await f.guard.enforce(record())).reason, 'native_context_overflow');
  f.add(measured(20));
  assert.equal((await f.reader.read('s1')).overflow, false);
  assert.equal((await f.guard.enforce(record())).reason, 'limit_unknown');
});

test('只有超限错误时保持未知用量，而不是伪造 0% 的健康水位', async t => {
  const f = fixture(t, {});
  f.add({ role: 'assistant', tokens: { input: 0, output: 0 }, error: { name: 'UnknownError', data: {
    message: "This model's maximum context length is 1048576 tokens. However, you requested 32000 output tokens and your prompt contains at least 1016577 input tokens."
  } } });
  const usage = await f.reader.read('s1');
  assert.equal(usage.tokens, null);
  assert.equal(usage.ratio, null);
  assert.equal(usage.usageKnown, false);
  assert.equal((await f.guard.enforce(record())).action, 'rotate');
});

test('纯文案、鉴权、输出限制和请求回显不能触发自动轮换', async t => {
  for (const error of [
    { message: 'Conversation history too large to compact' },
    { name: 'ProviderAuthError', data: { message: 'context window exceeded' } },
    { name: 'FutureProviderError', data: { message: 'prompt too long' } },
    { code: 'max_tokens_exceeded' },
    { prompt: { name: 'ContextOverflowError' } },
    { message: 'prompt: [{message: "Conversation history too large to compact"}]' },
  ]) {
    const f = fixture(t, {});
    f.add(measured(10));
    f.add({ role: 'assistant', error, tokens: { input: 0, output: 0 } });
    assert.equal((await f.reader.read('s1')).overflow, false);
    assert.notEqual((await f.guard.enforce(record())).action, 'rotate');
  }
});

test('待完成交接不能绕过旧目标检查；轮换保留源摘要和完整显示历史', async t => {
  const f = fixture(t);
  f.add(measured());
  const persisted = { ...record(), pendingCliHandoff: { id: 'keep-id', status: 'pending', reusedTarget: true,
    fromCli: 'claude-exp', toCli: 'opencode', reason: 'auto_provider_cli_switch',
    checkpoint: { createdAt: 'today', transcript: ['重要上下文'] } } };
  const notices = [], saved = [];
  const run = () => enforceOpencodeContextForTurn({ guard: f.guard, persisted, sessionName: 'logical',
    history: () => { throw Error('已有摘要不应被替换'); }, rememberActiveCliState() {},
    savePersistedSessionsBestEffort: why => saved.push(why), logger: { warn() {} }, appendEvent() {},
    chatBroadcast: (_, event) => notices.push(event) });
  assert.equal((await run()).action, 'rotate');
  assert.equal(persisted.cliSessionId, null);
  assert.equal(persisted.pendingCliHandoff.id, 'keep-id');
  assert.equal(persisted.pendingCliHandoff.fromCli, 'claude-exp');
  assert.equal(persisted.pendingCliHandoff.reusedTarget, false);
  assert.deepEqual(persisted.pendingCliHandoff.checkpoint.transcript, ['重要上下文']);
  assert.equal(saved.length, 1);
  assert.match(notices[0].message, /完整对话历史保留/);
  assert.equal((await run()).reason, 'no_native_session');
  assert.equal(notices.length, 1, '新上下文尚未启动时不能重复轮换');
});

test('本轮用量游标隔离旧历史、兄弟会话和失败请求，累加所有有效步骤', async t => {
  const f = fixture(t);
  f.add(measured(9000));
  const cursor = await f.reader.cursor('s1');
  f.add(measured(100));
  f.add(measured(200));
  f.add(measured(5000), 'sibling');
  f.add({ role: 'assistant', tokens: { input: 0, output: 0 }, error: { name: 'UnknownError' } });
  const usage = await f.reader.turnUsage('s1', cursor);
  assert.equal(usage.input_tokens, 300);
  assert.equal(usage.output_tokens, 20);
  assert.equal(usage.cache_read_input_tokens, 10);
  assert.equal(usage.cache_creation_input_tokens, 6);
  assert.equal(usage.reasoning_output_tokens, 4);
  assert.equal(usage.context_tokens, 218);
  assert.equal(usage.request_count, 2);
  assert.equal(await f.reader.turnUsage('sibling', cursor), null);
  assert.equal(await f.reader.turnUsage('s1', await f.reader.cursor('s1')), null);
});

test('数据库不可读、用量未知和原生模块缺失均返回明确原因', async t => {
  const f = fixture(t);
  assert.equal((await f.reader.read('missing')).reason, 'session-not-found');
  assert.equal((await f.reader.read('')).reason, 'no-native-session');
  f.add({ role: 'user' });
  assert.equal((await f.reader.read('s1')).reason, 'usage-missing');
  const missing = createOpencodeContextReader({ dbPath: path.join(f.root, 'absent.db') });
  assert.equal((await missing.read('s1')).reason, 'db-unavailable');
  assert.equal(fs.existsSync(path.join(f.root, 'absent.db')), false);
  assert.equal((await createOpencodeContextReader({ getNative: () => { throw new Error('rust_backend_unavailable'); } }).read('s1')).reason, 'read-failed');
});

test('阈值边界保持兼容，数据库路径尊重 XDG 环境', async () => {
  assert.equal(resolveThreshold({}), .85);
  assert.equal(resolveThreshold({ MULTICC_OPENCODE_CONTEXT_THRESHOLD: '0.7' }), .7);
  assert.equal(clampThreshold(4), .95);
  assert.equal(clampThreshold(0.05), .5);
  assert.equal(clampThreshold(NaN), .85);
  let args;
  const reader = createOpencodeContextReader({ env: { HOME: '/h', XDG_DATA_HOME: '/d', XDG_CACHE_HOME: '/c' },
    getNative: () => ({ async readOpencodeContext(input) { args = JSON.parse(input); return '{}'; } }) });
  await reader.read('s1');
  assert.equal(args.dbPath, '/d/opencode/opencode.db');
  assert.equal(args.cachePath, '/c/opencode/models.json');
});

test('异步检查期间原生目标改变时不清除新目标', async () => {
  const persisted = record();
  const result = await enforceOpencodeContextForTurn({ persisted, guard: { async enforce() {
    persisted.cliSessionId = 'replacement'; return { action: 'rotate' };
  } } });
  assert.equal(result.reason, 'native_changed');
  assert.equal(persisted.cliSessionId, 'replacement');
});

test('OpenCode 上下文读取器保持冻结工厂的参数读取顺序与异步错误边界', async () => {
  const { compileFunction } = require('node:vm'), { createRequire } = require('node:module');
  const { createHash } = require('node:crypto');
  const file = path.resolve(__dirname, '../src/chat/opencode-context.js');
  const body = fs.readFileSync(path.join(__dirname, 'helpers/frozen-opencode-context.js'));
  assert.equal(createHash('sha1').update('blob ' + body.length + '\0').update(body).digest('hex'),
    'b659c82bc585047fc5d32feb1362a0994b133494');
  const mod = {exports:{}};
  compileFunction(body.toString(), ['module','require'], {filename:file})(mod,createRequire(file));
  async function trace(api) {
    const log = [], observed = [];
    for (const v of [undefined, null, '', 0, -1, 0.5, '0.9', 0.95, 2, NaN, Infinity, 9n, false]) {
      log.push([api.clampThreshold(v), api.resolveThreshold({ MULTICC_OPENCODE_CONTEXT_THRESHOLD:v })]);
    }
    const sentinel = Error('threshold');
    assert.throws(() => api.createOpencodeContextReader({ env:{HOME:'/home'},threshold:{valueOf(){throw sentinel;}} }),e=>e===sentinel);
    const env = new Proxy({HOME:'/x',XDG_DATA_HOME:'/d',XDG_CACHE_HOME:'/c'}, {get(o,k){observed.push(k);return o[k];}});
    let failure;
    const backend = {async readOpencodeContext(s) { assert.equal(this, backend); log.push(s); if(failure)throw failure; return '{"found":true}'; }};
    const reader = api.createOpencodeContextReader({env,
      get threshold(){ observed.push('threshold');return undefined; },
      getNative(){ observed.push('native');return backend; },
      logger: {warn(event, fields){log.push([event,fields]);}},
    });
    assert.ok(Object.isFrozen(reader));
    const key = { toJSON(){observed.push('toJSON');return 'id';} };
    log.push(await reader.read(key, 'a/b'), await reader.cursor(key), await reader.turnUsage(key, { sequence:2 }));
    failure=Object.assign(Error('private'),{code:'db_unready'});
    log.push(await reader.read('id', null),await reader.cursor('id'));
    const throws = api.createOpencodeContextReader({ env:{HOME:'/x'},getNative(){throw failure;},
      logger:{warn(){throw sentinel;}} });
    await assert.rejects(throws.turnUsage('id',{}), e => e===sentinel);
    return [log,observed];
  }
  assert.deepEqual(await trace(readerApi), await trace(mod.exports));
});

test('OpenCode 轮换与冻结实现保持目标复核、交接引用和宿主副作用顺序', async () => {
  const { compileFunction } = require('node:vm');
  const { createRequire } = require('node:module');
  const { createHash } = require('node:crypto');
  const legacy = fs.readFileSync(path.join(__dirname, 'helpers/frozen-opencode-context-guard.js'));
  assert.equal(createHash('sha1').update('blob ' + legacy.length + '\0').update(legacy).digest('hex'),
    '91e2b4543c95c896e271399432ea0b87e7175ca0');
  function loadGuard(file, body, trace, failure) {
    const local = createRequire(file), module = { exports: {} };
    const cliSwitch = {
      buildHandoffCheckpoint({ session, fromCli, toCli, history }) {
        trace.push(['build', session.cliSessionId, fromCli, toCli, history]);
        return { createdAt: 42, history };
      },
      clearAllNativeCliStates(persisted) {
        trace.push('clear');
        if (failure === 'clear') throw failure;
        persisted.cliSessionId = null;
        return ['old'];
      },
    };
    const crypto = { randomBytes(size) { trace.push(['random', size]); return Buffer.alloc(size, 25); } };
    compileFunction(body.toString(), ['module', 'require'], {filename:file})(module, id =>
      id === '../cli-switch' ? cliSwitch : id === 'node:crypto' ? crypto : local(id));
    return module.exports;
  }
  const oldPath = path.resolve(__dirname, '../src/chat/opencode-context-guard.js');
  const currentPath = typeof readerApi.enforceOpencodeContextForTurn === 'function'
    ? require.resolve('../src/chat/opencode-context') : require.resolve('../src/chat/opencode-context-guard');
  async function run(file, body, mode, failure) {
    const trace = [], guardApi = loadGuard(file, body, trace, failure);
    const ref = Symbol('opaque'), token = { toJSON() { throw Error('opaque value serialized'); } };
    const checkpoint = { createdAt: 21, token, [ref]: token };
    const pending = Object.assign(Object.create({ inherited: true }), {
      status: mode === 'expired' ? 'done' : 'pending', checkpoint, id: 'saved', fromCli: 'claude',
      extra: token, [ref]: token,
    });
    if (mode === 'empty') Object.assign(pending, { id: '', checkpoint: false, fromCli: 0, createdAt: '' });
    const observed = obj => new Proxy(obj, {
      get(target, key, receiver) { trace.push(['get', String(key)]); return Reflect.get(target, key, receiver); },
      ownKeys(target) { trace.push('keys'); return Reflect.ownKeys(target); },
      getOwnPropertyDescriptor(target, key) { trace.push(['desc', String(key)]); return Reflect.getOwnPropertyDescriptor(target, key); },
    });
    if (pending.checkpoint) pending.checkpoint = observed(checkpoint);
    let stored = mode === 'missing' ? null : observed(pending);
    const persisted = { cliSessionId: 'old', model: 'one', dirId: 'dir',
      get pendingCliHandoff() { trace.push('getPending'); return stored; },
      set pendingCliHandoff(value) { trace.push('setPending'); if (failure === 'set') throw failure; stored = value; },
    };
    const verdict = { action: mode === 'allow' ? 'allow' : 'rotate', cliSessionId:'old', reason:'high',
      tokensTotal:80, contextLimit:100, ratio:.8, threshold:.7, message:'rotate now' };
    const record = (name, ...args) => {
      trace.push([name, ...args]);
      if (failure === name) throw failure;
    };
    const args = { guard:{async enforce(p) {
      assert.equal(p, persisted); record('enforce');
      if (mode === 'stale') persisted.model = 'two';
      return verdict;
    }}, persisted, sessionName:'logical', assertCurrent:() => record('assert'),
      history() { record('history'); return ['visible']; },
      rememberActiveCliState(p) { assert.equal(p, persisted); record('remember'); },
      savePersistedSessionsBestEffort:reason => record('save',reason),
      logger:{ warn(...values) { assert.equal(this, args.logger); record('warn', ...values); } },
      appendEvent:(...values) => record('event', ...values), chatBroadcast:(...values) => record('broadcast', ...values) };
    let result, rejection;
    try { result = await guardApi.enforceOpencodeContextForTurn(args); }
    catch (err) { if (failure === null) throw err; assert.equal(err, failure); rejection = err; }
    const ops = trace.slice();
    if (result && mode !== 'stale') assert.equal(result, verdict);
    if (result === verdict && verdict.action === 'rotate' && mode === 'reuse') {
      assert.equal(stored.checkpoint.token, token);
      assert.equal(stored.checkpoint[ref], token);
      assert.equal(stored[ref], token);
      assert.equal(stored.inherited, undefined);
      assert.notEqual(stored.checkpoint, pending.checkpoint);
    }
    return { ops, rejection, same: result === verdict, action: result?.action, reason: result?.reason,
      session: persisted.cliSessionId, handoff: stored && [stored.id, stored.createdAt, stored.fromCli, stored.reason, stored.reusedTarget, stored.checkpoint?.reason] };
  }
  const current = fs.readFileSync(currentPath);
  for (const mode of ['missing','expired','empty','reuse','allow','stale']) {
    for (const failure of [null,'enforce','assert','history','set','clear','remember','save','warn','event','broadcast']) {
      assert.deepEqual(await run(currentPath,current,mode,failure), await run(oldPath,legacy,mode,failure), mode + '/' + failure);
    }
  }
});
