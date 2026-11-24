'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createCodexSessionFinder } = require('./helpers/legacy-codex-session-file');
const { createSessionPolicy, pollCodexSessionId } = require('../src/cli/session-policy');

const timestamp = 1_700_000_000_000;

function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-session-diff-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const policy = createSessionPolicy({
    homeDir: () => home, providers: { appTypeForCli() {} }, providerRouter: { getProviderSummary() {} },
  });
  const root = path.join(home, '.codex', 'sessions');
  const old = createCodexSessionFinder({ fs, path, defaultSessionsDir: root }).findCodexSessionId;
  const cwd = path.join(home, 'project');
  fs.mkdirSync(cwd);
  function write(name, line, time = timestamp, dir = root) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, line);
    fs.utimesSync(file, time / 1000, time / 1000);
    return file;
  }
  function meta(id, dir = cwd) {
    return JSON.stringify({ type: 'session_meta', payload: { id, cwd: dir } });
  }
  async function compare(expected, launch = cwd, since = 0, override) {
    const baseline = old(launch, since, override);
    assert.deepStrictEqual(baseline, expected);
    const lookup = policy.findCodexSessionId(launch, since, override);
    assert.ok(lookup instanceof Promise);
    assert.deepStrictEqual(await lookup, baseline);
  }
  return { home, root, cwd, write, meta, compare };
}

test('captures a matching cwd and ignores a different project', async t => {
  const { write, meta, cwd, compare } = setup(t);
  write('a.jsonl', meta('session-A') + '\n{"type":"event"}');
  await compare('session-A');
  await compare(null, cwd + '-other');
});

test('filters on fractional file mtime, including the exact boundary', async t => {
  const { write, meta, cwd, compare } = setup(t);
  const file = write('a.jsonl', meta('recent'), timestamp + 0.375);
  const modified = fs.statSync(file).mtimeMs;
  await compare('recent', cwd, modified);
  await compare(null, cwd, modified + 0.01);
});

test('orders nested rollouts by modification time', async t => {
  const { write, meta, compare } = setup(t);
  write('b/2026/01/z.jsonl', meta('newer'), timestamp + 1000);
  write('a.jsonl', meta('older'));
  await compare('newer');
});

test('equal mtimes retain the name order of the depth-first scan', async t => {
  const { write, meta, compare } = setup(t);
  write('a-.jsonl', meta('file'));
  write('a/z.jsonl', meta('nested'));
  await compare('nested');
});

test('skips bad JSON, non-meta, missing id and later lines', async t => {
  const { write, meta, compare } = setup(t);
  write('bad.jsonl', '{bad\n' + meta('later'));
  write('type.jsonl', '{"type":"event"}\n' + meta('later'));
  write('missing.jsonl', meta(undefined));
  await compare(null);
  write('valid.jsonl', meta('older'), timestamp - 2000);
  await compare('older');
});

test('root override, empty override, missing directory and file in place of root', async t => {
  const { home, cwd, write, meta, compare } = setup(t);
  await compare(null);
  const override = path.join(home, 'override');
  const regular = write('.jsonl', meta('default'));
  write('a.jsonl', meta('override'), timestamp, override);
  await compare('override', cwd, 0, override);
  await compare('default', cwd, 0, '');
  await compare(null, cwd, 0, regular);
});

test('resolves directory aliases and parents before symlinks', async t => {
  const { cwd, home, write, meta, compare } = setup(t);
  const folder = path.join(cwd, 'nested');
  fs.mkdirSync(folder);
  const alias = path.join(home, 'alias');
  fs.symlinkSync(folder, alias, 'dir');
  write('rollout.jsonl', meta('aliased', alias));
  await compare('aliased', folder);
  write('rollout.jsonl', meta('lexical', alias + '/../project'));
  await compare('lexical', cwd);
  write('rollout.jsonl', meta('empty', ''));
  await compare('empty', process.cwd());
});

test('missing realpath falls back to the exact input string', async t => {
  const { home, write, meta, compare } = setup(t);
  const missing = path.join(home, 'missing');
  write('a.jsonl', meta('missing', missing + '//x'));
  await compare('missing', missing + '//x');
  await compare(null, missing + '/x');
});

test('skips child symlinks and non-jsonl files but follows a symlinked root', async t => {
  const { home, root, cwd, write, meta, compare } = setup(t);
  const other = path.join(home, 'elsewhere');
  const target = write('actual.jsonl', meta('elsewhere'), timestamp, other);
  write('ignore.JSONL', meta('wrong'));
  fs.symlinkSync(target, path.join(root, 'link.jsonl'), 'file');
  fs.symlinkSync(other, path.join(root, 'dir-link'), 'dir');
  await compare(null);
  await compare('elsewhere', cwd, 0, path.join(root, 'dir-link'));
});

test('honours the 8192 byte read boundary before decoding UTF-8', async t => {
  const { write, meta, compare } = setup(t);
  const line = meta('会话');
  const prefix = ' '.repeat(8192 - Buffer.byteLength(line));
  write('a.jsonl', prefix + line + '\n' + meta('ignored'));
  await compare('会话');
  write('a.jsonl', ' ' + prefix + line);
  await compare(null);
  const parts = meta('SPLIT').split('SPLIT');
  write('a.jsonl', Buffer.concat([Buffer.from(parts[0]), Buffer.from([0xff]), Buffer.from(parts[1])]));
  await compare('\ufffd');
});

test('preserves JSON id types, truthiness and UTF-16 escapes', async t => {
  const { write, meta, compare } = setup(t);
  for (const id of ['', false, 0, null, true, 7, [], { retained: 1 }, '\ud800']) {
    write('a.jsonl', meta(id));
    await compare(id || null);
  }
});

test('duplicate metadata keys take their final value; deep unused metadata is skipped', async t => {
  const { cwd, write, compare } = setup(t);
  const payload = '{"cwd":' + JSON.stringify(cwd) + ',"id":"stale","id":"current"}';
  const ignored = '['.repeat(3100) + '0' + ']'.repeat(3100);
  write('a.jsonl', '{"type":"event","type":"session_meta","ignored":' + ignored + ',"payload":' + payload + '}');
  await compare('current');
});

test('overlapping timer ticks share one lookup and discard results after disposal', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let resolve, lookups = 0, current = true;
  const results = [];
  const timer = pollCodexSessionId(() => {
    lookups++;
    return new Promise(done => { resolve = done; });
  }, () => current, id => results.push(id));
  t.mock.timers.tick(1000);
  t.mock.timers.tick(1000);
  assert.equal(lookups, 1);
  current = false;
  clearInterval(timer);
  resolve('stale');
  await Promise.resolve();
  assert.deepEqual(results, []);
});

test('poller stops on capture and at the 30th unsuccessful tick', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  for (const [expected, attempts] of [['found', 1], [null, 30]]) {
    let calls = 0;
    const results = [];
    pollCodexSessionId(async () => { calls++; return expected; }, () => true, id => results.push(id));
    for (let i = 0; i <= 30; i++) {
      t.mock.timers.tick(1000);
      await Promise.resolve();
    }
    assert.deepEqual(results, [expected]);
    assert.equal(calls, attempts);
  }
});
