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

// Ordered by usefulness; the tail scan returns the LAST informative line, so
// the most recent episode wins. `code` is machine-consumed by the monitor
// (e.g. traffic_exhausted suppresses futile auto-restarts).
const DIAGNOSIS_PATTERNS = [
  {
    re: /流量已耗尽/,
    code: 'traffic_exhausted',
    reason: 'SakuraFrp 流量耗尽（签到或购买流量后重启隧道）',
  },
  {
    re: /登录节点失败/,
    code: 'node_login_failed',
    reason: 'frpc 登录节点失败（检查网络或更换节点）',
  },
  {
    re: /隧道.{0,12}(不存在|已删除)|(?:不存在|已删除).{0,8}隧道/,
    code: 'tunnel_missing',
    reason: '隧道不存在或已被删除',
  },
  {
    re: /登录失败/,
    code: 'login_failed',
    reason: 'SakuraFrp 登录失败（API 不可达或访问密钥失效）',
  },
];

// Log lines that carry no diagnosis value — skip them while tail-scanning.
const UNINFORMATIVE = /由于出现严重错误|frpc 已退出|日志记录|初始化|开始登录|登录成功|开始加载隧道配置/;

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
    const lines = content.split('\n');
    for (let index = lines.length - 1; index >= 0 && index > lines.length - 400; index--) {
      const line = lines[index].trim();
      if (!line || UNINFORMATIVE.test(line)) continue;
      const hit = DIAGNOSIS_PATTERNS.find(pattern => pattern.re.test(line));
      if (!hit) continue;
      return {
        code: hit.code,
        reason: hit.reason,
        // 日志行带 "2026-09-15 11:40:56 " 前缀，剥掉再展示。
        detail: line.replace(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?\s*/, '').slice(0, 240),
        at: now(),
      };
    }
    return null;
  } catch (_) {
    return null;
  }
}

module.exports = { findSakuraLauncher, restartSakuraLauncher, processPattern, diagnoseSakurafrp };
