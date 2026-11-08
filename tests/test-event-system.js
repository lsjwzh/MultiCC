'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { matchesPattern, isKnownPattern, EVENT_TYPES } = require('../src/events/catalog');
const { deriveTaskEvents } = require('../src/events/task-transitions');
const { createEventHub } = require('../src/events/hub');
const { createEventRuleEngine } = require('../src/events/engine');
const { validateEventRule } = require('../src/events/rules');
const { isPrivateAddress, sign } = require('../src/events/actions');
const { createSessionTriggers } = require('../src/triggers');
const { createChatHostRuntime } = require('../src/chat/host-runtime');

const base = { taskId: 't1', goal: 'ship it', phase: 'impl', startedAt: 1, classifyState: 'P', goalState: null };

function harness(extra = {}) {
  const bus = new EventEmitter();
  let n = 0;
  const hub = createEventHub({ bus, randomUUID: () => `e${++n}`, now: () => 1000, dirIdOf: () => 'dir1' });
  hub.start();
  const log = [];
  if (extra.beforeSubscribe) hub.subscribe(extra.beforeSubscribe);
  hub.subscribe((event) => log.push(event));
  return { bus, hub, log };
}

test('catalog: aliases and wildcards expand only at match time', () => {
  assert.ok(matchesPattern('task.attention', 'task.failed'));
  assert.ok(matchesPattern('task.attention', 'task.needs_interaction'));
  assert.ok(!matchesPattern('task.attention', 'task.achieved'));
  assert.ok(matchesPattern('task.done', 'task.achieved'));
  assert.ok(matchesPattern('task.*', 'task.running'));
  assert.ok(!matchesPattern('task.*', 'turn.completed'));
  assert.ok(!isKnownPattern('task.bogus'));
  assert.ok(!EVENT_TYPES.includes('task.attention'));
});

test('transitions: D without goalState, then refine to achieved', () => {
  const d = { ...base, classifyState: 'D' };
  const first = deriveTaskEvents(base, d).map((e) => e.type);
  assert.deepEqual(first, ['task.finished']);
  const refined = deriveTaskEvents(d, { ...d, goalState: 'achieved' });
  assert.deepEqual(refined.map((e) => e.type), ['task.goal_resolved', 'task.achieved']);
  assert.equal(refined[0].data.source, 'refine');
  assert.equal(refined[0].data.from, null);
});

test('transitions: D arriving with goalState carries classify source', () => {
  const events = deriveTaskEvents(base, { ...base, classifyState: 'D', goalState: 'interact' });
  assert.deepEqual(events.map((e) => e.type), ['task.finished', 'task.goal_resolved', 'task.needs_interaction']);
  assert.equal(events[1].data.source, 'classify');
});

test('transitions: manual interact -> achieved is detected as manual', () => {
  const prev = { ...base, classifyState: 'D', goalState: 'interact' };
  const next = { ...prev, goalState: 'achieved', goalStateManualAt: 99 };
  const events = deriveTaskEvents(prev, next);
  assert.deepEqual(events.map((e) => e.type), ['task.goal_resolved', 'task.achieved']);
  assert.equal(events[0].data.source, 'manual');
  assert.equal(events[0].data.from, 'interact');
});

test('transitions: goal cleared on new turn emits only task.running', () => {
  const prev = { ...base, classifyState: 'D', goalState: 'achieved' };
  const events = deriveTaskEvents(prev, { ...base, classifyState: 'P', goalState: null });
  assert.deepEqual(events.map((e) => e.type), ['task.running']);
});

test('transitions: E marks cancelled vs error; new task id after D is restarted', () => {
  const cancelled = deriveTaskEvents(base, { ...base, classifyState: 'E', cancelledAt: 5, cancelReason: 'user' });
  assert.equal(cancelled[0].type, 'task.failed');
  assert.equal(cancelled[0].data.cancelled, true);
  const failed = deriveTaskEvents(base, { ...base, classifyState: 'E', apiError: { category: 'rate_limit' } });
  assert.equal(failed[0].data.cancelled, false);
  assert.equal(failed[0].data.errorCategory, 'rate_limit');
  const restarted = deriveTaskEvents({ ...base, classifyState: 'D' }, { ...base, taskId: 't2', classifyState: 'P' });
  assert.deepEqual(restarted.map((e) => e.type), ['task.restarted', 'task.running']);
});

test('transitions: unchanged state and unknown letters emit nothing', () => {
  assert.deepEqual(deriveTaskEvents(base, { ...base, goal: 'renamed' }), []);
  assert.deepEqual(deriveTaskEvents(base, { ...base, classifyState: 'C' }), []);
});

test('hub: bus task:state-changed -> envelope; goal events are idempotent per segment', () => {
  const { bus, log } = harness();
  const d = { ...base, classifyState: 'D' };
  bus.emit('task:state-changed', 's1', base, d);
  bus.emit('task:state-changed', 's1', d, { ...d, goalState: 'achieved' });
  // re-applying the same value (e.g. manual mark after classify) must not refire
  bus.emit('task:state-changed', 's1', { ...d, goalState: 'interact' }, { ...d, goalState: 'achieved', goalStateManualAt: 5 });
  const types = log.map((e) => e.type);
  assert.equal(types.filter((t) => t === 'task.achieved').length, 1);
  assert.equal(types.filter((t) => t === 'task.finished').length, 1);
  assert.equal(log[0].sessionId, 's1');
  assert.equal(log[0].dirId, 'dir1');
  assert.equal(log[0].eventId, 'e1');
  assert.ok(log.every((e, i) => e.seq === i + 1));
});

test('hub: leaving D re-arms goal events; subscriber throw is isolated', () => {
  const { bus, hub, log } = harness();
  hub.subscribe(() => { throw new Error('boom'); });
  const d = { ...base, classifyState: 'D', goalState: 'achieved' };
  bus.emit('task:state-changed', 's1', base, d);
  bus.emit('task:state-changed', 's1', d, base);
  bus.emit('task:state-changed', 's1', base, d);
  assert.equal(log.filter((e) => e.type === 'task.achieved').length, 2);
});

test('hub: turn.completed only for durable results', () => {
  const { bus, log } = harness();
  bus.emit('chat:turn-complete', 's1', {}, { resultDurable: false });
  bus.emit('chat:turn-complete', 's1', {}, { resultDurable: true, turnId: 'x', lineage: { kind: 'trigger' } });
  assert.doesNotThrow(() => bus.emit('chat:turn-complete', 's1', {}, {
    resultDurable: true, isCurrentRunner() { throw new Error('state unavailable'); },
  }));
  assert.equal(log.length, 1);
  assert.equal(log[0].type, 'turn.completed');
  assert.equal(log[0].data.lineageKind, 'trigger');
});

test('rules: validation rejects bad patterns, actions, urls and enforces inject cooldown floor', () => {
  const opts = { idFactory: () => 'r1', nowIso: () => 'now' };
  assert.match(validateEventRule({ on: ['nope.x'], action: { kind: 'notify' } }, opts).error, /unknown event pattern/);
  assert.match(validateEventRule({ on: ['task.failed'], action: { kind: 'rm' } }, opts).error, /unknown action/);
  assert.match(validateEventRule({ on: ['task.failed'], action: { kind: 'webhook', url: 'file:///x' } }, opts).error, /http/);
  assert.match(validateEventRule({ on: ['task.failed'], action: { kind: 'webhook', url: 'https://u:p@x.io' } }, opts).error, /credentials/);
  const ok = validateEventRule({ on: 'task.attention', cooldownMs: 1, action: { kind: 'inject-prompt', prompt: 'hi' } }, opts);
  assert.equal(ok.rule.cooldownMs, 10000);
  assert.deepEqual(ok.rule.on, ['task.attention']);
});

function engineHarness(extra = {}) {
  const { bus, hub, log } = harness({ beforeSubscribe: extra.beforeSubscribe });
  const persistedSessions = new Map([['s1', { id: 's1', dirId: 'dir1', triggers: [] }]]);
  const calls = { notify: [], inject: [], http: [] };
  let stored = null;
  const engine = createEventRuleEngine({
    hub, persistedSessions, now: () => 1000000, idFactory: (() => { let i = 0; return () => `r${++i}`; })(),
    store: { read: () => stored, write: (v) => { stored = JSON.parse(JSON.stringify(v)); } },
    notify: (...a) => { calls.notify.push(a); return {}; },
    injectPrompt: (...a) => { calls.inject.push(a); return true; },
    resolveSecret: (n) => (n === 'hook' ? 's3cret' : null),
    lookup: async () => [{ address: '93.184.216.34' }],
    httpPost: async (url, headers, body) => { calls.http.push({ url: String(url), headers, body }); return 200; },
    sleep: async () => {},
    ...extra,
  });
  engine.start();
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return { bus, hub, log, engine, persistedSessions, calls, settle, get stored() { return stored; } };
}

const toD = (extra = {}) => ({ ...base, classifyState: 'D', ...extra });

test('engine: global notify rule fires on task.failed with mapped push type', async () => {
  const h = engineHarness();
  assert.ok(h.engine.addGlobal({ on: ['task.failed'], action: { kind: 'notify' } }).rule);
  h.bus.emit('task:state-changed', 's1', base, { ...base, classifyState: 'E', apiError: { category: 'x' } });
  await h.settle();
  assert.equal(h.calls.notify.length, 1);
  assert.equal(h.calls.notify[0][1], 'error');
  assert.ok(h.log.some((e) => e.type === 'trigger.fired'));
});

test('engine: filter goalState and alias attention; no match no action', async () => {
  const h = engineHarness();
  h.engine.addGlobal({ on: ['task.achieved'], filter: { goalState: 'achieved' }, action: { kind: 'notify' } });
  h.engine.addGlobal({ on: ['task.attention'], action: { kind: 'notify', message: 'look' } });
  h.bus.emit('task:state-changed', 's1', base, toD());
  await h.settle();
  assert.equal(h.calls.notify.length, 0); // finished with no goalState matches neither
  h.bus.emit('task:state-changed', 's1', toD(), toD({ goalState: 'interact' }));
  await h.settle();
  assert.equal(h.calls.notify.length, 1);
  assert.equal(h.calls.notify[0][2], 'look');
});

test('engine: cooldown suppresses repeats; disabled rules never run', async () => {
  const h = engineHarness();
  h.engine.addGlobal({ on: ['task.running'], cooldownMs: 60000, action: { kind: 'notify' } });
  const off = h.engine.addGlobal({ on: ['task.running'], enabled: false, action: { kind: 'notify' } });
  assert.equal(off.rule.enabled, false);
  h.bus.emit('task:state-changed', 's1', toD(), base);
  h.bus.emit('task:state-changed', 's1', base, toD());
  h.bus.emit('task:state-changed', 's1', toD(), base);
  await h.settle();
  assert.equal(h.calls.notify.length, 1);
});

test('engine: inject loop latch - the turn we caused does not re-trigger inject', async () => {
  const h = engineHarness({ now: (() => { let t = 0; return () => (t += 100000); })() });
  h.engine.addGlobal({ on: ['task.finished'], action: { kind: 'inject-prompt', prompt: 'review' } });
  h.bus.emit('task:state-changed', 's1', base, toD());
  await h.settle();
  assert.equal(h.calls.inject.length, 1);
  assert.equal(h.calls.inject[0][0], 's1');
  assert.ok(h.calls.inject[0][1].trimEnd().endsWith('你的指令：review'));
  // the injected turn runs and ends: terminal event must not inject again
  h.bus.emit('task:state-changed', 's1', toD(), base);
  h.bus.emit('task:state-changed', 's1', base, toD());
  await h.settle();
  assert.equal(h.calls.inject.length, 1);
  // a later genuine turn (latch consumed) can inject again
  h.bus.emit('task:state-changed', 's1', toD(), base);
  h.bus.emit('task:state-changed', 's1', base, toD());
  await h.settle();
  assert.equal(h.calls.inject.length, 2);
});

test('engine: session-level event trigger is scoped to its own session', async () => {
  const h = engineHarness();
  h.persistedSessions.set('s2', { id: 's2', dirId: 'dir1', triggers: [] });
  const { rule } = validateEventRule({ on: ['task.failed'], action: { kind: 'notify' } }, { idFactory: () => 'mine', nowIso: () => 'n', scope: 'session' });
  h.persistedSessions.get('s1').triggers.push(rule);
  h.bus.emit('task:state-changed', 's2', base, { ...base, classifyState: 'E' });
  await h.settle();
  assert.equal(h.calls.notify.length, 0);
  h.bus.emit('task:state-changed', 's1', base, { ...base, classifyState: 'E' });
  await h.settle();
  assert.equal(h.calls.notify.length, 1);
  assert.equal(h.persistedSessions.get('s1').triggers[0].lastFiredAt, 1000000);
});

test('engine: webhook is signed, public-only, retried on 5xx, never retried on 4xx', async () => {
  const h = engineHarness();
  h.engine.addGlobal({ on: ['task.failed'], action: { kind: 'webhook', url: 'https://hooks.example.com/x', secretName: 'hook' } });
  h.bus.emit('task:state-changed', 's1', base, { ...base, classifyState: 'E' });
  await h.settle();
  assert.equal(h.calls.http.length, 1);
  const { headers, body } = h.calls.http[0];
  assert.equal(headers['X-Multicc-Signature'], sign('s3cret', body, headers['X-Multicc-Timestamp']));
  const parsed = JSON.parse(body);
  assert.equal(parsed.type, 'task.failed');
  assert.ok(!('cwd' in parsed.data));
});

test('engine: webhook retries then gives up; private targets blocked; 4xx not retried', async () => {
  let statuses = [500, 502, 503];
  const h = engineHarness({ httpPost: async () => statuses.shift() });
  h.engine.addGlobal({ on: ['task.running'], action: { kind: 'webhook', url: 'https://hooks.example.com/x' } });
  h.bus.emit('task:state-changed', 's1', toD(), base);
  await h.settle(); await h.settle();
  assert.equal(statuses.length, 0);
  assert.equal(h.engine.recentResults().at(-1).ok, false);

  const priv = engineHarness({ lookup: async () => [{ address: '127.0.0.1' }] });
  priv.engine.addGlobal({ on: ['task.running'], action: { kind: 'webhook', url: 'https://evil.example.com/x' } });
  priv.engine.addGlobal({ on: ['task.running'], action: { kind: 'webhook', url: 'http://169.254.169.254/' } });
  priv.bus.emit('task:state-changed', 's1', toD(), base);
  await priv.settle();
  assert.equal(priv.calls.http.length, 0);
  assert.ok(priv.engine.recentResults().every((r) => r.error === 'private address blocked'));

  let four = 0;
  const f = engineHarness({ httpPost: async () => { four += 1; return 404; } });
  f.engine.addGlobal({ on: ['task.running'], action: { kind: 'webhook', url: 'https://hooks.example.com/x' } });
  f.bus.emit('task:state-changed', 's1', toD(), base);
  await f.settle();
  assert.equal(four, 1);
});

test('engine: a rule on * cannot loop through trigger.fired; depth capped', async () => {
  const h = engineHarness();
  h.engine.addGlobal({ on: ['*'], action: { kind: 'notify' } });
  h.bus.emit('task:state-changed', 's1', toD(), base);
  await h.settle();
  assert.equal(h.calls.notify.length, 1); // task.running only; trigger.fired not matched by *
  assert.ok(h.log.filter((e) => e.type === 'trigger.fired').every((e) => e.depth === 1));
});

test('engine: global rules persist and reload; corrupt/invalid CRUD is rejected', () => {
  const h = engineHarness();
  const { rule } = h.engine.addGlobal({ name: 'a', on: ['task.achieved'], action: { kind: 'notify' } });
  assert.equal(h.stored.rules.length, 1);
  assert.equal(h.engine.updateGlobal(rule.id, { enabled: false }).rule.enabled, false);
  assert.equal(h.engine.updateGlobal('missing', {}).status, 404);
  assert.match(h.engine.updateGlobal(rule.id, { on: ['bad'] }).error, /unknown/);
  assert.equal(h.engine.removeGlobal(rule.id), true);
  assert.equal(h.engine.removeGlobal(rule.id), false);
  assert.equal(h.stored.rules.length, 0);
});

test('private address classifier', () => {
  for (const a of ['10.0.0.1', '127.0.0.1', '192.168.1.1', '172.20.0.1', '169.254.1.1', '::1', 'fd00::1', '::ffff:10.0.0.1', 'garbage']) {
    assert.ok(isPrivateAddress(a), a);
  }
  for (const a of ['8.8.8.8', '93.184.216.34', '2606:4700::1111']) assert.ok(!isPrivateAddress(a), a);
});

test('session triggers accept type:event and reject bad event rules', () => {
  const runtime = createSessionTriggers({
    crypto: { randomUUID: () => 'gen' },
    cron: { validate: () => true, schedule: () => ({}) },
    chokidar: { watch: () => ({}) },
    fs: { existsSync: () => true },
    path: require('node:path'),
    bus: new EventEmitter(),
    persistedSessions: new Map(),
    chatSessions: new Map(),
    sessionPersistence: { mutate: (s, m) => m() },
    saveBestEffort() {}, cwdForSession() {}, appendEvent() {}, chatBroadcast() {},
  });
  const ok = runtime.validateTrigger({ type: 'event', on: ['task.attention'], action: { kind: 'notify' } });
  assert.equal(ok.trigger.type, 'event');
  assert.equal(ok.trigger.id, 'gen');
  assert.ok(runtime.validateTrigger({ type: 'event', on: ['zzz.x'], action: { kind: 'notify' } }).error);
  assert.equal(runtime.triggerLabel(ok.trigger), '事件 task.attention');
});

// ── event envelope ──────────────────────────────────────────────────────────
const envelope = require('../src/events/envelope');

test('envelope: conclusion = last non-empty assistant reply, clipped and redacted', () => {
  const history = [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: 'old answer' },
    { role: 'assistant', content: [{ type: 'text', text: 'done, key sk-abcdefghijklmnop1234 ok' }, { type: 'tool_use' }] },
    { role: 'assistant', content: '   ' },
    { role: 'user', content: 'thanks' },
  ];
  assert.equal(envelope.conclusionFromHistory(history), 'done, key *** ok');
  assert.equal(envelope.conclusionFromHistory([]), '');
  assert.equal(envelope.conclusionFromHistory(null), '');
  const long = envelope.conclusionFromHistory([{ role: 'assistant', content: 'x'.repeat(5000) }]);
  assert.ok(long.length <= envelope.CONCLUSION_MAX + 1);
  assert.match(envelope.redactText('Authorization: Bearer abcdefghijklmnopqrstuvwxyz'), /\*\*\*/);
});

test('envelope: injection text carries fixed fields and ends with the user instruction', () => {
  const text = envelope.renderInjection({
    type: 'task.achieved', sessionId: 's1',
    data: { goal: 'ship', goalState: 'achieved', summary: 'sum', conclusion: 'all green' },
  }, '部署到测试环境');
  assert.match(text, /事件 task\.achieved/);
  assert.match(text, /来源会话：s1/);
  assert.match(text, /达成目标/);
  assert.match(text, /上一轮结论[\s\S]*all green/);
  assert.ok(text.trimEnd().endsWith('你的指令：部署到测试环境'));
  const failed = envelope.renderInjection({ type: 'task.failed', sessionId: 's1', data: { errorCategory: 'rate_limit', cancelled: true } }, '');
  assert.match(failed, /错误类别：rate_limit（用户主动停止）/);
  assert.match(failed, /你的指令：请根据以上信息/);
});

test('hub: terminal events carry conclusion+summary once-read; running does not', () => {
  const bus = new EventEmitter();
  let reads = 0;
  const hub = createEventHub({ bus, conclusionOf: () => { reads += 1; return 'final words'; } });
  hub.start();
  const log = [];
  hub.subscribe((event) => log.push(event));
  bus.emit('task:state-changed', 's1', base, { ...base, classifyState: 'D', goalState: 'achieved', lastSummary: 'brief' });
  const types = log.map((e) => e.type);
  assert.deepEqual(types, ['task.finished', 'task.goal_resolved', 'task.achieved']);
  assert.ok(log.every((e) => e.data.conclusion === 'final words' && e.data.summary === 'brief'));
  assert.equal(reads, 1);
  bus.emit('task:state-changed', 's1', { ...base, classifyState: 'D' }, base);
  assert.equal(log.at(-1).type, 'task.running');
  assert.ok(!('conclusion' in log.at(-1).data));
});

test('hub: a throwing conclusion reader never blocks the event', () => {
  const bus = new EventEmitter();
  const hub = createEventHub({ bus, conclusionOf: () => { throw new Error('disk'); } });
  hub.start();
  const log = [];
  hub.subscribe((event) => log.push(event));
  bus.emit('task:state-changed', 's1', base, { ...base, classifyState: 'E' });
  assert.equal(log[0].type, 'task.failed');
  assert.equal(log[0].data.conclusion, '');
});

test('webhook: conclusion only with includeConclusion; inject uses the envelope', async () => {
  const { webhookBody } = require('../src/events/actions');
  const event = { eventId: 'e', seq: 1, ts: 1, type: 'task.achieved', sessionId: 's1', dirId: 'd', data: { goal: 'g', goalState: 'achieved', conclusion: 'secret-ish reply', summary: 's' } };
  assert.ok(!('conclusion' in JSON.parse(webhookBody(event)).data));
  assert.equal(JSON.parse(webhookBody(event, true)).data.conclusion, 'secret-ish reply');
  assert.equal(validateEventRule({ on: ['task.failed'], action: { kind: 'webhook', url: 'https://a.io/x', includeConclusion: true } }, { idFactory: () => 'r', nowIso: () => 'n' }).rule.action.includeConclusion, true);
  assert.equal(validateEventRule({ on: ['task.failed'], action: { kind: 'webhook', url: 'https://a.io/x' } }, { idFactory: () => 'r', nowIso: () => 'n' }).rule.action.includeConclusion, false);

  const h = engineHarness();
  h.engine.addGlobal({ on: ['task.achieved'], action: { kind: 'inject-prompt', prompt: '继续部署' } });
  h.hub.emit('task.achieved', 's1', { goal: 'ship', goalState: 'achieved', conclusion: 'all green' });
  await h.settle();
  assert.equal(h.calls.inject.length, 1);
  assert.match(h.calls.inject[0][1], /all green/);
  assert.ok(h.calls.inject[0][1].trimEnd().endsWith('你的指令：继续部署'));
});

test('engine.listAll merges global + session event rules with last run; skips other trigger types', async () => {
  const h = engineHarness();
  h.persistedSessions.get('s1').label = 'My chat';
  const mine = validateEventRule({ on: ['task.failed'], action: { kind: 'notify' } }, { idFactory: () => 'mine', nowIso: () => 'n', scope: 'session' }).rule;
  h.persistedSessions.get('s1').triggers.push(mine, { id: 'x', type: 'post-turn', enabled: true });
  const global = h.engine.addGlobal({ on: ['task.achieved'], action: { kind: 'notify' } }).rule;
  h.bus.emit('task:state-changed', 's1', base, { ...base, classifyState: 'E' });
  await h.settle();
  const all = h.engine.listAll();
  assert.equal(all.length, 2);
  const session = all.find((item) => item.scope === 'session');
  assert.equal(session.sessionId, 's1');
  assert.equal(session.sessionLabel, 'My chat');
  assert.equal(session.lastRun.ok, true);
  const globalItem = all.find((item) => item.scope === 'global');
  assert.equal(globalItem.rule.id, global.id);
  assert.equal(globalItem.lastRun, null);
});

// ── inject target: specific session / brand-new session per firing ─────────
function newSessionHarness(over = {}) {
  const created = [];
  const h = engineHarness({
    createSession: async (input) => { created.push(input); return { sessionId: `task-new-${created.length}` }; },
    sessionInfo: (id) => (id === 's1' ? { dirId: 'dir1', cli: 'codex' } : null),
    ...over,
  });
  h.created = created;
  return h;
}

test('rules: newSession is validated, normalized and exclusive with targetSessionId', () => {
  const opts = { idFactory: () => 'r', nowIso: () => 'n' };
  const ok = validateEventRule({ on: ['task.achieved'], action: { kind: 'inject-prompt', prompt: 'go', newSession: { dirId: 'd1', cli: 'claude', title: ' T ' } } }, opts);
  assert.deepEqual(ok.rule.action.newSession, { dirId: 'd1', cli: 'claude', title: 'T' });
  const blank = validateEventRule({ on: ['task.achieved'], action: { kind: 'inject-prompt', newSession: {} } }, opts);
  assert.deepEqual(blank.rule.action.newSession, { dirId: '', cli: '', title: '' }, '空=沿用来源会话');
  assert.match(validateEventRule({ on: ['task.achieved'], action: { kind: 'inject-prompt', targetSessionId: 's2', newSession: {} } }, opts).error, /mutually exclusive/);
  assert.match(validateEventRule({ on: ['task.achieved'], action: { kind: 'inject-prompt', newSession: { dirId: 'bad dir!' } } }, opts).error, /newSession\.dirId/);
  assert.match(validateEventRule({ on: ['task.achieved'], action: { kind: 'inject-prompt', newSession: { cli: 'Bad CLI' } } }, opts).error, /newSession\.cli/);
});

test('engine: newSession creates a session then injects into it; follows source dir/cli when blank', async () => {
  const h = newSessionHarness();
  h.engine.addGlobal({ on: ['task.achieved'], name: '汇总', action: { kind: 'inject-prompt', prompt: '整理发布说明', newSession: {} } });
  h.hub.emit('task.achieved', 's1', { goal: 'ship', goalState: 'achieved', conclusion: 'all green' });
  await h.settle();
  assert.equal(h.created.length, 1);
  assert.equal(h.created[0].dirId, 'dir1', '沿用来源会话的工作区');
  assert.equal(h.created[0].cli, 'codex', '沿用来源会话的 CLI');
  assert.equal(h.created[0].title, '汇总');
  assert.match(h.created[0].clientMsgId, /^hook:[\w.:-]+:r\d+$/, '幂等 id 由事件+规则派生');
  assert.equal(h.calls.inject.length, 1);
  assert.equal(h.calls.inject[0][0], 'task-new-1', '指令进的是新会话，不是来源会话');
  assert.match(h.calls.inject[0][1], /all green[\s\S]*你的指令：整理发布说明/);
  assert.equal(h.engine.recentResults().at(-1).ok, true);
});

test('engine: explicit workspace and cli win over the source session', async () => {
  const h = newSessionHarness();
  h.engine.addGlobal({ on: ['task.failed'], action: { kind: 'inject-prompt', prompt: 'p', newSession: { dirId: 'other', cli: 'claude', title: '排障' } } });
  h.hub.emit('task.failed', 's1', { goal: 'g' });
  await h.settle();
  assert.deepEqual([h.created[0].dirId, h.created[0].cli, h.created[0].title], ['other', 'claude', '排障']);
});

test('engine: no workspace resolvable, or create failure, is a recorded failure with no inject', async () => {
  const { ACTIONS } = require('../src/events/actions');
  const noDir = await ACTIONS['inject-prompt'](
    { eventId: 'e', type: 'task.failed', sessionId: null, dirId: null, data: {} },
    { id: 'r', action: { kind: 'inject-prompt', prompt: 'p', newSession: { dirId: '', cli: '', title: '' } } },
    { sessionInfo: () => null, createSession: async () => { throw new Error('must not be called'); }, injectPrompt: () => true });
  assert.match(noDir.error, /no workspace/);
  assert.equal(noDir.ok, false);

  const boom = newSessionHarness({ createSession: async () => { throw new Error('limit'); } });
  boom.engine.addGlobal({ on: ['task.failed'], action: { kind: 'inject-prompt', prompt: 'p', newSession: {} } });
  boom.hub.emit('task.failed', 's1', { goal: 'g' });
  await boom.settle();
  assert.equal(boom.calls.inject.length, 0);
  assert.equal(boom.engine.recentResults().at(-1).ok, false);
});

test('engine: a refused admission is a failed run, not ok (hook prompt silently dropped)', async () => {
  const h = engineHarness({ injectPrompt: async (...a) => ({ ok: false, code: 'task_shell_route_required', args: a }) });
  h.engine.addGlobal({ on: ['task.failed'], action: { kind: 'inject-prompt', prompt: 'p' } });
  h.hub.emit('task.failed', 's1', { goal: 'g' });
  await h.settle(); await h.settle();
  const last = h.engine.recentResults().at(-1);
  assert.equal(last.ok, false);
  assert.equal(last.error, 'task_shell_route_required');
});

test('events host: injectPrompt awaits admission with originTrigger and returns its result', async () => {
  const { createEventsHost } = require('../src/events/host');
  const { bus } = harness();
  const admitted = [];
  const host = createEventsHost({ bus, app: null, persistedSessions: new Map([['s1', { id: 's1', dirId: 'd' }]]), chatSessions: new Map(),
    saveBestEffort: () => {}, rulesFile: require('path').join(require('os').tmpdir(), `ev-${process.pid}-${Date.now()}.json`), logger: { warn() {} },
    secretsVault: { reveal: () => null }, notify: () => {}, createChatTask: async () => ({}),
    admit: async (id, text, opts) => { admitted.push([id, opts]); return { ok: false, code: 'task_shell_route_required' }; } });
  host.engine.addGlobal({ on: ['task.failed'], action: { kind: 'inject-prompt', prompt: 'p' } });
  host.start();
  host.hub.emit('task.failed', 's1', { goal: 'g' });
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
  await host.stop();
  assert.deepEqual(admitted, [['s1', { originTrigger: true }]]);
  assert.equal(host.engine.recentResults().at(-1).error, 'task_shell_route_required');
});

test('engine: the new session finishing does not spawn another one (loop latch follows the new id)', async () => {
  const h = newSessionHarness();
  h.persistedSessions.set('task-new-1', { id: 'task-new-1', dirId: 'dir1', triggers: [] });
  h.engine.addGlobal({ on: ['task.finished'], action: { kind: 'inject-prompt', prompt: 'p', newSession: {} }, cooldownMs: 0 });
  h.hub.emit('task.finished', 's1', { goal: 'g' });
  await h.settle();
  assert.equal(h.created.length, 1);
  h.hub.emit('task.finished', 'task-new-1', { goal: 'g' });
  await h.settle();
  assert.equal(h.created.length, 1, '新会话自己的完成事件被防环压制，不会再建第二个');
});

test('engine: targetSessionId injects into that specific session', async () => {
  const h = newSessionHarness();
  h.engine.addGlobal({ on: ['task.achieved'], action: { kind: 'inject-prompt', prompt: 'p', targetSessionId: 's9' } });
  h.hub.emit('task.achieved', 's1', { goal: 'g' });
  await h.settle();
  assert.equal(h.calls.inject[0][0], 's9');
  assert.equal(h.created.length, 0);
});

// ── chains: `then` steps run one after another ──────────────────────────────
test('rules: then steps are validated per step and capped', () => {
  const opts = { idFactory: () => 'r', nowIso: () => 'n' };
  const plain = validateEventRule({ on: ['task.finished'], action: { kind: 'notify' } }, opts);
  assert.deepEqual(plain.rule.then, []);
  const ok = validateEventRule({ on: ['task.finished'], action: { kind: 'inject-prompt', prompt: 'a' },
    then: [{ kind: 'inject-prompt', prompt: 'b' }, { kind: 'notify', message: 'done' }] }, opts);
  assert.deepEqual(ok.rule.then, [{ kind: 'inject-prompt', prompt: 'b' }, { kind: 'notify', message: 'done' }]);
  assert.match(validateEventRule({ on: ['task.finished'], action: { kind: 'notify' }, then: [{ kind: 'rm' }] }, opts).error, /^then\[0\]: unknown action/);
  const many = Array.from({ length: 10 }, () => ({ kind: 'notify' }));
  assert.match(validateEventRule({ on: ['task.finished'], action: { kind: 'notify' }, then: many }, opts).error, /at most 9/);
});

function chainHarness(over = {}) {
  let t = 0;
  return newSessionHarness({ now: () => (t += 100000), ...over });
}

test('engine: chain injects the next step only after the previous turn finishes', async () => {
  const h = chainHarness();
  h.engine.addGlobal({ on: ['task.finished'], action: { kind: 'inject-prompt', prompt: 'step1' },
    then: [{ kind: 'inject-prompt', prompt: 'step2' }, { kind: 'notify', message: 'all done' }] });
  h.hub.emit('task.finished', 's1', { goal: 'g' });
  await h.settle();
  assert.equal(h.calls.inject.length, 1);
  assert.ok(h.calls.inject[0][1].trimEnd().endsWith('你的指令：step1'));
  assert.deepEqual(h.engine.pendingChains().map((c) => [c.sessionId, c.index]), [['s1', 1]]);
  // step1 still running: nothing else happens
  h.hub.emit('task.running', 's1', { goal: 'g' });
  await h.settle();
  assert.equal(h.calls.inject.length, 1);
  // step1's turn finishes with a conclusion -> step2 gets it, and the rule itself does not re-fire
  h.hub.emit('task.finished', 's1', { goal: 'g', conclusion: 'step1 result' });
  await h.settle();
  assert.equal(h.calls.inject.length, 2);
  assert.match(h.calls.inject[1][1], /step1 result/);
  assert.ok(h.calls.inject[1][1].trimEnd().endsWith('你的指令：step2'));
  // step2 finishes -> the trailing notify runs, no further inject, chain is over
  h.hub.emit('task.finished', 's1', { goal: 'g' });
  await h.settle();
  assert.equal(h.calls.inject.length, 2);
  assert.equal(h.calls.notify.length, 1);
  assert.equal(h.calls.notify[0][2], 'all done');
  assert.equal(h.engine.pendingChains().length, 0);
  assert.deepEqual(h.engine.recentResults().map((r) => r.step), [1, 2, 3]);
});

test('engine: a failed or waiting step stops the chain; background keeps waiting', async () => {
  const h = chainHarness();
  h.engine.addGlobal({ on: ['task.finished'], action: { kind: 'inject-prompt', prompt: 'a' }, then: [{ kind: 'inject-prompt', prompt: 'b' }] });
  h.hub.emit('task.finished', 's1', { goal: 'g' });
  await h.settle();
  h.hub.emit('task.waiting_background', 's1', { goal: 'g' });
  await h.settle();
  assert.equal(h.engine.pendingChains().length, 1, '后台任务还在跑，链继续等');
  h.hub.emit('task.failed', 's1', { goal: 'g' });
  await h.settle();
  assert.equal(h.calls.inject.length, 1);
  assert.equal(h.engine.pendingChains().length, 0);
  assert.equal(h.engine.recentResults().at(-1).error, 'chain stopped: task.failed');
});

test('engine: chain follows a new session; non-inject steps run right away', async () => {
  const h = chainHarness();
  h.persistedSessions.set('task-new-1', { id: 'task-new-1', dirId: 'dir1', triggers: [] });
  h.engine.addGlobal({ on: ['task.achieved'], action: { kind: 'notify', message: 'starting' },
    then: [{ kind: 'inject-prompt', prompt: 'plan', newSession: {} }, { kind: 'inject-prompt', prompt: 'build' }] });
  h.hub.emit('task.achieved', 's1', { goal: 'g' });
  await h.settle(); await h.settle();
  assert.equal(h.calls.notify.length, 1);
  assert.equal(h.created.length, 1);
  assert.equal(h.calls.inject[0][0], 'task-new-1');
  h.hub.emit('task.finished', 'task-new-1', { goal: 'g' });
  await h.settle();
  assert.equal(h.calls.inject.length, 2);
  assert.equal(h.calls.inject[1][0], 'task-new-1', '后续步骤默认接在上一步所在的会话里');
  assert.equal(h.created.length, 1);
});

test('engine: disabling a rule mid-chain cancels the remaining steps', async () => {
  const h = chainHarness();
  const { rule } = h.engine.addGlobal({ on: ['task.finished'], action: { kind: 'inject-prompt', prompt: 'a' }, then: [{ kind: 'inject-prompt', prompt: 'b' }] });
  h.hub.emit('task.finished', 's1', { goal: 'g' });
  await h.settle();
  h.engine.updateGlobal(rule.id, { enabled: false });
  h.hub.emit('task.finished', 's1', { goal: 'g' });
  await h.settle();
  assert.equal(h.calls.inject.length, 1);
  assert.equal(h.engine.recentResults().at(-1).error, 'chain cancelled (rule changed)');
});

test('engine: a user turn finishing while the step is queued does not advance the chain', async () => {
  const h = chainHarness();
  h.engine.addGlobal({ on: ['task.finished'], action: { kind: 'inject-prompt', prompt: 'a' }, then: [{ kind: 'inject-prompt', prompt: 'b' }] });
  h.hub.emit('task.finished', 's1', { goal: 'g' });
  await h.settle();
  // the user's own message ran first and finished
  h.hub.emit('turn.completed', 's1', { lineageKind: 'user' });
  h.hub.emit('task.finished', 's1', { goal: 'g' });
  await h.settle();
  assert.equal(h.calls.inject.length, 1, '用户自己那一轮的完成不算第一步完成');
  assert.equal(h.engine.pendingChains()[0].index, 1);
  // then the injected step itself finishes
  h.hub.emit('turn.completed', 's1', { lineageKind: 'trigger' });
  h.hub.emit('task.finished', 's1', { goal: 'g' });
  await h.settle();
  assert.equal(h.calls.inject.length, 2);
  assert.ok(h.calls.inject[1][1].trimEnd().endsWith('你的指令：b'));
});

test('a replaced runner cannot publish its old turn into a newer event chain', async () => {
  const h = chainHarness();
  h.engine.addGlobal({ on: ['task.finished'], action: { kind: 'inject-prompt', prompt: 'a' },
    then: [{ kind: 'inject-prompt', prompt: 'b' }] });
  h.hub.emit('task.finished', 's1', { goal: 'g' });
  await h.settle();
  h.hub.emit('turn.completed', 's1', { lineageKind: 'user' });
  assert.equal(h.engine.pendingChains()[0].sawOther, true);
  assert.equal(h.engine.pendingChains()[0].sawTrigger, false);
  const turn = { turnId: 'old', sessionId: 's1', requestId: 'old-request', lineage: { kind: 'trigger' },
    resultDurable: true, resultRunnerId: 'old-runner', postTurnClaimed: false };
  const runner = { turnId: turn.turnId, runnerId: 'old-runner',
    completionOutcome: { version: 1, state: 'completed', settled: true } };
  const state = { _activeTurn: turn, _activeRunner: runner };
  const nextTurn = { ...turn, turnId: 'new', resultRunnerId: 'new-runner', postTurnClaimed: false };
  const nextRunner = { ...runner, turnId: nextTurn.turnId, runnerId: 'new-runner' };
  const nextState = { _activeTurn: nextTurn, _activeRunner: nextRunner };
  let live = state;
  const gateway = [];
  const replace = () => { live = nextState; };
  h.bus.prependListener('chat:turn-complete', replace);
  const host = createChatHostRuntime({
    appendMessage: () => true, persistUsage: () => true, afterUsageCommit() {},
    getSessionState: () => live, consumeHandoff() {},
    emitTurnComplete: (...args) => h.bus.emit('chat:turn-complete', ...args),
    emitDispatchComplete() {}, emitGatewayComplete: (...args) => gateway.push(args), logSuppressed() {},
  });
  const completedBefore = h.log.filter(event => event.type === 'turn.completed').length;
  assert.equal(host.runDurablePostTurn('s1', state, { type: 'gateway' }, turn, runner, 'old answer'), false);
  assert.deepEqual(gateway, [['old answer', 's1', 'old', 'old-request']]);
  assert.equal(h.log.filter(event => event.type === 'turn.completed').length, completedBefore);
  assert.equal(h.engine.pendingChains()[0].sawTrigger, false);
  h.hub.emit('task.finished', 's1', { goal: 'g' });
  await h.settle();
  assert.equal(h.calls.inject.length, 1, 'the stale result does not advance the new chain');
  h.bus.removeListener('chat:turn-complete', replace);
  assert.equal(host.runDurablePostTurn('s1', nextState, {}, nextTurn, nextRunner, 'new answer'), true);
  assert.equal(h.log.filter(event => event.type === 'turn.completed').length, completedBefore + 1);
  h.hub.emit('task.finished', 's1', { goal: 'g' });
  await h.settle();
  assert.equal(h.calls.inject.length, 2, 'the real current turn can advance the chain');
  h.engine.stop();
  h.hub.stop();
});

test('a hub subscriber replacing the runner blocks later subscribers and the new chain', async () => {
  let live;
  let replaceOnCompletion = false;
  let replacement;
  const first = [];
  const h = chainHarness({ beforeSubscribe(event) {
    if (event.type === 'turn.completed' && replaceOnCompletion) {
      first.push(event);
      live = replacement;
    }
  } });
  const later = [];
  h.hub.subscribe(event => { if (event.type === 'turn.completed') later.push(event); });
  h.engine.addGlobal({ on: ['task.finished'], action: { kind: 'inject-prompt', prompt: 'a' },
    then: [{ kind: 'inject-prompt', prompt: 'b' }] });
  h.hub.emit('task.finished', 's1', { goal: 'g' });
  await h.settle();
  h.hub.emit('turn.completed', 's1', { lineageKind: 'user' });
  assert.equal(h.engine.pendingChains()[0].sawOther, true);
  const turn = { turnId: 'old', sessionId: 's1', requestId: 'old-request', lineage: { kind: 'trigger' },
    resultDurable: true, resultRunnerId: 'old-runner', postTurnClaimed: false };
  const runner = { turnId: turn.turnId, runnerId: 'old-runner',
    completionOutcome: { version: 1, state: 'completed', settled: true } };
  const state = { _activeTurn: turn, _activeRunner: runner };
  const nextTurn = { ...turn, turnId: 'new', resultRunnerId: 'new-runner', postTurnClaimed: false };
  const nextRunner = { ...runner, turnId: nextTurn.turnId, runnerId: 'new-runner' };
  replacement = { _activeTurn: nextTurn, _activeRunner: nextRunner };
  live = state;
  const gateway = [];
  const host = createChatHostRuntime({
    appendMessage: () => true, persistUsage: () => true, afterUsageCommit() {},
    getSessionState: () => live, consumeHandoff() {},
    emitTurnComplete: (...args) => h.bus.emit('chat:turn-complete', ...args),
    emitDispatchComplete() {}, emitGatewayComplete: (...args) => gateway.push(args), logSuppressed() {},
  });
  const before = h.log.filter(event => event.type === 'turn.completed').length;
  const laterBefore = later.length;
  replaceOnCompletion = true;
  assert.equal(host.runDurablePostTurn('s1', state, { type: 'gateway' }, turn, runner, 'old answer'), false);
  assert.deepEqual(gateway, [['old answer', 's1', 'old', 'old-request']]);
  assert.equal(first.length, 1, 'the earlier subscriber was called while the runner was current');
  assert.equal(h.hub.recent().some(event => event.eventId === first[0].eventId), true,
    'the already published event is not falsely recalled');
  assert.equal(h.log.filter(event => event.type === 'turn.completed').length, before);
  assert.equal(later.length, laterBefore, 'no later subscriber sees the stale event');
  assert.equal(h.engine.pendingChains()[0].sawTrigger, false);
  h.hub.emit('task.finished', 's1', { goal: 'g' });
  await h.settle();
  assert.equal(h.calls.inject.length, 1, 'the stale event cannot advance the chain');
  replaceOnCompletion = false;
  assert.equal(host.runDurablePostTurn('s1', replacement, {}, nextTurn, nextRunner, 'new answer'), true);
  assert.equal(later.length, laterBefore + 1, 'the current turn reaches all subscribers');
  h.hub.emit('task.finished', 's1', { goal: 'g' });
  await h.settle();
  assert.equal(h.calls.inject.length, 2);
  h.engine.stop();
  h.hub.stop();
});

test('owner loss while constructing a completion envelope prevents recording', () => {
  const bus = new EventEmitter();
  let current = true;
  const hub = createEventHub({ bus, randomUUID: () => 'event', dirIdOf: () => { current = false; return 'dir'; } });
  const seen = [];
  hub.subscribe(event => seen.push(event));
  hub.start();
  bus.emit('chat:turn-complete', 's1', {}, { turnId: 'old', resultDurable: true,
    isCurrentRunner: () => current });
  assert.deepEqual(seen, []);
  assert.deepEqual(hub.recent(), []);
  hub.stop();
});

test('engine: a busy session makes the next step wait instead of failing', async () => {
  let busy = false;
  const injected = [];
  const h = chainHarness({ injectPrompt: (id, text) => { if (busy) return { ok: false, code: 'target_busy' }; injected.push(text); return true; } });
  h.engine.addGlobal({ on: ['task.finished'], action: { kind: 'inject-prompt', prompt: 'a' }, then: [{ kind: 'inject-prompt', prompt: 'b' }] });
  h.hub.emit('task.finished', 's1', { goal: 'g' });
  await h.settle();
  busy = true;
  h.hub.emit('task.finished', 's1', { goal: 'g' });
  await h.settle();
  assert.equal(injected.length, 1);
  assert.deepEqual(h.engine.pendingChains().map((c) => [c.index, c.awaiting]), [[1, 'inject']]);
  assert.equal(h.engine.recentResults().at(-1).error, 'chain waiting: target busy');
  // a failure of the user's busy turn does not cancel the waiting step
  h.hub.emit('task.failed', 's1', { goal: 'g' });
  await h.settle();
  assert.equal(h.engine.pendingChains().length, 1);
  busy = false;
  h.hub.emit('task.finished', 's1', { goal: 'g' });
  await h.settle();
  assert.equal(injected.length, 2);
  assert.ok(injected[1].trimEnd().endsWith('你的指令：b'));
  assert.equal(h.engine.pendingChains().length, 0);
});

test('engine: parked chains survive a restart through the rules store', async () => {
  const h = chainHarness();
  h.engine.addGlobal({ on: ['task.finished'], action: { kind: 'inject-prompt', prompt: 'a' }, then: [{ kind: 'inject-prompt', prompt: 'b' }] });
  h.hub.emit('task.finished', 's1', { goal: 'g' });
  await h.settle();
  assert.deepEqual(h.stored.chains.map((c) => [c.sessionId, c.index]), [['s1', 1]]);
  const saved = JSON.parse(JSON.stringify(h.stored));
  h.engine.stop();

  const { bus, hub } = harness();
  const inject = [];
  const engine = createEventRuleEngine({
    hub, persistedSessions: h.persistedSessions, now: () => 1000000,
    store: { read: () => saved, write: () => {} },
    injectPrompt: (...a) => { inject.push(a); return true; },
  });
  engine.start();
  assert.equal(engine.pendingChains().length, 1, '重启后从规则文件恢复等待中的链');
  bus.emit('task:state-changed', 's1', base, toD());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(inject.length, 1);
  assert.ok(inject[0][1].trimEnd().endsWith('你的指令：b'));
  assert.equal(engine.pendingChains().length, 0);
});

test('engine: an unreadable rules file is never overwritten by chain bookkeeping', async () => {
  const { hub } = harness();
  const writes = [];
  const engine = createEventRuleEngine({
    hub, persistedSessions: new Map([['s1', { id: 's1', triggers: [] }]]), now: () => 1,
    store: { read: () => { throw new Error('corrupt'); }, write: (v) => writes.push(v) },
    injectPrompt: () => true,
  });
  engine.start();
  hub.emit('turn.completed', 's1', { lineageKind: 'user' });
  engine.forgetSession('s1');
  assert.equal(writes.length, 0);
});

test('events host: a streaming or missing target reports why instead of a bare false', async () => {
  const { createEventsHost } = require('../src/events/host');
  const { bus } = harness();
  const rulesFile = require('path').join(require('os').tmpdir(), `ev-busy-${process.pid}-${Date.now()}.json`);
  const host = createEventsHost({ bus, app: null, persistedSessions: new Map([['s1', { id: 's1', dirId: 'd' }]]),
    chatSessions: new Map([['s1', { isStreaming: true }]]), saveBestEffort: () => {}, rulesFile, logger: { warn() {} },
    secretsVault: { reveal: () => null }, notify: () => {}, createChatTask: async () => ({}), admit: async () => ({ ok: true }) });
  host.engine.addGlobal({ on: ['task.failed'], action: { kind: 'inject-prompt', prompt: 'p' } });
  host.engine.addGlobal({ on: ['task.failed'], action: { kind: 'inject-prompt', prompt: 'p', targetSessionId: 'gone' } });
  host.start();
  host.hub.emit('task.failed', 's1', { goal: 'g' });
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
  await host.stop();
  assert.deepEqual(host.engine.recentResults().map((r) => r.error).sort(), ['target_busy', 'target_missing']);
  require('fs').rmSync(rulesFile, { force: true });
});

// ── one-shot hooks: fire once, then disable themselves ──────────────────────
test('rules: once is normalized and defaults to persistent', () => {
  const opts = { idFactory: () => 'r', nowIso: () => 'n' };
  assert.equal(validateEventRule({ on: ['task.failed'], action: { kind: 'notify' } }, opts).rule.once, false);
  assert.equal(validateEventRule({ on: ['task.failed'], action: { kind: 'notify' }, once: true }, opts).rule.once, true);
  assert.equal(validateEventRule({ on: ['task.failed'], action: { kind: 'notify' }, once: 'yes' }, opts).rule.once, false);
});

test('engine: a one-shot global rule fires once, then disables itself with a firedAt stamp', async () => {
  const h = engineHarness();
  const rule = h.engine.addGlobal({ on: ['task.failed'], once: true, cooldownMs: 0, action: { kind: 'notify', message: '一次' } }).rule;
  h.hub.emit('task.failed', 's1', { goal: 'g' });
  await h.settle();
  assert.equal(h.calls.notify.length, 1, '动作照常执行');
  const live = h.engine.listGlobal().find((item) => item.id === rule.id);
  assert.equal(live.enabled, false, '触发成功后自动关闭');
  assert.equal(live.firedAt, 1000000, '留下已触发时间给 UI');
  assert.equal(h.stored.rules.find((item) => item.id === rule.id).enabled, false, '关闭状态落盘，重启后不会复活');

  h.hub.emit('task.failed', 's1', { goal: 'g' });
  await h.settle();
  assert.equal(h.calls.notify.length, 1, '第二次事件不再触发');
});

test('engine: a one-shot session rule consumes the persisted trigger', async () => {
  const saved = [];
  const h = engineHarness({ saveBestEffort: (reason) => saved.push(reason) });
  const rule = validateEventRule({ on: ['task.failed'], once: true, action: { kind: 'notify' } },
    { idFactory: () => 'trig', nowIso: () => 'n', scope: 'session' }).rule;
  h.persistedSessions.get('s1').triggers.push(rule);
  h.bus.emit('task:state-changed', 's1', base, { ...base, classifyState: 'E' });
  await h.settle();
  const live = h.persistedSessions.get('s1').triggers.find((item) => item.id === 'trig');
  assert.equal(live.enabled, false);
  assert.equal(live.firedAt, 1000000);
  assert.equal(saved.at(-1), 'runtime.event-rule-consumed', '会话触发器要立刻落盘');
});

test('engine: a manual test never burns a one-shot rule', async () => {
  const h = engineHarness();
  h.engine.addGlobal({ on: ['task.failed'], once: true, action: { kind: 'notify' } });
  h.hub.emit('task.failed', 's1', { goal: 'g' }, { origin: 'manual-test' });
  await h.settle();
  assert.equal(h.calls.notify.length, 1);
  assert.equal(h.engine.listGlobal()[0].enabled, true, '空跑只验证，不消耗');
});

test('engine: a one-shot chain stays armed until its last step, then consumes', async () => {
  const h = chainHarness();
  h.engine.addGlobal({ on: ['task.finished'], once: true, action: { kind: 'inject-prompt', prompt: 'a' },
    then: [{ kind: 'inject-prompt', prompt: 'b' }] });
  h.hub.emit('task.finished', 's1', { goal: 'g' });
  await h.settle();
  assert.equal(h.engine.pendingChains().length, 1);
  assert.equal(h.engine.listGlobal()[0].enabled, true, '链还没走完，不能提前关闭');
  h.hub.emit('task.finished', 's1', { goal: 'g' });
  await h.settle();
  assert.equal(h.calls.inject.length, 2);
  assert.equal(h.engine.listGlobal()[0].enabled, false, '最后一步完成后才消耗');
});

test('engine: a failed action leaves a one-shot rule armed', async () => {
  const h = engineHarness({ injectPrompt: async () => ({ ok: false, code: 'target_busy' }) });
  h.engine.addGlobal({ on: ['task.failed'], once: true, action: { kind: 'inject-prompt', prompt: 'p' } });
  h.hub.emit('task.failed', 's1', { goal: 'g' });
  await h.settle(); await h.settle();
  assert.equal(h.engine.listGlobal()[0].enabled, true, '没跑成就还有下一次机会');
});
