'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

// This program only operates inside a disposable, source-only container.
const candidate = '/candidate', installed = '/home/node/installed';
const dataDir = '/home/node/clean-install-data';
async function run(command, args, cwd, env = process.env) {
  console.log(`[clean-install] ${command} ${args.join(' ')}`);
  const child = spawn(command, args, { cwd, env, stdio: 'inherit' });
  const stop = () => child.kill('SIGTERM');
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    if (code !== 0) throw new Error(`${command} failed (${code})`);
  } finally { process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); }
}
(async () => {
  assert.ok(fs.existsSync('/.dockerenv'), 'container-only gate');
  assert.equal(process.cwd(), candidate);
  for (const file of [installed, dataDir, '/home/node/.npm', `${candidate}/node_modules`, `${candidate}/.git`, `${candidate}/.env`]) {
    assert.equal(fs.existsSync(file), false, `Fresh installation requires absent ${file}`);
  }
  const manifest = JSON.parse(fs.readFileSync(`${candidate}/docker-source.json`));
  console.log('Candidate:', JSON.stringify(manifest));
  const version = require(`${candidate}/package.json`).version;
  const tag = `v${version}`;
  // Install exactly this candidate, including uncommitted reviewable changes.
  // Git's local mirror replaces only MultiCC's clone URL; npm uses real packages.
  await run('git', ['config', '--global', 'user.name', 'MultiCC install test'], candidate);
  await run('git', ['config', '--global', 'user.email', 'test@multicc.invalid'], candidate);
  await run('git', ['config', '--global', 'init.defaultBranch', 'main'], candidate);
  await run('git', ['init'], candidate);
  await run('git', ['add', '.'], candidate);
  await run('git', ['commit', '--quiet', '-m', 'Exact release candidate'], candidate);
  await run('git', ['tag', tag], candidate);
  await run('git', ['config', '--global', 'url.file:///candidate.insteadOf', 'https://github.com/lsjwzh/MultiCC.git'], candidate);
  await run('bash', [`${candidate}/install.sh`, '--branch', tag, '--dir', installed,
    '--no-service', '--token', 'clean-install-test', '--port', '3000'], '/home/node');
  assert.ok(fs.existsSync(path.join(installed, 'node_modules/better-sqlite3')));
  assert.equal(fs.statSync(path.join(installed, '.env')).mode & 0o777, 0o600);
  assert.equal(require(`${installed}/package.json`).version, version);
  assert.equal(JSON.parse(fs.readFileSync(`${installed}/docker-source.json`)).sourceDigest, manifest.sourceDigest);
  fs.accessSync(`${installed}/docker/task-shell/fake-codex.js`, fs.constants.X_OK);
  const env = { ...process.env, MULTICC_DATA_DIR: dataDir, MULTICC_MEMORY_ROOT: `${dataDir}/memories`, MULTICC_SHELL_BROWSER_TEST: '1',
    CODEX_CMD: `${installed}/docker/task-shell/fake-codex.js`,
    CLAUDE_CMD: '/nonexistent/claude', CLAUDE_BIN: '/nonexistent/claude',
    OPENCODE_CMD: '/nonexistent/opencode', QODER_CMD: '/nonexistent/qoder' };
  await run(process.execPath, ['docker/task-shell/installed-smoke.js'], installed, env);
  await run(process.execPath, ['docker/task-shell/run-tests.js'], installed, env);
  console.log('PASS clean-install release gate:', JSON.stringify({ ...manifest, version, node: process.version, platform: process.platform, arch: process.arch }));
})().catch(error => { console.error(error); process.exitCode = 1; });
