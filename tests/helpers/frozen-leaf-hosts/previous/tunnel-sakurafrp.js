'use strict';

const { getNative } = require('./native/binding');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function findSakuraLauncher({ platform = process.platform, home = os.homedir(), exists = fs.existsSync } = {}) {
  if (platform !== 'darwin') return null;
  const apps = ['/Applications/SakuraLauncher.app', path.join(home, 'Applications/SakuraLauncher.app')];
  return getNative().sakuraFindApp(apps, path.join, exists);
}

function processPattern(binary) {
  return '^' + binary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([[:space:]]|$)';
}

// The bundled frpc inherits the launcher's macOS sandbox. Executing it directly
// from Node crashes in libsecinit; LaunchServices must start the app, which owns
// the saved tunnel IDs, credentials, certificates and its frpc child process.
async function restartSakuraLauncher(app, {
  run, wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  const native = getNative();
  const binaries = native.sakuraLauncherPaths().map(file => path.join(app, file));
  const restart = new native.SakuraRestart();
  for (;;) {
    const action = restart.action;
    let result;
    if (action === 'wait') await wait(250);
    else if (action === 'open') result = await run('/usr/bin/open', ['-g', '-a', app]);
    else {
      const pattern = processPattern(binaries[restart.index]);
      result = action === 'probe'
        ? await run('/usr/bin/pgrep', ['-f', pattern])
        : await run('/usr/bin/pkill', ['-TERM', '-f', pattern]);
    }
    const ok = action === 'wait' || !!result.ok;
    const terminal = restart.advance(ok, !ok && action !== 'open' && result.code === 1);
    if (terminal) {
      if (terminal.ok) return terminal.message;
      throw new Error(terminal.message);
    }
  }
}

// ── Failure diagnosis ──────────────────────────────────────────────────────
// The URL probe only knows "the tunnel answers nothing"; the ACTIONABLE reason
// (流量耗尽 / 登录节点失败 / 密钥失效…) lives in natfrp-service's own log.
// Surface it so the manage page can show "诊断: SakuraFrp 流量耗尽" instead of
// leaving the user guessing why restarts never help.

const NATFRP_LOG_DIR = path.join(
  'Library', 'Containers', 'com.natfrp.launcher', 'Data',
  'Library', 'Application Support', 'natfrp-service', 'Logs',
);
const NATFRP_LOG_NAME = /^natfrp-service\.\d{8}\.log$/;

function diagnoseSakurafrp({
  home = os.homedir(),
  logDir = path.join(home, NATFRP_LOG_DIR),
  readdirSync = fs.readdirSync,
  readFileSync = fs.readFileSync,
  now = Date.now,
} = {}) {
  try {
    const files = readdirSync(logDir)
      .filter(name => NATFRP_LOG_NAME.test(name))
      .sort();
    if (!files.length) return null;
    // 单条日志 ≤ ~1MB，整读最稳；只看尾部 400 行足够覆盖最近一次故障周期。
    const content = readFileSync(path.join(logDir, files[files.length - 1]), 'utf8');
    return getNative().sakuraDiagnosis(content, now);
  } catch (_) {
    return null;
  }
}

module.exports = { findSakuraLauncher, restartSakuraLauncher, processPattern, diagnoseSakurafrp };
