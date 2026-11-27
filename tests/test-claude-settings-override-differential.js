'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { getNative } = require('../src/native/binding');

// Frozen from 5ec8703f, so the oracle survives commits and removal of the module.
const source = fs.readFileSync(path.join(__dirname, 'helpers/legacy-claude-settings-override.js'), 'utf8');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-settings-differential-'));
test.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
const legacy = { exports: {} };
new Function('require', 'module', source)(name => {
  if (name === 'os') return { homedir: () => path.join(fixture, 'node') };
  if (name === 'path') return path;
  return require('../src/native/binding').runtimeSecurity;
}, legacy);
const native = getNative();
const directory = path.join(fixture, 'rust', '.multicc', 'claude-settings-overrides');

test('540 inputs preserve routing projection, serialized bytes, names and private permissions', () => {
  const environments = [undefined, null, false, 42, 'env', {}, [],
    { ANTHROPIC_BASE_URL: 'http://fixture', ANTHROPIC_AUTH_TOKEN: 'fixture-key', TERM: 'dumb', ANTHROPIC_NUM: 42 },
    { CLAUDE_CODE_OAUTH_TOKEN: 'login', ANTHROPIC_CUSTOM_HEADERS: 'x-tenant: fixture' },
    Object.assign(Object.create({ ANTHROPIC_MODEL: 'inherited' }), { CLAUDE_CODE_SIMPLE: '' }),
  ];
  const extras = [undefined, null, {}, [], false, { model: 'claude-test', ultracode: true },
    { env: { stale: 'fixture' }, note: '中文\ud800', unset: undefined, values: [NaN, Infinity, undefined] },
    [1, 2], { toJSON() { return { chosen: true }; } },
  ];
  let count = 0;
  for (const env of environments) for (const extra of extras) {
    for (const session of ['session', 'space / slash 中文', null, 0, false, Symbol('fixture')]) {
      assert.deepEqual(native.claudeRoutingEnv(env), legacy.exports.routingEnvOf(env));
      const before = legacy.exports.settingsOverrideFor(session, env, extra);
      const after = native.claudeSettingsOverride(directory, session, env, extra);
      assert.equal(before === null, after === null);
      if (before) {
        assert.equal(path.basename(before), path.basename(after));
        assert.deepEqual(fs.readFileSync(before), fs.readFileSync(after));
        if (process.platform !== 'win32') {
          assert.equal(fs.statSync(after).mode & 0o777, fs.statSync(before).mode & 0o777);
          assert.equal(fs.statSync(path.dirname(after)).mode & 0o777, 0o700);
        }
      }
      count++;
    }
  }
  assert.equal(count, 540);
  if (process.platform !== 'win32') for (const side of ['node', 'rust']) {
    assert.equal(fs.statSync(path.join(fixture, side, '.multicc')).mode & 0o777, 0o700);
  }
});

test('getters retain access order and throw the original exception before writing', () => {
  function run(write) {
    const calls = [];
    const error = new Error('fixture getter failure');
    const env = { get TERM() { calls.push('TERM'); return 'dumb'; },
      get ANTHROPIC_MODEL() { calls.push('model'); return 'chosen'; } };
    const extra = { get model() { calls.push('extra'); throw error; } };
    assert.throws(() => write('getter', env, extra), value => value === error);
    return calls;
  }
  assert.deepEqual(run(legacy.exports.settingsOverrideFor),
    run((...args) => native.claudeSettingsOverride(directory, ...args)));
  assert.equal(fs.existsSync(path.join(directory, 'getter.json')), false);
});

test('serialization failure leaves the previous settings intact', () => {
  for (const write of [legacy.exports.settingsOverrideFor,
    (...args) => native.claudeSettingsOverride(directory, ...args)]) {
    const file = write('atomic', { ANTHROPIC_MODEL: 'before' });
    const bytes = fs.readFileSync(file);
    const cycle = {}; cycle.cycle = cycle;
    assert.throws(() => write('atomic', { ANTHROPIC_MODEL: 'after' }, cycle), TypeError);
    assert.deepEqual(fs.readFileSync(file), bytes);
    assert.equal(fs.readdirSync(path.dirname(file)).some(name => name.includes('.tmp.')), false);
  }
});
