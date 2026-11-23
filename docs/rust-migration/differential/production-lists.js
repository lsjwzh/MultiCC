'use strict';

// Independent homes, plugin processes, task stores and listeners for the two deployments.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const WebSocket = require('ws');
const { start, token } = require('./production-entry');
const [gateway, addon] = process.argv.slice(2).map((p) => path.resolve(p));
const fixed = '2024-01-02T00:00:00.000Z';
const plugin = 'fixture-channel';
const action = { kind: 'channel', plugin, target: 'test' };

function write(dir, file, value) {
  const p = path.join(dir, file);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(value));
}

function seed(dir) {
  const data = path.join(dir, 'data');
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const tree = path.join(dir, 'checkout');
  function git(cwd, ...args) {
    execFileSync(
      'git',
      [
        '-C',
        cwd,
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        '-c',
        'commit.gpgSign=false',
        ...args,
      ],
      { stdio: 'ignore' }
    );
  }
  git(repo, 'init', '-b', 'main');
  git(repo, 'commit', '--allow-empty', '-m', 'fixture');
  git(repo, 'worktree', 'add', '-b', 'fixture-topic', tree);
  fs.writeFileSync(path.join(tree, 'tracked'), 'first');
  git(tree, 'add', 'tracked');
  git(tree, 'commit', '-m', 'one change');
  fs.writeFileSync(path.join(tree, 'tracked'), 'dirty');

  write(data, 'directories.json', [{ id: 'd', name: 'Directory', path: repo, baseBranch: 'main' }]);
  write(data, 'sessions.json', [
    { id: 'legacy', dirId: 'd', kind: 'chat', cli: 'claude', label: 'Old task' },
    {
      id: 'visible',
      loginFlow: true,
      cwd: dir,
      kind: 'chat',
      cli: 'claude',
      label: 'Hello',
      model: 'explicit',
      effort: 'high',
      triggers: [{ type: 'event', enabled: true, id: 'assigned', action }],
    },
    { id: 'codex', kind: 'chat', cli: 'codex', label: 'Codex', autoCommit: false },
    { id: 'relay', kind: 'chat', cli: 'claude', provider: 'fixture-relay', model: 'sonnet' },
    {
      id: 'tree',
      dirId: 'd',
      worktreePath: tree,
      branch: 'fixture-topic',
      cli: 'claude',
      kind: 'chat',
      experimentalMode: true,
    },
    { id: 'tty', cli: 'claude', kind: 'terminal', createdAt: fixed },
    { id: '__aux__', cwd: '/aux-fixture', type: 'aux', label: 'AI Assistant', createdAt: fixed },
    { id: 'system', type: 'gateway' },
    { id: 'slot', taskExecutionSlot: true },
    { id: 'bound', taskBoundTaskId: 'task-hidden' },
  ]);
  write(dir, 'home/.codex/models_cache.json', {
    models: [
      { slug: 'hidden', visibility: 'hide', priority: 0 },
      { slug: 'chosen', visibility: 'list', priority: 1 },
    ],
  });
  write(data, 'providers.json', {
    providers: [
      {
        id: 'fixture-relay',
        appType: 'claude',
        settingsConfig: {
          env: {
            ANTHROPIC_BASE_URL: 'https://provider.invalid',
            ANTHROPIC_DEFAULT_SONNET_MODEL: 'fixture-model',
          },
        },
      },
    ],
  });
  write(data, 'chat_history/visible.json', [
    { role: 'assistant', content: 'first', ts: 1000 },
    { role: 'user', content: 'second', ts: 2000 },
  ]);
  write(data, 'scheduled_tasks.json', [
    { id: 'example', dirId: 'd', name: 'Hello', cron: '*/5 * * * *', enabled: false, prompt: 'draft' },
    { id: 'adopt', dirId: 'd', name: 'adopt', lastSessionId: 'legacy' },
    { id: 'gone', dirId: 'd', name: 'missing task', taskId: 'removed /?' },
    { id: 'removed', dirId: 'x', name: 'missing directory' },
    { id: 'bad-cli', dirId: 'd', name: 'invalid', cli: 'invalid' },
    {
      id: 'script',
      kind: 'script',
      dirId: 'd',
      command: 'never-run',
      name: 'Script',
      enabled: true,
      cron: '10,20-50/5 3 2 * 1',
      lastExitCode: 0,
      lastOutput: 'prefix😀' + '测'.repeat(399),
      scriptTimeoutMs: 10000,
      runs: Array.from({ length: 14 }, (_, i) => ({ at: i, output: '测'.repeat(405) })),
    },
    { id: 'bad-cron', kind: 'script', enabled: true, cron: '70 12 * * *', dirId: 'd' },
  ]);
  write(data, 'channel-subscriptions.json', {
    subscriptions: [
      { id: 'push', plugin, target: 'test' },
      { id: 'disabled', plugin, target: 'test', enabled: false },
      { id: 'bad', plugin, target: 'invalid target' },
    ],
  });
  write(data, 'event_rules.json', {
    rules: [
      { id: 'hook', enabled: true, action, then: [action] },
      { id: 'off', enabled: false, action },
    ],
  });
  function manifest(id, extra = {}, engine = {}) {
    write(data, 'plugins/' + id + '/plugin.json', {
      id,
      name: id,
      version: '1',
      commands: ['ping'],
      ui: '/ui/index.html',
      channel: { label: 'Test' },
      ...extra,
      engine: { type: 'command', resident: true, binary: 'worker', ...engine },
    });
  }
  manifest(plugin);
  manifest('missing');
  manifest('nonresident', {}, { resident: false });
  manifest('incompatible', { channel: { label: 'Other', platforms: ['not-a-platform'] } });
  for (const id of [plugin, 'incompatible']) {
    const runner = path.join(data, 'plugins', id, 'worker');
    fs.writeFileSync(
      runner,
      `#!/bin/sh
while [ ! -f allow-hello ]; do sleep 0.1; done
if [ -f omit-version ]; then
  printf '%s\\n' '{"event":"hello","protocol":1}'
else
  printf '%s\\n' '{"event":"hello","protocol":1,"version":"reported"}'
fi
printf '%s\\n' '{"event":"alert","key":"fixture","title":"示例","replay":true}'
while IFS= read -r msg; do :; done
printf eof > stopped
`,
      { mode: 0o700 }
    );
  }
}

async function until(fn, label) {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await delay(50);
  }
  throw Error('timeout ' + label);
}
async function deployment(dir, reference) {
  seed(dir);
  let server = await start(dir, gateway, addon, reference);
  const proof = {};
  const request = (route, opts) =>
    fetch(server.origin + route, { signal: AbortSignal.timeout(8000), ...opts });
  const get = async (route) => {
    const res = await request(route);
    assert.equal(res.status, 200, route);
    return res.json();
  };
  try {
    for (const route of ['/api/sessions', '/api/cron', '/api/channels']) {
      const denied = await request(route, { headers: { 'x-forwarded-for': '192.0.2.9' } });
      assert.equal(denied.status, 403);
      assert.equal((await denied.json()).code, 'AUTH_REQUIRED');
      const head = await request(route, { method: 'HEAD' });
      assert.equal(head.status, 200);
      assert.equal(await head.text(), '');
      const options = await request(route, { method: 'OPTIONS' });
      assert.equal(options.status, 200);
      proof[route + ' methods and authentication'] = [
        head.headers.get('content-type'),
        head.headers.get('cache-control'),
        options.headers.get('allow'),
        await options.text(),
      ];
    }
    let sessions = await get('/api/Sessions/?ignored=true');
    assert.deepEqual(
      sessions.map((s) => s.id),
      ['__aux__', 'visible', 'codex', 'relay', 'tree', 'tty']
    );
    assert.equal(sessions[1].lastActivity, new Date(1000).toISOString());
    assert.equal(sessions[1].effectiveModel, 'explicit');
    assert.equal(sessions[1].active, false);
    assert.equal(sessions[2].effectiveModel, 'chosen');
    assert.equal(sessions[3].effectiveModel, 'fixture-model');
    const probed = await until(async () => {
      const all = await get('/api/sessions');
      const row = all.find((s) => s.id === 'tree');
      return row?.mergeState?.ahead === 1 && all;
    }, 'background Git state');
    const mergeState = probed.find((s) => s.id === 'tree').mergeState;
    assert.equal(mergeState.dirty, true);
    assert.equal(mergeState.behind, 0);
    assert.equal(mergeState.mergeReady, true);
    proof['dirty worktree and local branch divergence'] = mergeState;
    sessions = probed;
    for (const s of sessions) {
      if (s.cwd) s.cwd = s.cwd.replace(fs.realpathSync(dir), '<root>').replace(dir, '<root>');
      for (const state of Object.values(s.cliStates || {})) {
        if (state.updatedAt) {
          assert.ok(Number.isFinite(state.updatedAt));
          state.updatedAt = '<time>';
        }
      }
    }
    proof['sessions visible rows, order and DTOs'] = sessions;
    const ticket = await (
      await request('/api/auth/ws-ticket', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-access-token': token },
        body: JSON.stringify({ path: '/ws/chat' }),
      })
    ).json();
    const ws = new WebSocket(
      server.origin.replace('http:', 'ws:') + '/ws/chat?session=visible&ticket=' + ticket.ticket
    );
    try {
      await once(ws, 'open', { signal: AbortSignal.timeout(5000) });
      await until(async () => {
        const s = (await get('/api/sessions')).find((x) => x.id === 'visible');
        return s.active && s.clients === 1;
      }, 'attached chat');
    } finally {
      ws.terminate();
    }
    await until(async () => {
      const s = (await get('/api/sessions')).find((x) => x.id === 'visible');
      return !s.active && s.clients === 0;
    }, 'closed chat');
    proof['live chat attach and disconnect'] = true;
    const rules = await get('/api/CRON/');
    assert.equal(rules[0].taskId, 'tsk_390b7539a29651686a456ddfbcfc4b81');
    assert.equal(rules[1].lastSessionId, 'legacy');
    assert.notEqual(rules[1].taskId, rules[0].taskId);
    assert.equal(rules[2].taskId, 'removed /?');
    assert.equal(rules[3].taskBindingError, '目标目录不存在');
    const script = rules[5];
    assert.equal(script.lastExitCode, 0);
    assert.equal(script.lastOutput.length, 400);
    assert.equal(script.lastOutput.charCodeAt(0), 0xde00);
    assert.equal(script.recentRuns.length, 10);
    assert.equal(script.recentRuns[0].at, 13);
    assert.ok(script.nextRunAt > Date.now());
    assert.equal(rules[6].nextRunAt, null);
    const stored = JSON.parse(fs.readFileSync(path.join(dir, 'data/scheduled_tasks.json')));
    assert.equal(stored[0].taskBindingVersion, 1);
    for (const rule of [...rules, ...stored]) {
      if (rule.taskBindingBrokenAt) {
        assert.ok(Number.isFinite(rule.taskBindingBrokenAt));
        rule.taskBindingBrokenAt = '<time>';
      }
    }
    proof['cron projections and stored bindings'] = [rules, stored];
    const channels = async () => get('/api/CHANNELS/');
    const status = (await channels()).plugins;
    const waiting = status.find((p) => p.id === plugin);
    assert.ok(waiting.running && !waiting.ready && waiting.pid > 0);
    assert.deepEqual([waiting.subscriptions, waiting.uses, waiting.inUse], [1, 4, true]);
    assert.ok(!status.some((p) => p.id === 'nonresident'));
    assert.equal(status.find((p) => p.id === 'missing').unsupported, 'binary-missing');
    assert.equal(status.find((p) => p.id === 'incompatible').unsupported, 'platform');
    fs.writeFileSync(path.join(dir, 'data/plugins', plugin, 'allow-hello'), '');
    const live = await until(async () => {
      const v = await channels();
      return v.plugins.some((p) => p.id === plugin && p.ready && p.alerts.length) && v;
    }, 'resident hello and alert');
    const ready = live.plugins.find((p) => p.id === plugin);
    assert.ok(ready.startedAt > 0 && ready.readyAt >= ready.startedAt);
    assert.equal(ready.pid, waiting.pid);
    assert.equal(ready.version, 'reported');
    assert.equal(ready.alerts[0].fromHost, false);
    process.kill(ready.pid, 'SIGTERM');
    const exited = await until(async () => {
      const p = (await channels()).plugins.find((p) => p.id === plugin);
      return !p.running && p.lastExit && p;
    }, 'resident exit');
    assert.equal(exited.ready, false);
    assert.equal(exited.pid, null);
    assert.equal(exited.lastExit.signal, 'SIGTERM');
    const restarted = await until(async () => {
      const p = (await channels()).plugins.find((p) => p.id === plugin);
      return p.ready && p.pid !== ready.pid && p;
    }, 'resident restart');
    fs.writeFileSync(path.join(dir, 'data/plugins', plugin, 'omit-version'), '');
    process.kill(restarted.pid, 'SIGHUP');
    const again = await until(async () => {
      const p = (await channels()).plugins.find((p) => p.id === plugin);
      return p.ready && p.pid !== restarted.pid && p;
    }, 'resident restart without a reported version');
    assert.deepEqual([again.lastExit.signal, again.version], ['SIGHUP', '1']);
    proof['resident exits and restarts'] = [
      exited.restarts,
      restarted.restarts,
      restarted.version,
      restarted.lastExit.signal,
      again.lastExit.signal,
      again.version,
    ];
    for (const p of [waiting, ready]) {
      p.pid = '<pid>';
      p.startedAt = '<time>';
      if (p.readyAt) p.readyAt = '<time>';
      for (const a of p.alerts) {
        assert.ok(a.at > 0);
        a.at = '<time>';
      }
    }
    proof['resident states and configured uses'] = [waiting, live];
    await server.stop();
    await until(
      async () => fs.existsSync(path.join(dir, 'data/plugins', plugin, 'stopped')),
      'plugin sees stdin EOF'
    );
    await until(async () => {
      try {
        process.kill(again.pid, 0);
        return false;
      } catch (error) {
        return error.code === 'ESRCH';
      }
    }, 'child reaped');
    proof['gateway stop closes plugin stdin and releases process'] = true;
    const boardFile = path.join(dir, 'data/task_board.json');
    const board = JSON.parse(fs.readFileSync(boardFile));
    board.tasks[rules[0].taskId].status = 'archived';
    board.revision++;
    fs.writeFileSync(boardFile, JSON.stringify(board));
    server = await start(dir, gateway, addon, reference);
    const restored = await get('/api/cron');
    assert.deepEqual(
      restored.map((r) => r.taskId),
      rules.map((r) => r.taskId)
    );
    assert.equal(restored[0].taskReadOnly, true);
    assert.equal(restored[0].taskBindingError, '固定任务已归档或只读');
    proof['restart preserves task identities and archived binding'] = [
      restored.map((r) => r.taskId),
      restored[0].taskStatus,
      restored[0].taskBindingError,
    ];
    await server.stop();
    for (const file of ['scheduled_tasks.json', 'channel-subscriptions.json', 'event_rules.json']) {
      fs.writeFileSync(path.join(dir, 'data', file), '{broken');
    }
    server = await start(dir, gateway, addon, reference);
    assert.deepEqual(await get('/api/cron'), []);
    const damaged = (await channels()).plugins.find((p) => p.id === plugin);
    assert.equal(damaged.subscriptions, 0);
    assert.equal(damaged.uses, 1);
    proof['corrupt config falls back, independent session hook survives'] = [
      damaged.uses,
      damaged.subscriptions,
    ];
  } finally {
    await server.stop();
  }
  return proof;
}
async function legacyStore(dir, reference) {
  const root = path.resolve(__dirname, '../../..');
  const plugins = path.join(dir, 'package/plugins');
  fs.mkdirSync(path.join(plugins, 'cron'), { recursive: true });
  if (reference) {
    for (const entry of fs.readdirSync(path.join(root, 'plugins'))) {
      if (entry !== 'cron') fs.symlinkSync(path.join(root, 'plugins', entry), path.join(plugins, entry));
    }
    for (const file of ['cron-tasks.js', 'fanout-migration.js']) {
      fs.copyFileSync(path.join(root, 'plugins/cron', file), path.join(plugins, 'cron', file));
    }
  }
  const rules = [
    { id: 'legacy-script', name: 'legacy', kind: 'script', enabled: false, command: 'do-not-run' },
  ];
  write(plugins, 'cron/scheduled_tasks.json', rules);
  let server = await start(dir, gateway, addon, reference);
  try {
    const res = await fetch(server.origin + '/api/cron');
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.equal(JSON.parse(body)[0].id, 'legacy-script');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'data/scheduled_tasks.json'))), rules);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(plugins, 'cron/scheduled_tasks.json'))), rules);
    // fetch adds Cache-Control: no-cache when passed an ETag. Send exactly the
    // conditional request a client with a reusable cached representation sends.
    const status = await new Promise((resolve, reject) => {
      require('node:http')
        .get(
          server.origin + '/api/cron',
          {
            headers: {
              'if-none-match': res.headers.get('etag'),
              'x-access-token': token,
              'x-forwarded-for': '192.0.2.9',
            },
            signal: AbortSignal.timeout(5000),
          },
          (reply) => {
            reply.resume();
            resolve(reply.statusCode);
          }
        )
        .on('error', reject);
    });
    assert.equal(status, 304);
    await server.stop();
    write(dir, 'data/scheduled_tasks.json', [{ kind: 'script', runs: [null] }]);
    server = await start(dir, gateway, addon, reference);
    const invalid = await fetch(server.origin + '/api/cron', {
      headers: {
        'x-request-id': 'cron-fixture',
        'x-correlation-id': 'cron-fixture',
      },
    });
    assert.equal(invalid.status, 500);
    const error = await invalid.json();
    assert.equal(error.code, 'internal_error');
    return { body, etag: res.headers.get('etag'), bytes: res.headers.get('content-length'), error };
  } finally {
    await server.stop();
  }
}

async function main() {
  assert.ok(gateway && addon);
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-production-lists-')));
  try {
    const reference = await deployment(path.join(dir, 'reference'), true);
    const rust = await deployment(path.join(dir, 'rust'), false);
    reference['legacy cron copy, conditional GET, response bytes and invalid run'] = await legacyStore(
      path.join(dir, 'legacy-reference'),
      true
    );
    rust['legacy cron copy, conditional GET, response bytes and invalid run'] = await legacyStore(
      path.join(dir, 'legacy-rust'),
      false
    );
    for (const k of Object.keys(reference)) {
      assert.deepEqual(rust[k], reference[k], k);
      console.log('PASS ' + k);
    }
    console.log(JSON.stringify({ equal: Object.keys(reference).length }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
