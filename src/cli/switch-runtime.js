'use strict';

const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');

// 官方 CLI 安装命令表(单一事实源, 三端共用 API 契约)。display 同 command。
// 静态表无用户输入拼接, 命令直接喂给 bash -c。
const OFFICIAL_INSTALL_SPECS = Object.freeze({
  claude: {
    auto: true,
    command: 'npm install -g @anthropic-ai/claude-code',
    display: 'npm install -g @anthropic-ai/claude-code',
  },
  codex: {
    auto: true,
    command: 'npm install -g @openai/codex',
    display: 'npm install -g @openai/codex',
  },
  opencode: {
    auto: true,
    command: 'npm install -g opencode-ai',
    display: 'npm install -g opencode-ai',
  },
  qoder: {
    auto: true,
    command: 'curl -fsSL https://qoder.cn/install | bash',
    display: 'curl -fsSL https://qoder.cn/install | bash',
  },
  zcode: {
    auto: false,
    manual: 'ZCode 暂无官方 CLI 安装脚本, 请从官网 https://zcode.z.ai 下载安装 ZCode 桌面版(其内置 CLI)',
  },
});

const INSTALL_TIMEOUT_MS = 8 * 60 * 1000;
const INSTALL_LOG_TAIL = 12 * 1024; // 环形 buffer 保留尾部约 12KB
const INSTALL_JOB_CAPACITY = 50;

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
    'getChatStream', 'cancelClassify', 'assignKillReason', 'appendMessage',
    'appendEvent', 'chatBroadcast', 'workspaceBroadcast', 'saveBestEffort',
    'cliAvailabilitySummary', 'sessionProviderName', 'effectiveSessionModel',
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
  // 安装任务表(模块内, 容量上限 50; 每个 runtime 实例独立, 便于测试隔离)。
  const installJobs = new Map();

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
    if (/is required but not installed|Neither curl nor wget/i.test(text)) {
      return '缺少安装所需的命令行工具（如 curl / unzip / tar）。请先安装相应工具后重试。';
    }
    return null;
  }

  function findRunningInstallJob(cli) {
    for (const job of installJobs.values()) {
      if (job.cli === cli && job.status === 'running') return job;
    }
    return null;
  }

  function serializeInstallJob(job) {
    return {
      id: job.id,
      cli: job.cli,
      status: job.status,
      command: job.command,
      startedAt: job.startedAt,
      endedAt: job.endedAt,
      exitCode: job.exitCode,
      error: job.error,
      hint: classifyInstallHint(job._log.tail()),
      logTail: job._log.tail(),
    };
  }

  // spawn 的 PATH 追加常见二进制目录(homebrew/local/user-local)。
  function buildInstallEnv() {
    const extra = ['/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local/bin')];
    return { ...process.env, PATH: [process.env.PATH, ...extra].filter(Boolean).join(':') };
  }

  function launchInstallJob(cli) {
    const spec = installSpecs[cli];
    const command = spec.command;
    const jobId = makeInstallJobId();
    const startedAt = new Date(clock()).toISOString();
    const log = createLogRing();
    const job = {
      id: jobId, cli, status: 'running', command, startedAt,
      endedAt: null, exitCode: null, error: null, _log: log, _timer: null,
    };
    if (installJobs.size >= INSTALL_JOB_CAPACITY) {
      const oldest = installJobs.keys().next().value;
      if (oldest) installJobs.delete(oldest);
    }
    installJobs.set(jobId, job);

    const spawn = resolveSpawn();
    const env = buildInstallEnv();
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
    return {
      provider: providerDefaults[cli] || null,
      model: null,
      effort: cli === 'codex' ? options.codexDefaultReasoningLevel() : null,
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
    const busy = !!(
      (chat && (chat.isStreaming || chat.claudeProc))
      || (stream && (stream.busy || stream.queued > 0))
    );
    return { busy, cs: chat, stream };
  }

  function resetChatRuntimeForCli(chat, session) {
    if (!chat) return;
    options.assignKillReason(chat._activeRunner, 'cli_switch');
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

    options.getChatStream().close(session.id);
    resetChatRuntimeForCli(chatSessions.get(session.id), session);
    options.rememberActiveCliState(session, now);
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
      providerName: options.sessionProviderName(session),
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
    return { result, handoff };
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
      message: handoff.reason === 'history_clear_keep'
        ? `✓ 保留的最近消息已由 ${handoff.toCli} 作为新上下文接收`
        : `✓ ${handoff.fromCli} → ${handoff.toCli} 的上下文交接已由目标 CLI 接收`,
    });
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
      if ((session.cli || 'claude') === targetCli && !fresh) {
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
      const activity = cliSwitchBusyState(session.id);
      if (activity.busy) {
        return res.status(409).json({
          error: 'session is running; wait for the current turn to finish or cancel it before switching CLI',
          stream: activity.stream || null,
        });
      }
      const gitSnapshot = await cliSwitchGitSnapshot(session);
      const switched = sessionPersistence.mutate('http.switch-cli', () =>
        performCliSwitch(session, targetCli, { fresh, gitSnapshot }));
      return res.json({
        ok: true,
        changed: true,
        cli: session.cli,
        fromCli: switched.result.fromCli,
        handoffId: switched.handoff.id,
        reusedTarget: switched.result.reused,
        fresh,
        cliStates: options.cliStateSummary(session),
        cliAvailability: availability,
        effectiveModel: options.effectiveSessionModel(session),
        effectiveEffort: options.effectiveSessionEffort(session),
        provider: session.provider || null,
        providerName: options.sessionProviderName(session),
        model: session.model || null,
        effort: session.effort || null,
        agent: session.agent || null,
        subagent: options.serializeSubagent(session.subagent),
      });
    }));

    app.get('/api/cli/install-specs', asyncHandler(async (req, res) => {
      return res.json({ ok: true, specs: installSpecs });
    }));

    app.post('/api/cli/:cli/install', asyncHandler(async (req, res) => {
      const cli = String((req.params && req.params.cli) || '').trim().toLowerCase();
      if (!supportedClis.includes(cli)) {
        return res.status(400).json({ ok: false, error: 'unsupported cli' });
      }
      const availability = options.cliAvailabilitySummary();
      if (availability && availability[cli] && availability[cli].available) {
        return res.json({ ok: true, alreadyInstalled: true, availability: { [cli]: availability[cli] } });
      }
      const spec = installSpecs[cli];
      if (!spec) {
        return res.status(400).json({ ok: false, error: 'unsupported cli' });
      }
      if (spec.auto === false) {
        return res.status(400).json({ ok: false, manual: true, error: spec.manual });
      }
      const running = findRunningInstallJob(cli);
      if (running) {
        return res.status(409).json({ ok: false, running: true, jobId: running.id });
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
  }

  return Object.freeze({
    mountRoutes,
    cliSwitchDefaults,
    cliSwitchGitSnapshot,
    cliSwitchBusyState,
    performCliSwitch,
    consumePendingCliHandoff,
  });
}

module.exports = { cliHandoffSummary, createCliSwitchRuntime, OFFICIAL_INSTALL_SPECS };
