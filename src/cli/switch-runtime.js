'use strict';

const { desiredSession, configurationBusy, stageConfiguration } = require('../session/pending-configuration');
const { isChatStateBusy } = require('../session/runtime-busy');
const cliUpstream = require('./cli-upstream-version');
const capability = require('./cli-capability');
const homebrewTakeover = require('./homebrew-takeover');

const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');

// 官方 CLI 安装命令表(单一事实源: src/cli/cli-capability.js 的家族 update 列)。
// display 同 command。静态表无用户输入拼接, 命令直接喂给 bash -c。
//
// **键是家族, 不是车道** —— 这一列原先按车道手写, 于是 codex 与 codex-exp 两条车道
// 各占一行、跑同一条命令, 而 claude-exp 的引擎(Agent SDK)是 multicc 自己的依赖、根本
// 没有制品, 只能挤出一行「请升级 MultiCC」。升级的对象是 CLI 制品, 而制品属于家族:
// 两条车道一个二进制、一条安装脚本。所以这一列从目录里派生, 车道 id 需要先落到家族
// (见 installTargetOf), 面板也就自然是「一行一个 CLI」。
const OFFICIAL_INSTALL_SPECS = Object.freeze(Object.fromEntries(
  Object.entries(capability.updateSpecs()).map(([family, spec]) => [
    family,
    Object.freeze(spec.auto
      ? { auto: true, command: spec.command, display: spec.command }
      : { auto: false, manual: spec.manual }),
  ]),
));

// 15 分钟不是随手放宽, 是按最坏路径算的: codex 的官方安装脚本自己 metadata 30s +
// asset 300s, 而它在 releases.openai.com 不可达时会退到 GitHub Releases 把整套再来
// 一遍(≈11 分钟)。原来的 8 分钟会在这种情况下 SIGKILL 掉一个其实正在正常下载的进程。
// 对 npm 车道无影响 —— npm 自己的 fetch-timeout 更短, 够不到这条线。
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000;
const INSTALL_LOG_TAIL = 12 * 1024; // 环形 buffer 保留尾部约 12KB
const INSTALL_JOB_CAPACITY = 50;

// CLI 版本探测: 只报告 multicc 实际派生的那个二进制(`<bin> --version`)的当前
// 版本, 不联网比对、不自动升级、不替换二进制。结果按 runtime 实例缓存 1 天
// (与 installJobs 同级), 懒探测: 打开面板时才跑一次, 之后走缓存。
// SessionStart hook 曾把 qoder 报成 1.0.45(读错产物), 而真正派生的是 1.1.4——
// 这里统一以 resolveCliCommands() 解析出的、与派生会话同一个二进制为准。
const CLI_VERSION_TTL_MS = 24 * 60 * 60 * 1000;
// 比 install 短得多: --version 是本地调用, 但个别 CLI 冷启动较慢, 给 8s 兜底。
const CLI_VERSION_TIMEOUT_MS = Number(process.env.CLI_VERSION_TIMEOUT_MS || 8000);
const CLI_VERSION_MAX_BUFFER = 64 * 1024;
// 随 MultiCC 走的引擎(目录里的 bundled 列)的版本。这类引擎不躺在家族的 CLI 制品
// 里 —— npm 上没有它、安装脚本也不含它 —— 所以既没有 `--version` 可探, 也没有
// 发布源可比: 版本就是 multicc 自己依赖里那一行, 升级它的唯一动作是升级 MultiCC。
// 今天只有 claude-exp(src/chat/claude-sdk-stream.js 直接 import
// '@anthropic-ai/claude-agent-sdk')。面板把这一行写成副标题, 而不是给它一颗装不了的
// 按钮 —— 旧表按车道铺开时, claude-exp 就是这么挤出一行假动作的。
const BUNDLED_ENGINE_VERSIONS = Object.freeze({
  'claude-exp': (() => {
    try {
      const value = require('../../package.json').dependencies?.['@anthropic-ai/claude-agent-sdk'];
      return typeof value === 'string' ? value.replace(/^[~^]/, '') : null;
    } catch (_) { return null; }
  })(),
});

// 最新版探测与本地版本探测分开缓存: 上游 registry 会超时/限流, 本地 `--version`
// 不会。两者共用一个 TTL, 但互不覆盖 —— 上游挂了不该让「当前版本」这一栏也空掉。
const CLI_LATEST_TTL_MS = 24 * 60 * 60 * 1000;
// 启动后先等一会儿再探, 别和进程启动时的其它初始化抢网络/CPU。
const UPDATE_WATCH_STARTUP_DELAY_MS = 15 * 1000;
const UPDATE_WATCH_INTERVAL_MS = 24 * 60 * 60 * 1000;

function cliHandoffSummary(session) {
  const handoff = session && session.pendingCliHandoff;
  return handoff ? {
    id: handoff.id,
    fromCli: handoff.fromCli,
    toCli: handoff.toCli,
    status: handoff.status,
    reason: handoff.reason || null,
    createdAt: handoff.createdAt,
    reusedTarget: !!handoff.reusedTarget,
  } : null;
}

function requireFunction(options, name) {
  if (typeof options[name] !== 'function') {
    throw new TypeError(`[cli-switch-runtime] ${name} is required`);
  }
}

function createCliSwitchRuntime(options) {
  if (!options || typeof options !== 'object') {
    throw new TypeError('[cli-switch-runtime] options are required');
  }
  const records = options.records;
  if (!records || typeof records.get !== 'function') {
    throw new TypeError('[cli-switch-runtime] records map is required');
  }
  const sessionPersistence = options.sessionPersistence;
  if (!sessionPersistence || typeof sessionPersistence.mutate !== 'function') {
    throw new TypeError('[cli-switch-runtime] sessionPersistence.mutate is required');
  }
  const supportedClis = options.supportedClis;
  if (!Array.isArray(supportedClis)) {
    throw new TypeError('[cli-switch-runtime] supportedClis array is required');
  }
  for (const name of [
    'getProviderDefaults', 'codexDefaultReasoningLevel', 'getHistory',
    'buildHandoffCheckpoint', 'activateCliState', 'rememberActiveCliState',
    'ensureCliStates', 'cliStateSummary', 'gitWorktreeSnapshot', 'cwdForSession',
    'getChatStream', 'hasLiveBackgroundTasks', 'cancelClassify', 'assignKillReason',
    'finishProviderAttempt', 'appendMessage',
    'appendEvent', 'chatBroadcast', 'workspaceBroadcast', 'saveBestEffort',
    'cliAvailabilitySummary', 'sessionProviderName', 'sessionProviderBaseUrl',
    'effectiveSessionModel',
    'effectiveSessionEffort', 'serializeSubagent',
  ]) requireFunction(options, name);

  const chatSessions = options.chatSessions;
  if (!chatSessions || typeof chatSessions.get !== 'function') {
    throw new TypeError('[cli-switch-runtime] chatSessions map is required');
  }
  const clock = options.clock || Date.now;
  const handoffIdFactory = options.handoffIdFactory
    || (() => `handoff_${crypto.randomBytes(8).toString('hex')}`);
  // specs/spawn 可由测试注入; 缺省用本文件常量与 lazy require 的 spawn。
  const installSpecs = options.installSpecs || OFFICIAL_INSTALL_SPECS;
  const spawnProcessOverride = options.spawnProcess;
  const homebrewOwnerOf = typeof options.homebrewOwnerOf === 'function'
    ? options.homebrewOwnerOf
    : homebrewTakeover.homebrewOwnerOf;
  // 安装任务表(模块内, 容量上限 50; 每个 runtime 实例独立, 便于测试隔离)。
  const installJobs = new Map();

  // 版本探测依赖(可注入以便测试)。cliCommands 缺省走 resolveCliCommands()——
  // 与 host 的 createCliAdapters 用的是同一个解析器, 故探测到的正是派生会话真正
  // 会 spawn 的那个二进制; execFile 缺省走 child_process, 测试可注入假实现。
  const cliCommandsOverride = options.cliCommands;
  const execFileVersionOverride = options.execFileVersion;
  const fetchLatestVersionOverride = options.fetchLatestVersion;
  const fetchLatestSourceOverride = options.fetchLatestVersionWithSource;
  const registryBaseOverride = options.registryBase;
  const versionCache = { at: 0, versions: null };
  // registry 与 latest 一起缓: 记下「这个新版是从哪个源读到的」, 安装时把同一个源
  // 交给 npm, 保证报得出的新版一定装得到(见 buildInstallEnv)。
  const latestCache = { at: 0, latest: null, registry: null };
  let updateWatchStarted = false;

  function resolveCliCommandMap() {
    if (cliCommandsOverride && typeof cliCommandsOverride === 'object') return cliCommandsOverride;
    try {
      return require('../cli-adapters/commands')
        .resolveCliCommands({ logger: { log() {}, warn() {} } });
    } catch (_) { return {}; }
  }

  function resolveExecFile() {
    if (typeof execFileVersionOverride === 'function') return execFileVersionOverride;
    return require('node:child_process').execFile;
  }

  function resolveFetchLatestVersion() {
    if (typeof fetchLatestVersionOverride === 'function') return fetchLatestVersionOverride;
    return pkg => cliUpstream.fetchLatestVersion(pkg, { registryBase: registryBaseOverride });
  }

  // 与 resolveFetchLatestVersion 同一件事, 但多带一个「哪个源答的」。注入的老接口
  // (只回版本号)继续被兼容: 包成 {version, registry: 显式源或 null}。
  function resolveFetchLatestVersionWithSource() {
    if (typeof fetchLatestSourceOverride === 'function') return fetchLatestSourceOverride;
    if (typeof fetchLatestVersionOverride === 'function') {
      return async pkg => ({ version: await fetchLatestVersionOverride(pkg), registry: registryBaseOverride || null });
    }
    return pkg => cliUpstream.fetchLatestVersionWithSource(pkg, { registryBase: registryBaseOverride });
  }

  function resolveSpawn() {
    if (typeof spawnProcessOverride === 'function') return spawnProcessOverride;
    return require('node:child_process').spawn;
  }

  function makeInstallJobId() {
    return `cli-install_${crypto.randomBytes(8).toString('hex')}`;
  }

  // 环形日志缓冲: 保留尾部约 12KB(stdout+stderr 合并)。
  function createLogRing(cap = INSTALL_LOG_TAIL) {
    let buf = '';
    return {
      push(text) {
        if (text == null) return;
        buf += String(text);
        if (buf.length > cap * 2) buf = buf.slice(-cap);
      },
      tail() {
        return buf.length > cap ? buf.slice(-cap) : buf;
      },
    };
  }

  // 根据安装日志识别常见失败类别, 给出可操作的中文提示(证书/网络/缺依赖)。
  // 安装命令本身正确, 但官方安装器内部的 HTTPS/解压/权限步骤会因用户本机环境
  // (如 VPN/代理拦截 TLS) 失败; 仅给"退出码 N"用户无从排查, 故补 hint。
  function classifyInstallHint(logTail) {
    const text = String(logTail || '');
    if (!text) return null;
    if (/certificate|cert verification|\btls\b|\bssl\b|handshake/i.test(text)) {
      return '安装程序的 HTTPS 请求证书校验失败，通常由 VPN / 网络代理 / 抓包工具拦截 HTTPS 引起。可尝试关闭 VPN/代理后重试，或在终端手动执行上面的命令。';
    }
    if (/No binary available|Failed to download|Could not resolve|connection (timed out|refused)|network is unreachable|temporary failure/i.test(text)) {
      return '下载发布信息或二进制失败，多为网络不通或被代理拦截。可检查网络/代理后重试，或在终端手动执行上面的命令。';
    }
    if (/EEXIST/.test(text)) {
      return '目标位置已有一个不是 npm 装的同名文件（例如 Homebrew 或其它渠道装的旧版），npm 拒绝覆盖。请先卸载那份旧安装再重试。';
    }
    if (/is required but not installed|Neither curl nor wget/i.test(text)) {
      return '缺少安装所需的命令行工具（如 curl / unzip / tar）。请先安装相应工具后重试。';
    }
    return null;
  }

  function findRunningInstallJob(cli) {
    // 串行键是「安装目标」而不是「CLI 名」: codex 与 codex-exp 派生同一个二进制、
    // 跑同一条安装命令, 两个并发任务会互相踩(以前是 npm 的全局目录, 现在是安装脚本
    // 的 install.lock 与 current 软链)。同目标必须串行, 不同目标可以并行。
    const target = installTargetKey(cli);
    for (const job of installJobs.values()) {
      if (job.status === 'running' && installTargetKey(job.cli) === target) return job;
    }
    return null;
  }

  function installTargetKey(cli) {
    const spec = installSpecs[installTargetOf(cli)];
    const command = spec && typeof spec.command === 'string' ? spec.command.trim() : '';
    return command || `cli:${installTargetOf(cli)}`;
  }

  // 车道 id → 升级目标(家族)。升级的对象是家族的 CLI 制品; 车道只是它的一个使用
  // 场景(令牌、会话记录、路由都持久化车道 id, 所以 id 不动, 只是落到同一个制品上)。
  // 先在 spec 表里精确命中(表本身就是家族键, 也给测试注入的车道键留着这条路),
  // 落不到再问目录。目录不认识的 id 原样返回, 由调用方判 400。
  function installTargetOf(cli) {
    const key = String(cli == null ? '' : cli).trim().toLowerCase();
    if (installSpecs[key]) return key;
    return capability.familyOf(key) || key;
  }

  // 探测/上报的计划: 一个家族一行。两个组成都由目录推导 ——
  // ① 「谁代言家族的 CLI 制品」= 家族里第一条已支持的非 bundled 车道(它解析出的
  //    二进制就是命令表里那一条);
  // ② 「哪些引擎随 MultiCC 走」= 目录的 bundled 列。
  // 手写过一版按车道铺开的表, 于是 codex 与 codex-exp 变成两行跑同一条命令,
  // claude-exp 变成一行只能回「请升级 MultiCC」的假动作。
  // 一个家族若只有 bundled 车道(今天没有), 它没有制品可升级, 也就不出现在这里。
  function familyTargets() {
    const targets = new Map();
    for (const cli of supportedClis) {
      const family = installTargetOf(cli);
      if (targets.has(family) || capability.isBundled(cli)) continue;
      targets.set(family, cli);
    }
    return targets;
  }

  // 随 MultiCC 走的引擎: 版本读本机依赖, 可用性沿用宿主的口径。面板把它写成
  // 副标题, 好让用户知道这条车道的引擎由谁负责升 —— 升级面板不碰它。
  function bundledEnginesOf(family, availability) {
    return capability.bundledEnginesOf(family).map(engine => ({
      ...engine,
      available: !!(availability[engine.lane] && availability[engine.lane].available),
      version: BUNDLED_ENGINE_VERSIONS[engine.lane] || null,
    }));
  }

  function serializeInstallJob(job) {
    return {
      id: job.id,
      cli: job.cli,
      status: job.status,
      command: job.command,
      target: job._target || null,
      startedAt: job.startedAt,
      endedAt: job.endedAt,
      exitCode: job.exitCode,
      error: job.error,
      // job.hint 优先: 它是「命令成功但没作用到派生的二进制」这类我们已经查明的
      // 具体原因, 比按日志正则猜出来的通用提示更准。
      hint: job.hint || classifyInstallHint(job._log.tail()),
      registry: job._registry || null,
      logTail: job._log.tail(),
    };
  }

  // 从 `--version` 输出里提取语义化版本号。兼容 "1.1.4"、"claude v2.0.1"、
  // "codex-cli 0.20.0"、"opencode 0.1.48 (cli)" 等噪声: 取第一个 x.y.z 片段。
  function parseCliVersion(stdout) {
    const text = String(stdout || '');
    const match = text.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/);
    return match ? match[0] : null;
  }

  // 探测单个二进制的当前版本。永不 reject: 失败也回 {version:null, error},
  // 让上层把"探测不到"如实呈现, 而不是让整个接口 500。
  function probeCliVersion(cmd) {
    return new Promise((resolve) => {
      const execFile = resolveExecFile();
      let settled = false;
      const done = (result) => { if (!settled) { settled = true; resolve(result); } };
      try {
        execFile(cmd, ['--version'], {
          timeout: CLI_VERSION_TIMEOUT_MS,
          maxBuffer: CLI_VERSION_MAX_BUFFER,
          windowsHide: true,
        }, (err, stdout, stderr) => {
          const version = parseCliVersion(stdout) || parseCliVersion(stderr);
          if (version) return done({ version, error: null });
          done({
            version: null,
            error: err ? String(err.message || err).slice(0, 200) : 'version not parseable',
          });
        });
      } catch (err) {
        done({ version: null, error: String((err && err.message) || err).slice(0, 200) });
      }
    });
  }

  // 「哪些 CLI 现在有会话在用」。升级是就地替换二进制: 正在跑的进程持有旧 inode,
  // 本身不受影响, 但升级瞬间新起的 turn 可能读到半写状态。前端拿这个数字把确认框
  // 的文案说准 —— 只提示, 不阻断。计数按家族: 升级换的是家族的制品, 用着这个家族
  // 任一车道的会话(codex 与 codex-exp)都得算进去。
  // 逐会话 try: 读不出来就少报一个, 绝不抛。
  function cliInUseCounts() {
    const counts = {};
    if (typeof records.values !== 'function') return counts;
    for (const session of records.values()) {
      const cli = session && session.cli;
      const id = session && session.id;
      if (!cli || !id) continue;
      try {
        if (chatSessions.has(id) || options.hasLiveBackgroundTasks(id)) {
          const family = installTargetOf(cli);
          counts[family] = (counts[family] || 0) + 1;
        }
      } catch (_) { /* 只影响提示文案 */ }
    }
    return counts;
  }

  // 本地 `--version` 探测(原样保留: 不可用的 CLI 标记 available:false 且不 spawn,
  // 避免 ENOENT 噪声与无谓子进程; 并发进行, 单个失败不影响其它)。
  // 按家族一行: 副标题里随 MultiCC 走的引擎只报版本, 不探测(bundledEnginesOf)。
  async function probeLocalVersions({ force }) {
    const now = clock();
    if (!force && versionCache.versions && (now - versionCache.at) < CLI_VERSION_TTL_MS) {
      return { versions: versionCache.versions, at: versionCache.at, cached: true };
    }
    const commands = resolveCliCommandMap();
    const availability = options.cliAvailabilitySummary() || {};
    const next = {};
    await Promise.all([...familyTargets()].map(async ([family, lane]) => {
      const cmd = commands[lane] || null;
      const avail = !!(availability[lane] && availability[lane].available);
      const bundled = bundledEnginesOf(family, availability);
      if (!cmd || !avail) {
        next[family] = { cmd: cmd || null, available: false, version: null, error: null, bundled };
        return;
      }
      const probed = await probeCliVersion(cmd);
      next[family] = { cmd, available: true, version: probed.version, error: probed.error, bundled };
    }));
    versionCache.at = now;
    versionCache.versions = next;
    return { versions: next, at: now, cached: false };
  }

  // 上游最新版。只对「已安装 且 有 npm 源」的 CLI 发请求: qoder(curl 脚本安装)与
  // zcode(手动装桌面版)没有可比对的发布源, 一律 latest:null —— 前端据此显示
  // 「无法检测最新版」, 而不是把它当成「已是最新」。整体 best-effort: 解析不到就是
  // null, 永不 reject。
  async function probeLatestVersions({ force, versions }) {
    const now = clock();
    const fresh = !force && latestCache.latest && (now - latestCache.at) < CLI_LATEST_TTL_MS;
    if (fresh) {
      return { latest: latestCache.latest, registry: latestCache.registry, at: latestCache.at, cached: true };
    }
    const fetchLatest = resolveFetchLatestVersionWithSource();
    const next = {};
    const usedRegistry = {};
    await Promise.all([...familyTargets().keys()].map(async (family) => {
      const pkg = cliUpstream.npmPackageFor(family);
      const entry = versions[family];
      if (!pkg || !entry || !entry.available) { next[family] = null; usedRegistry[family] = null; return; }
      try {
        const result = await fetchLatest(pkg);
        // 兼容两种注入: 老接口回版本号, 新接口回 {version, registry}。
        next[family] = typeof result === 'string' ? result : (result && result.version) || null;
        usedRegistry[family] = (result && typeof result === 'object' && result.registry) || null;
      } catch (_) {
        next[family] = null;
        usedRegistry[family] = null;
      }
    }));
    latestCache.at = now;
    latestCache.latest = next;
    latestCache.registry = usedRegistry;
    return { latest: next, registry: usedRegistry, at: now, cached: false };
  }

  // 合并成对外契约。原有字段(cmd/available/version/error)一个不动, 只新增
  // latest/updateAvailable/updateSource/inUseCount/latestRegistry, 老客户端继续照旧读。
  // 键是**家族**(= 升级目标): 一个 CLI 一行, 由它带出随 MultiCC 走的引擎(bundled)。
  function decorateVersions(versions, latest, inUse = {}, registry = {}) {
    const out = {};
    for (const family of familyTargets().keys()) {
      const entry = versions[family] || { cmd: null, available: false, version: null, error: null, bundled: [] };
      const pkg = cliUpstream.npmPackageFor(family);
      const verdict = cliUpstream.classifyUpdate(entry.version, latest ? latest[family] : null);
      out[family] = {
        ...entry,
        bundled: entry.bundled || [],
        latest: verdict.latest,
        updateAvailable: verdict.updateAvailable,
        updateSource: pkg ? 'npm' : null,
        // 这个 latest 是从哪个 registry 读到的(null = 没读到)。面板拿它解释「为什么
        // 走的是镜像」, 升级则用同一个源去装。
        latestRegistry: (registry && registry[family]) || null,
        inUseCount: inUse[family] || 0,
      };
    }
    return out;
  }

  async function collectCliVersions({ force = false } = {}) {
    const local = await probeLocalVersions({ force });
    const upstream = await probeLatestVersions({ force, versions: local.versions });
    const versions = decorateVersions(local.versions, upstream.latest, cliInUseCounts(), upstream.registry);
    const updateCount = Object.values(versions).filter(entry => entry.updateAvailable).length;
    return {
      versions,
      cached: local.cached && upstream.cached,
      checkedAt: new Date(Math.max(local.at, upstream.at)).toISOString(),
      lastCheckedAt: new Date(local.at).toISOString(),
      latestCheckedAt: new Date(upstream.at).toISOString(),
      latestRegistries: upstream.registry || null,
      updateCount,
    };
  }

  function invalidateVersionCaches() {
    versionCache.at = 0;
    versionCache.versions = null;
    latestCache.at = 0;
    latestCache.latest = null;
    latestCache.registry = null;
  }

  // 启动后探一次, 之后每 24h 一次。两个 timer 都 unref: 检测永远不该把一个进程
  // 留在世上, 也不该在重启时拖住退出。检测失败只记一行日志 —— 待更新角标是纯提示,
  // 它坏了不能让服务坏。
  function startUpdateWatch() {
    if (updateWatchStarted) return updateWatchStarted;
    updateWatchStarted = true;
    const run = () => {
      Promise.resolve()
        .then(() => collectCliVersions({ force: true }))
        .catch(error => {
          const logger = options.logger || console;
          const message = (error && error.message) || String(error);
          if (logger && typeof logger.warn === 'function') {
            logger.warn(`[multicc] CLI update check failed: ${message}`);
          }
        });
    };
    const startup = setTimeout(run, UPDATE_WATCH_STARTUP_DELAY_MS);
    if (typeof startup.unref === 'function') startup.unref();
    const interval = setInterval(run, UPDATE_WATCH_INTERVAL_MS);
    if (typeof interval.unref === 'function') interval.unref();
    return true;
  }

  // spawn 的 PATH 追加常见二进制目录(homebrew/local/user-local)。
  function buildInstallEnv(cli) {
    const target = installTargetOf(cli);
    const extra = ['/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local/bin')];
    const env = { ...process.env, PATH: [process.env.PATH, ...extra].filter(Boolean).join(':') };
    // 「在哪个源上看到新版，就在哪个源上装」：检测走了兜底镜像（官方源不可达）时，
    // 必须把同一个源交给 npm，否则升级命令会去打一个连不上的官方源 —— 用户看到的
    // 就是「明明说有新版，升级却总是失败」。只作用于这次安装子进程，不写任何配置。
    const registry = (latestCache.registry && latestCache.registry[target]) || null;
    if (registry) env.npm_config_registry = registry;
    // 上面这条只对 npm 车道有效。codex 是 curl 车道(见 OFFICIAL_INSTALL_SPECS), 它没有
    // 「检测源 = 安装源」的问题, npm_config_registry 对它是个无害的空操作。
    const installEnv = CLI_INSTALL_ENV[target];
    if (installEnv) Object.assign(env, installEnv);
    return env;
  }

  // 各 CLI 安装命令需要的额外环境变量。与命令字符串分开, 是为了让 display 与官方
  // 文档一字不差, 同时不靠 shell 里 `VAR=1 cmd` 的作用域把戏。
  // codex: 官方安装脚本里有两个交互 prompt —— handle_conflicting_install 问「要不要
  // 卸掉现有的 npm 版 codex」、maybe_launch_codex_now 问「现在启动 codex 吗」。
  // 无 TTY 时 prompt_yes_no 已经默认答「否」, 所以不设也不会挂死; 但那是巧合, 显式
  // 声明才是契约 —— 尤其 get() 那个若答"是"会把 codex TUI 拉起来, 直接吊死 install job。
  // 键是安装目标(家族): codex 与 codex-exp 派生同一个二进制、跑同一条命令, 所以只有
  // 一行 —— 车道各占一行是旧表按车道铺开时的产物, 那也正是串行保护要额外兜的坑。
  const CLI_INSTALL_ENV = Object.freeze({
    codex: { CODEX_NON_INTERACTIVE: '1' },
  });

  // 各 CLI 用来覆盖可执行文件路径的环境变量(与 cli-adapters/commands.js 一致),
  // 用于「升级没作用到派生二进制」时给出可直接照做的出路。
  const CLI_CMD_ENV = Object.freeze({
    claude: 'CLAUDE_CMD', codex: 'CODEX_CMD', 'codex-exp': 'CODEX_CMD',
    opencode: 'OPENCODE_CMD', zcode: 'ZCODE_CMD', kimi: 'KIMI_CMD',
    qoder: 'QODER_CMD', codebuddy: 'CODEBUDDY_CMD', dsh: 'DSH_CMD',
    gemini: 'GEMINI_CMD', grok: 'GROK_CMD',
  });

  // 「命令成功」不等于「multicc 派生的那个二进制升级了」。实测: 同一台机器上 claude
  // 既有原生安装(~/.local/bin/claude, 也是 multicc 优先派生的那个)又有 npm 全局安装,
  // `npm install -g` 把新版装进 /opt/homebrew, 派生路径纹丝不动 —— 面板上「有新版」的
  // 角标永不消失, 用户看到的就是「升级总是失败」。
  // 判据: 升级前就已知有新版, 升级后派生二进制的 `--version` 一个字符都没变 ->
  // 这次升级没作用到真正在用的那份, 如实报错并给出两条可照做的出路。
  async function verifyInstallReachedBinary(job, cli) {
    const before = job._beforeVersion;
    const expected = job._expectedLatest;
    if (!before || !expected) return; // 升级前就不知道版本/最新版 -> 不下结论
    if (cliUpstream.compareSemver(before, expected) >= 0) return; // 本来就不落后
    const cmd = resolveCliCommandMap()[cli];
    if (!cmd) return;
    const probed = await probeCliVersion(cmd);
    if (!probed || !probed.version) return; // 探不到就不下结论
    if (cliUpstream.compareSemver(before, probed.version) !== 0) return; // 真的换掉了
    job.status = 'error';
    job.error = `升级命令已完成，但 multicc 派生的 ${cmd} 仍是 v${before}`;
    job.hint = '新版本装到了另一个位置，multicc 实际派生的这个二进制没有变化。'
      + `解决办法二选一：① 设置环境变量 ${CLI_CMD_ENV[cli] || `${String(cli).toUpperCase()}_CMD`}`
      + ' 指向升级后的可执行文件，然后重启 multicc；'
      + `② 移除或重命名被派生的旧安装（${cmd}），让 multicc 回退到新装的那一份。`;
  }

  function launchInstallJob(cli) {
    const target = installTargetOf(cli);
    const spec = installSpecs[target];
    const env = buildInstallEnv(cli);
    // 派生二进制归 Homebrew 管时先卸掉它再 npm 装(见 homebrew-takeover.js)。
    // 探测失败按「不归 brew 管」处理, 照旧只跑 npm。
    let brewOwner = null;
    if (homebrewTakeover.isNpmGlobalInstall(spec.command)) {
      try { brewOwner = homebrewOwnerOf(resolveCliCommandMap()[cli], { envPath: env.PATH }); } catch (_) {}
    }
    const command = homebrewTakeover.takeoverCommand(brewOwner, spec.command);
    const jobId = makeInstallJobId();
    const startedAt = new Date(clock()).toISOString();
    const log = createLogRing();
    // 升级前的基线: 派生二进制的当前版本 + 我们已知的上游最新版。两者都有时, 命令跑完
    // 才能判断「这次升级到底有没有作用到真正在用的那个二进制」(见 verifyInstallReachedBinary)。
    // 缓存是冷的就不下结论 —— 宁可少一次诊断, 不可误报一次失败。
    const beforeEntry = (versionCache.versions && versionCache.versions[target]) || null;
    const job = {
      id: jobId, cli, status: 'running', command, startedAt,
      endedAt: null, exitCode: null, error: null, _log: log, _timer: null,
      hint: null,
      _target: installTargetKey(cli),
      _registry: (latestCache.registry && latestCache.registry[target]) || null,
      _beforeVersion: (beforeEntry && beforeEntry.version) || null,
      _expectedLatest: (latestCache.latest && latestCache.latest[target]) || null,
    };
    if (installJobs.size >= INSTALL_JOB_CAPACITY) {
      const oldest = installJobs.keys().next().value;
      if (oldest) installJobs.delete(oldest);
    }
    installJobs.set(jobId, job);

    const spawn = resolveSpawn();
    let proc;
    try {
      // 命令全来自静态表, 无用户输入拼接; 仅用 async spawn, 禁止同步子进程调用。
      proc = spawn('bash', ['-c', command], { env });
    } catch (err) {
      job.status = 'error';
      job.endedAt = new Date(clock()).toISOString();
      job.error = `安装进程启动失败: ${err && err.message || err}`;
      return job;
    }

    function clearTimer() {
      if (job._timer) { clearTimeout(job._timer); job._timer = null; }
    }

    const timer = setTimeout(() => {
      if (job.status !== 'running') return;
      try { proc.kill('SIGKILL'); } catch (_) {}
      job.status = 'error';
      job.endedAt = new Date(clock()).toISOString();
      job.error = '安装超时';
    }, INSTALL_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
    job._timer = timer;

    if (proc.stdout && typeof proc.stdout.on === 'function') {
      proc.stdout.on('data', (d) => log.push(d));
    }
    if (proc.stderr && typeof proc.stderr.on === 'function') {
      proc.stderr.on('data', (d) => log.push(d));
    }
    proc.on('error', (err) => {
      if (job.status !== 'running') return;
      clearTimer();
      job.status = 'error';
      job.endedAt = new Date(clock()).toISOString();
      job.error = `安装进程异常: ${err && err.message || err}`;
    });
    proc.on('exit', (code, signal) => {
      if (job.status !== 'running') return;
      clearTimer();
      job.endedAt = new Date(clock()).toISOString();
      job.exitCode = code == null ? null : code;
      if (code === 0) {
        // exit0 后复查可用性; PATH 仍找不到 -> error(中文文案)。
        const avail = options.cliAvailabilitySummary();
        if (avail && avail[cli] && avail[cli].available) {
          job.status = 'done';
          // 装/升级成功 -> 两份缓存都作废, 下一次读取立刻反映新版本(角标随之消失)。
          // 先同步作废缓存(调用方可能立刻再读 /api/cli/versions), 再异步做「升级
          // 真的作用到派生二进制了吗」的复查 —— 它能推翻上面这个 done。
          invalidateVersionCaches();
          Promise.resolve()
            .then(() => verifyInstallReachedBinary(job, cli))
            .catch(() => { /* 复查只是尽力而为, 失败不改状态 */ });
        } else {
          job.status = 'error';
          job.error = '安装已完成, 但未在 PATH 找到可执行文件, 请重开终端或手动配置 PATH';
        }
      } else {
        job.status = 'error';
        job.error = signal
          ? `安装失败, 信号 ${signal}`
          : `安装失败, 退出码 ${code}`;
      }
    });

    return job;
  }

  function cliSwitchDefaults(cli) {
    const providerDefaults = options.getProviderDefaults() || {};
    const providerPool = cli === 'codex-exp' ? 'codex' : cli === 'claude-exp' ? 'claude' : cli;
    return {
      provider: providerDefaults[providerPool] || null,
      model: null,
      effort: cli === 'codex' || cli === 'codex-exp' ? options.codexDefaultReasoningLevel() : null,
      subagent: null,
      agent: null,
    };
  }

  async function cliSwitchGitSnapshot(session) {
    const fallback = { branch: session.branch || null, head: null, changes: [] };
    try {
      const snapshot = await options.gitWorktreeSnapshot(
        options.cwdForSession(session),
        session.branch || null,
      );
      return { branch: snapshot.branch, head: snapshot.head, changes: snapshot.changes };
    } catch (_) {
      return fallback;
    }
  }

  function cliSwitchBusyState(sessionId) {
    const chat = chatSessions.get(sessionId);
    const stream = options.getChatStream().status(sessionId);
    // chat 运行时忙的唯一判定（src/session/runtime-busy.js）：切换 CLI 不能在
    // 还在收尾的轮次下面动 chat state。stream 是另一条独立的轴。
    const busy = !!(isChatStateBusy(chat) || (stream && (stream.busy || stream.queued > 0)));
    return { busy, cs: chat, stream };
  }

  function resetChatRuntimeForCli(chat, session) {
    if (!chat) return;
    options.assignKillReason(chat._activeRunner, 'cli_switch');
    if (chat._activeRunner?.providerAttempt) {
      options.finishProviderAttempt(chat._activeRunner.providerAttempt, {
        outcome: 'failed', errorCategory: 'cancelled', reasonCode: 'cli_switch',
      });
    }
    if (chat.claudeProc) {
      try { chat.claudeProc.kill('SIGTERM'); } catch (_) {}
      chat.claudeProc = null;
    }
    options.cancelClassify(chat);
    chat.cli = session.cli;
    chat.chatTurnCount = (session.cliSessionId || session._streamSessionId) ? 1 : 0;
    chat.lineBuf = '';
    chat.currentAssistantText = '';
    chat.currentToolCalls = [];
    chat.currentCost = null;
    chat.isStreaming = false;
    chat.streamReplay = [];
    chat._adapterError = null;
    chat._activeRunner = null;
    chat._activeTurn = null;
    chat._continuationLineage = null;
    chat._resultSaved = false;
    chat._sawApiError = false;
  }

  function performCliSwitch(session, targetCli, switchOptions = {}) {
    const fromCli = session.cli || 'claude';
    const now = clock();
    const checkpoint = options.buildHandoffCheckpoint({
      session,
      fromCli,
      toCli: targetCli,
      history: options.getHistory(session.id),
      git: switchOptions.gitSnapshot || { branch: session.branch || null, head: null, changes: [] },
      now,
    });
    const result = options.activateCliState(session, targetCli, {
      fresh: switchOptions.fresh === true,
      defaults: cliSwitchDefaults(targetCli),
      now,
    });
    const handoff = {
      id: handoffIdFactory(),
      fromCli,
      toCli: targetCli,
      createdAt: checkpoint.createdAt,
      status: 'pending',
      reusedTarget: result.reused,
      checkpoint,
    };
    session.pendingCliHandoff = handoff;

    options.rememberActiveCliState(session, now);
    const publish = () => {
      options.getChatStream().close(session.id);
      resetChatRuntimeForCli(chatSessions.get(session.id), session);
      if (switchOptions.forced === true) {
        options.chatBroadcast(session.id, { type: 'stream_end', reason: 'cli_switch' });
      }
      options.appendMessage(session.id, {
        role: 'system',
        content: `CLI switched from ${fromCli} to ${targetCli}. A structured handoff checkpoint will be delivered with the next message.`,
        ts: now,
        cliSwitch: {
          handoffId: handoff.id,
          fromCli,
          toCli: targetCli,
          reusedTarget: result.reused,
        },
      });
      options.appendEvent(
        session.dirId,
        'session_cli_changed',
        `${session.label || session.id}: ${fromCli} → ${targetCli}`,
        session.id,
      );
      options.chatBroadcast(session.id, {
        type: 'cli_switched',
        cli: targetCli,
        fromCli,
        handoffId: handoff.id,
        reusedTarget: result.reused,
        fresh: switchOptions.fresh === true,
        provider: session.provider || null,
        providerSelection: session.providerSelection || null,
        providerName: options.sessionProviderName(session),
        providerBaseUrl: options.sessionProviderBaseUrl(session),
        model: session.model || null,
        effectiveModel: options.effectiveSessionModel(session),
        effort: session.effort || null,
        effectiveEffort: options.effectiveSessionEffort(session),
        subagent: options.serializeSubagent(session.subagent),
      });
      if (session.dirId) {
        options.workspaceBroadcast(session.dirId, {
          type: 'session_cli_changed', sessionId: session.id, cli: targetCli,
        });
      }
    };
    if (!switchOptions.deferEffects) publish();
    return { result, handoff, publish };
  }

  function consumePendingCliHandoff(sessionName) {
    const session = records.get(sessionName);
    const handoff = session && session.pendingCliHandoff;
    if (!handoff || handoff.status !== 'pending') return false;
    session.lastCliHandoff = {
      id: handoff.id,
      fromCli: handoff.fromCli,
      toCli: handoff.toCli,
      createdAt: handoff.createdAt,
      consumedAt: new Date(clock()).toISOString(),
    };
    delete session.pendingCliHandoff;
    options.rememberActiveCliState(session);
    options.saveBestEffort('runtime.consume-cli-handoff');
    options.chatBroadcast(sessionName, {
      type: 'system',
      subtype: 'cli_handoff_applied',
      message: ['history_clear_keep', 'manual_native_context_rotate', 'auto_native_context_rotate'].includes(handoff.reason)
        ? `✓ 保留的上下文 checkpoint 已由 ${handoff.toCli} 的新原生会话接收`
        : `✓ ${handoff.fromCli} → ${handoff.toCli} 的上下文交接已由目标 CLI 接收`,
    });
    return true;
  }

  const isConfigurationBusy = id => configurationBusy(id, {
    getChatState: id => chatSessions.get(id), getChatStream: options.getChatStream,
    hasLiveBackgroundTasks: options.hasLiveBackgroundTasks, getPreparation: options.getPreparation,
  });

  function queueCliSwitch(session, targetCli, fresh) {
    const draft = JSON.parse(JSON.stringify(session));
    const pending = session.pendingConfiguration;
    if (pending?.cli === targetCli && pending.fresh === fresh) {
      Object.assign(draft, desiredSession(session));
    } else if ((session.cli || 'claude') !== targetCli || fresh) {
      options.activateCliState(draft, targetCli, { fresh, defaults: cliSwitchDefaults(targetCli) });
    }
    sessionPersistence.mutate('http.stage-cli-switch', () => stageConfiguration(session, draft, { fresh }));
    const event = { type: 'session_configuration_pending', sessionId: session.id,
      pendingConfiguration: session.pendingConfiguration };
    options.chatBroadcast(session.id, event);
    options.workspaceBroadcast(session.dirId, event);
    return { ok: true, changed: false, deferred: true, appliesOn: 'next_turn',
      cli: session.cli || 'claude', pendingConfiguration: session.pendingConfiguration,
      provider: session.provider || null, providerSelection: session.providerSelection || null,
      providerName: options.sessionProviderName(session), providerBaseUrl: options.sessionProviderBaseUrl(session),
      model: session.model || null, effectiveModel: options.effectiveSessionModel(session),
      effort: session.effort || null, effectiveEffort: options.effectiveSessionEffort(session),
      agent: session.agent || null, subagent: options.serializeSubagent(session.subagent),
      cliStates: options.cliStateSummary(session), cliAvailability: options.cliAvailabilitySummary() };
  }

  function applyPendingConfiguration(sessionId, turnOptions = {}) {
    const session = records.get(sessionId), pending = session?.pendingConfiguration;
    if (!pending) return true;
    // A retry/background continuation belongs to the original turn and route.
    if ((turnOptions.originContinue && !turnOptions.directUserInput)
        || turnOptions.bgTaskIds?.length || turnOptions.bgToolUseIds?.length) return true;
    if (isConfigurationBusy(sessionId)) {
      // A correlated input may still be steering the current warm turn.
      // Leave the usual admission policy in charge without changing its route.
      const chat = chatSessions.get(sessionId);
      return !!(turnOptions.originContinue && turnOptions.directUserInput
        && isChatStateBusy(chat));
    }
    if (!options.cliAvailabilitySummary()[pending.cli]?.available) return false;
    const target = JSON.parse(JSON.stringify(session));
    if (pending.cli !== (session.cli || 'claude') || pending.fresh) {
      options.activateCliState(target, pending.cli, { fresh: pending.fresh, defaults: cliSwitchDefaults(pending.cli) });
    }
    if ((target.cli === 'codex' || target.cli === 'codex-exp') && target.cliSessionId && target.provider !== pending.profile.provider) {
      options.synchronizeCodexSessionRoute({ logicalSessionId: session.id,
        nativeSessionId: target.cliSessionId, fromProviderId: target.provider,
        toProviderId: pending.profile.provider });
    }
    let switched;
    sessionPersistence.mutate('runtime.apply-pending-configuration', () => {
      if (pending.cli !== (session.cli || 'claude') || pending.fresh) {
        // Build the handoff now, so it contains the final output of the old CLI.
        switched = performCliSwitch(session, pending.cli, { fresh: pending.fresh, deferEffects: true });
      }
      Object.assign(session, pending.profile);
      delete session.pendingConfiguration;
      options.rememberActiveCliState(session);
    });
    if (switched) switched.publish();
    else if ((session.cli || 'claude') === 'claude') options.getChatStream().close(session.id);
    options.chatBroadcast(sessionId, { type: 'session_configuration_applied', sessionId });
    options.workspaceBroadcast(session.dirId, { type: 'session_configuration_applied', sessionId });
    options.appendEvent(session.dirId, 'session_configuration_applied', '已应用下一轮 AI 配置', sessionId);
    return true;
  }

  function mountRoutes(app, asyncHandler) {
    if (!app || typeof app.post !== 'function') throw new TypeError('[cli-switch-runtime] app.post is required');
    if (typeof app.get !== 'function') throw new TypeError('[cli-switch-runtime] app.get is required');
    if (typeof asyncHandler !== 'function') throw new TypeError('[cli-switch-runtime] asyncHandler is required');
    app.post('/api/sessions/:id/switch-cli', asyncHandler(async (req, res) => {
      const session = records.get(req.params.id);
      if (!session) return res.status(404).json({ error: 'session not found' });
      if (session.type === 'aux' || session.type === 'gateway') {
        return res.status(400).json({ error: 'system session must be switched by its bridge controller' });
      }
      if (session.kind !== 'chat') {
        return res.status(400).json({ error: 'only chat sessions can switch CLI' });
      }
      const targetCli = String(req.body && req.body.cli || '').trim().toLowerCase();
      if (!supportedClis.includes(targetCli)) {
        return res.status(400).json({ error: `cli must be one of: ${supportedClis.join(', ')}` });
      }
      const fresh = !!(req.body && req.body.fresh);
      if ((session.cli || 'claude') === targetCli && !fresh && !session.pendingConfiguration) {
        sessionPersistence.mutate('http.switch-cli-noop', () => options.ensureCliStates(session));
        return res.json({
          ok: true,
          changed: false,
          cli: targetCli,
          cliStates: options.cliStateSummary(session),
          cliAvailability: options.cliAvailabilitySummary(),
          pendingCliHandoff: cliHandoffSummary(session),
        });
      }
      const availability = options.cliAvailabilitySummary();
      if (!availability[targetCli]?.available) {
        return res.status(400).json({ error: `${targetCli} CLI is not installed or not executable` });
      }
      if (session.pendingConfiguration || isConfigurationBusy(session.id)) {
        return res.json(queueCliSwitch(session, targetCli, fresh));
      }
      const gitSnapshot = await cliSwitchGitSnapshot(session);
      // Git yields: a new turn may have started while we read the checkpoint.
      if (session.pendingConfiguration || isConfigurationBusy(session.id)) {
        return res.json(queueCliSwitch(session, targetCli, fresh));
      }
      const activity = { busy: false };
      const switched = sessionPersistence.mutate('http.switch-cli', () =>
        performCliSwitch(session, targetCli, {
          fresh, gitSnapshot, forced: activity.busy,
        }));
      return res.json({
        ok: true,
        changed: true,
        cli: session.cli,
        fromCli: switched.result.fromCli,
        handoffId: switched.handoff.id,
        reusedTarget: switched.result.reused,
        fresh,
        forced: activity.busy,
        cliStates: options.cliStateSummary(session),
        cliAvailability: availability,
        effectiveModel: options.effectiveSessionModel(session),
        effectiveEffort: options.effectiveSessionEffort(session),
        provider: session.provider || null,
        providerSelection: session.providerSelection || null,
        providerName: options.sessionProviderName(session),
        providerBaseUrl: options.sessionProviderBaseUrl(session),
        model: session.model || null,
        effort: session.effort || null,
        agent: session.agent || null,
        subagent: options.serializeSubagent(session.subagent),
      });
    }));

    app.get('/api/cli/install-specs', asyncHandler(async (req, res) => {
      return res.json({
        ok: true,
        // 键是家族(= 升级目标)。客户端拿到的是车道 id(选择器、会话记录都是车道),
        // 要问「这个车道怎么装」得先落到家族 —— web 侧用 provider-catalog 的
        // cliFamilyOf, App 侧用 cli_display.dart 的 cliFamilyOf。
        specs: installSpecs,
        // Host-level availability lets a brand-new client choose a working
        // default before any session exists. Previously the App could only
        // discover this through an existing session and guessed "Claude" on
        // an empty installation. 这一份仍是**车道**键: 可用性天然是「这个 id 能不能
        // 被派生」, 而 claude-exp 与 claude 是两条不同的派生路径。
        availability: options.cliAvailabilitySummary(),
      });
    }));

    // 面板/选择器只该给「家族的 CLI 制品」装东西。随 MultiCC 走的引擎(bundled 车道)
    // 没有可安装的制品: npm 上没有它、安装脚本也不含它 —— 拿家族的命令糊弄过去,
    // 用户会以为修好了。如实说去哪儿升。
    function bundledRefusal(cli) {
      const engines = capability.bundledEnginesOf(cli).map(engine => engine.engine).join(' / ');
      return `${capability.familyNameOf(cli)} 的引擎(${engines || '内置引擎'})随 MultiCC 一起发布，`
        + '请升级 MultiCC 本身来更新它';
    }

    app.post('/api/cli/:cli/install', asyncHandler(async (req, res) => {
      const cli = String((req.params && req.params.cli) || '').trim().toLowerCase();
      if (!supportedClis.includes(cli)) {
        return res.status(400).json({ ok: false, error: 'unsupported cli' });
      }
      if (capability.isBundled(cli)) {
        return res.status(400).json({ ok: false, manual: true, error: bundledRefusal(cli) });
      }
      const availability = options.cliAvailabilitySummary();
      if (availability && availability[cli] && availability[cli].available) {
        return res.json({ ok: true, alreadyInstalled: true, availability: { [cli]: availability[cli] } });
      }
      const spec = installSpecs[installTargetOf(cli)];
      if (!spec) {
        return res.status(400).json({ ok: false, error: 'unsupported cli' });
      }
      if (spec.auto === false) {
        return res.status(400).json({ ok: false, manual: true, error: spec.manual });
      }
      const running = findRunningInstallJob(cli);
      if (running) {
        return res.status(409).json({
          ok: false, running: true, jobId: running.id,
          // 串行是按「安装目标」判的, 所以可能是另一个 CLI(codex / codex-exp 跑同一条
          // npm 命令)占着。说清楚是谁在占, 比一个干巴巴的 409 有用。
          error: running.cli === cli
            ? `${cli} 的安装/升级任务正在进行中`
            : `${running.cli} 与 ${cli} 使用同一条安装命令，请等它跑完再试`,
        });
      }
      const job = launchInstallJob(cli);
      return res.status(202).json({ ok: true, jobId: job.id, cli: job.cli, command: job.command });
    }));

    app.get('/api/cli/install-status/:jobId', asyncHandler(async (req, res) => {
      const jobId = String((req.params && req.params.jobId) || '');
      const job = installJobs.get(jobId);
      if (!job) {
        return res.status(404).json({ ok: false, error: 'job not found' });
      }
      const availability = options.cliAvailabilitySummary();
      return res.json({
        ok: true,
        job: serializeInstallJob(job),
        availability: { [job.cli]: availability[job.cli] || { available: false } },
      });
    }));

    // GET /api/cli/versions — 报告 multicc 实际派生的每个 CLI 二进制的当前版本
    // (`<bin> --version`, 缓存 1 天, ?refresh=1 强制重探) 与上游发布的最新版。
    // 本地探测只读; 最新版只在 GET 时读缓存/按 TTL 重探, 绝不自动升级或替换二进制。
    // 待更新只是提示, 装不装由用户在浮层里点「升级」决定(POST .../upgrade)。
    app.get('/api/cli/versions', asyncHandler(async (req, res) => {
      const force = !!(req.query && (req.query.refresh === '1' || req.query.force === '1'));
      const result = await collectCliVersions({ force });
      return res.json({ ok: true, ...result });
    }));

    // POST /api/cli/:cli/upgrade — 跑官方安装命令做原地升级。
    // 刻意不复用 /install 的 `alreadyInstalled` 短路: 那条捷径的语义是「没装才装」,
    // 而升级的前提恰恰是已经装了。其余(同一 CLI 串行、INSTALL_TIMEOUT_MS 超时、
    // 日志尾部、失败分类提示)与安装完全同一条链路。成功后 exit 处理里会作废版本缓存。
    app.post('/api/cli/:cli/upgrade', asyncHandler(async (req, res) => {
      const cli = String((req.params && req.params.cli) || '').trim().toLowerCase();
      if (!supportedClis.includes(cli)) {
        return res.status(400).json({ ok: false, error: 'unsupported cli' });
      }
      if (capability.isBundled(cli)) {
        return res.status(400).json({ ok: false, manual: true, error: bundledRefusal(cli) });
      }
      const target = installTargetOf(cli);
      const spec = installSpecs[target];
      if (!spec) {
        return res.status(400).json({ ok: false, error: 'unsupported cli' });
      }
      if (spec.auto === false) {
        return res.status(400).json({ ok: false, manual: true, error: spec.manual });
      }
      const running = findRunningInstallJob(cli);
      if (running) {
        return res.status(409).json({
          ok: false, running: true, jobId: running.id,
          error: running.cli === cli
            ? `${cli} 的升级任务正在进行中`
            : `${running.cli} 与 ${cli} 使用同一条安装命令，请等它跑完再试`,
        });
      }
      const job = launchInstallJob(cli);
      return res.status(202).json({
        ok: true,
        jobId: job.id,
        cli: job.cli,
        command: job.command,
        inUseCount: cliInUseCounts()[target] || 0,
      });
    }));
  }

  return Object.freeze({
    mountRoutes,
    startUpdateWatch,
    cliSwitchDefaults,
    cliSwitchGitSnapshot,
    cliSwitchBusyState,
    performCliSwitch,
    consumePendingCliHandoff,
    applyPendingConfiguration,
  });
}

module.exports = { cliHandoffSummary, createCliSwitchRuntime, OFFICIAL_INSTALL_SPECS };
