'use strict';

// 常驻 `-p` 进程的环境在 spawn 时固定。保险箱条目会话中途新增/修改/删除后，
// chat-stream 要在回合边界回收重启（respawn 用 --resume 保留上下文）：
//   1. 保险箱没变 → 绝不重启；
//   2. 变了且空闲 → 下个回合换新进程，新进程环境里带着最新值；
//   3. 后台任务活跃 → 顺延，回合照常跑（不能像路由变化那样拒绝回合），后台结束后再换。
// 保险箱落在隔离的 MULTICC_DATA_DIR，绝不碰真实 secrets.json。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-vault-recycle-'));
process.env.MULTICC_DATA_DIR = path.join(tmp, 'data');
fs.mkdirSync(process.env.MULTICC_DATA_DIR);
const { assertTestDir } = require('../src/paths');
assertTestDir(process.env.MULTICC_DATA_DIR);
const vault = require('../src/native/binding').secretsVault;
const stream = require('../src/chat/chat-stream');

const spawnLog = path.join(tmp, 'spawns.jsonl');
// 假 CLI：启动时记下 pid 和 VAULT_PROBE，之后对每行 stdin 回一个 result。
const fakeCli = [
  "const fs=require('fs')",
  "fs.appendFileSync(process.env.SPAWN_LOG, JSON.stringify({pid:process.pid,probe:process.env.VAULT_PROBE||null})+'\\n')",
  "let buf=''",
  "process.stdin.on('data', c => {",
  "  buf += c.toString()",
  "  while (buf.includes('\\n')) {",
  "    const i=buf.indexOf('\\n'); buf=buf.slice(i+1)",
  "    setTimeout(() => process.stdout.write(JSON.stringify({type:'result', result:'ok'})+'\\n'), 40)",
  "  }",
  "})",
  "process.stdin.on('end', () => process.exit(0))",
].join(';');

let bgActive = false;
const name = 'vault-recycle';

// 模拟 turn-engine：每个回合重建 env 并叠加保险箱，再 ensure。
function ensureTurn() {
  stream.ensure(name, {
    cmd: process.execPath,
    cwd: process.cwd(),
    sessionId: 'vault-recycle-session',
    baseArgs: ['-e', fakeCli, '--'],
    env: vault.applyEnvOverlay({ PATH: process.env.PATH, SPAWN_LOG: spawnLog }),
    isBackgroundActive: () => bgActive,
    resume: false,
  });
}
async function turn(text) { ensureTurn(); return stream.send(name, text, () => {}); }

const readSpawns = () => {
  const raw = fs.existsSync(spawnLog) ? fs.readFileSync(spawnLog, 'utf8').trim() : '';
  return raw ? raw.split('\n').map(JSON.parse) : [];
};

(async () => {
  vault._resetForTests();

  // ── 1. 保险箱没变：多个回合同一个进程 ───────────────────────────────────
  vault.upsert({ name: 'VAULT_PROBE', value: 'v1' });
  await turn('turn-1');
  const pid1 = stream.status(name).pid;
  assert.strictEqual(readSpawns()[0].probe, 'v1', 'existing entry is in the child env at spawn');
  await turn('turn-2');
  await turn('turn-3');
  assert.strictEqual(readSpawns().length, 1, 'unchanged vault → no respawn');
  assert.strictEqual(stream.status(name).pid, pid1);

  // ── 2. 中途改值：下个回合换新进程并带上新值 ─────────────────────────────
  vault.upsert({ name: 'VAULT_PROBE', value: 'v2' });
  await turn('turn-4');
  assert.strictEqual(readSpawns().length, 2, 'changed value → recycled at the boundary');
  assert.notStrictEqual(stream.status(name).pid, pid1);
  assert.strictEqual(readSpawns()[1].probe, 'v2', 'new child sees the new value');
  assert.strictEqual(stream.status(name).recycleRequested, false, 'request consumed');

  // ── 3. 后台任务活跃：顺延，回合照常跑；结束后再换 ───────────────────────
  const pid2 = stream.status(name).pid;
  bgActive = true;
  vault.upsert({ name: 'VAULT_PROBE', value: 'v3' });
  await turn('turn-5');
  assert.strictEqual(stream.status(name).pid, pid2, 'live background work keeps its process');
  assert.strictEqual(readSpawns().length, 2);
  assert.strictEqual(stream.status(name).recycleRequested, true, 'still pending');
  bgActive = false;
  await turn('turn-6');
  assert.strictEqual(readSpawns().length, 3, 'applied once the background work clears');
  assert.strictEqual(readSpawns()[2].probe, 'v3');

  // ── 4. 删除：新进程里没有这个变量 ───────────────────────────────────────
  vault.remove('VAULT_PROBE');
  await turn('turn-7');
  assert.strictEqual(readSpawns().length, 4);
  assert.strictEqual(readSpawns()[3].probe, null, 'removed entry is gone from the new child');

  console.log('chat-stream vault-recycle tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  stream.close(name);
  vault._resetForTests();
  fs.rmSync(tmp, { recursive: true, force: true });
});
