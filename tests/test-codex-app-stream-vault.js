'use strict';
// 常驻 codex app-server 的环境同样在 spawn 时固定：保险箱条目会话中途变化后，
// 要在下个回合边界回收重启（thread/resume 保留对话）；没变化则绝不重启。
// 保险箱落在隔离的 MULTICC_DATA_DIR，绝不碰真实 secrets.json。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-vault-test-'));
process.env.MULTICC_DATA_DIR = dataDir;
const { assertTestDir } = require('../src/paths');
assertTestDir(dataDir);
const vault = require('../src/secrets-vault');
const { createCodexAppStream } = require('../src/chat/codex-app-stream');
const { writeFakeAppServer } = require('./helpers/fake-codex-app-server');

const BRIDGE = 'codex-app-bridge';
const BRIDGE_CMD = require('../src/native/binding').gatewayPath();

function createFixture(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `multicc-codex-vault-${name}-`));
  const logFile = path.join(root, 'requests.jsonl');
  fs.writeFileSync(logFile, '');
  const bin = writeFakeAppServer(root);
  const stream = createCodexAppStream();
  const baseEnv = { ...process.env, FAKE_CODEX_LOG: logFile };
  const ensureTurn = () => stream.ensure(name, {
    cmd: BRIDGE_CMD,
    cwd: root,
    baseArgs: [BRIDGE, '--codex-bin', bin, '--resident'],
    env: vault.applyEnvOverlay({ ...baseEnv }),
    idleMs: 60_000,
  });
  ensureTurn();
  return {
    stream,
    turn: (text) => { ensureTurn(); return stream.send(name, text, () => {}); },
    methods: () => fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean)
      .map(line => JSON.parse(line)).filter(item => item.id).map(item => item.method),
  };
}

test('unchanged vault never respawns the resident codex child', { timeout: 15000 }, async (t) => {
  vault._resetForTests();
  t.after(() => vault._resetForTests());
  vault.upsert({ name: 'ARK_API_KEY', value: 'k1' });
  const f = createFixture('stable');
  t.after(() => f.stream.closeAndWait('stable'));
  await f.turn('one');
  await f.turn('two');
  assert.deepEqual(f.methods(), ['initialize', 'thread/start', 'turn/start', 'turn/start']);
});

test('an entry added or changed mid-session recycles the child at the next turn and resumes the thread', { timeout: 15000 }, async (t) => {
  vault._resetForTests();
  t.after(() => vault._resetForTests());
  const f = createFixture('mid-session');
  t.after(() => f.stream.closeAndWait('mid-session'));
  await f.turn('before');
  vault.upsert({ name: 'LATE_KEY', value: 'v1' });
  await f.turn('after add');
  assert.deepEqual(f.methods(),
    ['initialize', 'thread/start', 'turn/start', 'initialize', 'thread/resume', 'turn/start']);
  vault.upsert({ name: 'LATE_KEY', value: 'v2' });
  await f.turn('after change');
  assert.equal(f.methods().filter(m => m === 'initialize').length, 3, 'changed value recycles again');
});
