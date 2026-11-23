'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { accountEnv, hasAccount, hasRemoteAccount } = require('../src/agy-accounts');
const { applyRouterMcpEnv } = require('../src/cli-adapters/router-mcp');
const { createAgyAdapter } = require('../src/cli-adapters/agy');
const { gatewayPath } = require('../src/native/runtime');

function mkTempDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `multicc-agy-remote-${tag}-`));
}

function writeExecutable(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, { mode: 0o755 });
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

test('remote VPS account resolves to MULTICC_AGY_REMOTE_ACCOUNT_JSON without altering HOME', () => {
  const home = mkTempDir('acct');
  const root = path.join(home, '.multicc', 'official-accounts', 'agy');
  const remoteId = 'abcdef0123456789';
  assert.equal(hasRemoteAccount(home), false);

  writeJson(path.join(root, `${remoteId}.json`), {
    id: remoteId,
    kind: 'remote',
    label: '新加坡 VPS',
    createdAt: 100,
    source: 'remote',
    remote: {
      sshTarget: 'ubuntu@203.0.113.10',
      sshPort: 2222,
      fileMode: 'mutagen',
    },
  });

  assert.equal(hasAccount(remoteId, home), true);
  assert.equal(hasRemoteAccount(home), true);

  // Explicit binding resolves without global active.json.
  const explicitEnv = accountEnv(home, remoteId);
  assert.ok(explicitEnv && explicitEnv.MULTICC_AGY_REMOTE_ACCOUNT_JSON);
  assert.equal(explicitEnv.HOME, undefined);
  const parsed = JSON.parse(explicitEnv.MULTICC_AGY_REMOTE_ACCOUNT_JSON);
  assert.equal(parsed.kind, 'remote');
  assert.equal(parsed.remote.sshTarget, 'ubuntu@203.0.113.10');
  assert.equal(parsed.remote.sshPort, 2222);

  // Router MCP injection skips writing local ~/.gemini/config/mcp_config.json for remote accounts.
  const childEnv = { HOME: home, ...explicitEnv };
  applyRouterMcpEnv(childEnv, 'agy', process.execPath, '/tmp/fake-router.js');
  assert.equal(fs.existsSync(path.join(home, '.gemini', 'config', 'mcp_config.json')), false);

  // Global active pin also resolves remote account.
  writeJson(path.join(root, 'active.json'), { id: remoteId });
  const globalEnv = accountEnv(home, null);
  assert.ok(globalEnv && globalEnv.MULTICC_AGY_REMOTE_ACCOUNT_JSON);

  // Missing explicit id still fails closed.
  assert.throws(
    () => accountEnv(home, '1111111111111111'),
    err => err.code === 'AGY_ACCOUNT_MISSING',
  );
});

test('agy-remote-bridge end-to-end: mutagen sync flush + reverse tunnel + stdio MCP host_run_command + path jail', {
  skip: process.platform === 'win32',
}, () => {
  const work = mkTempDir('e2e-mutagen');
  const localWs = path.join(work, 'local-project');
  const remoteHome = path.join(work, 'remote-home');
  const logDir = path.join(work, 'logs');
  fs.mkdirSync(localWs, { recursive: true });
  fs.mkdirSync(remoteHome, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(localWs, 'local-marker.txt'), 'REAL_LOCAL_MACHINE_OK\n', 'utf8');

  const mutagenLog = path.join(logDir, 'mutagen.log');
  const sshLog = path.join(logDir, 'ssh.log');
  const fakeMutagen = path.join(work, 'bin', 'mutagen');
  const fakeSsh = path.join(work, 'bin', 'ssh');
  const fakeAgy = path.join(work, 'bin', 'fake-agy');

  // Fake mutagen records every invocation and simulates session creation + flush.
  writeExecutable(fakeMutagen, `#!/bin/sh
echo "$*" >> ${JSON.stringify(mutagenLog)}
if [ "$1" = "version" ]; then
  echo "0.18.1"
  exit 0
fi
if [ "$1" = "sync" ] && [ "$2" = "list" ]; then
  if [ -f ${JSON.stringify(path.join(logDir, 'mutagen.created'))} ]; then
    exit 0
  fi
  exit 1
fi
if [ "$1" = "sync" ] && [ "$2" = "create" ]; then
  touch ${JSON.stringify(path.join(logDir, 'mutagen.created'))}
  exit 0
fi
if [ "$1" = "sync" ] && [ "$2" = "flush" ]; then
  exit 0
fi
exit 0
`);

  // Fake SSH records args (verifying -R tunnel & ExitOnForwardFailure) and executes the piped `sh -s` script locally.
  writeExecutable(fakeSsh, `#!/bin/sh
echo "$*" >> ${JSON.stringify(sshLog)}
exec /bin/sh -s
`);

  // Fake remote agy verifies --settings deny command(*), spawns the bootstrapped host-exec-mcp.mjs over stdio,
  // invokes host_run_command (success + path escape rejection), and emits standard agy stream-json NDJSON.
  writeExecutable(fakeAgy, `#!${process.execPath}
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const argv = process.argv.slice(2);
const settingsIdx = argv.indexOf('--settings');
if (settingsIdx < 0) {
  console.error('missing --settings');
  process.exit(21);
}
const settings = JSON.parse(argv[settingsIdx + 1]);
if (!settings.permissions || !Array.isArray(settings.permissions.deny) || !settings.permissions.deny.includes('command(*)')) {
  console.error('missing command(*) deny rule');
  process.exit(22);
}

const cfgPath = path.join(process.env.HOME, '.gemini', 'config', 'mcp_config.json');
const cfgRaw = fs.readFileSync(cfgPath, 'utf8');
if (cfgRaw.includes(process.env.MULTICC_HOST_EXEC_TOKEN)) {
  console.error('secret token leaked into mcp_config.json!');
  process.exit(23);
}
const cfg = JSON.parse(cfgRaw);
const entry = cfg.mcpServers && cfg.mcpServers.multicc_host_exec;
if (!entry || !entry.command || !Array.isArray(entry.args)) {
  console.error('missing multicc_host_exec in mcp_config.json');
  process.exit(24);
}

// Drive the bootstrapped host-exec-mcp.mjs via stdio JSON-RPC.
const requests = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
  { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'host_run_command', arguments: { command: 'cat local-marker.txt' } } },
  { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'host_run_command', arguments: { command: 'pwd', cwd: '../../etc' } } },
].map(r => JSON.stringify(r)).join('\\n') + '\\n';

const mcpRun = spawnSync(entry.command, entry.args, {
  input: requests,
  encoding: 'utf8',
  env: process.env,
});
if (mcpRun.status !== 0) {
  console.error('mcp bridge failed:', mcpRun.stderr);
  process.exit(25);
}
const responses = mcpRun.stdout.trim().split('\\n').map(line => JSON.parse(line));
const execRes = responses.find(r => r.id === 3).result;
const escapeRes = responses.find(r => r.id === 4).result;
if (execRes.isError || !execRes.content[0].text.includes('REAL_LOCAL_MACHINE_OK')) {
  console.error('host_run_command failed:', JSON.stringify(execRes));
  process.exit(26);
}
if (!escapeRes.isError || !escapeRes.content[0].text.includes('越界')) {
  console.error('path jail did not reject escape:', JSON.stringify(escapeRes));
  process.exit(27);
}

console.log(JSON.stringify({ event: 'init', conversation_id: 'conv-remote-1', init: { model: 'gemini-4-neon' } }));
console.log(JSON.stringify({
  event: 'step_update',
  step_update: {
    conversation_id: 'conv-remote-1',
    step_index: 1,
    step_type: 'agent_response',
    state: 'DONE',
    text_delta: 'Host exec verified: REAL_LOCAL_MACHINE_OK',
    usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
  },
}));
console.log(JSON.stringify({
  event: 'result',
  result: { conversation_id: 'conv-remote-1', status: 'SUCCESS', num_turns: 1 },
}));
`);

  const targetPayload = JSON.stringify({
    id: 'abcdef0123456789',
    kind: 'remote',
    label: '测试 VPS',
    remote: {
      sshTarget: 'ubuntu@vps.test',
      sshPort: 2222,
      remoteAgyBin: fakeAgy,
      remoteHome,
      fileMode: 'mutagen',
    },
  });

  const run = spawnSync(gatewayPath(), [
    'agy-remote-bridge',
    '--local-cwd', localWs,
    '--machine-id', 'mac-test-a',
    '--',
    '--output-format', 'stream-json',
    '--dangerously-skip-permissions',
    '--model', 'gemini-4-neon',
    '-p', 'check local marker',
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      MULTICC_AGY_REMOTE_ACCOUNT_JSON: targetPayload,
      MULTICC_SSH_BIN: fakeSsh,
      MULTICC_MUTAGEN_BIN: fakeMutagen,
      MULTICC_REMOTE_DIRECT_LOOPBACK: '1',
    },
  });

  assert.equal(run.status, 0, `bridge exited ${run.status}: stderr=${run.stderr}\nstdout=${run.stdout}`);

  // Decode stdout NDJSON using the real agy stream adapter.
  const adapter = createAgyAdapter({ cmd: 'agy' });
  const events = run.stdout.trim().split('\n').flatMap(line => adapter.decodeEvent(JSON.parse(line)));
  assert.ok(events.some(e => e.type === 'session_started' && e.sessionId === 'conv-remote-1'));
  assert.ok(events.some(e => e.type === 'assistant_text' && e.text.includes('REAL_LOCAL_MACHINE_OK')));
  assert.ok(events.some(e => e.type === 'complete'));

  // Verify SSH reverse tunnel flags were passed.
  const sshLines = fs.readFileSync(sshLog, 'utf8').trim().split('\n');
  assert.ok(sshLines.some(line => line.includes('-R 127.0.0.1:') && line.includes('ExitOnForwardFailure=yes') && line.includes('-p 2222')));

  // Verify Mutagen lifecycle: version -> create (with pure-source ignores) -> pre-turn flush -> pre/post-exec flush -> post-turn flush.
  const mutagenLines = fs.readFileSync(mutagenLog, 'utf8').trim().split('\n');
  assert.ok(mutagenLines.some(l => l.startsWith('sync create ') && l.includes('--ignore node_modules') && l.includes('--ignore target')));
  const flushCount = mutagenLines.filter(l => l.startsWith('sync flush ')).length;
  assert.ok(flushCount >= 4, `expected at least 4 mutagen flushes (pre-turn + before/after exec + post-turn), got ${flushCount}: ${mutagenLines.join(' | ')}`);
});

test('agy-remote-bridge remote_mcp zero-disk mode works without mutagen and writes directly to local disk', {
  skip: process.platform === 'win32',
}, () => {
  const work = mkTempDir('e2e-mcp');
  const localWs = path.join(work, 'local-project');
  const remoteHome = path.join(work, 'remote-home');
  fs.mkdirSync(localWs, { recursive: true });
  fs.mkdirSync(remoteHome, { recursive: true });

  const fakeSsh = path.join(work, 'bin', 'ssh');
  const fakeAgy = path.join(work, 'bin', 'fake-agy');

  writeExecutable(fakeSsh, '#!/bin/sh\nexec /bin/sh -s\n');
  writeExecutable(fakeAgy, `#!${process.execPath}
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const argv = process.argv.slice(2);
const settings = JSON.parse(argv[argv.indexOf('--settings') + 1]);
for (const rule of ['command(*)', 'read_file(*)', 'write_file(*)']) {
  if (!settings.permissions.deny.includes(rule)) {
    console.error('missing deny rule:', rule);
    process.exit(31);
  }
}

const cfg = JSON.parse(fs.readFileSync(path.join(process.env.HOME, '.gemini', 'config', 'mcp_config.json'), 'utf8'));
const entry = cfg.mcpServers.multicc_host_exec;
const requests = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
  { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'host_write_file', arguments: { path: 'nested/out.txt', content: 'ZERO_DISK_WRITE_OK' } } },
  { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'host_read_file', arguments: { path: 'nested/out.txt' } } },
  { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'host_list_dir', arguments: { path: 'nested' } } },
].map(r => JSON.stringify(r)).join('\\n') + '\\n';

const mcpRun = spawnSync(entry.command, entry.args, { input: requests, encoding: 'utf8', env: process.env });
const responses = mcpRun.stdout.trim().split('\\n').map(line => JSON.parse(line));
if (responses.find(r => r.id === 3).result.content[0].text !== 'ZERO_DISK_WRITE_OK') process.exit(32);
if (!responses.find(r => r.id === 4).result.content[0].text.includes('out.txt')) process.exit(33);

console.log(JSON.stringify({ event: 'result', result: { conversation_id: 'conv-mcp-1', status: 'SUCCESS' } }));
`);

  const targetPayload = JSON.stringify({
    remote: {
      sshTarget: 'ubuntu@vps.test',
      remoteAgyBin: fakeAgy,
      remoteHome,
      fileMode: 'remote_mcp',
    },
  });

  const run = spawnSync(gatewayPath(), [
    'agy-remote-bridge',
    '--local-cwd', localWs,
    '--',
    '--output-format', 'stream-json',
    '-p', 'write file',
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      MULTICC_AGY_REMOTE_ACCOUNT_JSON: targetPayload,
      MULTICC_SSH_BIN: fakeSsh,
      MULTICC_MUTAGEN_BIN: '/nonexistent/mutagen',
      MULTICC_REMOTE_DIRECT_LOOPBACK: '1',
    },
  });

  assert.equal(run.status, 0, `remote_mcp failed: ${run.stderr}\n${run.stdout}`);
  assert.equal(fs.readFileSync(path.join(localWs, 'nested', 'out.txt'), 'utf8'), 'ZERO_DISK_WRITE_OK');
});

test('agy-remote-bridge emits clear agy error frame when mutagen is missing in mutagen mode', {
  skip: process.platform === 'win32',
}, () => {
  const work = mkTempDir('missing-mutagen');
  const run = spawnSync(gatewayPath(), [
    'agy-remote-bridge',
    '--local-cwd', work,
    '--',
    '--output-format', 'stream-json',
    '-p', 'hi',
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      MULTICC_AGY_REMOTE_ACCOUNT_JSON: JSON.stringify({
        remote: { sshTarget: 'ubuntu@vps.test', fileMode: 'mutagen' },
      }),
      MULTICC_MUTAGEN_BIN: '/nonexistent/mutagen',
    },
  });

  assert.equal(run.status, 1);
  const frame = JSON.parse(run.stdout.trim());
  assert.equal(frame.event, 'result');
  assert.equal(frame.result.status, 'ERROR');
  assert.match(frame.result.error, /mutagen/i);
});

test('agy-remote-bridge automatically uses managed ~/.multicc/bin/mutagen without PATH or env override', {
  skip: process.platform === 'win32',
}, () => {
  const work = mkTempDir('managed-mutagen');
  const fakeHome = path.join(work, 'home');
  const managedDir = path.join(fakeHome, '.multicc', 'bin', 'mutagen');
  const logFile = path.join(work, 'managed-mutagen.log');
  fs.mkdirSync(managedDir, { recursive: true });
  writeExecutable(path.join(managedDir, 'mutagen'), `#!/bin/sh
echo "MANAGED:$*" >> ${JSON.stringify(logFile)}
if [ "$1" = "version" ]; then echo "0.18.1"; exit 0; fi
if [ "$1" = "sync" ] && [ "$2" = "list" ]; then exit 0; fi
exit 0
`);
  fs.writeFileSync(path.join(managedDir, 'mutagen-agents.tar.gz'), 'agents', 'utf8');

  const fakeSsh = path.join(work, 'bin', 'ssh');
  const fakeAgy = path.join(work, 'bin', 'fake-agy');
  writeExecutable(fakeSsh, '#!/bin/sh\nexec /bin/sh -s\n');
  writeExecutable(fakeAgy, `#!${process.execPath}
console.log(JSON.stringify({ event: 'result', result: { conversation_id: 'conv-managed', status: 'SUCCESS' } }));
`);

  const env = {
    ...process.env,
    HOME: fakeHome,
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
    MULTICC_AGY_REMOTE_ACCOUNT_JSON: JSON.stringify({
      remote: { sshTarget: 'ubuntu@vps.test', remoteAgyBin: fakeAgy, remoteHome: fakeHome, fileMode: 'mutagen' },
    }),
    MULTICC_SSH_BIN: fakeSsh,
    MULTICC_REMOTE_DIRECT_LOOPBACK: '1',
  };
  delete env.MULTICC_MUTAGEN_BIN;

  const run = spawnSync(gatewayPath(), [
    'agy-remote-bridge',
    '--local-cwd', work,
    '--',
    '--output-format', 'stream-json',
    '-p', 'hi',
  ], { encoding: 'utf8', env });

  assert.equal(run.status, 0, `managed mutagen failed: ${run.stderr}\n${run.stdout}`);
  const log = fs.readFileSync(logFile, 'utf8');
  assert.match(log, /MANAGED:version/);
  assert.match(log, /MANAGED:sync flush/);
});

test('Host/Client separation: agy-remote-bridge delegates egress to VPS agy-host-exec with zero client proxy detour and fails closed', {
  skip: process.platform === 'win32',
}, () => {
  const work = mkTempDir('host-client-egress');
  const hostHome = path.join(work, 'vps-host-home');
  const hostAccountId = 'a1b2c3d4e5f60718';
  const hostAcctRoot = path.join(hostHome, '.multicc', 'official-accounts', 'agy');
  const hostAcctHome = path.join(hostAcctRoot, `${hostAccountId}.home`);
  fs.mkdirSync(hostAcctHome, { recursive: true });
  writeJson(path.join(hostAcctRoot, `${hostAccountId}.json`), {
    id: hostAccountId,
    label: 'VPS主号',
    createdAt: Date.now(),
    source: 'created',
    egressBinding: { pluginId: 'chrome-proxy-launcher', profileId: 'host-jp-1' },
  });

  // Host-side fake chrome-proxy-launcher plugin (runs on VPS, NOT on Client!).
  const hostPluginsDir = path.join(work, 'vps-plugins');
  const fakePluginBin = path.join(hostPluginsDir, 'chrome-proxy-launcher', 'bin', 'chrome-proxy-launcher');
  writeJson(path.join(hostPluginsDir, 'chrome-proxy-launcher', 'plugin.json'), {
    id: 'chrome-proxy-launcher',
    commands: ['list', 'egress'],
    engine: { type: 'command', binary: 'bin/chrome-proxy-launcher' },
  });
  writeExecutable(fakePluginBin, `#!/bin/sh
INPUT="$(cat)"
case "$INPUT" in
  *host-jp-1*)
    echo '{"ok":true,"data":{"proxyUrl":"http://127.0.0.1:28999"}}'
    exit 0
    ;;
  *)
    echo '{"ok":false,"error":"host egress profile offline"}'
    exit 1
    ;;
esac
`);

  // Host publishes ~/.multicc/host-runtime.json pointing to Host's multicc-gateway + pluginsDir.
  writeJson(path.join(hostHome, '.multicc', 'host-runtime.json'), {
    schema: 1,
    gatewayBin: gatewayPath(),
    pluginsDir: hostPluginsDir,
    updatedAt: Date.now(),
  });

  const sshLog = path.join(work, 'ssh.log');
  const fakeSsh = path.join(work, 'bin', 'ssh');
  const fakeAgy = path.join(work, 'bin', 'fake-agy');

  // Fake SSH runs on the simulated VPS with HOME=hostHome (no Client plugins dir, no Client proxy env).
  writeExecutable(fakeSsh, `#!/bin/sh
echo "$*" >> ${JSON.stringify(sshLog)}
export HOME=${JSON.stringify(hostHome)}
unset MULTICC_PLUGINS_DIR
unset MULTICC_EGRESS_PROXY_OVERRIDE
exec /bin/sh -s
`);
  writeExecutable(fakeAgy, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
if (process.env.HOME !== ${JSON.stringify(hostAcctHome)}) {
  console.error('unexpected Host account HOME:', process.env.HOME);
  process.exit(40);
}
if (process.env.HTTPS_PROXY !== 'http://127.0.0.1:28999') {
  console.error('unexpected Host HTTPS_PROXY:', process.env.HTTPS_PROXY);
  process.exit(41);
}
if (!String(process.env.NO_PROXY || '').includes('127.0.0.1')) {
  console.error('missing loopback NO_PROXY:', process.env.NO_PROXY);
  process.exit(42);
}
const mcpCfg = JSON.parse(fs.readFileSync(path.join(process.env.HOME, '.gemini', 'config', 'mcp_config.json'), 'utf8'));
if (!mcpCfg.mcpServers || !mcpCfg.mcpServers.multicc_host_exec) {
  console.error('missing multicc_host_exec MCP registration on Host account home');
  process.exit(43);
}
console.log(JSON.stringify({ event: 'result', result: { conversation_id: 'conv-host-egress', status: 'SUCCESS' } }));
`);

  const okRun = spawnSync(gatewayPath(), [
    'agy-remote-bridge',
    '--local-cwd', work,
    '--',
    '--output-format', 'stream-json',
    '-p', 'hi',
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      // Client has NO egressBinding and NO chrome-proxy-launcher plugin!
      MULTICC_PLUGINS_DIR: path.join(work, 'client-has-no-plugins'),
      MULTICC_AGY_REMOTE_ACCOUNT_JSON: JSON.stringify({
        remote: {
          sshTarget: 'ubuntu@vps.test',
          hostAccountId,
          remoteAgyBin: fakeAgy,
          fileMode: 'remote_mcp',
        },
      }),
      MULTICC_SSH_BIN: fakeSsh,
      MULTICC_REMOTE_DIRECT_LOOPBACK: '1',
    },
  });
  assert.equal(okRun.status, 0, `Host/Client remote bridge failed: ${okRun.stderr}\n${okRun.stdout}`);
  const sshArgsLog = fs.readFileSync(sshLog, 'utf8');
  // Client opens strictly ONE -R tunnel (for host_exec), never a second -R proxy tunnel.
  const turnLine = sshArgsLog.trim().split('\n').pop() || '';
  const rMatches = turnLine.match(/(?:^|\s)-R\s/g) || [];
  assert.equal(rMatches.length, 1, `expected strictly 1 -R tunnel (host_exec only), got: ${turnLine}`);

  // Fail-closed on Host: switch Host account egress to a broken profile -> Host agy-host-exec refuses to run agy!
  writeJson(path.join(hostAcctRoot, `${hostAccountId}.json`), {
    id: hostAccountId,
    label: 'VPS主号',
    createdAt: Date.now(),
    source: 'created',
    egressBinding: { pluginId: 'chrome-proxy-launcher', profileId: 'offline-profile' },
  });
  const failRun = spawnSync(gatewayPath(), [
    'agy-remote-bridge',
    '--local-cwd', work,
    '--',
    '--output-format', 'stream-json',
    '-p', 'hi',
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      MULTICC_PLUGINS_DIR: path.join(work, 'client-has-no-plugins'),
      MULTICC_AGY_REMOTE_ACCOUNT_JSON: JSON.stringify({
        remote: {
          sshTarget: 'ubuntu@vps.test',
          hostAccountId,
          remoteAgyBin: fakeAgy,
          fileMode: 'remote_mcp',
        },
      }),
      MULTICC_SSH_BIN: fakeSsh,
      MULTICC_REMOTE_DIRECT_LOOPBACK: '1',
    },
  });
  assert.equal(failRun.status, 1);
  const errLine = failRun.stdout.trim().split('\n').find(l => l.includes('"ERROR"'));
  assert.ok(errLine, `expected agy ERROR frame from Host fail-closed, got: ${failRun.stdout}`);
  const errFrame = JSON.parse(errLine);
  assert.equal(errFrame.result.status, 'ERROR');
  assert.match(errFrame.result.error, /Host 账号专用出口不可用/);
});

test('agy-egress-exec injects resolved egress proxy for local agy and fails closed when unavailable', {
  skip: process.platform === 'win32',
}, () => {
  const work = mkTempDir('egress-local');
  const fakeAgy = path.join(work, 'fake-agy');
  writeExecutable(fakeAgy, `#!${process.execPath}
console.log(JSON.stringify({ https: process.env.HTTPS_PROXY, noProxy: process.env.NO_PROXY, argv: process.argv.slice(2) }));
`);

  const ok = spawnSync(gatewayPath(), [
    'agy-egress-exec',
    '--bin', fakeAgy,
    '--',
    '--output-format', 'stream-json',
    '-p', 'hello',
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      MULTICC_AGY_EGRESS_JSON: JSON.stringify({ pluginId: 'chrome-proxy-launcher', profileId: 'prof-1' }),
      MULTICC_EGRESS_PROXY_OVERRIDE: 'socks5://127.0.0.1:22001',
    },
  });
  assert.equal(ok.status, 0, ok.stderr);
  const out = JSON.parse(ok.stdout.trim());
  assert.equal(out.https, 'socks5://127.0.0.1:22001');
  assert.match(out.noProxy, /127\.0\.0\.1/);
  assert.deepEqual(out.argv, ['--output-format', 'stream-json', '-p', 'hello']);

  const bad = spawnSync(gatewayPath(), [
    'agy-egress-exec',
    '--bin', fakeAgy,
    '--',
    '-p', 'hello',
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: work,
      MULTICC_PLUGINS_DIR: path.join(work, 'no-plugins'),
      MULTICC_AGY_EGRESS_JSON: JSON.stringify({ pluginId: 'missing-plugin', profileId: 'p1' }),
    },
  });
  assert.equal(bad.status, 1);
  const frame = JSON.parse(bad.stdout.trim());
  assert.equal(frame.result.status, 'ERROR');
});

test('parseRelayShareCode accepts appType=agy share codes and rejects invalid payloads', () => {
  const vm = require('node:vm');
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'manage-provider-relay.js'), 'utf8');
  const ctx = {
    window: {},
    document: {},
    atob: b64 => Buffer.from(b64, 'base64').toString('binary'),
    crypto: { getRandomValues: arr => arr },
  };
  vm.runInNewContext(src, ctx);
  const payload = {
    v: 2,
    kind: 'multicc-relay',
    name: 'VPS工作号 · 反重力共享',
    appType: 'agy',
    baseUrl: 'https://vps.example.com/agy-proxy/0123456789abcdef',
    relayShareId: 'abcdef0123456789',
    authToken: 'mcr1.abcdef0123456789.secret123456',
  };
  const b64url = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const parsed = ctx.parseRelayShareCode(`mcrelay1.${b64url}`);
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.payload.appType, 'agy');
  assert.equal(parsed.payload.baseUrl, payload.baseUrl);
  assert.equal(parsed.payload.authToken, payload.authToken);

  const badType = Buffer.from(JSON.stringify({ ...payload, appType: 'unknown' }), 'utf8').toString('base64url');
  assert.match(ctx.parseRelayShareCode(`mcrelay1.${badType}`).error, /appType/);
});
