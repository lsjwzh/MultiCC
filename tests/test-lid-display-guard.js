'use strict';
// Exercise the actual Swift decision code without changing the physical lid,
// display or keychain, plus the durable consent shared by server and Agent.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { createPowerPreferences } = require('../src/routes/host-power');

test('Agent keeps power intent and unlock consent independent', { skip: process.platform !== 'darwin' }, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-lid-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = fs.readFileSync(path.join(__dirname, '../scripts/macos-agent/MultiCCAgent.swift'), 'utf8');
  const policy = source.slice(source.indexOf('func automaticUnlockAllowed()'), source.indexOf('final class LidDisplayGuard'));
  const intentReader = source.slice(source.indexOf('func lidModeEnabled()'), source.indexOf('func lidClosed()')).replace('"/Library/Application Support/multicc/power-intent"', 'agentDir + "/power-intent"');
  const file = path.join(dir, 'main.swift');
  fs.writeFileSync(file, 'import Foundation\n' + `
    let agentDir = ${JSON.stringify(dir)}
    ${intentReader}
    let intent = URL(fileURLWithPath: agentDir + "/power-intent")
    try! Data("off".utf8).write(to: intent)
    func hasUnlockPassword() -> Bool { return true }
    ${policy}
    // An existing credential preserves legacy consent until explicitly disabled.
    assert(automaticUnlockAllowed())
    let prefs = URL(fileURLWithPath: agentDir + "/power-settings.json")
    try! Data("{\\"autoUnlock\\":false}".utf8).write(to: prefs)
    assert(!automaticUnlockAllowed())
    try! Data("on".utf8).write(to: intent)
    assert(automaticUnlockAllowed())
    try! Data("off".utf8).write(to: intent)
    try! Data("{\\"autoUnlock\\":true}".utf8).write(to: prefs)
    assert(automaticUnlockAllowed())
    try! Data("broken".utf8).write(to: prefs)
    assert(!automaticUnlockAllowed())

    print("power consent passed")
  `);
  const bin = path.join(dir, 'test');
  execFileSync('xcrun', ['swiftc', file, '-o', bin], { timeout: 60000 });
  assert.match(execFileSync(bin, { encoding: 'utf8' }), /passed/);
});

test('consent survives restart and off/on, legacy migration is explicit, corrupt settings fail closed', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-power-prefs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const preferences = createPowerPreferences({ dir });
  assert.equal(preferences.read(false), false);
  assert.equal(preferences.read(true), true);
  preferences.write(false);
  assert.equal(createPowerPreferences({ dir }).read(true), false);
  preferences.write(true);
  assert.equal(createPowerPreferences({ dir }).read(false), true);
  assert.equal(fs.statSync(path.join(dir, 'power-settings.json')).mode & 0o777, 0o600);
  fs.writeFileSync(path.join(dir, 'power-settings.json'), '{}');
  assert.throws(() => preferences.read(true));
});

test('power preference persistence matches the frozen implementation on legacy and failed writes', () => {
  const frozen = require('./helpers/frozen-file-batch18/host-power-services');
  const current = { createPowerPreferences };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'power-preferences-diff-'));
  try {
    for (const [name, api] of Object.entries({ frozen, current })) {
      const dir = path.join(root, name);
      const file = path.join(dir, 'power-settings.json');
      const store = api.createPowerPreferences({ dir });
      const legacy = { consent: true };
      assert.equal(store.read(legacy), legacy);
      store.write(false);
      assert.equal(fs.readFileSync(file, 'utf8'), '{"autoUnlock":false}\n');
      assert.equal(store.read(true), false);
      store.write(true);
      assert.equal(store.read(false), true);
      if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      const circular = {}; circular.self = circular;
      assert.throws(() => store.write(circular), TypeError);
      assert.deepEqual(fs.readdirSync(dir), ['power-settings.json']);
      assert.equal(store.read(), true);
      fs.writeFileSync(file, '{"autoUnlock":"yes"}');
      assert.throws(() => store.read(), { name: 'Error', message: 'invalid power preferences' });
      fs.writeFileSync(file, '{');
      assert.throws(() => store.read(), SyntaxError);
      fs.unlinkSync(file);
      fs.mkdirSync(file);
      assert.throws(() => store.write(false));
      assert.deepEqual(fs.readdirSync(dir), ['power-settings.json']);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
