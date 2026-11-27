'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn: systemSpawn } = require('node:child_process');

// The service stop can use taskkill /T, even for detached Node children. A
// short-lived PowerShell parent hands off to an updater outside that tree.
async function startWindowsStandaloneUpdate({
  bundleRoot, logPath, targetVersion, port, env = process.env, from, noStart = false, waitForPid,
  spawn = systemSpawn,
}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-win-update-'));
  const worker = path.join(temp, 'update.ps1');
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'windows-standalone-update.ps1'), worker);
    fs.writeFileSync(path.join(temp, 'request.json'), JSON.stringify({
      bundleRoot, logPath, targetVersion: targetVersion || 'latest', port, from, noStart, waitForPid,
    }));
    fs.writeFileSync(logPath, `__MULTICC_UPDATE_START__ ${new Date().toISOString()} force=0 target=${String(targetVersion || '').replace(/^v/, '')}\n`);
    const childEnv = { ...env };
    delete childEnv.MULTICC_STANDALONE_DETACHED;
    // install.ps1 reads the install's configured port and pin on replacement.
    // A copy of the running server's PORT would inadvertently create a pin.
    delete childEnv.PORT;
    const relay = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', worker, '-Launch',
    ], { cwd: os.tmpdir(), env: childEnv, windowsHide: true, stdio: 'ignore' });
    await new Promise((resolve, reject) => {
      relay.once('error', reject);
      relay.once('exit', code => code === 0 ? resolve() : reject(new Error(`PowerShell 启动升级进程失败（${code}）`)));
    });
    return relay;
  } catch (error) {
    fs.rmSync(temp, { recursive: true, force: true });
    fs.appendFileSync(logPath, `${error.message}\n__MULTICC_UPDATE_EXIT__ 1\n`);
    throw error;
  }
}

module.exports = { startWindowsStandaloneUpdate };
