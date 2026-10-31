'use strict';

// 常驻插件与通知渠道（docs/notification-channel-plugin-design.md 10.1）。
//
// plugin.json 写了 engine.resident: true 的插件，MultiCC 启动后作为常驻进程拉起
// （`<binary> serve`），退出后按 1 秒、5 秒、30 秒、之后每 5 分钟退避重启；连续运行满
// 一分钟算恢复，退避从头算。插件被删掉、换了版本或换了程序文件，下一次重新扫描时停掉
// 或换新。再写了 channel 的常驻插件就是一个通知渠道：推送设置和钩子只认这套约定，这里
// 没有任何具体渠道（微信、飞书……）的代码。
//
// 和常驻进程之间走它的标准输入输出，每行一个 JSON：
//   MultiCC → 插件  {"id":7,"type":"run","command":"health","input":{…}}
//                   {"id":8,"type":"targets"}        {"id":9,"type":"status"}
//                   {"id":10,"type":"deliver","target":"…","source":"push:…","sessionId":"…",
//                    "taskName":"…","project":"…","category":"error","summary":"…",
//                    "occurredAt":…,"dedupKey":"…"}   只入队，插件回投递编号（方案 10.1）
//   插件 → MultiCC  {"id":7,"ok":true,"data":{…}} 或 {"id":7,"ok":false,"error":"…"}
//                   {"event":"hello","protocol":1,"version":"0.1.0"}      就绪
//                   {"event":"alert","key":"agent-permissions","level":"warn"|"critical",
//                    "title":"…","body":"…"}，问题消失时同一个 key 带 "resolved":true；
//                   重启后补报已推送过的问题带 "replay":true（只上页面，不再推送）
// 插件读到标准输入结束（MultiCC 退出了）就该自己退出，所以关机时这里不用另做什么；
// 别的程序也连不上这条通道。插件的数据目录经环境变量 MULTICC_PLUGIN_DATA_DIR 给出。
//
// 健康告警由这里交给推送的现有渠道（deps.alert，网页推送、FCM、Bark、Webhook）：渠道
// 自己出故障时不能只靠它自己报。同一个 key 在恢复之前只发一次；每个插件每小时最多发
// 10 条，防止写错的插件刷屏。插件进程停了一分钟还没回来，这里替它报一条 plugin-down。

const fs = require('fs');
const path = require('path');
const { spawn: nodeSpawn } = require('child_process');

const PROTOCOL = 1;
const BACKOFF_MS = Object.freeze([1_000, 5_000, 30_000, 300_000]);
const RESCAN_MS = 30_000;
const HEALTHY_AFTER_MS = 60_000;
const DOWN_ALERT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 20_000;
const TARGETS_TIMEOUT_MS = 3_000;
const DELIVER_TIMEOUT_MS = 5_000;
const STOP_GRACE_MS = 3_000;
const MAX_LINE = 4 * 1024 * 1024;
const ALERT_KEY = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const ALERTS_PER_HOUR = 10;
const MAX_ACTIVE_ALERTS = 20;
const STDERR_LINES = 20;

function text(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

// plugin.json 的 channel 声明：{label, labelEn?, platforms?}。没有 label 的不算渠道。
function normalizeChannel(channel) {
  if (!channel || typeof channel !== 'object' || Array.isArray(channel)) return null;
  const label = text(channel.label, 40);
  if (!label) return null;
  const platforms = Array.isArray(channel.platforms) ? channel.platforms.filter(item => typeof item === 'string') : null;
  return { label, labelEn: text(channel.labelEn, 40) || null, platforms: platforms && platforms.length ? platforms : null };
}

// 不能在本机常驻的原因；能就返回 null。
function unsupportedReason(spec, platform) {
  if (!spec.binary) return 'binary-missing';
  if (spec.channel && spec.channel.platforms && !spec.channel.platforms.includes(platform)) return 'platform';
  const platforms = spec.requires && Array.isArray(spec.requires.platforms) ? spec.requires.platforms : null;
  if (platforms && platforms.length && !platforms.some(item => item && item.os === platform)) return 'platform';
  return null;
}

function createChannelHost(deps) {
  for (const key of ['discover', 'dataDir', 'logger']) {
    if (!deps || !deps[key]) throw new TypeError(`[channel-host] ${key} is required`);
  }
  const {
    discover, dataDir, logger,
    platform = process.platform,
    spawn = nodeSpawn,
    now = Date.now,
    alert = () => {},
    baseUrl = null,
    backoffMs = BACKOFF_MS,
    rescanMs = RESCAN_MS,
    healthyAfterMs = HEALTHY_AFTER_MS,
    downAlertMs = DOWN_ALERT_MS,
    requestTimeoutMs = REQUEST_TIMEOUT_MS,
    stopGraceMs = STOP_GRACE_MS,
  } = deps;

  const records = new Map();   // id → 常驻进程记录
  const skipped = new Map();   // id → 声明了常驻、但本机跑不了的原因
  let rescanTimer = null;
  let stopped = true;
  let nextRequestId = 1;

  const unref = timer => { if (timer && typeof timer.unref === 'function') timer.unref(); return timer; };

  function fingerprint(spec) {
    let mtime = 0;
    try { mtime = fs.statSync(spec.binary).mtimeMs; } catch (_) {}
    return `${spec.binary}|${spec.version}|${mtime}`;
  }

  function raise(rec, raw, { fromHost = false } = {}) {
    const key = text(raw.key, 64);
    if (!ALERT_KEY.test(key)) return;
    if (raw.resolved === true) {
      if (rec.alerts.delete(key)) logger.info('plugin_alert_resolved', { id: rec.id, key });
      return;
    }
    if (rec.alerts.has(key)) return; // 恢复之前同一个问题只报一次
    if (rec.alerts.size >= MAX_ACTIVE_ALERTS) return;
    const entry = {
      key,
      level: raw.level === 'critical' ? 'critical' : 'warn',
      title: text(raw.title, 120) || key,
      body: text(raw.body, 500),
      at: now(),
      fromHost,
    };
    rec.alerts.set(key, entry);
    // replay：插件重启或 MultiCC 重启后补报一条已经推送过、还没恢复的问题——页面要
    // 看得到，但不再推送第二次。
    if (raw.replay === true) return;
    const hourAgo = now() - 3_600_000;
    rec.alertTimes = rec.alertTimes.filter(at => at > hourAgo);
    if (rec.alertTimes.length >= ALERTS_PER_HOUR) {
      logger.warn('plugin_alert_throttled', { id: rec.id, key });
      return;
    }
    rec.alertTimes.push(now());
    logger.warn('plugin_alert', { id: rec.id, key, level: entry.level, title: entry.title });
    try {
      alert({ source: rec.id, sourceName: rec.spec.name || rec.id, ...entry });
    } catch (error) {
      logger.warn('plugin_alert_delivery_failed', { id: rec.id, key, error: error.message });
    }
  }

  function settlePending(rec, error) {
    for (const [, pending] of rec.pending) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, error, exited: true });
    }
    rec.pending.clear();
  }

  function onMessage(rec, message) {
    if (!message || typeof message !== 'object') return;
    if (Number.isSafeInteger(message.id) && rec.pending.has(message.id)) {
      const pending = rec.pending.get(message.id);
      rec.pending.delete(message.id);
      clearTimeout(pending.timer);
      pending.resolve(message.ok === true
        ? { ok: true, data: message.data ?? {} }
        : { ok: false, error: text(message.error, 2000) || '插件命令失败' });
      return;
    }
    if (message.event === 'hello') {
      if (message.protocol !== PROTOCOL) logger.warn('plugin_protocol_mismatch', { id: rec.id, protocol: message.protocol });
      rec.ready = true;
      rec.readyAt = now();
      rec.reportedVersion = text(message.version, 40) || null;
      rec.downSince = null;
      if (rec.alerts.has('plugin-down')) raise(rec, { key: 'plugin-down', resolved: true });
      logger.info('plugin_resident_ready', { id: rec.id, pid: rec.child && rec.child.pid, version: rec.reportedVersion });
      if (rec.spec.channel) refreshTargets(rec);
      return;
    }
    if (message.event === 'alert') raise(rec, message);
  }

  function attachLines(stream, onLine, onOverflow) {
    let buffer = '';
    stream.setEncoding('utf8');
    stream.on('data', chunk => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) onLine(line);
      }
      if (buffer.length > MAX_LINE) { buffer = ''; onOverflow(); }
    });
  }

  function checkDown(rec) {
    if (stopped || rec.stopping || rec.ready || !rec.downSince) return;
    if (now() - rec.downSince < downAlertMs) return;
    const exit = rec.lastExit;
    raise(rec, {
      key: 'plugin-down',
      level: 'critical',
      title: `${rec.spec.name || rec.id} 停止运行`,
      body: exit
        ? `插件进程已重启 ${rec.failures} 次仍未恢复（最后一次退出：${exit.signal || `退出码 ${exit.code}`}）。在 MultiCC「资料与插件 → 插件」查看。`
        : '插件进程启动后一直没有就绪。在 MultiCC「资料与插件 → 插件」查看。',
    }, { fromHost: true });
  }

  function launch(rec) {
    if (stopped || rec.stopping) return;
    rec.restartTimer = null;
    rec.ready = false;
    rec.startedAt = now();
    if (!rec.downSince) rec.downSince = now();
    const env = {
      ...process.env,
      MULTICC_PLUGIN_ID: rec.id,
      MULTICC_PLUGIN_PROTOCOL: String(PROTOCOL),
      MULTICC_PLUGIN_DATA_DIR: path.join(dataDir, rec.id),
    };
    const url = typeof baseUrl === 'function' ? baseUrl() : baseUrl;
    if (url) env.MULTICC_BASE_URL = url;
    let child;
    try {
      child = spawn(rec.spec.binary, ['serve'], { cwd: rec.spec.dir, env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      return onExit(rec, null, { code: null, signal: null, error: error.message });
    }
    rec.child = child;
    attachLines(child.stdout, line => {
      let message;
      try { message = JSON.parse(line); } catch (_) {
        logger.warn('plugin_resident_bad_line', { id: rec.id, line: line.slice(0, 200) });
        return;
      }
      onMessage(rec, message);
    }, () => {
      logger.warn('plugin_resident_line_too_long', { id: rec.id });
      try { child.kill('SIGKILL'); } catch (_) {}
    });
    attachLines(child.stderr, line => {
      rec.stderr.push(line.slice(0, 500));
      if (rec.stderr.length > STDERR_LINES) rec.stderr.shift();
    }, () => {});
    child.stdin.on('error', () => {}); // 插件已退出时写入报 EPIPE；以 exit 事件为准
    child.on('error', error => onExit(rec, child, { code: null, signal: null, error: error.message }));
    child.on('exit', (code, signal) => onExit(rec, child, { code, signal }));
    rec.downTimer = unref(setTimeout(() => checkDown(rec), downAlertMs + 10));
    logger.info('plugin_resident_started', { id: rec.id, pid: child.pid });
  }

  function onExit(rec, child, exit) {
    if (child && rec.child !== child) return; // 已经处理过（error 和 exit 都会来）
    rec.child = null;
    rec.ready = false;
    settlePending(rec, '插件进程已退出');
    if (rec.stopping || stopped) return;
    rec.lastExit = { ...exit, at: now() };
    if (rec.startedAt && now() - rec.startedAt >= healthyAfterMs) rec.failures = 0;
    const delay = backoffMs[Math.min(rec.failures, backoffMs.length - 1)];
    rec.failures += 1;
    if (!rec.downSince) rec.downSince = now();
    logger.warn('plugin_resident_exited', { id: rec.id, ...exit, restartInMs: delay, stderr: rec.stderr.slice(-3) });
    rec.restartTimer = unref(setTimeout(() => launch(rec), delay));
    clearTimeout(rec.downTimer);
    rec.downTimer = unref(setTimeout(() => checkDown(rec), Math.max(10, rec.downSince + downAlertMs - now() + 10)));
  }

  function startRecord(spec) {
    const rec = {
      id: spec.id, spec, fingerprint: fingerprint(spec), child: null, ready: false, stopping: false,
      startedAt: null, readyAt: null, reportedVersion: null, failures: 0, lastExit: null, downSince: null,
      pending: new Map(), alerts: new Map(), alertTimes: [], stderr: [], restartTimer: null, downTimer: null,
      knownTargets: null,
    };
    records.set(spec.id, rec);
    launch(rec);
    return rec;
  }

  function stopRecord(rec) {
    rec.stopping = true;
    clearTimeout(rec.restartTimer);
    clearTimeout(rec.downTimer);
    settlePending(rec, '插件已停止');
    const child = rec.child;
    if (!child) return;
    try { child.stdin.end(); } catch (_) {}
    unref(setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill('SIGKILL'); } catch (_) {}
      }
    }, stopGraceMs));
  }

  function reconcile() {
    if (stopped) return;
    let specs;
    try {
      specs = discover().filter(spec => spec && spec.resident === true);
    } catch (error) {
      logger.warn('plugin_resident_scan_failed', { error: error.message });
      return;
    }
    const wanted = new Map();
    skipped.clear();
    for (const spec of specs) {
      const reason = unsupportedReason(spec, platform);
      if (reason) skipped.set(spec.id, { spec, reason });
      else wanted.set(spec.id, spec);
    }
    for (const [id, rec] of records) {
      const spec = wanted.get(id);
      if (spec && fingerprint(spec) === rec.fingerprint) {
        rec.spec = spec;
        continue;
      }
      logger.info('plugin_resident_stopping', { id, reason: spec ? 'changed' : 'removed' });
      stopRecord(rec);
      records.delete(id);
    }
    for (const [id, spec] of wanted) if (!records.has(id)) startRecord(spec);
    for (const rec of records.values()) if (rec.ready && rec.spec.channel) refreshTargets(rec);
  }

  function request(rec, type, body, timeoutMs = requestTimeoutMs) {
    return new Promise(resolve => {
      if (!rec || !rec.child) return resolve({ ok: false, error: '插件常驻进程没有运行', down: true });
      if (!rec.ready) return resolve({ ok: false, error: '插件常驻进程正在启动', down: true });
      const id = nextRequestId++;
      const timer = unref(setTimeout(() => {
        rec.pending.delete(id);
        resolve({ ok: false, error: `插件没有在 ${Math.round(timeoutMs / 1000)} 秒内回应`, timeout: true });
      }, timeoutMs));
      rec.pending.set(id, { resolve, timer });
      try {
        rec.child.stdin.write(`${JSON.stringify({ id, type, ...body })}\n`);
      } catch (error) {
        rec.pending.delete(id);
        clearTimeout(timer);
        resolve({ ok: false, error: `发给插件失败：${error.message}`, down: true });
      }
    });
  }

  // 插件面板的 run：结果形状与按次启动的 runPluginCommand 一致（{status, payload}）。
  async function run(id, command, input) {
    const reply = await request(records.get(id), 'run', { command, input: input ?? {} });
    if (reply.ok) return { status: 200, payload: reply.data };
    if (reply.timeout) return { status: 504, payload: { error: reply.error } };
    if (reply.down || reply.exited) return { status: 503, payload: { error: reply.error } };
    return { status: 400, payload: { error: reply.error } };
  }

  function isResident(id) {
    return records.has(id) || skipped.has(id);
  }

  function describe(rec) {
    return {
      id: rec.id,
      name: rec.spec.name || rec.id,
      nameEn: rec.spec.nameEn || null,
      version: rec.reportedVersion || rec.spec.version || null,
      channel: rec.spec.channel || null,
      // 面板地址（推送设置、钩子、横幅里的「去插件面板」链接用）。
      ui: rec.spec.ui ? `/plugins/${encodeURIComponent(rec.id)}/${String(rec.spec.ui).replace(/^\/+/, '')}` : null,
      running: Boolean(rec.child),
      ready: rec.ready,
      pid: rec.child ? rec.child.pid : null,
      startedAt: rec.startedAt,
      readyAt: rec.ready ? rec.readyAt : null,
      restarts: rec.failures,
      lastExit: rec.lastExit,
      alerts: [...rec.alerts.values()],
    };
  }

  // 所有常驻插件（含本机跑不了的）与它们未恢复的告警；渠道插件带 channel。
  function status() {
    const plugins = [...records.values()].map(describe);
    for (const [id, { spec, reason }] of skipped) {
      plugins.push({
        id, name: spec.name || id, nameEn: spec.nameEn || null, version: spec.version || null,
        channel: spec.channel || null, ui: null, running: false, ready: false, unsupported: reason, alerts: [],
      });
    }
    return plugins.sort((a, b) => a.id.localeCompare(b.id));
  }

  function briefTargets(list) {
    return (Array.isArray(list) ? list : []).filter(target => target && typeof target.id === 'string').map(target => ({
      id: text(target.id, 64), name: text(target.name, 80) || target.id, status: text(target.status, 32) || null,
    }));
  }

  // 接收人簿缓存（就绪时、每次重新扫描、每次有人列接收人时刷新）：保存推送订阅和钩子时
  // 要同步核对接收人还在不在，不能为此等插件。
  async function refreshTargets(rec) {
    const reply = await request(rec, 'targets', {}, TARGETS_TIMEOUT_MS);
    if (reply.ok) rec.knownTargets = briefTargets(reply.data && reply.data.targets);
    return reply;
  }

  // 保存时核对（方案 10.4）：插件声明了渠道、在运行、接收人在它的接收人簿里。
  function checkTarget(id, target) {
    const rec = records.get(id);
    if (!rec) {
      return skipped.has(id) && skipped.get(id).spec.channel ? 'channel plugin not running' : 'unknown channel plugin';
    }
    if (!rec.spec.channel) return 'unknown channel plugin';
    if (!rec.ready || !rec.knownTargets) return 'channel plugin not running';
    return rec.knownTargets.some(item => item.id === target) ? null : 'unknown channel target';
  }

  // 投递一件事：插件只回「已入队」和投递编号，不等发送结果（方案 10.1）。
  async function deliver(id, payload) {
    const rec = records.get(id);
    if (!rec || !rec.spec.channel) return { ok: false, error: 'unknown channel plugin' };
    const reply = await request(rec, 'deliver', { ...payload }, DELIVER_TIMEOUT_MS);
    if (!reply.ok) return { ok: false, error: reply.error, down: Boolean(reply.down || reply.exited) };
    const data = reply.data || {};
    return { ok: true, receipt: data, deliveryId: data.deliveryId ?? null };
  }

  // 各渠道插件的接收人（推送设置、钩子编辑器的下拉框）；没就绪的插件带 error，不阻塞别的插件。
  async function targets() {
    const channels = status().filter(item => item.channel);
    return Promise.all(channels.map(async item => {
      const base = { plugin: item.id, name: item.name, label: item.channel.label, labelEn: item.channel.labelEn, ready: item.ready };
      if (!item.ready) return { ...base, targets: [], error: item.unsupported ? `本机不支持（${item.unsupported}）` : '插件没有运行' };
      const rec = records.get(item.id);
      const reply = await refreshTargets(rec);
      if (!reply.ok) return { ...base, targets: [], error: reply.error };
      return { ...base, targets: rec.knownTargets || [] };
    }));
  }

  function start() {
    if (!stopped) return;
    stopped = false;
    reconcile();
    rescanTimer = unref(setInterval(reconcile, rescanMs));
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(rescanTimer);
    for (const rec of records.values()) stopRecord(rec);
    records.clear();
  }

  return { start, stop, reconcile, run, isResident, status, targets, deliver, checkTarget };
}

module.exports = { PROTOCOL, BACKOFF_MS, createChannelHost, normalizeChannel, unsupportedReason };
