'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const legacy = require('./helpers/legacy-message-composer');
const native = require('../src/native/runtime').messageComposer;
const OPAQUE = Object.freeze({ model: 'opaque', fn() {} });

const frozen = fs.readFileSync(path.join(__dirname, 'helpers/legacy-message-composer.js'));
assert.equal(crypto.createHash('sha256').update(frozen).digest('hex'),
  'd796677ac67587b0c3c39b9f626d007d65a49fedc8dacbf6abf54bf75fe8aa4d');

function fixedClock(run) {
  const now = Date.now;
  Date.now = () => 1795274000123;
  try { return run(); } finally { Date.now = now; }
}

function scenario(api, values = {}, stopAt) {
  const trace = [];
  const opaque = OPAQUE;
  const providers = [opaque];
  const tools = ['WebSearch'];
  const notes = Array.from({ length: values.notes || 0 }, (_, i) => ({ fromLabel: `agent-${i}`, body: values.long ? '😀'.repeat(2400) : `note-${i}` }));
  const track = (label, object) => new Proxy(object, {
    get(target, key, receiver) {
      // These inputs cover the independent workflow and subtask switches tested below.
      const preferenceRead = label === 'persisted' && ['effort', 'cli', 'claudeWorkflow', 'preferSubtasks'].includes(key);
      if (!preferenceRead && !(label === 'deps' && key === 'normalizeEffort')) trace.push(['get', label, String(key)]);
      if (stopAt === `${label}.${String(key)}`) throw stopAt;
      return Reflect.get(target, key, receiver);
    },
    ownKeys() { throw new Error('live values must not be enumerated'); },
  });
  const persisted = track('persisted', {
    cli: values.cli, claudeWorkflow: values.claudeWorkflow, preferSubtasks: values.preferSubtasks,
    type: values.type, autoCommit: values.autoCommit, model: opaque,
    effort: values.effort, agent: opaque, cliSessionId: values.first ? null : 'session-id',
    dirId: 'directory', subagent: opaque,
  });
  const deps = track('deps', {
    multiccImgHint: 'image\ud800',
    resolveRolePrompt(p) { assert.equal(p, persisted); trace.push(['role', this === deps]); return values.role === false ? null : 'role'; },
    buildSubagentProviderHint(value) { assert.equal(value, opaque); trace.push(['subagent', this === deps]); return 'provider'; },
    buildCliHandoffPrompt(p) { assert.equal(p, persisted); trace.push(['handoff', this === deps]); return 'handoff\n'; },
    buildPlanPrompt(p, session, opts) { assert.equal(p, persisted); trace.push(['plan', session, opts]); return 'plan\n'; },
    buildGatewayPrompt(text, session) { trace.push(['gateway', text, session]); return 'gateway\n'; },
    buildDispatchContextPrompt(session) { trace.push(['dispatch', session]); return 'dispatch\n'; },
    takeBackgroundStopNote(session) { trace.push(['stopped', session]); return 'stopped\n'; },
    pendingNotesFor(session) { trace.push(['pending', session]); return notes.filter(n => !n.delivered); },
    saveNotes() { trace.push(['save', this === deps]); },
    appendEvent(...args) { trace.push(['append', ...args]); },
    workspaceBroadcast(...args) { trace.push(['workspace', ...args]); },
    chatBroadcast(...args) { trace.push(['chat', ...args]); },
    normalizeEffort(effort) { return effort; },
  });
  const opts = track('opts', {
    isFirstTurn: values.first, taskContextSeed: values.seed ? 'ledger\n' : undefined,
    mode: values.mode, bare: values.bare, providerModel: opaque, providerModels: providers,
    skipDefaultModel: values.skip, disallowedTools: tools, lang: values.lang,
    voice: values.voice,
  });
  const input = track('input', { text: 'user\udfff', persisted, sessionName: 'session', opts, deps });
  try {
    const envelope = api.composeMessage(input);
    assert.equal(envelope.spawnOpts.rawModel, opaque);
    assert.equal(envelope.spawnOpts.rawAgent, opaque);
    assert.equal(envelope.spawnOpts.providerModels, providers);
    assert.equal(envelope.spawnOpts.disallowedTools, tools);
    const prompt = api.renderPrompt(envelope);
    return { envelope, prompt, trace, notes };
  } catch (error) {
    if (stopAt) assert.equal(error, stopAt, 'the host exception must cross unchanged');
    else throw error;
    return { error, trace, notes };
  }
}

for (const type of [undefined, 'chat', 'aux', 'gateway']) {
  for (const bare of [false, true]) for (const effort of ['high', 'medium']) {
    test(`frozen prompt, live read order and side effects: ${type}/${bare}/${effort}`, () => fixedClock(() => {
      for (const count of [0, 2, 12]) {
        const values = { type, bare, effort, notes: count, seed: true, first: true,
          autoCommit: false, lang: 'zh', voice: { raw: 'unedited\ud800' }, long: count === 12 };
        assert.deepEqual(scenario(native, values), scenario(legacy, values));
      }
    }));
  }
}

test('原生工作流与跨 CLI 子任务提示可独立开启', () => {
  for (const cli of ['claude', 'codex-exp', 'agy']) {
    for (const claudeWorkflow of [false, true]) for (const preferSubtasks of [false, true]) {
      const { envelope, prompt } = scenario(native, { cli, effort: 'medium', claudeWorkflow, preferSubtasks });
      assert.equal(envelope.spawnOpts.rawEffort, 'medium');
      assert.equal(envelope.spawnOpts.ultracode, cli === 'claude' && claudeWorkflow);
      assert.equal(prompt.includes('优先使用可用的子任务工具'), preferSubtasks);
      assert.doesNotMatch(prompt, /Workflow tool/);
    }
  }
  const bare = scenario(native, { cli: 'claude', claudeWorkflow: true, preferSubtasks: true, bare: true }).envelope;
  assert.equal(bare.spawnOpts.ultracode, true);
  assert.equal(bare.suffix, '');
  const legacyEnvelope = scenario(native, { cli: 'claude', effort: 'ultracode' }).envelope;
  assert.equal(legacyEnvelope.spawnOpts.ultracode, true);
  assert.equal(legacyEnvelope.suffix, '');
});

test('truthy bare, explicit undefined fields, null mode, language and raw values retain their distinctions', () => fixedClock(() => {
  for (const bare of [0, '', null, undefined, {}, 'yes']) {
    for (const lang of [undefined, 'en', 'zh', 'fr']) {
      const values = { bare, lang, mode: null, first: false, skip: undefined, role: false, notes: 1 };
      assert.deepEqual(scenario(native, values), scenario(legacy, values));
    }
  }
}));

test('getter failures stop at the same read, preserve identity and do not deliver later side effects', () => fixedClock(() => {
  for (const stopAt of ['input.text', 'input.opts', 'opts.voice', 'deps.resolveRolePrompt',
    'persisted.subagent', 'deps.buildCliHandoffPrompt', 'deps.buildPlanPrompt',
    'deps.pendingNotesFor', 'deps.saveNotes', 'deps.appendEvent', 'deps.workspaceBroadcast',
    'deps.chatBroadcast', 'persisted.model']) {
    assert.deepEqual(scenario(native, { notes: 2 }, stopAt), scenario(legacy, { notes: 2 }, stopAt), stopAt);
  }
}));

test('all injected callbacks propagate the exact thrown object without replaying note delivery', () => fixedClock(() => {
  const marker = Object.freeze({ error: 'port failure' });
  for (const key of ['resolveRolePrompt', 'buildSubagentProviderHint', 'buildCliHandoffPrompt',
    'buildPlanPrompt', 'buildDispatchContextPrompt', 'takeBackgroundStopNote', 'pendingNotesFor',
    'saveNotes', 'appendEvent', 'workspaceBroadcast', 'chatBroadcast']) {
    const run = api => {
      const notes = [{ fromLabel: 'a', body: 'b' }];
      const trace = [];
      const deps = {
        multiccImgHint: 'image', resolveRolePrompt: () => 'role', buildSubagentProviderHint: () => '',
        buildCliHandoffPrompt: () => '', buildPlanPrompt: () => '', buildDispatchContextPrompt: () => '',
        takeBackgroundStopNote: () => '', pendingNotesFor: () => notes,
        saveNotes: () => trace.push('save'), appendEvent: () => trace.push('append'),
        workspaceBroadcast: () => trace.push('workspace'), chatBroadcast: () => trace.push('chat'),
        normalizeEffort: () => 'high',
      };
      deps[key] = () => { trace.push(key); throw marker; };
      assert.throws(() => api.composeMessage({ text: 'hi', persisted: {}, sessionName: 's', opts: {}, deps }), error => error === marker);
      return { trace, notes };
    };
    assert.deepEqual(run(native), run(legacy), key);
  }
}));

test('voice trimming and truncation retain the 4000 UTF-16-unit boundary and lone surrogates', () => {
  for (const source of [null, undefined, false, {}, { inputSource: 'voice' },
    { inputSource: 'voice', voiceRaw: ' \ud800text\udfff ' },
    { inputSource: 'voice', voiceRaw: 'x'.repeat(3999) + '😀tail' }]) {
    assert.deepEqual(native.normalizeVoiceInput(source), legacy.normalizeVoiceInput(source));
  }
  for (const voice of [null, {}, { raw: '' }, { raw: 'hi' }, { raw: '\ud800hi\udfff' }]) {
    for (const text of ['', 'hi', 'changed']) assert.equal(native.buildVoiceInputPrompt(voice, text), legacy.buildVoiceInputPrompt(voice, text));
  }
});

test('voice reads remain lazy and thrown getters keep their identity', () => {
  for (const name of ['normalizeVoiceInput', 'buildVoiceInputPrompt']) {
    const run = api => {
      const trace = [];
      const input = new Proxy({ inputSource: 'voice', voiceRaw: ' a ', raw: ' a ' }, {
        get(target, key) { trace.push(key); return target[key]; },
      });
      return { value: api[name](input, 'b'), trace };
    };
    assert.deepEqual(run(native), run(legacy));
    const marker = {};
    assert.throws(() => native[name](new Proxy({}, { get() { throw marker; } }), 'x'), error => error === marker);
  }
});

test('validation errors and production warnings equal the frozen report', () => {
  const previous = process.env.NODE_ENV;
  const warn = console.warn;
  try {
    for (const environment of ['development', 'production']) {
      process.env.NODE_ENV = environment;
      for (const value of [null, {}, { userText: '', contextLayers: [null, { kind: 'x', text: '', order: 10 },
        { kind: 'x', text: 'a', order: 0 }], spawnOpts: {}, suffix: '', systemPrompt: 'wrong' },
      { userText: 'a', contextLayers: [], imgHint: '', subagentHint: '', rolePrompt: null, systemPrompt: '' }]) {
        const run = api => {
          const warnings = [];
          console.warn = value => warnings.push(value);
          try { return { result: api.validateEnvelope(value), warnings }; }
          catch (error) { return { error: error.message, warnings }; }
        };
        assert.deepEqual(run(native), run(legacy));
      }
    }
  } finally {
    console.warn = warn;
    if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous;
  }
});

test('render uses a defensive copy, V8 stable sorting and default-hint addition', () => {
  const run = api => {
    const trace = [];
    const layers = [2, 1, 1, 0].map((order, i) => ({
      get order() { trace.push(['order', i]); return order; },
      get text() { trace.push(['text', i]); return `${i}\ud800`; },
    }));
    const userText = { [Symbol.toPrimitive](hint) { trace.push(['user', hint]); return 'user'; } };
    const suffix = { [Symbol.toPrimitive](hint) { trace.push(['suffix', hint]); return 'suffix'; } };
    const result = api.renderPrompt({ contextLayers: layers, userText, suffix });
    assert.equal(layers[0].order, 2);
    return { result, trace };
  };
  assert.deepEqual(run(native), run(legacy));
});

test('AutoCommit reads only strict false and always preserves the original text', () => {
  for (const autoCommit of [undefined, true, false, 0, '', null]) {
    assert.equal(native.buildAutoCommitStatusPrompt({ autoCommit }), legacy.buildAutoCommitStatusPrompt({ autoCommit }));
  }
});

test('the production module is retired and the oracle remains an independent frozen source', () => {
  assert.equal(fs.existsSync(path.join(__dirname, '../src/message-composer.js')), false);
  assert.equal(frozen.includes(Buffer.from('getNative')), false);
  const source = fs.readFileSync(path.join(__dirname, '../native/addon/src/message_composer.rs'), 'utf8');
  assert.equal(/(?:eval|new Function|runInContext)\s*\(/.test(source), false);
});
