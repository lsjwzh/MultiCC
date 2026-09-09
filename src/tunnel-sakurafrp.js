'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function findSakuraLauncher({ platform = process.platform, home = os.homedir(), exists = fs.existsSync } = {}) {
  if (platform !== 'darwin') return null;
  return ['/Applications/SakuraLauncher.app', path.join(home, 'Applications/SakuraLauncher.app')]
    .find(app => exists(path.join(app, 'Contents/MacOS/SakuraLauncher'))
      && exists(path.join(app, 'Contents/MacOS/natfrp-service.app/Contents/MacOS/natfrp-service'))) || null;
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
  const binaries = [
    path.join(app, 'Contents/MacOS/SakuraLauncher'),
    path.join(app, 'Contents/MacOS/natfrp-service.app/Contents/MacOS/natfrp-service'),
    path.join(app, 'Contents/MacOS/natfrp-service.app/Contents/MacOS/frpc'),
  ];
  async function running(binary) {
    const result = await run('/usr/bin/pgrep', ['-f', processPattern(binary)]);
    if (!result.ok && result.code !== 1) throw new Error('SakuraFrp 进程状态检查失败');
    return result.ok;
  }
  for (const binary of binaries) {
    if (!await running(binary)) continue;
    const stopped = await run('/usr/bin/pkill', ['-TERM', '-f', processPattern(binary)]);
    if (!stopped.ok && stopped.code !== 1) throw new Error('SakuraFrp 客户端停止失败');
    for (let check = 0; await running(binary); check++) {
      if (check >= 20) throw new Error('SakuraFrp 客户端尚未退出，未重复启动');
      await wait(250);
    }
  }
  const opened = await run('/usr/bin/open', ['-g', '-a', app]);
  if (!opened.ok) throw new Error('SakuraFrp 启动器打开失败');
  for (let check = 0; check < 20; check++) {
    if (await running(binaries[1])) return '已启动 SakuraFrp 启动器，等待公网复检';
    await wait(250);
  }
  throw new Error('SakuraFrp 核心服务未启动');
}

module.exports = { findSakuraLauncher, restartSakuraLauncher, processPattern };
