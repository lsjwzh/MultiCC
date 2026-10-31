'use strict';

// 插件通道 —— 把 plugins/ 目录里的「自包含插件」接进 Air。
//
// 插件规范见 plugins/README.md。每个插件是一个自带 plugin.json 的目录：
//   • engine.binary 指向插件自带的可执行文件（Rust 实现，跨平台产物放
//     bin/<platform>-<arch>/，通道会先试平台目录再试原始路径）；
//   • commands 是允许调用的子命令白名单；
//   • ui 指向插件自带的 HTML 面板（GET /plugins/<id>/<ui 路径> 挂出，Air 的
//     插件面板用 iframe 嵌入，插件前端再走 /api/plugins/<id>/run 与自己的
//     二进制对话）。
//
// 语言边界（AGENTS.md：新后端功能默认 Rust）：本文件只做协议桥接 —— 发现
// manifest、spawn 二进制、转发 stdin/stdout JSON、挂静态文件 —— 不含业务
// 逻辑；插件的全部行为都住在插件自己的可执行文件里，目录复制进来即安装。
//
// 两个来源：程序目录的 plugins/ 放内置插件（随 MultiCC 发布）；从插件列表安装的
// 插件在 userPluginsDir（默认 ~/.multicc/plugins/），桌面版的程序目录只读。同一 id
// 两边都有时以内置为准，并在清单里报出冲突。插件列表（GitHub 上签名的 index.json）
// 由 src/plugins/catalog.js 拉取，这里把它和本机已装的合成每个插件的状态；安装、
// 更新、卸载、退回由 src/plugins/installer.js 做，只接受本机请求。
//
// 安全：插件目录来自仓库（或运维手动放置），但通道仍按不可信输入处理 ——
// id 白名单字符、command 必须在 manifest.commands、静态文件 realpath 必须
// 落在插件目录内、spawn 不走 shell、stdin/stdout 有超时与体积上限。

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const {
  PLUGIN_API_VERSION, appsReferenced, computeStates, createHostFacts, createPluginCatalog,
} = require('../plugins/catalog');
const { createPluginInstaller } = require('../plugins/installer');
const { createChannelHost, normalizeChannel } = require('../plugins/channel-host');
const channelRegistry = require('../plugins/channel-registry');
const { isLocalRequest: isLocalPeer } = require('../request-locality');

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;
const COMMAND_PATTERN = /^[a-z][a-z0-9-]*$/i;
const RUN_TIMEOUT_MS = 20_000;
const RUN_MAX_BUFFER = 4 * 1024 * 1024;
// 安装类错误码 → HTTP 状态（src/plugins/installer.js PluginInstallError）。
const INSTALL_ERROR_STATUS = {
  invalidId: 400, busy: 409, noPrevious: 409, notInstalled: 404,
  download: 502, size: 502, checksum: 502, package: 422, mismatch: 422,
};

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function readManifest(pluginsDir, id) {
  if (!ID_PATTERN.test(id)) return null;
  // 统一成绝对路径：resolveBinary 里 resolved 候选与目录前缀比较，相对/绝对
  // 混用会把合法产物误判成「目录外」。
  const dir = path.resolve(pluginsDir, id);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8'));
  } catch (_) {
    return null; // 无 manifest（如 plugins/bridges 这类内部模块目录）：不是插件
  }
  if (manifest.id !== id) return null;
  if (!Array.isArray(manifest.commands) || !manifest.commands.length) return null;
  const engine = manifest.engine || {};
  if (engine.type !== 'command' || typeof engine.binary !== 'string' || !engine.binary) return null;
  return { manifest, dir };
}

function resolveBinary({ manifest, dir }, platform, arch) {
  const engine = manifest.engine;
  const candidates = [];
  const binary = engine.binary;
  const base = path.basename(binary);
  // Windows 上 cargo 产物带 .exe，manifest 里写的是不带后缀的名字。
  const names = platform === 'win32' && !base.endsWith('.exe') ? [base, `${base}.exe`] : [base];
  if (engine.binaryPlatformDir) {
    for (const name of names) candidates.push(path.join(dir, engine.binaryPlatformDir, `${platform}-${arch}`, name));
  }
  candidates.push(path.join(dir, binary));
  if (names.length > 1) candidates.push(path.join(dir, `${binary}.exe`));
  for (const candidate of candidates) {
    // 只接受插件目录内的路径（binary 是相对路径拼进 dir，但配置可能写 ../）。
    const resolved = path.resolve(candidate);
    if (!resolved.startsWith(dir + path.sep)) continue;
    try {
      if (fs.statSync(resolved).isFile()) return resolved;
    } catch (_) { /* try next */ }
  }
  return null;
}

function pluginEntry(pluginsDir, id, platform, arch, source = 'builtin') {
  const found = readManifest(pluginsDir, id);
  if (!found) return null;
  const binary = resolveBinary(found, platform, arch);
  const manifest = found.manifest;
  return {
    id,
    source,
    requires: manifest.requires && typeof manifest.requires === 'object' && !Array.isArray(manifest.requires) ? manifest.requires : null,
    category: typeof manifest.category === 'string' ? manifest.category : null,
    provides: Array.isArray(manifest.provides) ? manifest.provides.filter(item => typeof item === 'string') : [],
    name: found.manifest.name || id,
    nameEn: found.manifest.nameEn || null,
    version: found.manifest.version || '0.0.0',
    description: found.manifest.description || '',
    descriptionEn: found.manifest.descriptionEn || null,
    icon: found.manifest.icon || '🧩',
    commands: found.manifest.commands,
    ui: found.manifest.ui || null,
    // 常驻插件与通知渠道（src/plugins/channel-host.js）：resident 由 MultiCC 拉起常驻，
    // channel 声明它能当提醒渠道。
    resident: manifest.engine.resident === true,
    channel: normalizeChannel(manifest.channel),
    engine: {
      type: 'command',
      available: Boolean(binary),
      reason: binary ? null : '插件二进制缺失：需要为当前平台构建（见插件 README）',
    },
  };
}

function createPluginsRoutes(deps) {
  const required = ['pluginsDir', 'platform', 'arch', 'logger'];
  for (const key of required) {
    if (!deps || !deps[key]) throw new TypeError(`[plugins] ${key} is required`);
  }
  const { pluginsDir, platform, arch, logger } = deps;
  // server.js 传 paths（src/paths.js 的 userPluginsDir / pluginCatalogDir）；测试直接给目录。
  const userPluginsDir = deps.userPluginsDir || (deps.paths && deps.paths.userPluginsDir) || null;
  const catalogDir = deps.catalogDir || (deps.paths && deps.paths.pluginCatalogDir) || null;
  const roots = [['builtin', pluginsDir], ...(userPluginsDir ? [['user', userPluginsDir]] : [])];
  const catalog = deps.catalog || (catalogDir ? createPluginCatalog({ cacheDir: catalogDir, logger }) : null);
  const hostFacts = deps.hostFacts || createHostFacts({ platform, arch });
  const isLocalRequest = deps.isLocalRequest || isLocalPeer;
  const installer = deps.installer || (userPluginsDir ? createPluginInstaller({
    root: userPluginsDir,
    platform,
    // 走统一出站（代理设置照常生效）；测试注入 deps.fetch。
    fetch: deps.fetch || ((...args) => require('../network/outbound').outboundFetch(...args)),
    inspect: (parent, id) => {
      const found = readManifest(parent, id);
      return found ? { manifest: found.manifest, binary: resolveBinary(found, platform, arch) } : null;
    },
    logger,
  }) : null);
  // MULTICC_PLUGIN_CATALOG_OFFLINE=1 只用缓存、不定时拉取（同 MULTICC_PRICE_TABLE_OFFLINE）。
  if (catalog && deps.autoRefresh && process.env.MULTICC_PLUGIN_CATALOG_OFFLINE !== '1') catalog.start();
  // 常驻插件（deps.resident 由 server.js 给：本服务的地址、告警交给哪个推送入口）。插件的
  // 数据目录与用户插件目录同级（~/.multicc/plugins-data/<id>/，隔离实例在各自数据根下）。
  const residentDataDir = deps.resident && (deps.resident.dataDir || (userPluginsDir && path.join(path.dirname(userPluginsDir), 'plugins-data')));
  const channelHost = residentDataDir ? createChannelHost({
    discover: () => scan().plugins.filter(plugin => plugin.resident).map(plugin => {
      const found = findManifest(plugin.id);
      return { ...plugin, dir: found && found.dir, binary: found ? resolveBinary(found, platform, arch) : null };
    }),
    dataDir: residentDataDir,
    platform,
    // server.js 只给端口（同一行守字节预算）；测试可以直接给 baseUrl。
    baseUrl: deps.resident.baseUrl || (deps.resident.port ? () => `http://127.0.0.1:${deps.resident.port()}` : null),
    alert: deps.resident.alert || (() => {}),
    logger,
    ...(deps.resident.overrides || {}),
  }) : null;
  if (channelHost && deps.resident.autoStart !== false) channelHost.start();
  // 推送订阅和钩子从登记处拿宿主投递（src/plugins/channel-registry.js）；测试可以不登记。
  if (channelHost && deps.resident.register !== false) channelRegistry.register(channelHost);

  function idsIn(dir) {
    try {
      return fs.readdirSync(dir, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
        .map(entry => entry.name)
        .sort();
    } catch (_) {
      return []; // 目录不存在：一台没有任何插件的安装是正常状态
    }
  }

  // { plugins, conflicts }：内置在前、同 id 的后置插件被内置盖住并记一笔。
  function scan() {
    const plugins = [];
    const conflicts = [];
    const seen = new Set();
    for (const [source, dir] of roots) {
      for (const id of idsIn(dir)) {
        const entry = pluginEntry(dir, id, platform, arch, source);
        if (!entry) continue;
        if (seen.has(id)) { conflicts.push(id); continue; }
        seen.add(id);
        plugins.push(entry);
      }
    }
    return { plugins, conflicts };
  }

  function listPlugins() {
    return scan().plugins;
  }

  // 按 id 找插件所在目录：与 scan() 同一优先级（内置先）。
  function findManifest(id) {
    for (const [, dir] of roots) {
      const found = readManifest(dir, id);
      if (found) return found;
    }
    return null;
  }

  async function catalogPayload(req) {
    const { plugins, conflicts } = scan();
    const snapshot = catalog ? catalog.snapshot() : { catalog: null, source: null, fetchedAt: null, updatedAt: null, error: null };
    const host = await hostFacts(appsReferenced(snapshot.catalog, plugins));
    const rows = computeStates({ catalog: snapshot.catalog, installed: plugins, host });
    // 只有从列表装进用户目录的插件能卸载、退回；内置和放在程序目录里的不归这里管。
    for (const row of rows) {
      const managed = Boolean(installer && row.local && row.local.source === 'user');
      row.removable = managed;
      row.rollbackVersion = managed ? installer.previousVersion(row.id) : null;
    }
    return {
      pluginApi: PLUGIN_API_VERSION,
      host: { os: host.os, arch: host.arch, osVersion: host.osVersion, multicc: host.multicc, agentBuild: host.agentBuild },
      catalog: {
        available: Boolean(snapshot.catalog), configured: Boolean(catalog), updatedAt: snapshot.updatedAt,
        fetchedAt: snapshot.fetchedAt, source: snapshot.source, error: snapshot.error,
      },
      conflicts,
      // allowed：这次请求来自这台电脑本身（和 Agent 权限按钮一样），手机和远程页面只能看。
      manage: { available: Boolean(installer), allowed: Boolean(installer && req && isLocalRequest(req)) },
      plugins: rows,
      _snapshot: snapshot,
      _host: host,
    };
  }

  async function publicPayload(req) {
    const { _snapshot, _host, ...payload } = await catalogPayload(req);
    return payload;
  }

  // 安装 / 更新：版本和下载包都只取列表算出的那个（row.candidate），不接受调用方指定。
  async function installFromCatalog(req, id) {
    const payload = await catalogPayload(req);
    const row = payload.plugins.find(item => item.id === id);
    if (!row || row.listed !== true || row.distribution !== 'optional') {
      return { status: 404, payload: { code: 'notListed', error: `插件 ${id} 不在插件列表里，或者是内置插件` } };
    }
    if (row.state !== 'installable' && row.state !== 'update') {
      return { status: 409, payload: { code: 'notInstallable', state: row.state, error: `插件 ${id} 现在不能安装（${row.state}）` } };
    }
    if (row.local && row.local.source !== 'user') {
      return { status: 409, payload: { code: 'inProgramDir', error: `插件 ${id} 放在程序目录的 plugins/ 里，先把它移走再从列表安装` } };
    }
    const entry = payload._snapshot.catalog.plugins.find(item => item.id === id);
    const release = entry.releases.find(item => item.version === row.candidate);
    const asset = release.assets[`${payload._host.os}-${payload._host.arch}`];
    const result = await installer.install({ id, version: release.version, asset });
    return { status: 200, payload: { ok: true, result, ...(await publicPayload(req)) } };
  }

  // 本机请求不用口令，所以别的网站在浏览器里提交一个表单到 127.0.0.1 也算「本机」。
  // 浏览器跨站 POST 一定带 Origin：带了就必须和本服务同源；不带的是 curl 这类非浏览器。
  function sameOrigin(req) {
    const origin = req.headers && req.headers.origin;
    if (!origin) return true;
    try { return new URL(origin).host === req.headers.host; } catch (_) { return false; }
  }

  async function manage(req, res, work) {
    if (!installer) return res.status(404).json({ code: 'unavailable', error: '这个实例没有用户插件目录' });
    if (!isLocalRequest(req)) return res.status(403).json({ code: 'localOnly', error: '请在这台电脑上安装、卸载插件' });
    if (!sameOrigin(req)) return res.status(403).json({ code: 'crossOrigin', error: '只接受 MultiCC 自己页面发来的安装、卸载请求' });
    try {
      const outcome = await work();
      res.status(outcome.status).json(outcome.payload);
    } catch (error) {
      const status = INSTALL_ERROR_STATUS[error.code];
      if (!status) logger.warn('plugin_manage_failed', { id: req.params.id, error: error.message });
      res.status(status || 500).json({ code: error.code || 'failed', error: error.message });
    }
  }

  function runPluginCommand(id, command, input) {
    return new Promise(resolve => {
      const entry = listPlugins().find(plugin => plugin.id === id);
      if (!entry) return resolve({ status: 404, payload: { error: `插件 ${id} 不存在` } });
      if (!COMMAND_PATTERN.test(command)) return resolve({ status: 400, payload: { error: '命令名不合法' } });
      if (!entry.commands.includes(command)) {
        return resolve({ status: 400, payload: { error: `命令 ${command} 不在插件 ${id} 的白名单里` } });
      }
      // 常驻插件不再每次启动程序，转给它的常驻进程（长操作由插件自己返回任务编号）。
      if (channelHost && channelHost.isResident(id)) return channelHost.run(id, command, input).then(resolve);
      const found = findManifest(id);
      const binary = resolveBinary(found, platform, arch);
      if (!binary) {
        return resolve({ status: 503, payload: { error: `插件 ${id} 的二进制不可用（${entry.engine.reason}）` } });
      }
      let child;
      try {
        child = spawn(binary, [command], { stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (error) {
        return resolve({ status: 500, payload: { error: `启动插件进程失败：${error.message}` } });
      }
      let stdout = '';
      let settled = false;
      const finish = (status, payload) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ status, payload });
      };
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(504, { error: `插件命令 ${command} 超时（${RUN_TIMEOUT_MS / 1000}s）` });
      }, RUN_TIMEOUT_MS);
      child.stdout.on('data', chunk => {
        if (stdout.length < RUN_MAX_BUFFER) stdout += chunk;
      });
      child.on('error', error => finish(500, { error: `插件进程出错：${error.message}` }));
      child.on('close', code => {
        const text = stdout.trim();
        if (!text) return finish(502, { error: `插件没有返回结果（退出码 ${code}）` });
        try {
          const parsed = JSON.parse(text);
          if (parsed && parsed.ok === true) return finish(200, parsed.data ?? {});
          return finish(400, { error: (parsed && parsed.error) || `插件命令失败（退出码 ${code}）` });
        } catch (_) {
          return finish(502, { error: '插件输出不是 JSON' });
        }
      });
      // 插件不读 stdin 就退出时，写入会异步报 EPIPE；结果仍以 stdout 为准，只记日志。
      child.stdin.on('error', error => logger.warn('plugin_stdin_failed', { id, command, error: error.message }));
      try {
        child.stdin.end(JSON.stringify(input ?? {}));
      } catch (error) {
        logger.warn('plugin_stdin_failed', { id, command, error: error.message });
      }
    });
  }

  function servePluginFile(req, res) {
    const id = req.params.id;
    const found = findManifest(id);
    if (!found) return res.status(404).json({ error: `插件 ${id} 不存在` });
    const relative = (req.params[0] || '').replace(/\\/g, '/');
    if (!relative || relative.includes('..') || relative.startsWith('/')) {
      return res.status(400).json({ error: '非法路径' });
    }
    const root = fs.realpathSync(found.dir);
    let absolute;
    try {
      absolute = fs.realpathSync(path.join(found.dir, relative));
    } catch (_) {
      return res.status(404).json({ error: '文件不存在' });
    }
    if (!absolute.startsWith(root + path.sep)) return res.status(400).json({ error: '非法路径' });
    // 只挂插件声明过 UI 的那棵子树（默认 ui/），插件目录里的源码、Cargo 产物不出网。
    const uiRoot = path.join(root, path.dirname(found.manifest.ui || 'ui/index.html'));
    if (!absolute.startsWith(uiRoot + path.sep)) return res.status(403).json({ error: '只有 UI 子树可访问' });
    let body;
    try {
      body = fs.readFileSync(absolute);
    } catch (_) {
      return res.status(404).json({ error: '文件不存在' });
    }
    res.set('Content-Type', MIME_TYPES[path.extname(absolute).toLowerCase()] || 'application/octet-stream');
    // WebView 常无视静态资源的 Cache-Control，跟主站一个策略：URL 不带指纹就禁缓存。
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.send(body);
  }

  function mount(app) {
    app.get('/api/plugins', (req, res) => {
      const { plugins, conflicts } = scan();
      res.json({ pluginApi: PLUGIN_API_VERSION, plugins, conflicts });
    });
    // 插件列表 × 本机：每个插件的状态（内置 / 已安装 / 可更新 / 可安装 / 不支持本机 /
    // 已装但不兼容）与第一条不满足的要求。只读；refresh 只是立刻重拉一次列表。
    app.get('/api/plugins/catalog', async (req, res) => {
      res.set('Cache-Control', 'no-store');
      try { res.json(await publicPayload(req)); }
      catch (error) { res.status(500).json({ error: error.message }); }
    });
    app.post('/api/plugins/catalog/refresh', async (req, res) => {
      if (!catalog) return res.status(404).json({ error: '插件列表未配置' });
      try {
        await catalog.refresh();
        res.json(await publicPayload(req));
      } catch (error) { res.status(500).json({ error: error.message }); }
    });
    // 安装 / 更新 / 卸载 / 退回：只接受本机请求；成功后带回最新的整张清单。
    app.post('/api/plugins/:id/install', (req, res) => manage(req, res, () => installFromCatalog(req, req.params.id)));
    app.post('/api/plugins/:id/uninstall', (req, res) => manage(req, res, async () => {
      const result = await installer.uninstall(req.params.id);
      return { status: 200, payload: { ok: true, result, ...(await publicPayload(req)) } };
    }));
    app.post('/api/plugins/:id/rollback', (req, res) => manage(req, res, async () => {
      const result = await installer.rollback(req.params.id);
      return { status: 200, payload: { ok: true, result, ...(await publicPayload(req)) } };
    }));
    app.post('/api/plugins/:id/run', async (req, res) => {
      const command = typeof req.body?.command === 'string' ? req.body.command : '';
      if (!command) return res.status(400).json({ error: '缺少 command' });
      const result = await runPluginCommand(req.params.id, command, req.body.input);
      res.status(result.status).json(result.payload);
    });
    // 常驻插件与通知渠道：是否在运行、未恢复的告警；各渠道的接收人（推送设置、钩子用）。
    app.get('/api/channels', (req, res) => {
      res.set('Cache-Control', 'no-store');
      // inUse：有推送订阅或钩子指望它。插件停了而 inUse 为真，Air 要出横幅。
      const usage = channelRegistry.usage();
      const plugins = (channelHost ? channelHost.status() : []).map(item => {
        if (!item.channel) return item;
        const count = usage.filter(use => use.plugin === item.id).length;
        return { ...item, inUse: count > 0, subscriptions: usage.filter(use => use.plugin === item.id && use.kind === 'push').length, uses: count };
      });
      res.json({ available: Boolean(channelHost), plugins });
    });
    // 插件发送前复核（方案 10.5 第 5 步）：这些任务的问题还在不在。只给本机的插件进程。
    app.post('/api/channels/recheck', (req, res) => {
      if (!isLocalRequest(req)) return res.status(403).json({ error: '只接受本机插件的复核请求' });
      const items = Array.isArray(req.body && req.body.items) ? req.body.items.slice(0, 200) : [];
      res.set('Cache-Control', 'no-store');
      res.json({
        items: items.filter(item => item && typeof item === 'object').map(item => {
          const sessionId = typeof item.sessionId === 'string' ? item.sessionId.slice(0, 128) : '';
          const category = typeof item.category === 'string' ? item.category.slice(0, 32) : '';
          return { sessionId, category, active: channelRegistry.stillActive(sessionId, category) };
        }),
      });
    });
    app.get('/api/channels/targets', async (req, res) => {
      res.set('Cache-Control', 'no-store');
      try { res.json({ channels: channelHost ? await channelHost.targets() : [] }); }
      catch (error) { res.status(500).json({ error: error.message }); }
    });
    // 插件 UI 静态树（iframe 源）。挂在全局 auth gate 之后，与页面同等鉴权。
    app.get('/plugins/:id/*', servePluginFile);
  }

  return { mount, listPlugins, scan, catalogPayload: publicPayload, runPluginCommand, servePluginFile, catalog, installer, channelHost };
}

module.exports = { createPluginsRoutes, pluginEntry, readManifest, resolveBinary };
