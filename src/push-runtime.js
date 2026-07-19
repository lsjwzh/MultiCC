'use strict';

const { sanitizePublicText } = require('./http/public-safety');

const PUSH_ANSI_RE = /\x1b(?:\[[0-9;?]*[a-zA-Z~]|\][^\x07]*(?:\x07|\x1b\\)|[()][AB012]|.)/g;
const DEFAULT_IDLE_MS = 6000;
const DEFAULT_MIN_CHARS = 80;
const DEFAULT_COOLDOWN_MS = 8000;

const CLASSIFY_PROMPT = `你是一个意图分析器。下面是一个命令行 AI 编码助手(Claude Code / Codex)终端会话的最近输出。请严格输出三行：
第1行：当前任务目标，用一个简短的名词性短语（中文≤20字，英文≤10词）。如果没有任务则输出「—」。
第2行：当前阶段，必须是以下五个词之一：规划中 / 实现中 / 验证中 / 收尾中 / 已完成
第3行：仅一个字母，表示当前状态——
  D = 任务已完成（终端回到空闲提示符、汇报结果后正常收尾，不需要用户操作、也不需要再继续）
  C = AI 应继续（任务还没做完，但可以直接接着跑，不需要用户操作；没有反问/等待迹象）
  W = 正在等待用户回复、确认或选择（如 y/n、Allow/Deny、编号选项、问题待答）
  B = 正在等待后台任务/子进程/外部数据返回后才能继续（如 Monitor 监控进度、nohup 后台跑、等部署/API）
  E = API 异常中断（输出末尾出现 “API Error”、503、”Connection closed”、”Overloaded”、”Internal server error”、”The system is busy” 等错误信息，说明 AI 并非正常完成而是被故障截断）

判断时看整体走向：终端回到提示符、汇报结果后没有反问 → D（完成）；任务没做完但能接着跑 → C；有明确反问/让用户选 → W。

只输出这三行。不要加序号、解释、引号、空行。

终端输出（尾部）：`;

function stripAnsi(value) {
  return String(value || '')
    .replace(PUSH_ANSI_RE, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

function redactClassifierTail(value) {
  return stripAnsi(value)
    .replace(/(\bBearer\s+)[^\s,;]+/ig, '$1[REDACTED]')
    .replace(/([?&](?:token|access_token|api_key)=)[^&#\s]+/ig, '$1[REDACTED]')
    .replace(/((?:[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY)|authorization)\s*(?:[:=]|\bis\b)\s*)["']?[^\s,"';]+/ig,
      '$1[REDACTED]')
    .replace(/\b(?:sk|gh[pousr])[-_][A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/\/Users\/[^/\s]+/g, '~')
    .replace(/\/home\/[^/\s]+/g, '~');
}

function assertDependencies(options) {
  if (!options || typeof options !== 'object') throw new TypeError('push runtime options required');
  const requiredFunctions = [
    'getAuxQueue', 'getTaskState', 'setTaskState', 'parseClassifyResult',
    'dispatchStateAction',
  ];
  for (const name of requiredFunctions) {
    if (typeof options[name] !== 'function') throw new TypeError(`push runtime missing: ${name}`);
  }
  for (const name of ['sessions', 'persistedSessions', 'workspaceClients', 'chatSessions']) {
    if (!options[name] || typeof options[name].get !== 'function') {
      throw new TypeError(`push runtime missing map: ${name}`);
    }
  }
  const push = options.push;
  if (!push || !push.subscriptions || !push.cfg) throw new TypeError('push runtime missing push service');
  for (const name of ['saveSubscriptions', 'sendPushToAll', 'sendBarkNotification', 'sendWebhookNotification']) {
    if (typeof push[name] !== 'function') throw new TypeError(`push service missing: ${name}`);
  }
}

function createPushRuntime(options) {
  assertDependencies(options);
  const {
    push, sessions, persistedSessions, workspaceClients, getAuxQueue,
    getTaskState, setTaskState, parseClassifyResult, dispatchStateAction,
    chatSessions,
  } = options;
  const logger = options.logger || console;
  const now = options.now || Date.now;
  const timers = options.timers || { setTimeout, clearTimeout };
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  const minChars = options.minChars ?? DEFAULT_MIN_CHARS;
  const cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const monitors = new Map();
  let stopped = false;
  let runtimeGeneration = 0;

  function warn(label, error) {
    const safe = sanitizePublicText(error && error.message, 'push runtime failed');
    try { logger.warn(`[multicc/push] ${label}: ${safe}`); } catch (_) {}
  }

  function initMonitor(sessionId) {
    let monitor = monitors.get(sessionId);
    if (monitor) return monitor;
    monitor = {
      state: 'idle',
      chars: 0,
      recentText: '',
      idleTimer: null,
      timerGeneration: 0,
      classifyPending: false,
      classifyGeneration: 0,
      lastPushTime: 0,
    };
    monitors.set(sessionId, monitor);
    return monitor;
  }

  function cleanup(sessionId) {
    const monitor = monitors.get(sessionId);
    if (!monitor) return false;
    monitor.timerGeneration++;
    monitor.classifyGeneration++;
    if (monitor.idleTimer) timers.clearTimeout(monitor.idleTimer);
    monitor.idleTimer = null;
    monitors.delete(sessionId);
    return true;
  }

  function hasNotifyConsumer(sessionId) {
    if (push.subscriptions.size > 0 || push.cfg.BARK_URL || push.cfg.WEBHOOK_URL) return true;
    if ((sessions.get(sessionId)?.clients?.size || 0) > 0) return true;
    const dirId = persistedSessions.get(sessionId)?.dirId;
    return !!(dirId && (workspaceClients.get(dirId)?.size || 0) > 0);
  }

  function classifyTerminalIdle(sessionId, tail, monitor) {
    if (stopped || monitors.get(sessionId) !== monitor || monitor.classifyPending) return;
    const persisted = persistedSessions.get(sessionId);
    if (persisted) {
      const taskState = getTaskState(persisted);
      if (taskState.classifyState === 'D' || taskState.classifyState === 'W') return;
    }

    let queue;
    try { queue = getAuxQueue(); } catch (error) { warn('aux queue unavailable', error); return; }
    if (!queue || typeof queue.enqueue !== 'function') {
      warn('aux queue unavailable', new Error('missing enqueue'));
      return;
    }

    monitor.classifyPending = true;
    const generation = runtimeGeneration;
    const classifyGeneration = ++monitor.classifyGeneration;
    const safeTail = redactClassifierTail(tail).slice(-2000);
    Promise.resolve().then(() => queue.enqueue({
      type: 'intent_classify',
      prompt: `${CLASSIFY_PROMPT}\n${safeTail}`,
      meta: { sessionId },
    })).then(result => {
      if (stopped || generation !== runtimeGeneration || monitors.get(sessionId) !== monitor
        || classifyGeneration !== monitor.classifyGeneration) return;
      monitor.classifyPending = false;
      if (!result || result.cancelled) return;
      const parsed = parseClassifyResult(result.text);
      dispatchStateAction(parsed, {
        sessionName: sessionId,
        sessionId,
        cs: chatSessions.get(sessionId),
        isTerminal: true,
      });
      try { logger.log(`[multicc/aux] Terminal classify for ${sessionId}: ${parsed.state}`); } catch (_) {}
    }).catch(error => {
      if (generation === runtimeGeneration && monitors.get(sessionId) === monitor
        && classifyGeneration === monitor.classifyGeneration) {
        monitor.classifyPending = false;
      }
      warn('terminal classify failed', error);
    });
  }

  function onOutput(sessionId, rawData) {
    if (stopped || !hasNotifyConsumer(sessionId)) return false;
    const monitor = initMonitor(sessionId);
    const text = stripAnsi(rawData);
    const printable = text.replace(/\s+/g, '');
    monitor.recentText += text;
    if (monitor.recentText.length > 3000) monitor.recentText = monitor.recentText.slice(-2000);

    if (printable.length > 0) {
      monitor.chars += printable.length;
      if (monitor.state === 'idle') monitor.state = 'active';
    }

    if (monitor.idleTimer) timers.clearTimeout(monitor.idleTimer);
    const timerGeneration = ++monitor.timerGeneration;
    const generation = runtimeGeneration;
    monitor.idleTimer = timers.setTimeout(() => {
      if (stopped || generation !== runtimeGeneration || monitors.get(sessionId) !== monitor
        || timerGeneration !== monitor.timerGeneration) return;
      monitor.idleTimer = null;
      if (monitor.state === 'active' && monitor.chars >= minChars) {
        classifyTerminalIdle(sessionId, monitor.recentText.slice(-2000), monitor);
      }
      monitor.state = 'idle';
      monitor.chars = 0;
      monitor.recentText = '';
    }, idleMs);
    return true;
  }

  function onInput(sessionId) {
    if (stopped) return false;
    const monitor = monitors.get(sessionId);
    if (monitor) {
      monitor.timerGeneration++;
      monitor.classifyGeneration++;
      monitor.classifyPending = false;
      monitor.state = 'idle';
      monitor.chars = 0;
      monitor.recentText = '';
      if (monitor.idleTimer) timers.clearTimeout(monitor.idleTimer);
      monitor.idleTimer = null;
    }
    const persisted = persistedSessions.get(sessionId);
    if (persisted) {
      const taskState = getTaskState(persisted);
      if (taskState.classifyState === 'D' || taskState.classifyState === 'W') {
        setTaskState(sessionId, { classifyState: 'P' });
      }
    }
    return true;
  }

  function fireAndForget(label, callback) {
    try {
      const result = callback();
      if (result && typeof result.then === 'function') result.catch(error => warn(label, error));
    } catch (error) { warn(label, error); }
  }

  function notify(sessionId, type, message) {
    if (stopped) return false;
    const monitor = initMonitor(sessionId);
    const timestamp = now();
    if (timestamp - monitor.lastPushTime < cooldownMs) return false;
    monitor.lastPushTime = timestamp;

    const session = sessions.get(sessionId);
    const cwd = session ? String(session.cwd || '') : '';
    const shortCwd = cwd.length > 30 ? `...${cwd.slice(-27)}` : cwd;
    const payloadForLocale = locale => ({
      title: locale === 'en'
        ? type === 'waiting' ? `MultiCC #${sessionId}: Action Required`
          : type === 'error' ? `MultiCC #${sessionId}: Error`
            : `MultiCC #${sessionId}: Completed`
        : type === 'waiting' ? `MultiCC #${sessionId}: 等待操作`
          : type === 'error' ? `MultiCC #${sessionId}: 出现异常`
            : `MultiCC #${sessionId}: 完成`,
      body: `${message}\n${shortCwd}`,
      sessionId,
      type,
      locale: locale === 'en' ? 'en' : 'zh',
      tag: `multicc-${sessionId}`,
      url: '/manage',
    });
    const payload = payloadForLocale('zh');

    push.globalStats.lastPushTime = timestamp;
    push.globalStats.lastPushType = type;
    push.globalStats.lastPushSessionId = sessionId;
    fireAndForget('web push failed', () => push.sendPushToAll(
      subscription => payloadForLocale(subscription.locale),
    ));
    fireAndForget('Bark notification failed', () => push.sendBarkNotification(
      payload.title, `${message} ${shortCwd}`, payload.url,
    ));
    fireAndForget('webhook notification failed', () => push.sendWebhookNotification(payload));
    try { logger.log(`[multicc/push] Sent ${type} notification for session ${sessionId}`); } catch (_) {}
    return payload;
  }

  function route(handler) {
    return function guardedPushRoute(req, res, next) {
      Promise.resolve().then(() => handler(req, res)).catch(error => {
        if (res.headersSent && typeof next === 'function') return next(error);
        warn('request failed', error);
        return res.status(500).json({ error: 'push request failed' });
      });
    };
  }

  function mountRoutes(app) {
    if (!app || typeof app.post !== 'function' || typeof app.delete !== 'function') {
      throw new TypeError('push routes require Express post/delete');
    }
    app.post('/api/push/subscribe', route(async (req, res) => {
      const subscription = req.body;
      if (!subscription || !subscription.endpoint) {
        return res.status(400).json({ error: 'Invalid subscription' });
      }
      const previous = push.subscriptions.get(subscription.endpoint);
      const existed = push.subscriptions.has(subscription.endpoint);
      push.subscriptions.set(subscription.endpoint, subscription);
      try {
        await push.saveSubscriptions();
      } catch (error) {
        if (existed) push.subscriptions.set(subscription.endpoint, previous);
        else push.subscriptions.delete(subscription.endpoint);
        throw error;
      }
      try { logger.log(`[multicc/push] New subscription (${push.subscriptions.size} total)`); } catch (_) {}
      return res.json({ ok: true });
    }));
    app.delete('/api/push/subscribe', route(async (req, res) => {
      const { endpoint } = req.body || {};
      if (endpoint && push.subscriptions.has(endpoint)) {
        const previous = push.subscriptions.get(endpoint);
        push.subscriptions.delete(endpoint);
        try {
          await push.saveSubscriptions();
        } catch (error) {
          push.subscriptions.set(endpoint, previous);
          throw error;
        }
      }
      return res.json({ ok: true });
    }));
    app.post('/api/push/validate', route((req, res) => {
      const { endpoint } = req.body || {};
      if (!endpoint) return res.status(400).json({ error: 'Missing endpoint' });
      return res.json({ known: push.subscriptions.has(endpoint) });
    }));
    app.post('/api/push/test', route(async (req, res) => {
      const payload = {
        title: 'MultiCC Test',
        body: `Push test at ${new Date(now()).toLocaleTimeString()}`,
        type: 'test',
        tag: 'multicc-test',
        url: '/manage',
      };
      await push.sendPushToAll(payload);
      await push.sendBarkNotification(payload.title, payload.body, payload.url);
      await push.sendWebhookNotification(payload);
      return res.json({ ok: true, subscribers: push.subscriptions.size });
    }));
    app.post('/api/push/test-bark', route(async (req, res) => {
      if (!push.cfg.BARK_URL) return res.status(400).json({ error: 'Bark URL not configured' });
      await push.sendBarkNotification(
        'MultiCC Test', `Bark test at ${new Date(now()).toLocaleTimeString()}`, '/manage',
      );
      return res.json({ ok: true });
    }));
    app.post('/api/push/test-webhook', route(async (req, res) => {
      if (!push.cfg.WEBHOOK_URL) return res.status(400).json({ error: 'Webhook URL not configured' });
      await push.sendWebhookNotification({
        title: 'MultiCC Test',
        body: `Webhook test at ${new Date(now()).toLocaleTimeString()}`,
        type: 'test',
      });
      return res.json({ ok: true });
    }));
    return app;
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    runtimeGeneration++;
    for (const [sessionId] of monitors) cleanup(sessionId);
  }

  return Object.freeze({
    mountRoutes,
    onOutput,
    onInput,
    notify,
    cleanup,
    stop,
  });
}

module.exports = {
  CLASSIFY_PROMPT,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_IDLE_MS,
  DEFAULT_MIN_CHARS,
  PUSH_ANSI_RE,
  createPushRuntime,
  redactClassifierTail,
  stripAnsi,
};
