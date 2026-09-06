'use strict';
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const suites = [
  ['--test', 'tests/test-docker-task-shell.js', 'tests/test-task-shell-lab-service.js'],
  ['--test', 'tests/test-task-shells.js', 'tests/test-task-shell-http.js'],
  ['--test', 'tests/test-session-work-scheduler.js', 'tests/test-session-work-host.js',
    'tests/test-user-input-answer-delivery.js', 'tests/test-task-context-host.js', 'tests/test-task-bound-session.js'],
  ['tests/test-task-shell-isolated.js'],
  ['--test', 'tests/test-task-shell-cdp.js'],
];
async function run(args) {
  console.log(`\n[Docker regression] node ${args.join(' ')}`);
  const child = spawn(process.execPath, args, { stdio: 'inherit' });
  const stop = () => child.kill('SIGTERM');
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code)); });
    if (code !== 0) throw new Error(`Suite failed (${code}): ${args.join(' ')}`);
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
(async () => {
  fs.accessSync(process.env.MULTICC_CHROME_BIN, fs.constants.X_OK); // Browser test must not silently skip.
  fs.mkdirSync(process.env.MULTICC_DATA_DIR, { recursive: true });
  console.log('Source:', fs.readFileSync('docker-source.json', 'utf8'));
  console.log('Runtime:', process.version, process.platform, process.arch);
  for (const suite of suites) await run(suite);
  console.log('\nPASS Docker task-shell release gate (unit, HTTP, scheduler, server/SQLite/Git, Chromium)');
})().catch(error => { console.error(error); process.exitCode = 1; });
