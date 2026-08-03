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
});
