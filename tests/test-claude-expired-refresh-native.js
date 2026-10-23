'use strict';

// 用真实原生策略、临时凭据文件和持久健康记录验证整个续期入口。
// CLI 是注入的假进程边界；不读取本机凭据，不访问真实账号或网络。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');

const { createClaudeOAuthRefresher, credentialFingerprint, parseCredentials } = require('../src/claude-auth/oauth-refresh');
const { createRefreshHealthStore } = require('../src/claude-auth/refresh-health');
const { createOfficialAccountStore } = require('../src/official-accounts');
const { createClaudeAccountRefreshSupervisor } = require('../src/claude-auth/accounts-refresh');

let addon;
try {
  addon = process.env.MULTICC_RUST_ADDON ? require(process.env.MULTICC_RUST_ADDON)
    : require('../src/native/runtime').getNative('claude_expired_refresh');
} catch (_) {}
const nativeReady = typeof addon?.planClaudeExpiredRefresh === 'function';
const nativeTest = (name, fn) => test(name, { skip: !nativeReady }, fn);

const T0 = 1_700_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;

function makeCredential(expiresAt) {
  return { claudeAiOauth: { accessToken: 'fake-access-1', refreshToken: 'fake-refresh-1', expiresAt } };
}

function parkedRecord(expiresAt, failureClass = 'unknown') {
  return {
    consecutiveFailures: 1,
    failureClass,
    parked: {
      at: expiresAt,
      reason: 'periodic',
      failureClass,
      consecutiveFailures: 1,
      credentialFingerprint: credentialFingerprint(parseCredentials(JSON.stringify(makeCredential(expiresAt)))),
      credentialExpiresAt: expiresAt,
    },
  };
}

function makeFixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-expired-native-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const credentialsFile = path.join(root, '.credentials.json');
  const healthKey = 'account-1';
  let clock = options.now ?? T0;
  let mode = options.mode || 'decline';
  let health = createRefreshHealthStore({ root });
  const calls = [];
  const expiresAt = options.expiresAt ?? T0 + 4 * MIN;
  fs.writeFileSync(credentialsFile, JSON.stringify(makeCredential(expiresAt)));
  if (options.parked) health.write(healthKey, parkedRecord(expiresAt, options.parked));
  const readRecord = () => {
    try { return JSON.parse(fs.readFileSync(path.join(root, 'refresh-health', `${healthKey}.json`), 'utf8')); }
    catch (_) { return null; }
  };
  const readCredential = () => JSON.parse(fs.readFileSync(credentialsFile, 'utf8'));
  const rotate = () => {
    const credential = readCredential();
    credential.claudeAiOauth = {
      ...credential.claudeAiOauth,
      accessToken: 'fake-access-rotated',
      refreshToken: 'fake-refresh-rotated',
      expiresAt: clock + 8 * HOUR,
    };
    fs.writeFileSync(credentialsFile, JSON.stringify(credential));
  };
  const run = async (file, args) => {
    assert.equal(file, '/fake/claude');
    calls.push({ args, at: clock });
    if (args[0] === 'auth') {
      return { code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: 'oauth_token' }), stderr: '' };
    }
    assert.equal(args[0], '-p');
    if (readCredential().claudeAiOauth.expiresAt <= clock) {
      const reservation = readRecord()?.postExpiryAttempt;
      assert.equal(reservation?.credentialExpiresAt, readCredential().claudeAiOauth.expiresAt,
        '每次到期后探测启动前，首次尝试标记必须已经落盘');
      assert.ok(reservation.reservedAt <= clock);
    }
    if (options.onProbe) await options.onProbe({ readRecord, readCredential, rotate, now: () => clock });
    if (mode === 'throw') throw new Error('模拟预留落盘后进程异常');
    if (mode === 'rotate') rotate();
    return {
      code: ['network', 'fail', 'revoked', 'rejected'].includes(mode) ? 1 : 0,
      stdout: '',
      stderr: mode === 'network' ? 'getaddrinfo ENOTFOUND api.anthropic.com'
        : mode === 'fail' ? 'temporary failure'
          : mode === 'revoked' ? 'OAuth token revoked'
            : mode === 'rejected' ? 'invalid_grant' : '',
    };
  };
  const build = (healthOverride = health) => createClaudeOAuthRefresher({
    platform: 'linux',
    claudeBin: '/fake/claude',
    credentialsFile,
    now: () => clock,
    run,
    health: healthOverride,
    healthKey,
    probeThresholdMs: 5 * MIN,
    cooldownMs: 0,
    deferCooldownMs: 0,
    buildEnv: () => ({}),
    isEnabled: () => true,
  });
  let refresher = build();
  return {
    get refresher() { return refresher; },
    root, credentialsFile, healthKey, calls, readRecord, readCredential,
    probes: () => calls.filter(call => call.args[0] === '-p'),
    setTime: value => { clock = value; },
    setMode: value => { mode = value; },
    writeCredential: value => fs.writeFileSync(credentialsFile, JSON.stringify(value)),
    restart: healthOverride => {
      health = createRefreshHealthStore({ root });
      refresher = build(healthOverride || health);
      return refresher;
    },
  };
}

for (const earlyMode of ['decline', 'network']) {
  nativeTest(earlyMode === 'decline'
    ? '到期前两次成功但未续期，到期后仍实际探测并写入新凭据'
    : '到期前两次网络失败不耗掉到期后的续期机会', async t => {
    const expiresAt = T0 + 4 * MIN;
    const h = makeFixture(t, { expiresAt, mode: earlyMode });
    await h.refresher.check();
    h.setTime(T0 + MIN);
    await h.refresher.check();
    assert.equal(h.probes().length, 2);
    assert.equal(h.readCredential().claudeAiOauth.expiresAt, expiresAt);
    assert.equal(h.readRecord()?.postExpiryAttempt ?? null, null, '到期前不预支到期后的机会');

    h.setTime(expiresAt);
    h.setMode('rotate');
    const result = await h.refresher.check();
    assert.equal(result.outcome, 'refreshed');
    assert.equal(h.probes().length, 3, '恰好过期时必须真正启动第三次 CLI 探测');
    assert.equal(h.readCredential().claudeAiOauth.expiresAt, expiresAt + 8 * HOUR);
  });
}

nativeTest('旧未知暂停经账号入口播种、续期、收养新凭据并清理临时槽', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-expired-supervisor-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const accounts = createOfficialAccountStore({ root });
  const { id } = accounts.createClaudeAccount({ label: 'fixture' });
  const expiresAt = T0 - MIN;
  accounts.writeClaudeCredential(id, {
    access_token: 'fake-access-1', refresh_token: 'fake-refresh-1', expired: new Date(expiresAt).toISOString(),
  });
  const health = createRefreshHealthStore({ root });
  health.write(id, parkedRecord(expiresAt));
  const slot = path.join(accounts.claudeHomeDir(id), '.credentials.json');
  const calls = [];
  const supervisor = createClaudeAccountRefreshSupervisor({
    accounts, health, platform: 'linux', claudeBin: '/fake/claude', now: () => T0,
    minCheckGapMs: 0, isEnabled: () => true,
    run: async (file, args, { env }) => {
      assert.equal(file, '/fake/claude');
      assert.equal(env.CLAUDE_CONFIG_DIR, accounts.claudeHomeDir(id));
      const seeded = JSON.parse(fs.readFileSync(slot, 'utf8'));
      assert.equal(seeded.claudeAiOauth.accessToken, 'fake-access-1');
      calls.push(args);
      if (args[0] === 'auth') return { code: 0, stdout: '{"loggedIn":true}', stderr: '' };
      const persisted = JSON.parse(fs.readFileSync(path.join(root, 'refresh-health', `${id}.json`), 'utf8'));
      assert.equal(persisted.postExpiryAttempt.credentialExpiresAt, expiresAt, '探测启动前预留已经落盘');
      fs.writeFileSync(slot, JSON.stringify({ claudeAiOauth: {
        ...seeded.claudeAiOauth,
        accessToken: 'fake-access-2', refreshToken: 'fake-refresh-2', expiresAt: T0 + 8 * HOUR,
      } }));
      return { code: 0, stdout: '', stderr: '' };
    },
  });
  t.after(() => supervisor.stop());
  const results = await Promise.all([
    supervisor.checkAccount(id, 'manual'), supervisor.checkAccount(id, 'read-miss'),
  ]);
  assert.equal(results[0].outcome, 'refreshed');
  assert.equal(results[1].outcome, 'fresh');
  assert.equal(calls.filter(args => args[0] === '-p').length, 1, '并发入口共享账号锁');
  const adopted = accounts.readClaudeCredential(id);
  assert.equal(adopted.access_token, 'fake-access-2');
  assert.equal(adopted.refresh_token, 'fake-refresh-2');
  assert.equal(Date.parse(adopted.expired), T0 + 8 * HOUR);
  assert.equal(fs.existsSync(slot), false, '收养完成后不留下临时凭据副本');
});

for (const failureClass of ['rejected', 'needs-login', 'revoked', 'token_revoked']) {
  nativeTest(`旧 ${failureClass} 暂停不触碰凭据槽也不启动 CLI`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-rejected-supervisor-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const accounts = createOfficialAccountStore({ root });
    const { id } = accounts.createClaudeAccount({ label: 'rejected-fixture' });
    const expiresAt = T0 - MIN;
    accounts.writeClaudeCredential(id, {
      access_token: 'fake-access-1', refresh_token: 'fake-refresh-1', expired: new Date(expiresAt).toISOString(),
    });
    const health = createRefreshHealthStore({ root });
    health.write(id, parkedRecord(expiresAt, failureClass));
    const calls = [];
    const supervisor = createClaudeAccountRefreshSupervisor({
      accounts, health, platform: 'darwin', claudeBin: '/fake/claude', now: () => T0,
      minCheckGapMs: 0, isEnabled: () => true,
      run: async (file, args) => {
        calls.push({ file, args });
        return { code: 1, stdout: '', stderr: '' };
      },
    });
    t.after(() => supervisor.stop());
    const result = await supervisor.checkAccount(id, 'manual');
    assert.ok(['parked', 'needs-login'].includes(result.outcome));
    assert.equal(calls.length, 0, '包括 Keychain 读写在内都不得执行');
  });
}

nativeTest('额外机会失败后重复检查和重建都不再次探测同一凭据', async t => {
  const expiresAt = T0 - MIN;
  const h = makeFixture(t, { expiresAt, parked: 'unknown', mode: 'fail' });
  await h.refresher.check();
  assert.equal(h.probes().length, 1);
  assert.equal(h.readRecord().postExpiryAttempt.credentialExpiresAt, expiresAt);
  h.setTime(T0 + HOUR);
  await h.refresher.check();
  h.restart();
  await h.refresher.check();
  assert.equal(h.probes().length, 1, '持久预留不能在重建后重新发放');
});

nativeTest('持久预留写失败时不启动到期后的额外探测', async t => {
  const h = makeFixture(t, { expiresAt: T0 - MIN, parked: 'unknown', mode: 'rotate' });
  const disk = createRefreshHealthStore({ root: h.root });
  let rejectedWrites = 0;
  const unavailable = {
    read: key => disk.read(key),
    write: (key, value) => {
      if (value.postExpiryAttempt) { rejectedWrites += 1; return false; }
      return disk.write(key, value);
    },
  };
  h.restart(unavailable);
  await h.refresher.check();
  h.setTime(T0 + HOUR);
  h.restart(unavailable);
  await h.refresher.check();
  assert.ok(rejectedWrites > 0, '必须尝试记录预留');
  assert.equal(h.probes().length, 0, '无法保证预留持久化就不得消费额外机会');
  assert.equal(h.readCredential().claudeAiOauth.expiresAt, T0 - MIN);
  assert.equal(h.readRecord()?.postExpiryAttempt ?? null, null);
});

nativeTest('预留后 CLI 异常退出，重建仍保留已消费事实', async t => {
  const expiresAt = T0 - MIN;
  const h = makeFixture(t, {
    expiresAt, parked: 'unknown', mode: 'throw',
    onProbe: ({ readRecord }) => {
      assert.equal(readRecord().postExpiryAttempt.credentialExpiresAt, expiresAt,
        '异常发生前已有可恢复的磁盘证据');
    },
  });
  await h.refresher.check();
  assert.equal(h.probes().length, 1);
  h.setMode('rotate');
  h.setTime(T0 + HOUR);
  h.restart();
  await h.refresher.check();
  assert.equal(h.probes().length, 1);
  assert.equal(h.readCredential().claudeAiOauth.expiresAt, expiresAt);
});

nativeTest('到期边界的并发请求只启动一次额外探测', async t => {
  const expiresAt = T0 + 4 * MIN;
  const h = makeFixture(t, { expiresAt });
  await h.refresher.check();
  h.setTime(T0 + MIN);
  await h.refresher.check();
  h.setTime(expiresAt - 1);
  await h.refresher.check();
  assert.equal(h.probes().length, 2, '尚差一毫秒到期不得超出原预算');
  h.setTime(expiresAt);
  h.setMode('rotate');
  const results = await Promise.all([
    h.refresher.check('periodic'),
    h.refresher.check('read-miss'),
    h.refresher.onApiError({ error: { sanitizedMessage: 'official OAuth unavailable: OAuth token expired' } }),
  ]);
  assert.ok(results.every(result => result.outcome === 'refreshed'));
  assert.equal(h.probes().length, 3);
});

nativeTest('初次发现已过期的凭据仍保留原有两次探测预算', async t => {
  const h = makeFixture(t, { expiresAt: T0 - MIN, mode: 'fail' });
  await h.refresher.check();
  h.setTime(T0 + HOUR);
  await h.refresher.check();
  assert.equal(h.probes().length, 2);
  h.setTime(T0 + 2 * HOUR);
  await h.refresher.check();
  h.restart();
  await h.refresher.check();
  assert.equal(h.probes().length, 2, '原预算耗尽后不再补发第三次');
});

nativeTest('凭据有效期更新后可以为新凭据预留新的到期续期机会', async t => {
  const h = makeFixture(t, { expiresAt: T0 - MIN, parked: 'unknown', mode: 'fail' });
  await h.refresher.check();
  assert.equal(h.probes().length, 1);
  const expiresAt = T0 + 4 * MIN;
  h.writeCredential(makeCredential(expiresAt));
  h.setMode('decline');
  await h.refresher.check();
  h.setTime(T0 + MIN);
  await h.refresher.check();
  assert.equal(h.probes().length, 3);
  h.setTime(expiresAt);
  h.setMode('rotate');
  assert.equal((await h.refresher.check()).outcome, 'refreshed');
  assert.equal(h.probes().length, 4);
});

test('原生模块不可用时强制调用也不能绕过旧凭据的拒绝暂停', t => {
  const h = makeFixture(t, { expiresAt: T0 - MIN, parked: 'rejected' });
  const script = `
    const { createClaudeOAuthRefresher } = require(process.argv[1]);
    const { createRefreshHealthStore } = require(process.argv[2]);
    let calls = 0;
    const refresher = createClaudeOAuthRefresher({
      platform: 'linux', claudeBin: '/fake/claude',
      credentialsFile: process.argv[3],
      health: createRefreshHealthStore({ root: process.argv[4] }), healthKey: 'account-1',
      now: () => ${T0}, buildEnv: () => ({}), isEnabled: () => true,
      run: async () => { calls += 1; return { code: 0, stdout: '', stderr: '' }; },
    });
    refresher.refresh({ force: true }).then(result => {
      process.stdout.write(JSON.stringify({ outcome: result.outcome, calls }));
    }).catch(() => { process.exitCode = 1; });
  `;
  const stdout = execFileSync(process.execPath, [
    '-e', script,
    require.resolve('../src/claude-auth/oauth-refresh'),
    require.resolve('../src/claude-auth/refresh-health'),
    h.credentialsFile, h.root,
  ], {
    encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, MULTICC_RUST_ADDON: path.join(h.root, 'missing-addon.node') },
  });
  const result = JSON.parse(stdout);
  assert.equal(result.outcome, 'parked');
  assert.equal(result.calls, 0, '兼容路径不能把强制检查变成对失效授权的再次请求');
});

for (const mode of ['revoked', 'rejected']) {
  nativeTest(`到期前已有 ${mode} 证据时不再探测，凭据替换后才恢复`, async t => {
    const expiresAt = T0 + 4 * MIN;
    const h = makeFixture(t, { expiresAt, mode });
    await h.refresher.check();
    assert.equal(h.probes().length, 1);
    h.setTime(T0 + MIN);
    await h.refresher.check();
    h.setTime(expiresAt);
    await h.refresher.check();
    await h.refresher.refresh({ force: true });
    h.restart();
    await h.refresher.check();
    assert.equal(h.probes().length, 1, '明确失效证据跨到期和重建均有效');
    assert.equal(h.readCredential().claudeAiOauth.expiresAt, expiresAt);

    h.writeCredential(makeCredential(expiresAt + MIN));
    h.setMode('rotate');
    const recovered = await h.refresher.check();
    assert.equal(recovered.outcome, 'refreshed');
    assert.equal(h.probes().length, 2, '旧凭据的拒绝证据不阻止新凭据续期');
    assert.equal(h.readCredential().claudeAiOauth.expiresAt, expiresAt + 8 * HOUR);
  });
}
