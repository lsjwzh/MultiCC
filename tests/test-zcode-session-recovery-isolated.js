'use strict';

// Real host startup with copied synthetic state, no CLI/model turn and no
// production session mutation. Verify boot persists the narrowly scoped repair.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { assertTestDir } = require('../src/paths');

const root = assertTestDir(fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-zcode-boot-')));
const dataDir = path.join(root, 'data');
fs.mkdirSync(path.join(dataDir, 'chat_history'), { recursive: true });
const records = [
  { id: 'zcode-poisoned', cli: 'zcode', cliSessionId: 'zcode-settings', cliStates: { zcode: { cliSessionId: 'zcode-settings' } } },
  { id: 'zcode-valid', cli: 'zcode', cliSessionId: 'sess_original' },
  { id: 'codex-preserved', cli: 'codex', cliSessionId: 'thread-original', cliStates: { zcode: { cliSessionId: 'zcode-err' } } },
].map(record => ({ ...record, kind: 'chat', cwd: root, createdAt: new Date().toISOString() }));
const write = (kind, data) => fs.writeFileSync(path.join(dataDir, kind + '.json'), JSON.stringify({
  __multiccSchema: { kind, version: 1, writtenAt: new Date().toISOString() }, data,
}));
write('sessions', records); write('directories', []);
const historyFile = path.join(dataDir, 'chat_history', 'zcode-poisoned.json');
const history = JSON.stringify([{ role: 'assistant', content: 'Keep visible evidence', id: 'message-1', ts: 1 }]);
fs.writeFileSync(historyFile, history);
let server, output = '';
async function stop() {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  const exit = new Promise(resolve => server.once('exit', resolve));
  server.kill('SIGTERM');
  const timeout = setTimeout(() => server.kill('SIGKILL'), 10000);
  await exit; clearTimeout(timeout);
}
async function start() {
  const probe = net.createServer(); probe.listen(0, '127.0.0.1');
  await new Promise(resolve => probe.once('listening', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'), env: { ...process.env, NODE_ENV: 'test', PORT: String(port), HOST: '127.0.0.1',
      ACCESS_TOKEN: 'zcode-recovery-test', MULTICC_DATA_DIR: dataDir, MULTICC_MEMORY_ROOT: path.join(dataDir, 'memories'),
      MULTICC_ENV_FILE: path.join(root, 'test.env'), MULTICC_TASK_SHELLS: '0', ASR_LOCAL: 'off',
      MULTICC_ORCHESTRATION_WORKER_INTERVAL_MS: '60000' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [server.stdout, server.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-10000); });
  for (let i = 0; i < 200; i++) {
    try { if ((await fetch(base + '/readyz')).ok) return base; } catch (_) {}
    if (server.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('isolated ZCode recovery host did not start');
}
(async () => {
  try {
    for (let iteration = 0; iteration < 2; iteration++) {
      const base = await start();
      const response = await fetch(base + '/api/sessions', { headers: { Authorization: 'Bearer zcode-recovery-test' } });
      assert.equal(response.status, 200);
      const live = await response.json();
      assert.equal(live.find(s => s.id === 'zcode-poisoned').cliSessionId, null);
      assert.equal(live.find(s => s.id === 'zcode-valid').cliSessionId, 'sess_original');
      assert.equal(live.find(s => s.id === 'codex-preserved').cliSessionId, 'thread-original');
      const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'sessions.json'))).data;
      assert.equal(saved.find(s => s.id === 'zcode-poisoned').cliStates.zcode.cliSessionId, null);
      assert.equal(saved.find(s => s.id === 'codex-preserved').cliStates.zcode.cliSessionId, null);
      assert.equal(fs.readFileSync(historyFile, 'utf8'), history);
      await stop();
    }
    console.log('PASS ZCode isolated boot: persisted marker repair, valid identities/history preserved, repeat startup');
  } catch (error) { console.error(output); throw error; }
  finally { await stop(); fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
