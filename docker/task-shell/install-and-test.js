'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

// This program only operates inside a disposable, source-only container.
//
// Release gate, in the order that matters:
//   1. build the standalone package from this exact source (network only:
//      nodejs.org for the pinned runtime, npm for production dependencies);
//   2. install it through install.sh, the way a user does — from the package,
//      not from a git checkout;
//   3. boot it through the `multicc` command it ships, and prove a real
//      session survives a stop/start;
//   4. only then install this checkout's dev dependencies and run the
//      regression suites, which are about the app and belong in the source tree.
//
// Steps 2-3 run in a container with no node_modules, no git repo and no
// globally installed Node — that is what makes the standalone claim meaningful.
const candidate = '/candidate', installed = '/home/node/installed';
const dataDir = '/home/node/clean-install-data';
const standaloneHome = '/home/node/.multicc-standalone';
const outDir = '/tmp/dist-standalone';
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
  for (const file of [installed, dataDir, standaloneHome, outDir,
    `${candidate}/node_modules`, `${candidate}/.git`, `${candidate}/.env`]) {
    assert.equal(fs.existsSync(file), false, `Fresh installation requires absent ${file}`);
  }
  const manifest = JSON.parse(fs.readFileSync(`${candidate}/docker-source.json`));
  console.log('Candidate:', JSON.stringify(manifest));
  const version = require(`${candidate}/package.json`).version;

  // 1) Build the release artifact from this source. This is the same script the
  // release workflow runs, so a package that cannot be built here cannot be
  // published either.
  await run(process.execPath, ['scripts/standalone-bundle.js',
    '--platform', 'linux', '--arch', process.arch, '--out', outDir], candidate);
  const bundleName = `multicc-standalone-${version}-linux-${process.arch}`;
  const archive = path.join(outDir, `${bundleName}.tar.gz`);
  assert.ok(fs.existsSync(archive), `the bundle builder must produce ${path.basename(archive)}`);
  assert.ok(fs.existsSync(`${archive}.sha256`), 'a package without its checksum sidecar cannot be installed');

  // 2) Install it exactly as a user would: the published script, the published
  // package, no source checkout involved.
  await run('bash', [`${candidate}/install.sh`, '--from', archive, '--dir', installed,
    '--no-service', '--token', 'clean-install-test', '--port', '3000'], '/home/node',
  { ...process.env, MULTICC_STANDALONE_HOME: standaloneHome });

  // 3) The installed tree must stand on its own: its own runtime, its own
  // command, and all writable state outside the package so the next upgrade is
  // a plain replacement.
  assert.equal(fs.statSync(path.join(installed, 'multicc')).mode & 0o111, 0o111, 'multicc must be executable');
  const runtime = path.join(installed, 'Resources', 'runtime', 'bin', 'node');
  fs.accessSync(runtime, fs.constants.X_OK);
  assert.equal(require(`${installed}/Resources/bundle-manifest.json`).version, version);
  assert.equal(fs.existsSync(path.join(installed, 'multicc.env')), false,
    'configuration must not be written inside the package');
  assert.equal(fs.existsSync(path.join(installed, '.env')), false,
    'configuration must not be written inside the package');
  const configFile = path.join(standaloneHome, 'multicc.env');
  assert.equal(fs.statSync(configFile).mode & 0o777, 0o600, 'the access token must stay owner-only');
  const config = fs.readFileSync(configFile, 'utf8');
  assert.match(config, /^ACCESS_TOKEN=clean-install-test$/m);
  assert.match(config, /^PORT=3000$/m);
  // Storage ships inside the runtime (node:sqlite since 22.5). Proving the
  // *shipped* runtime can open a database is the meaningful check — and the one
  // a host `node` could never make on its behalf.
  await run(runtime, ['--disable-warning=ExperimentalWarning', '-e',
    "const { DatabaseSync } = require('node:sqlite'); new DatabaseSync(':memory:').close();"], installed);

  const smokeEnv = { ...process.env, MULTICC_STANDALONE_HOME: standaloneHome, MULTICC_DATA_DIR: dataDir,
    MULTICC_MEMORY_ROOT: `${dataDir}/memories`, MULTICC_SHELL_BROWSER_TEST: '1',
    CODEX_CMD: `${candidate}/docker/task-shell/fake-codex.js`,
    CLAUDE_CMD: '/nonexistent/claude', CLAUDE_BIN: '/nonexistent/claude',
    OPENCODE_CMD: '/nonexistent/opencode', QODER_CMD: '/nonexistent/qoder' };
  delete smokeEnv.ACCESS_TOKEN; // The config install.sh wrote is the only source.
  await run(process.execPath, [`${candidate}/docker/task-shell/installed-smoke.js`], installed, smokeEnv);

  // 4) Only now, with the install proven on a pristine machine, bring in the
  // dev dependencies the app's own suites need. They test the application, and
  // the source checkout is where they were written to run.
  await run('npm', ['ci', '--no-audit', '--no-fund'], candidate);
  const regressionData = path.join(dataDir, 'regression');
  await run(process.execPath, ['docker/task-shell/run-tests.js'], candidate, {
    ...smokeEnv,
    MULTICC_DATA_DIR: regressionData,
    MULTICC_MEMORY_ROOT: `${regressionData}/memories`,
    MULTICC_ENV_FILE: path.join(dataDir, 'regression.env'),
  });
  console.log('PASS clean-install release gate:', JSON.stringify({ ...manifest, version, node: process.version, platform: process.platform, arch: process.arch }));
})().catch(error => { console.error(error); process.exitCode = 1; });
