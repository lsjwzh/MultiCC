'use strict';

const { sanitizePublicText } = require('../http/public-safety');

const AUX_SESSION_ID = '__aux__';
const AUX_HISTORY_MAX = 200;

const GOAL_DIMENSIONS = {
  objective: '目标明确：清楚要达成什么结果，而非含糊方向。',
  criteria: '完成标准明确：有可判断「做完了」的验收标准或可观察的产出。',
  scope: '范围清晰：边界明确，不至于无限发散。',
  executable: '可独立执行：代理无需再追问关键信息即可开工，或缺失信息能用合理默认补足。',
};

const GOAL_CONFIG_DEFAULT = {
  dimensions: { objective: true, criteria: true, scope: true, executable: true },
  minScore: 60,
};

const GOAL_ROUNDS_DEFAULT = 0;
const GOAL_BUDGET_DEFAULT = 0;
const GOAL_ROUNDS_MAX = 200;
const GOAL_BUDGET_MAX = 5000000;

function clampInt(value, min, max, fallback) {
  let parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) parsed = fallback;
  return Math.max(min, Math.min(max, parsed));
}

function normalizeGoalConfig(config) {
  const source = config || {};
  const dimensions = {};
  for (const key of Object.keys(GOAL_DIMENSIONS)) {
    dimensions[key] = source.dimensions && typeof source.dimensions[key] === 'boolean'
      ? source.dimensions[key]
      : GOAL_CONFIG_DEFAULT.dimensions[key];
  }
  return {
    dimensions,
    minScore: clampInt(source.minScore, 0, 100, GOAL_CONFIG_DEFAULT.minScore),
  };
}

function resolveGoalLimits(override) {
  const source = override && typeof override === 'object' ? override : {};
  const maxRounds = source.maxRounds != null && source.maxRounds !== ''
    ? clampInt(source.maxRounds, 0, GOAL_ROUNDS_MAX, GOAL_ROUNDS_DEFAULT)
    : GOAL_ROUNDS_DEFAULT;
  const maxBudget = source.maxBudget != null && source.maxBudget !== ''
    ? clampInt(source.maxBudget, 0, GOAL_BUDGET_MAX, GOAL_BUDGET_DEFAULT)
    : GOAL_BUDGET_DEFAULT;
  return { maxRounds, maxBudget };
}

function buildGoalLimitNote(limits) {
  const parts = [];
  if (limits.maxRounds > 0) {
    parts.push(`本次为 Goal 模式自主任务，自主执行的轮次（agent turns）上限为 ${limits.maxRounds} 轮，请在该轮次内完成；接近上限时先收敛、给出当前结论与未尽事项，不要无限发散。`);
  }
  if (limits.maxBudget > 0) {
    parts.push(`本次输出 token 预算上限约为 ${limits.maxBudget}，请在预算内完成；接近上限时停止并总结已完成的部分与剩余工作。`);
  }
  return parts.length ? `[Goal 模式限制]\n${parts.join('\n')}\n[限制结束]\n\n` : '';
}

function buildGoalPrecheckPrompt(task, dimensions) {
  const enabled = Object.keys(GOAL_DIMENSIONS).filter(key => dimensions[key]);
  const list = (enabled.length ? enabled : Object.keys(GOAL_DIMENSIONS))
    .map((key, index) => `${index + 1}. ${GOAL_DIMENSIONS[key]}`)
    .join('\n');
  return `你是「任务质量审查助手」。下面是用户想交给一个自主 AI 编程代理、以「Goal 模式」（目标驱动、自主规划并执行到完成、最后自检验证）执行的任务。

请只依据以下启用的标准判断它是否满足要求：
${list}

只输出一个 JSON 对象，不要任何额外文字、不要 markdown 代码块，字段如下：
{
  "verdict": "ok" | "needs_work",
  "score": 0,
  "issues": ["不满足之处，没有则空数组"],
  "questions": ["仍需向用户澄清的问题，没有则空数组"],
  "criteria": ["建议的完成/验收标准"],
  "revised": "改写后可直接执行的 Goal-ready 任务描述，含目标与完成标准；若原任务已经很好可与原文基本一致"
}

score 为 0-100 的整数符合度评分，只针对上面启用的标准评分。所有文本字段用与用户任务相同的语言填写。

用户任务：
<<<
${task}
>>>`;
}

function parseGoalVerdict(text) {
  const raw = String(text || '');
  let parsed = null;
  try { parsed = JSON.parse(raw.trim()); } catch (_) {}
  if (!parsed) {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try { parsed = JSON.parse(raw.slice(start, end + 1)); } catch (_) {}
    }
  }
  if (!parsed || typeof parsed !== 'object') {
    return {
      verdict: 'needs_work',
      score: 0,
      issues: ['辅助 AI 未能给出可解析的结果，请人工确认或直接发送'],
      questions: [],
      criteria: [],
      revised: '',
      raw,
    };
  }
  const strings = value => Array.isArray(value)
    ? value.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim())
    : [];
  const verdict = parsed.verdict === 'ok' ? 'ok' : 'needs_work';
  let score = parseInt(parsed.score, 10);
  if (!Number.isFinite(score)) score = verdict === 'ok' ? 80 : 40;
  return {
    verdict,
    score: Math.max(0, Math.min(100, score)),
    issues: strings(parsed.issues),
    questions: strings(parsed.questions),
    criteria: strings(parsed.criteria),
    revised: typeof parsed.revised === 'string' ? parsed.revised.trim() : '',
  };
}

function normalizeAuxProtocol(value) {
  return String(value || '').toLowerCase() === 'openai' ? 'openai' : 'anthropic';
}

// Aux failures are reflected in REST responses, WebSocket events and the
// synthetic session history. Keep provider bodies, credentials and filesystem
// paths off all of those public surfaces.
function safeAuxErrorMessage(error, fallback = 'aux failed') {
  const message = error && typeof error === 'object' ? error.message : error;
  return sanitizePublicText(message, fallback);
}

function mountAuxGoalRoutes(app, dependencies) {
  const {
    fs,
    crypto,
    rootDir,
    auxConfigFile,
    goalConfigFile,
    atomicWriteJson,
    persistedSessions,
    savePersistedSessionsBestEffort,
    isShuttingDown,
    recordApiError,
    recordApiSuccess,
    appendChatMessage,
    loadChatHistory,
    providers,
    getPort,
    getClaudeOfficialViaProxy,
    executeAuxHttp,
    broadcast,
    env = process.env,
    logger = console,
  } = dependencies;

  const timeoutMs = Math.max(10000, parseInt(env.AUX_TIMEOUT_MS || '90000', 10) || 90000);
  let auxConfig = { protocol: 'anthropic', providerId: null, model: null };

  function saveAuxConfig() {
    try { atomicWriteJson(auxConfigFile, auxConfig); } catch (_) {}
  }

  function loadAuxConfig() {
    try {
      const config = JSON.parse(fs.readFileSync(auxConfigFile, 'utf8'));
      auxConfig = {
        protocol: normalizeAuxProtocol(config.protocol || (config.cli === 'codex' ? 'openai' : 'anthropic')),
        providerId: config.providerId || null,
        model: config.model && String(config.model).trim() || null,
      };
      // Compatibility reads are migrated immediately so the removed `cli`
      // field cannot leak back into later writes.
      saveAuxConfig();
    } catch (_) {}
  }

  const auxQueue = {
    queue: [],
    currentTask: null,
    processing: false,
    totalProcessed: 0,
    lastTaskTime: null,
    health: {
      consecutiveFails: 0,
      unhealthy: false,
      retryable: true,
      category: null,
      action: null,
      retryAt: null,
      lastFailAt: null,
      lastFailMsg: '',
      sinceAt: null,
    },
    clients: new Set(),

    recordFail(error) {
      const publicMessage = safeAuxErrorMessage(error);
      const detail = error && typeof error === 'object' ? error : {};
      const response = detail.response && typeof detail.response === 'object' ? detail.response : {};
      const responseHeaders = response.headers;
      const retryAfter = detail.retryAfter
        || (responseHeaders && typeof responseHeaders.get === 'function'
          ? responseHeaders.get('retry-after') : null);
      const decision = recordApiError({
        source: 'aux_http',
        provider: auxConfig.protocol === 'openai' ? 'aux-openai' : 'aux-anthropic',
        code: detail.code || detail.type || response.code,
        httpStatus: detail.httpStatus || detail.statusCode || detail.status
          || response.statusCode || response.status,
        retryAfterMs: detail.retryAfterMs,
        retryAfter,
        message: publicMessage,
      }, {
        provider: auxConfig.protocol === 'openai' ? 'aux-openai' : 'aux-anthropic',
        source: 'aux_http',
        phase: 'before_first_token',
        partialOutput: false,
        sideEffects: false,
        idempotencyKey: `aux:${this.currentTask?.id || 'unknown'}`,
      });
      const health = this.health;
      health.consecutiveFails = (health.consecutiveFails || 0) + 1;
      health.lastFailAt = Date.now();
      health.lastFailMsg = publicMessage.slice(0, 200);
      health.retryable = decision
        ? decision.action === 'retry' || decision.action === 'wait_circuit'
          || (decision.action === 'wait_reset' && !!decision.retryAt)
        : true;
      health.category = decision?.error?.category || 'unknown';
      health.action = decision?.action || 'fail_fast';
      health.retryAt = decision?.retryAt || null;
      const thresholdReached = health.action === 'retry'
        ? health.consecutiveFails >= 3 : true;
      if (thresholdReached && !health.unhealthy) {
        health.unhealthy = true;
        health.sinceAt = Date.now();
        logger.error('[multicc/aux] unavailable', {
          category: health.category,
          retryable: health.retryable,
          consecutiveFails: health.consecutiveFails,
        });
        this.broadcastHealth();
      }
      return { health, decision, publicMessage };
    },

    recordSuccess() {
      const health = this.health;
      if (health.consecutiveFails || health.unhealthy) {
        health.consecutiveFails = 0;
        health.retryable = true;
        health.category = null;
        health.action = null;
        health.retryAt = null;
        if (health.unhealthy) {
          health.unhealthy = false;
          health.sinceAt = null;
          logger.log('[multicc/aux] recovered: healthy again');
          this.broadcastHealth();
        }
      }
      recordApiSuccess(auxConfig.protocol === 'openai' ? 'aux-openai' : 'aux-anthropic');
      return health;
    },

    isUnhealthy() {
      return !!(this.health && this.health.unhealthy);
    },

    broadcastHealth() {
      this.broadcast({ type: 'aux_health', health: { ...this.health } });
    },

    attachClient(client) {
      this.clients.add(client);
      const cleanup = () => { this.clients.delete(client); };
      // `/ws/aux` returns before the terminal socket handlers are installed.
      // Own both terminal paths here so an error cannot leave a stale client in
      // the hub (or become an unhandled EventEmitter `error`).
      if (typeof client.once === 'function') client.once('close', cleanup);
      if (typeof client.on === 'function') client.on('error', cleanup);
      return cleanup;
    },

    init() {
      loadAuxConfig();
      if (!persistedSessions.has(AUX_SESSION_ID)) {
        persistedSessions.set(AUX_SESSION_ID, {
          id: AUX_SESSION_ID,
          cwd: rootDir,
          createdAt: new Date(),
          type: 'aux',
          label: 'AI Assistant',
        });
        savePersistedSessionsBestEffort('startup.aux-session-create');
      } else {
        const existing = persistedSessions.get(AUX_SESSION_ID);
        if (existing.type !== 'aux') {
          existing.type = 'aux';
          existing.label = 'AI Assistant';
          savePersistedSessionsBestEffort('startup.aux-session-repair');
        }
      }
      logger.log('[multicc/aux] AuxQueue initialized (direct HTTP)');
    },

    enqueue(task) {
      if (isShuttingDown()) {
        const error = new Error('server is shutting down');
        error.code = 'SERVER_SHUTTING_DOWN';
        return Promise.reject(error);
      }
      return new Promise((resolve, reject) => {
        task.id = task.id || crypto.randomUUID();
        task.ts = Date.now();
        task.cancelled = false;
        task.resolve = resolve;
        task.reject = reject;
        this.queue.push(task);
        this.broadcast({
          type: 'aux_event',
          status: 'queued',
          task: { id: task.id, type: task.type, meta: task.meta },
          queueDepth: this.queue.length,
        });
        logger.log(`[multicc/aux] Enqueued ${task.type} (queue: ${this.queue.length})`);
        this.drain();
      });
    },

    cancel(taskId) {
      const index = this.queue.findIndex(task => task.id === taskId);
      if (index !== -1) {
        const task = this.queue.splice(index, 1)[0];
        task.reject({ cancelled: true });
        this.broadcast({ type: 'aux_event', status: 'cancelled', task: { id: taskId } });
        logger.log(`[multicc/aux] Cancelled queued task ${taskId}`);
        return;
      }
      if (this.currentTask?.id === taskId) {
        this.currentTask.cancelled = true;
        this.broadcast({ type: 'aux_event', status: 'cancelled', task: { id: taskId } });
        logger.log(`[multicc/aux] Marked in-flight task ${taskId} as cancelled`);
      }
    },

    hasPendingFor(sessionName) {
      if (!sessionName) return false;
      const matches = task => {
        const meta = task && task.meta || {};
        return meta.sessionName === sessionName || meta.sid === sessionName;
      };
      if (this.currentTask && matches(this.currentTask)) return true;
      return this.queue.some(matches);
    },

    cancelClassifyFor(sessionKey) {
      if (!sessionKey) return 0;
      const isClassify = task => task && task.type === 'intent_classify'
        && task.meta
        && (task.meta.sessionName === sessionKey || task.meta.sid === sessionKey);
      let cancelled = 0;
      for (const task of [...this.queue]) {
        if (isClassify(task)) { this.cancel(task.id); cancelled++; }
      }
      // The in-flight one too. This used to iterate the queue only, so a cancel
      // that arrived while this session's classify was already executing left it
      // to finish and resolve — harmless for state (applyClassifyResult drops a
      // verdict once cancelledAt is set) but it still spent an Aux call and
      // logged a judgement for a turn nobody was waiting on. `cancel()` marks it,
      // it does not abort the socket: see drain()'s catch, which deliberately
      // keeps a cancelled in-flight request out of the upstream health stats.
      if (this.currentTask && isClassify(this.currentTask) && !this.currentTask.cancelled) {
        this.cancel(this.currentTask.id);
        cancelled++;
      }
      return cancelled;
    },

    async drain() {
      if (this.processing || this.queue.length === 0) return;
      this.processing = true;
      const task = this.queue.shift();
      this.currentTask = task;
      this.broadcast({
        type: 'aux_event',
        status: 'processing',
        task: { id: task.id, type: task.type, meta: task.meta },
      });

      const startTime = Date.now();
      try {
        const resultText = await this.execute(task);
        const durationMs = Date.now() - startTime;
        this.totalProcessed++;
        this.lastTaskTime = Date.now();
        appendChatMessage(AUX_SESSION_ID, {
          role: 'user',
          content: task.prompt,
          ts: task.ts,
          taskType: task.type,
          taskId: task.id,
          meta: task.meta,
          protocol: auxConfig.protocol,
          wireApi: task._wireApi || null,
          transport: 'directHttp',
        });
        appendChatMessage(AUX_SESSION_ID, {
          role: 'assistant',
          content: resultText,
          ts: Date.now(),
          taskId: task.id,
          durationMs,
          cancelled: task.cancelled,
          protocol: auxConfig.protocol,
          wireApi: task._wireApi || null,
          transport: 'directHttp',
          enqueuedAt: task.ts,
          startedAt: startTime,
          queueMs: startTime - task.ts,
        });
        if (task.cancelled) {
          task.reject({ cancelled: true });
          this.broadcast({ type: 'aux_event', status: 'done', task: { id: task.id, type: task.type }, result: resultText, durationMs, cancelled: true });
        } else {
          this.recordSuccess();
          task.resolve({ text: resultText, cancelled: false });
          this.broadcast({ type: 'aux_event', status: 'done', task: { id: task.id, type: task.type }, result: resultText, durationMs, cancelled: false });
        }
      } catch (error) {
        const durationMs = Date.now() - startTime;
        const message = safeAuxErrorMessage(error);
        // A user-cancelled in-flight request may still finish by failing because
        // the transport itself is intentionally not aborted. That is not an
        // upstream health failure and must retain cancellation semantics.
        const failure = !task.cancelled ? this.recordFail(error) : null;
        appendChatMessage(AUX_SESSION_ID, {
          role: 'user',
          content: task.prompt,
          ts: task.ts,
          taskType: task.type,
          taskId: task.id,
          meta: task.meta,
          protocol: auxConfig.protocol,
          wireApi: task._wireApi || null,
          transport: 'directHttp',
        });
        appendChatMessage(AUX_SESSION_ID, {
          role: 'assistant',
          content: `[ERROR] ${message}`,
          ts: Date.now(),
          taskId: task.id,
          durationMs,
          error: true,
          cancelled: task.cancelled,
          protocol: auxConfig.protocol,
          wireApi: task._wireApi || null,
          transport: 'directHttp',
          enqueuedAt: task.ts,
          startedAt: startTime,
          queueMs: startTime - task.ts,
          apiError: failure && failure.decision ? {
            category: failure.decision.error.category,
            provider: failure.decision.error.provider,
            code: failure.decision.error.code,
            httpStatus: failure.decision.error.httpStatus,
            retryable: failure.decision.error.retryable,
            action: failure.decision.action,
            retryAfterMs: failure.decision.error.retryAfterMs,
          } : undefined,
        });
        if (task.cancelled) {
          task.reject({ cancelled: true });
          this.broadcast({ type: 'aux_event', status: 'done', task: { id: task.id, type: task.type }, durationMs, cancelled: true });
        } else {
          task.reject(error);
          this.broadcast({ type: 'aux_event', status: 'error', task: { id: task.id, type: task.type }, error: message, durationMs });
          logger.error(`[multicc/aux] Task ${task.id} failed:`, message);
        }
      } finally {
        this.currentTask = null;
        this.processing = false;
        this.drain();
      }
    },

    resolveHttpTarget() {
      const target = providers.resolveAuxHttpTarget(auxConfig.protocol, auxConfig.providerId, {
        port: getPort(),
        claudeOfficialViaProxy: getClaudeOfficialViaProxy(),
      });
      if (!target.available) {
        const reason = safeAuxErrorMessage(target.reason, '缺少可调用的 HTTP 端点');
        throw new Error(`Aux Provider 不可用：${reason}`);
      }
      return target;
    },

    execute(task) {
      let target;
      try {
        target = this.resolveHttpTarget();
      } catch (error) {
        return Promise.reject(error);
      }
      task._transport = 'directHttp';
      task._wireApi = target.wireApi;
      return this.executeHttp(task, target);
    },

    executeHttp(task, target) {
      const model = auxConfig.model || target.model || target.modelOptions && target.modelOptions[0] || '';
      return executeAuxHttp({
        target,
        model,
        prompt: task.prompt,
        systemPrompt: task.systemPrompt,
        timeoutMs: task.meta && task.meta.timeout || timeoutMs,
      });
    },

    broadcast(payload) {
      broadcast(this.clients, payload);
    },

    getStatus() {
      return {
        processing: this.processing,
        queueDepth: this.queue.length,
        currentTask: this.currentTask ? { id: this.currentTask.id, type: this.currentTask.type } : null,
        totalProcessed: this.totalProcessed,
        lastTaskTime: this.lastTaskTime,
        health: { ...this.health },
      };
    },
  };

  function listAuxProviders(protocol) {
    const normalized = normalizeAuxProtocol(protocol);
    const appType = normalized === 'openai' ? 'codex' : 'claude';
    return providers.listProviders(appType).map(provider => {
      const target = providers.resolveAuxHttpTarget(normalized, provider.id, {
        port: getPort(),
        claudeOfficialViaProxy: getClaudeOfficialViaProxy(),
      });
      return {
        id: provider.id,
        name: provider.name,
        modelOptions: target.modelOptions || provider.modelOptions || [],
        wireApi: target.wireApi || provider.wireApi || null,
        available: !!target.available,
        unavailableReason: target.available ? null : target.reason,
      };
    }).filter(provider => provider.available);
  }

  let goalConfig;
  try {
    goalConfig = normalizeGoalConfig(JSON.parse(fs.readFileSync(goalConfigFile, 'utf8')));
  } catch (_) {
    goalConfig = normalizeGoalConfig(null);
  }

  function saveGoalConfig() {
    try { atomicWriteJson(goalConfigFile, goalConfig); }
    catch (error) { logger.warn('[multicc/goal] save config failed:', safeAuxErrorMessage(error, 'save failed')); }
  }

  app.get('/api/aux/status', (req, res) => {
    res.json(auxQueue.getStatus());
  });

  app.get('/api/aux/health', (req, res) => {
    res.json({ health: { ...auxQueue.health } });
  });

  app.get('/api/aux/history', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 50, AUX_HISTORY_MAX);
    const history = loadChatHistory(AUX_SESSION_ID);
    res.json(history.slice(-limit));
  });

  app.post('/api/aux/enqueue', (req, res) => {
    const { type, prompt, meta } = req.body || {};
    if (!prompt) return res.status(400).json({ error: 'prompt required' });
    const rawId = req.body && req.body.id;
    const trimmedId = typeof rawId === 'string' ? rawId.trim() : '';
    const validId = /^[A-Za-z0-9_-]+$/.test(trimmedId) && trimmedId.length >= 1 && trimmedId.length <= 80
      ? trimmedId : '';
    const taskId = validId || crypto.randomUUID();
    auxQueue.enqueue({ id: taskId, type: type || 'manual', prompt, meta: meta || {} })
      .then(result => res.json({ ok: true, result: result.text, taskId }))
      .catch(error => res.json({
        ok: false,
        error: error && error.cancelled ? 'cancelled' : safeAuxErrorMessage(error),
        taskId,
      }));
  });

  app.post('/api/aux/cancel', (req, res) => {
    const id = req.body && req.body.id;
    if (!id) return res.status(400).json({ ok: false, error: 'id required' });
    auxQueue.cancel(String(id));
    return res.json({ ok: true });
  });

  app.get('/api/aux/config', (req, res) => {
    res.json({
      protocol: auxConfig.protocol,
      providerId: auxConfig.providerId,
      model: auxConfig.model,
      protocols: [
        { id: 'anthropic', name: 'Anthropic Messages' },
        { id: 'openai', name: 'OpenAI Responses / Chat Completions' },
      ],
      providersByProtocol: {
        anthropic: listAuxProviders('anthropic'),
        openai: listAuxProviders('openai'),
      },
    });
  });

  app.post('/api/aux/config', (req, res) => {
    const { providerId, model } = req.body || {};
    const rawProtocol = String(req.body && req.body.protocol || '').toLowerCase();
    if (rawProtocol !== 'anthropic' && rawProtocol !== 'openai') {
      return res.status(400).json({ ok: false, error: 'protocol 必须是 anthropic 或 openai' });
    }
    const protocol = normalizeAuxProtocol(rawProtocol);
    if (!providerId) return res.status(400).json({ ok: false, error: '请选择 Provider' });
    const target = providers.resolveAuxHttpTarget(protocol, String(providerId), {
      port: getPort(),
      claudeOfficialViaProxy: getClaudeOfficialViaProxy(),
    });
    if (!target.available) {
      const reason = safeAuxErrorMessage(target.reason, '不可用');
      return res.status(400).json({ ok: false, error: `Provider 不支持 ${protocol} HTTP 调用：${reason}` });
    }
    const resolvedModel = model && String(model).trim()
      || target.model
      || target.modelOptions && target.modelOptions[0]
      || null;
    if (!resolvedModel) return res.status(400).json({ ok: false, error: '请选择模型' });
    auxConfig.protocol = protocol;
    auxConfig.providerId = String(providerId);
    auxConfig.model = resolvedModel;
    saveAuxConfig();
    logger.log(`[multicc/aux] config updated: protocol=${protocol} wire=${target.wireApi} provider=${auxConfig.providerId} model=${auxConfig.model}`);
    res.json({ ok: true, protocol, providerId: auxConfig.providerId, model: auxConfig.model, wireApi: target.wireApi });
  });

  app.get('/api/settings/goal', (req, res) => {
    res.json({ ...goalConfig, dimensionLabels: GOAL_DIMENSIONS });
  });

  app.post('/api/settings/goal', (req, res) => {
    goalConfig = normalizeGoalConfig(req.body || {});
    saveGoalConfig();
    res.json({ ok: true, ...goalConfig });
  });

  app.post('/api/goal/precheck', (req, res) => {
    const body = req.body || {};
    const task = (body.task || '').trim();
    if (!task) return res.status(400).json({ error: 'task required' });
    const dimensions = body.dimensions && typeof body.dimensions === 'object'
      ? normalizeGoalConfig({ dimensions: body.dimensions }).dimensions
      : goalConfig.dimensions;
    let minScore = parseInt(body.minScore, 10);
    if (!Number.isFinite(minScore)) minScore = goalConfig.minScore;
    minScore = Math.max(0, Math.min(100, minScore));
    auxQueue.enqueue({
      type: 'goal_check',
      prompt: buildGoalPrecheckPrompt(task, dimensions),
      meta: { taskLen: task.length },
    }).then(result => {
      const verdict = parseGoalVerdict(result.text);
      if (minScore > 0 && verdict.verdict === 'ok' && verdict.score < minScore) {
        verdict.verdict = 'needs_work';
        verdict.issues = [`符合度 ${verdict.score} 低于设定阈值 ${minScore}`, ...verdict.issues];
      }
      res.json({ ok: true, ...verdict, dimensions, minScore });
    }).catch(error => res.json({ ok: false, error: safeAuxErrorMessage(error) }));
  });

  return {
    AUX_SESSION_ID,
    AUX_HISTORY_MAX,
    auxQueue,
    getAuxConfig: () => ({ ...auxConfig }),
    resolveGoalLimits,
    buildGoalLimitNote,
  };
}

module.exports = {
  AUX_SESSION_ID,
  AUX_HISTORY_MAX,
  GOAL_DIMENSIONS,
  normalizeAuxProtocol,
  normalizeGoalConfig,
  resolveGoalLimits,
  buildGoalLimitNote,
  buildGoalPrecheckPrompt,
  parseGoalVerdict,
  safeAuxErrorMessage,
  mountAuxGoalRoutes,
};
