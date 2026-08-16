'use strict';

// Regression tests for the tunnel restart UX fix:
//   • a failed restart surfaces its root cause (never a bare tunnel_restart_failed)
//   • failed restarts never count toward restartTimes / hourly caps
//   • monitorOnly providers probe but never restart
//   • surfaced error text is redacted (authtoken can never leave the server)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createTunnelRestartHandler,
  normalizeTunnelUpdate,
} = require('../src/routes/host-write');

function withFreshTunnel(fn) {
  return async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-tunnel-semantics-'));
    const previousDataDir = process.env.MULTICC_DATA_DIR;
    const modulePath = require.resolve('../src/tunnel');
    process.env.MULTICC_DATA_DIR = dataDir;
    delete require.cache[modulePath];
    let tunnel;
    try {
      tunnel = require('../src/tunnel');
      await fn(tunnel, dataDir);
    } finally {
      if (tunnel) tunnel.stop();
      delete require.cache[modulePath];
      if (previousDataDir === undefined) delete process.env.MULTICC_DATA_DIR;
      else process.env.MULTICC_DATA_DIR = previousDataDir;
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  };
}

function withPreloadedLedger(contents, fn) {
  return async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-tunnel-ledger-preload-'));
    const previousDataDir = process.env.MULTICC_DATA_DIR;
    const modulePath = require.resolve('../src/tunnel');
    process.env.MULTICC_DATA_DIR = dataDir;
    fs.writeFileSync(
      path.join(dataDir, 'tunnel-repair-ledger.json'),
      typeof contents === 'string' ? contents : JSON.stringify(contents),
    );
    delete require.cache[modulePath];
    let tunnel;
    try {
      tunnel = require('../src/tunnel');
      await fn(tunnel);
    } finally {
      if (tunnel) tunnel.stop();
      delete require.cache[modulePath];
      if (previousDataDir === undefined) delete process.env.MULTICC_DATA_DIR;
      else process.env.MULTICC_DATA_DIR = previousDataDir;
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  };
}

function confirmedFunnelFailure(overrides = {}) {
  return {
    mode: 'tailscale_funnel_public',
    verdict: 'unhealthy',
    healthy: false,
    repairEligible: true,
    error: 'public_data_plane_down',
    httpCode: 0,
    originHttpCode: 200,
    publicUrl: 'https://node-a.example-tail.ts.net/',
    resolvedAddressCount: 3,
    edgeSuccessCount: 0,
    ...overrides,
  };
}

test('failed manual restart returns the root cause and does not count', withFreshTunnel(async tunnel => {
  const before = tunnel.getStatus().providers.sakurafrp.restartTimes.length;
  const result = await tunnel.restartNow('sakurafrp', {
    restarter: async () => { throw new Error('sakurafrp 未安装, 请先安装其客户端'); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'restart_failed');
  assert.equal(result.message, 'sakurafrp 未安装, 请先安装其客户端');
  const provider = tunnel.getStatus().providers.sakurafrp;
  assert.equal(provider.restartTimes.length, before, 'failed restart must not count');
  assert.match(provider.lastAction, /重启失败: sakurafrp 未安装/);
}));

test('successful manual restart counts exactly once', withFreshTunnel(async tunnel => {
  const before = tunnel.getStatus().providers.sakurafrp.restartTimes.length;
  const result = await tunnel.restartNow('sakurafrp', { restarter: async () => '已后台启动' });
  assert.deepEqual(result, { ok: true, message: '已后台启动' });
  assert.equal(tunnel.getStatus().providers.sakurafrp.restartTimes.length, before + 1);
}));

test('real sakurafrp restart without an installed client reports the install hint', withFreshTunnel(async tunnel => {
  if (tunnel.getStatus().availability.sakurafrp) return; // frpc present → skip, never launch it
  const before = tunnel.getStatus().providers.sakurafrp.restartTimes.length;
  const result = await tunnel.restartNow('sakurafrp');
  assert.equal(result.ok, false);
  assert.match(result.message || '', /未安装/);
  assert.equal(tunnel.getStatus().providers.sakurafrp.restartTimes.length, before);
}));

test('restart failure text never leaks the configured authtoken', withFreshTunnel(async tunnel => {
  tunnel.applyConfig({ sakurafrp: { authtoken: 'sf-top-secret' } });
  const result = await tunnel.restartNow('sakurafrp', {
    restarter: async () => {
      const error = new Error('后台启动失败');
      error.cause = "Command failed: /bin/bash -c nohup frpc -f 'sf-top-secret'";
      throw error;
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.message.includes('sf-top-secret'), false, 'authtoken leaked');
  assert.match(result.message, /\*\*\*/);
  assert.equal(JSON.stringify(tunnel.getStatus().providers.sakurafrp).includes('sf-top-secret'), false);
}));

test('monitorOnly probes but never calls the restarter', withFreshTunnel(async tunnel => {
  tunnel.applyConfig({
    failThreshold: 1,
    sakurafrp: { enabled: true, monitorOnly: true, url: 'https://tunnel.example.test/' },
  });
  let restartCalls = 0;
  await tunnel.checkProvider('sakurafrp', {
    probeFn: async () => 0,
    restarter: async () => { restartCalls++; return 'restarted'; },
  });
  assert.equal(restartCalls, 0, 'monitorOnly must never restart');
  const provider = tunnel.getStatus().providers.sakurafrp;
  assert.equal(provider.healthy, false);
  assert.match(provider.lastAction, /仅监控/);
  assert.equal(provider.restartTimes.length, 0);
}));

test('tick auto-restart failure does not count and records the root cause', withFreshTunnel(async tunnel => {
  tunnel.applyConfig({
    failThreshold: 1,
    sakurafrp: { enabled: true, url: 'https://tunnel.example.test/' },
  });
  await tunnel.checkProvider('sakurafrp', {
    probeFn: async () => 0,
    restarter: async () => { throw new Error('sakurafrp 未安装, 请先安装其客户端'); },
  });
  const provider = tunnel.getStatus().providers.sakurafrp;
  assert.equal(provider.restartTimes.length, 0, 'failed auto-restart must not count');
  assert.match(provider.lastAction, /重启失败: sakurafrp 未安装/);

  // A subsequent successful restart is counted.
  await tunnel.checkProvider('sakurafrp', {
    probeFn: async () => 0,
    restarter: async () => '已后台启动',
  });
  assert.equal(tunnel.getStatus().providers.sakurafrp.restartTimes.length, 1);
}));

test('HTTP 302 probes healthy so no restart is attempted', withFreshTunnel(async tunnel => {
  tunnel.applyConfig({
    failThreshold: 1,
    sakurafrp: { enabled: true, url: 'https://tunnel.example.test/' },
  });
  let restartCalls = 0;
  await tunnel.checkProvider('sakurafrp', {
    probeFn: async () => 302,
    restarter: async () => { restartCalls++; return 'restarted'; },
  });
  assert.equal(restartCalls, 0);
  const provider = tunnel.getStatus().providers.sakurafrp;
  assert.equal(provider.healthy, true);
  assert.equal(provider.lastHttpCode, 302);
}));

test('Tailscale control reconnect and Funnel reapply are separate exact commands', withFreshTunnel(async tunnel => {
  const commands = [];
  const run = async (command, args) => {
    commands.push([command, args]);
    return { ok: true, stdout: '', stderr: '' };
  };
  const message = await tunnel.reapplyTailscaleFunnel({
    run,
    funnelConfig: { funnel: true, funnelPort: 3000 },
  });
  assert.match(message, /重新应用 Tailscale Funnel/);
  assert.deepEqual(commands, [['/usr/local/bin/tailscale', ['funnel', '--bg', '3000']]]);
  assert.equal(JSON.stringify(commands).includes('reset'), false);
  assert.equal(JSON.stringify(commands).includes('"up"'), false);

  commands.length = 0;
  await tunnel.restartTailscale({ run });
  assert.deepEqual(commands, [['/usr/local/bin/tailscale', ['up']]]);
}));

test('three confirmed Funnel edge failures reapply once and persist the attempt guard', withFreshTunnel(async (tunnel, dataDir) => {
  tunnel.applyConfig({
    failThreshold: 1,
    tailscale: { enabled: true, monitorOnly: false, funnel: true, funnelPort: 3000, url: 'http://stale.invalid' },
  });
  let repairs = 0;
  const restarter = async () => { repairs++; return '已重新应用 Tailscale Funnel，等待公网复检'; };
  for (let i = 0; i < 2; i++) {
    await tunnel.checkProvider('tailscale', { probeFn: async () => confirmedFunnelFailure(), restarter });
  }
  assert.equal(repairs, 0, 'Funnel has a hard minimum of three definitive failures');
  await tunnel.checkProvider('tailscale', { probeFn: async () => confirmedFunnelFailure(), restarter });
  assert.equal(repairs, 1);
  let provider = tunnel.getStatus().providers.tailscale;
  assert.equal(provider.restartTimes.length, 1);
  assert.equal(provider.repairGuard.attemptsLastHour, 1);
  const ledger = JSON.parse(fs.readFileSync(path.join(dataDir, 'tunnel-repair-ledger.json'), 'utf8'));
  assert.equal(ledger.tailscaleFunnel.attempts.length, 1);
  assert.equal(ledger.tailscaleFunnel.attempts[0].outcome, 'command_succeeded');

  for (let i = 0; i < 3; i++) {
    await tunnel.checkProvider('tailscale', { probeFn: async () => confirmedFunnelFailure(), restarter });
  }
  provider = tunnel.getStatus().providers.tailscale;
  assert.equal(repairs, 1, 'persisted cooldown suppresses the next fully confirmed repair round');
  assert.match(provider.lastAction, /等待冷却/);
}));

test('failed Funnel command consumes the persistent attempt guard but not restartTimes', withFreshTunnel(async tunnel => {
  tunnel.applyConfig({
    failThreshold: 1,
    tailscale: { enabled: true, monitorOnly: false, funnel: true, funnelPort: 3000, url: '' },
  });
  let repairs = 0;
  const restarter = async () => { repairs++; throw new Error('permission secret=/private/path'); };
  for (let i = 0; i < 3; i++) {
    await tunnel.checkProvider('tailscale', { probeFn: async () => confirmedFunnelFailure(), restarter });
  }
  assert.equal(repairs, 1);
  assert.equal(tunnel.getStatus().providers.tailscale.restartTimes.length, 0);
  await tunnel.checkProvider('tailscale', { probeFn: async () => confirmedFunnelFailure(), restarter });
  const provider = tunnel.getStatus().providers.tailscale;
  assert.equal(repairs, 1, 'failed command is still throttled');
  assert.equal(JSON.stringify(provider).includes('/private/path'), false);
  assert.equal(JSON.stringify(provider).includes('permission secret'), false);
}));

test('Funnel uncertainty, non-repairable failures, and monitorOnly never reapply', withFreshTunnel(async tunnel => {
  tunnel.applyConfig({
    failThreshold: 1,
    tailscale: { enabled: true, monitorOnly: false, funnel: true, funnelPort: 3000, url: '' },
  });
  let repairs = 0;
  const restarter = async () => { repairs++; return 'unexpected'; };
  for (let i = 0; i < 4; i++) {
    await tunnel.checkProvider('tailscale', {
      probeFn: async () => confirmedFunnelFailure({
        verdict: 'indeterminate', repairEligible: false, error: 'doh_unreachable',
      }),
      restarter,
    });
  }
  assert.equal(repairs, 0);
  assert.equal(tunnel.getStatus().providers.tailscale.consecutiveFails, 0);

  for (let i = 0; i < 3; i++) {
    await tunnel.checkProvider('tailscale', {
      probeFn: async () => confirmedFunnelFailure({ repairEligible: false, error: 'local_origin_down' }),
      restarter,
    });
  }
  assert.equal(repairs, 0);
  assert.match(tunnel.getStatus().providers.tailscale.lastAction, /不满足自动修复条件/);

  tunnel.applyConfig({ tailscale: { monitorOnly: true } });
  for (let i = 0; i < 3; i++) {
    await tunnel.checkProvider('tailscale', { probeFn: async () => confirmedFunnelFailure(), restarter });
  }
  assert.equal(repairs, 0);
  assert.match(tunnel.getStatus().providers.tailscale.lastAction, /仅监控/);
}));

test('only three fresh consecutive public transport failures can build repair evidence', withFreshTunnel(async tunnel => {
  tunnel.applyConfig({
    failThreshold: 1,
    tailscale: { enabled: true, monitorOnly: false, funnel: true, funnelPort: 3000, url: '' },
  });
  let repairs = 0;
  const restarter = async () => { repairs++; return 'reapplied'; };
  for (let i = 0; i < 2; i++) {
    await tunnel.checkProvider('tailscale', { probeFn: async () => confirmedFunnelFailure(), restarter });
  }
  assert.equal(tunnel.getStatus().providers.tailscale.repairableFailStreak, 2);
  await tunnel.checkProvider('tailscale', {
    probeFn: async () => confirmedFunnelFailure({
      verdict: 'indeterminate', repairEligible: false, error: 'doh_unreachable',
    }),
    restarter,
  });
  assert.equal(tunnel.getStatus().providers.tailscale.repairableFailStreak, 0);
  await tunnel.checkProvider('tailscale', { probeFn: async () => confirmedFunnelFailure(), restarter });
  await tunnel.checkProvider('tailscale', {
    probeFn: async () => confirmedFunnelFailure({ repairEligible: false, error: 'local_origin_down' }),
    restarter,
  });
  assert.equal(tunnel.getStatus().providers.tailscale.repairableFailStreak, 0);
  for (let i = 0; i < 2; i++) {
    await tunnel.checkProvider('tailscale', { probeFn: async () => confirmedFunnelFailure(), restarter });
  }
  assert.equal(repairs, 0);
  await tunnel.checkProvider('tailscale', { probeFn: async () => confirmedFunnelFailure(), restarter });
  assert.equal(repairs, 1);
  assert.equal(tunnel.getStatus().providers.tailscale.repairableFailStreak, 0);
}));

test('degraded edges and disabled auto repair stay read-only and clear evidence', withFreshTunnel(async tunnel => {
  tunnel.applyConfig({
    failThreshold: 1,
    tailscale: { enabled: false, monitorOnly: false, funnel: true, funnelPort: 3000, url: '' },
  });
  assert.equal(tunnel.getStatus().monitorRunning, true, 'active Funnel remains observable');
  let repairs = 0;
  const restarter = async () => { repairs++; return 'unexpected'; };
  for (let i = 0; i < 3; i++) {
    await tunnel.checkProvider('tailscale', { probeFn: async () => confirmedFunnelFailure(), restarter });
  }
  assert.equal(repairs, 0);
  assert.match(tunnel.getStatus().providers.tailscale.lastAction, /仅观察/);

  tunnel.applyConfig({ tailscale: { enabled: true } });
  await tunnel.checkProvider('tailscale', {
    probeFn: async () => confirmedFunnelFailure({
      verdict: 'degraded', repairEligible: false, error: 'partial_edge_failure', edgeSuccessCount: 1,
    }),
    restarter,
  });
  const state = tunnel.getStatus().providers.tailscale;
  assert.equal(state.repairableFailStreak, 0);
  assert.match(state.lastAction, /部分可用/);
}));

test('user Funnel mutation is serialized after an already-started automatic command', withFreshTunnel(async tunnel => {
  tunnel.applyConfig({
    failThreshold: 1,
    tailscale: { enabled: true, monitorOnly: false, funnel: true, funnelPort: 3000, url: '' },
  });
  const order = [];
  let signalStarted;
  const started = new Promise(resolve => { signalStarted = resolve; });
  let releaseAuto;
  const autoGate = new Promise(resolve => { releaseAuto = resolve; });
  const restarter = async () => {
    order.push('auto-3000-start');
    signalStarted();
    await autoGate;
    order.push('auto-3000-end');
    return 'stale-auto-success';
  };
  for (let i = 0; i < 2; i++) {
    await tunnel.checkProvider('tailscale', { probeFn: async () => confirmedFunnelFailure(), restarter });
  }
  const automatic = tunnel.checkProvider('tailscale', {
    probeFn: async () => confirmedFunnelFailure(), restarter,
  });
  await started;
  const userMutation = tunnel.setFunnel(true, 4000, {
    run: async (_command, args) => {
      order.push(args.join(' '));
      return { ok: true, stdout: '', stderr: '' };
    },
  });
  releaseAuto();
  await Promise.all([automatic, userMutation]);
  assert.deepEqual(order, ['auto-3000-start', 'auto-3000-end', 'funnel --bg 4000']);
  assert.equal(tunnel.getStatus().config.tailscale.funnelPort, 4000);
  assert.notEqual(tunnel.getStatus().providers.tailscale.lastAction, 'stale-auto-success');
}));

test('failure evidence accumulated while a user mutation is queued is discarded on commit', withFreshTunnel(async tunnel => {
  tunnel.applyConfig({
    failThreshold: 1,
    tailscale: { enabled: true, monitorOnly: false, funnel: true, funnelPort: 3000, url: '' },
  });
  let signalManualStarted;
  const manualStarted = new Promise(resolve => { signalManualStarted = resolve; });
  let releaseManual;
  const manualGate = new Promise(resolve => { releaseManual = resolve; });
  const manual = tunnel.restartNow('tailscale', {
    restarter: async () => {
      signalManualStarted();
      await manualGate;
      return 'manual-up-complete';
    },
  });
  await manualStarted;
  const mutation = tunnel.setFunnel(true, 4000, {
    run: async () => ({ ok: true, stdout: '', stderr: '' }),
  });
  for (let i = 0; i < 2; i++) {
    await tunnel.checkProvider('tailscale', { probeFn: async () => confirmedFunnelFailure() });
  }
  assert.equal(tunnel.getStatus().providers.tailscale.repairableFailStreak, 2);
  releaseManual();
  await Promise.all([manual, mutation]);
  assert.equal(tunnel.getStatus().config.tailscale.funnelPort, 4000);
  assert.equal(tunnel.getStatus().providers.tailscale.repairableFailStreak, 0);

  let repairs = 0;
  const restarter = async () => { repairs++; return 'new-port-reapplied'; };
  await tunnel.checkProvider('tailscale', { probeFn: async () => confirmedFunnelFailure(), restarter });
  assert.equal(repairs, 0, 'one failure after the user commit cannot borrow old evidence');
  for (let i = 0; i < 2; i++) {
    await tunnel.checkProvider('tailscale', { probeFn: async () => confirmedFunnelFailure(), restarter });
  }
  assert.equal(repairs, 1);
}));

test('successful Funnel mutations discard the old public probe snapshot', withFreshTunnel(async tunnel => {
  tunnel.applyConfig({
    tailscale: { enabled: true, monitorOnly: false, funnel: true, funnelPort: 3000, url: '' },
  });
  await tunnel.restartNow('tailscale', { restarter: async () => 'manual-up-complete' });
  await tunnel.checkProvider('tailscale', {
    probeFn: async () => confirmedFunnelFailure({
      verdict: 'healthy', healthy: true, repairEligible: false, error: '',
      httpCode: 200, edgeSuccessCount: 3,
    }),
  });
  const before = tunnel.getStatus().providers.tailscale;
  assert.equal(before.publicUrl, 'https://node-a.example-tail.ts.net/');
  assert.equal(before.edgeSuccessCount, 3);
  assert.equal(before.restartTimes.length, 1);

  const result = await tunnel.setFunnel(false, 3000, {
    run: async () => ({ ok: true, stdout: '', stderr: '' }),
  });
  assert.equal(result.ok, true);
  const after = tunnel.getStatus().providers.tailscale;
  assert.equal(tunnel.getStatus().config.tailscale.funnel, false);
  assert.equal(after.lastCheckAt, 0);
  assert.equal(after.healthy, null);
  assert.equal(after.probeMode, 'url');
  assert.equal(after.probeVerdict, 'unknown');
  assert.equal(after.publicUrl, '');
  assert.equal(after.originHttpCode, null);
  assert.equal(after.resolvedAddressCount, 0);
  assert.equal(after.edgeSuccessCount, 0);
  assert.equal(after.lastAction, '');
  assert.equal(after.restartTimes.length, 1, 'historical action count remains observable');
}));

test('settings changes that replace the Tailscale probe target clear stale results', withFreshTunnel(async tunnel => {
  tunnel.applyConfig({
    tailscale: { enabled: true, monitorOnly: false, funnel: true, funnelPort: 3000, url: '' },
  });
  await tunnel.checkProvider('tailscale', {
    probeFn: async () => confirmedFunnelFailure({
      verdict: 'healthy', healthy: true, repairEligible: false, error: '',
      httpCode: 200, edgeSuccessCount: 3,
    }),
  });
  assert.notEqual(tunnel.getStatus().providers.tailscale.lastCheckAt, 0);

  tunnel.applyConfig({ tailscale: { funnelPort: 4000 } });
  const after = tunnel.getStatus().providers.tailscale;
  assert.equal(after.lastCheckAt, 0);
  assert.equal(after.publicUrl, '');
  assert.equal(after.healthy, null);
}));

test('corrupt persisted guardrails sanitize fail-closed before monitoring', withFreshTunnel(async (tunnel, dataDir) => {
  fs.writeFileSync(path.join(dataDir, 'tunnel-config.json'), JSON.stringify({
    intervalSec: 'bad', failThreshold: 'bad', restartCooldownSec: -9, maxRestartsPerHour: 0,
    tailscale: {
      enabled: true, monitorOnly: 'bad', funnel: true, funnelPort: 3000,
    },
  }));
  const config = tunnel.loadConfig();
  assert.equal(config.intervalSec, 30);
  assert.equal(config.failThreshold, 2);
  assert.equal(config.restartCooldownSec, 120);
  assert.equal(config.maxRestartsPerHour, 5);
  assert.equal(config.tailscale.monitorOnly, true);
  let repairs = 0;
  for (let i = 0; i < 4; i++) {
    await tunnel.checkProvider('tailscale', {
      probeFn: async () => confirmedFunnelFailure(),
      restarter: async () => { repairs++; return 'unexpected'; },
    });
  }
  assert.equal(repairs, 0);
}));

test('stop or config change invalidates an in-flight Funnel repair decision', withFreshTunnel(async tunnel => {
  tunnel.applyConfig({
    failThreshold: 1,
    tailscale: { enabled: true, monitorOnly: false, funnel: true, funnelPort: 3000, url: '' },
  });
  let resolveProbe;
  let repairs = 0;
  const pending = tunnel.checkProvider('tailscale', {
    probeFn: () => new Promise(resolve => { resolveProbe = resolve; }),
    restarter: async () => { repairs++; return 'unexpected'; },
  });
  tunnel.stop();
  resolveProbe(confirmedFunnelFailure());
  await pending;
  assert.equal(repairs, 0);
  assert.equal(tunnel.getStatus().providers.tailscale.consecutiveFails, 0);

  tunnel.init();
  let resolveSecond;
  const second = tunnel.checkProvider('tailscale', {
    probeFn: () => new Promise(resolve => { resolveSecond = resolve; }),
    restarter: async () => { repairs++; return 'unexpected'; },
  });
  tunnel.applyConfig({ tailscale: { monitorOnly: true } });
  resolveSecond(confirmedFunnelFailure());
  await second;
  assert.equal(repairs, 0);
}));

test('Funnel runtime status remains bounded and redacts unknown probe errors', withFreshTunnel(async tunnel => {
  tunnel.applyConfig({
    failThreshold: 100,
    tailscale: { enabled: true, funnel: true, funnelPort: 3000, url: '' },
  });
  await tunnel.checkProvider('tailscale', {
    probeFn: async () => confirmedFunnelFailure({
      error: 'token=top-secret /Users/private/path',
      publicUrl: `https://${'x'.repeat(600)}.ts.net/`,
      resolvedAddressCount: 5000,
    }),
  });
  const provider = tunnel.getStatus().providers.tailscale;
  assert.equal(provider.probeError, 'probe_failed');
  assert.equal(provider.publicUrl, '');
  assert.equal(provider.resolvedAddressCount, 32);
  assert.equal(JSON.stringify(provider).includes('top-secret'), false);
  for (const legacy of ['lastCheckAt', 'lastHttpCode', 'healthy', 'consecutiveFails', 'restartTimes', 'lastRestartAt', 'lastAction', 'checking']) {
    assert.equal(Object.hasOwn(provider, legacy), true, legacy);
  }
}));

test('runtime restart history is pruned to the advertised one-hour bounded window', withFreshTunnel(async tunnel => {
  const exposed = tunnel.getStatus().providers.tailscale.restartTimes;
  exposed.push(Date.now() - 2 * 3600 * 1000);
  for (let i = 0; i < 120; i++) exposed.push(Date.now() - i);
  const pruned = tunnel.getStatus().providers.tailscale.restartTimes;
  assert.equal(pruned.some(at => Date.now() - at >= 3600 * 1000), false);
  assert.equal(pruned.length, 100);
}));

test('persistent Funnel repair cooldown survives a module reload', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-tunnel-ledger-reload-'));
  const previousDataDir = process.env.MULTICC_DATA_DIR;
  const modulePath = require.resolve('../src/tunnel');
  process.env.MULTICC_DATA_DIR = dataDir;
  let first;
  let second;
  try {
    delete require.cache[modulePath];
    first = require('../src/tunnel');
    first.applyConfig({
      failThreshold: 1,
      tailscale: { enabled: true, monitorOnly: false, funnel: true, funnelPort: 3000, url: '' },
    });
    for (let i = 0; i < 3; i++) {
      await first.checkProvider('tailscale', {
        probeFn: async () => confirmedFunnelFailure(), restarter: async () => 'first repair',
      });
    }
    first.stop();
    delete require.cache[modulePath];
    second = require('../src/tunnel');
    second.loadConfig();
    let secondRepairs = 0;
    for (let i = 0; i < 3; i++) {
      await second.checkProvider('tailscale', {
        probeFn: async () => confirmedFunnelFailure(),
        restarter: async () => { secondRepairs++; return 'unexpected'; },
      });
    }
    assert.equal(secondRepairs, 0);
    assert.equal(second.getStatus().providers.tailscale.repairGuard.attemptsLastHour, 1);
    assert.match(second.getStatus().providers.tailscale.lastAction, /等待冷却/);
  } finally {
    if (first) first.stop();
    if (second) second.stop();
    delete require.cache[modulePath];
    if (previousDataDir === undefined) delete process.env.MULTICC_DATA_DIR;
    else process.env.MULTICC_DATA_DIR = previousDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

for (const [label, contents] of [
  ['invalid JSON', '{invalid'],
  ['semantically corrupt item', { version: 1, tailscaleFunnel: { attempts: [{ at: 'bad', outcome: 'pending' }] } }],
]) {
  test(`${label} repair ledger disables automatic commands fail-closed`, withPreloadedLedger(contents, async tunnel => {
    tunnel.applyConfig({
      failThreshold: 1,
      tailscale: { enabled: true, monitorOnly: false, funnel: true, funnelPort: 3000, url: '' },
    });
    let repairs = 0;
    for (let i = 0; i < 3; i++) {
      await tunnel.checkProvider('tailscale', {
        probeFn: async () => confirmedFunnelFailure(),
        restarter: async () => { repairs++; return 'unexpected'; },
      });
    }
    assert.equal(repairs, 0);
    assert.equal(tunnel.getStatus().providers.tailscale.repairGuard.ledgerHealthy, false);
    assert.match(tunnel.getStatus().providers.tailscale.lastAction, /账本不可用/);
  }));
}

test('future repair evidence survives clock rollback and suppresses a new command', withPreloadedLedger({
  version: 1,
  tailscaleFunnel: {
    attempts: [{ at: Date.now() + 3600 * 1000, outcome: 'command_succeeded' }],
  },
}, async tunnel => {
  tunnel.applyConfig({
    failThreshold: 1,
    tailscale: { enabled: true, monitorOnly: false, funnel: true, funnelPort: 3000, url: '' },
  });
  let repairs = 0;
  for (let i = 0; i < 3; i++) {
    await tunnel.checkProvider('tailscale', {
      probeFn: async () => confirmedFunnelFailure(),
      restarter: async () => { repairs++; return 'unexpected'; },
    });
  }
  assert.equal(repairs, 0);
  assert.equal(tunnel.getStatus().providers.tailscale.repairGuard.ledgerHealthy, true);
  assert.match(tunnel.getStatus().providers.tailscale.lastAction, /等待冷却/);
}));

test('restart route passes the redacted message through but keeps the stable error code', async () => {
  const handler = createTunnelRestartHandler({
    tunnel: { restartNow: async () => ({ ok: false, error: 'restart_failed', message: 'sakurafrp 未安装, 请先安装其客户端' }) },
  });
  const res = { statusCode: 200, body: undefined, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  await handler({ params: { provider: 'sakurafrp' } }, res, () => {});
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, {
    ok: false,
    error: 'tunnel_restart_failed',
    message: 'sakurafrp 未安装, 请先安装其客户端',
  });
});

test('restart route keeps the legacy DTO when no message exists and never forwards raw error text', async () => {
  const handler = createTunnelRestartHandler({
    tunnel: { restartNow: async () => ({ ok: false, error: 'internal-secret-detail' }) },
  });
  const res = { statusCode: 200, body: undefined, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  await handler({ params: { provider: 'sakurafrp' } }, res, () => {});
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { ok: false, error: 'tunnel_restart_failed' });
  assert.equal(JSON.stringify(res.body).includes('internal-secret-detail'), false);
});

test('normalizeTunnelUpdate accepts monitorOnly for every provider and drops non-booleans', () => {
  const update = normalizeTunnelUpdate({
    phddns: { monitorOnly: true },
    tailscale: { monitorOnly: true },
    sakurafrp: { monitorOnly: true },
    natapp: { monitorOnly: 'yes' },
  });
  assert.equal(update.phddns.monitorOnly, true);
  assert.equal(update.tailscale.monitorOnly, true);
  assert.equal(update.sakurafrp.monitorOnly, true);
  assert.equal('monitorOnly' in update.natapp, false);
});

test('manage UI gates the restart button and exposes the monitorOnly switch', () => {
  const ui = fs.readFileSync(path.join(__dirname, '..', 'public', 'manage-host-settings.js'), 'utf8');
  assert.match(ui, /function tnlGateRestart\(/);
  assert.match(ui, /tnlGateRestart\('tnl-sf-restart', av\.sakurafrp, !!sf\.monitorOnly\)/);
  assert.match(ui, /tnl-sf-monitoronly/);
  assert.match(ui, /data\.message \|\| data\.error/);
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'manage.html'), 'utf8');
  assert.match(html, /id="tnl-sf-monitoronly"/);
  assert.match(html, /id="tnl-sf-restart"/);
  assert.match(html, /id="tnl-ts-publicurl"/);
  assert.match(ui, /公网 Funnel 部分可用/);
  assert.match(html, /重连控制面/);
});

test('stale restart failure is cleared once the probe turns healthy', withFreshTunnel(async tunnel => {
  tunnel.applyConfig({
    failThreshold: 1,
    sakurafrp: { enabled: true, url: 'https://tunnel.example.test/' },
  });
  await tunnel.checkProvider('sakurafrp', {
    probeFn: async () => 0,
    restarter: async () => { throw new Error('sakurafrp 未安装, 请先安装其客户端'); },
  });
  assert.match(tunnel.getStatus().providers.sakurafrp.lastAction, /重启失败/);
  await tunnel.checkProvider('sakurafrp', { probeFn: async () => 302 });
  const provider = tunnel.getStatus().providers.sakurafrp;
  assert.equal(provider.healthy, true);
  assert.equal(provider.lastAction, '', 'stale failure text must not survive a healthy probe');
}));

test('active guardrail note survives a healthy probe', withFreshTunnel(async tunnel => {
  tunnel.applyConfig({
    failThreshold: 1,
    restartCooldownSec: 0,
    maxRestartsPerHour: 1,
    sakurafrp: { enabled: true, url: 'https://tunnel.example.test/' },
  });
  await tunnel.checkProvider('sakurafrp', { probeFn: async () => 0, restarter: async () => '已后台启动' });
  await tunnel.checkProvider('sakurafrp', { probeFn: async () => 0, restarter: async () => '已后台启动' });
  assert.match(tunnel.getStatus().providers.sakurafrp.lastAction, /已达每小时重启上限/);
  await tunnel.checkProvider('sakurafrp', { probeFn: async () => 302 });
  assert.match(
    tunnel.getStatus().providers.sakurafrp.lastAction,
    /已达每小时重启上限/,
    'still-effective cap note must not be cleared',
  );
}));

test('manage UI never renders historical restart text for monitorOnly or uninstalled clients', () => {
  const ui = fs.readFileSync(path.join(__dirname, '..', 'public', 'manage-host-settings.js'), 'utf8');
  // Both indeterminate and normal paths return inside their monitorOnly branch
  // before any historical action text can be appended.
  const monitorOnlyBranches = [...ui.matchAll(/if \(prov\.monitorOnly\) \{([\s\S]*?)\n    \}/g)];
  assert.equal(monitorOnlyBranches.length, 2);
  for (const branch of monitorOnlyBranches) {
    assert.match(branch[1], /return s;/);
    const returnAt = branch[1].indexOf('return s;');
    const actionAt = branch[1].indexOf('p.lastAction');
    assert.ok(actionAt === -1 || returnAt < actionAt, 'monitorOnly must return before lastAction');
  }
  // Uninstalled client → neutral fact instead of historical failure.
  assert.match(ui, /function tnlFmtStatus\(p, prov, avail\)/);
  assert.match(ui, /客户端: 未安装（非 multicc 托管）/);
  assert.match(ui, /tnlFmtStatus\(pr\.sakurafrp \|\| \{\}, sf, av\.sakurafrp\)/);
  assert.match(ui, /近1h修复\/重连/);
  assert.match(ui, /最近动作:/);
  assert.match(ui, /不自动修复 Funnel/);
});
