'use strict';

const path = require('path');
const { createRouterToolRuntime } = require('./router-tool-runtime');
const { applyRouterMcpEnv } = require('./cli-adapters/router-mcp');

function createRouterToolHost({
  express,
  isLocalRequest,
  logger = console,
  activeTurnForSession = () => null,
  routerMcpNode = process.execPath,
  routerMcpScript = path.join(__dirname, '..', 'scripts', 'multicc-router-mcp.js'),
} = {}) {
  if (!express || typeof express.json !== 'function') {
    throw new TypeError('[router-tool-host] express port is required');
  }
  if (typeof isLocalRequest !== 'function') {
    throw new TypeError('[router-tool-host] locality port is required');
  }
  let runtime = null;

  function configure({
    records,
    dispatchToSession,
    orchestrationRuntime,
    resolveContext,
    taskBoard,
    recordUserInput,
  } = {}) {
    runtime = createRouterToolRuntime({
      records,
      dispatchToSession,
      operations: orchestrationRuntime?.operations,
      completeDispatch: (id, result) => orchestrationRuntime.completeDispatch(id, result),
      tick: () => orchestrationRuntime.tick(),
      onAdmitted: taskBoard?.recordRouterAdmission,
      recordUserInput,
      resolveContext: resolveContext || (sessionId => {
        const turn = activeTurnForSession(sessionId);
        return turn ? {
          turnId: turn.turnId,
          originDispatchId: turn.lineage?.kind === 'dispatch' ? turn.lineage.operationId : null,
          userText: turn.userText || '',
          taskId: turn.task?.id || null,
          taskStart: turn.task?.start === true,
          taskSource: turn.task?.source || null,
        } : null;
      }),
    });
  }

  function mount(app) {
    app.post(
      '/api/internal/router-tools/:tool',
      express.json({ limit: '768kb' }),
      async (req, res) => {
        const requestId = res.locals?.requestId || req.id || null;
        if (!isLocalRequest(req)) {
          return res.status(403).json({ ok: false, code: 'local_only', requestId });
        }
        if (!runtime) {
          return res.status(503).json({ ok: false, code: 'router_unavailable', requestId });
        }
        const controller = new AbortController();
        const abort = () => {
          if (!res.writableEnded) controller.abort();
        };
        req.once('aborted', abort);
        res.once('close', abort);
        try {
          const result = await runtime.execute(
            req.get('x-multicc-router-capability') || '',
            String(req.params.tool || ''),
            req.body?.arguments,
            { signal: controller.signal },
          );
          return res.json({ ok: true, result, requestId });
        } catch (error) {
          const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
          const code = status >= 500 ? 'router_internal_error' : (error?.code || 'router_error');
          if (status >= 500) logger.error('router_tool_failure', {
            requestId,
            tool: String(req.params.tool || ''),
            code: error?.code || null,
            error: error?.message || String(error),
          });
          return res.status(status).json({ ok: false, code, requestId });
        } finally {
          req.removeListener('aborted', abort);
          res.removeListener('close', abort);
        }
      },
    );
  }

  function processContext({
    sessionId,
    turnId,
    originDispatchId = null,
    userText = '',
    taskId = null,
    taskStart = false,
    taskSource = null,
    baseUrl,
    dynamic = false,
  } = {}) {
    if (!runtime) throw new Error('router tool runtime is not configured');
    const token = runtime.issueContext({
      sessionId, turnId, originDispatchId, userText,
      taskId, taskStart, taskSource, dynamic,
    });
    let revoked = false;
    const revoke = () => {
      if (revoked) return;
      revoked = true;
      runtime?.revoke(token);
    };
    return Object.freeze({
      env: Object.freeze({
        MULTICC_SESSION_ID: sessionId,
        MULTICC_BASE_URL: baseUrl,
        MULTICC_TURN_ID: turnId,
        MULTICC_ORIGIN_DISPATCH_ID: originDispatchId || '',
        MULTICC_ROUTER_CAPABILITY: token,
      }),
      bind(proc) {
        proc.once('error', revoke);
        proc.once('close', revoke);
      },
      revoke,
    });
  }

  function clear() {
    runtime?.clear();
  }

  function refreshPersistentProcess(holder, env, context) {
    releasePersistentProcess(holder);
    const processCapability = processContext({ ...context, dynamic: true });
    Object.assign(env, processCapability.env);
    holder._routerToolProcess = processCapability;
  }

  function releasePersistentProcess(holder) {
    holder?._routerToolProcess?.revoke();
    if (holder) holder._routerToolProcess = null;
  }

  function spawnProcess({
    cli,
    spawn,
    command,
    args,
    cwd,
    env,
    sessionId,
    turnId,
    originDispatchId,
    userText,
    taskId,
    taskStart,
    taskSource,
    baseUrl,
  } = {}) {
    const processCapability = processContext({
      sessionId, turnId, originDispatchId, userText,
      taskId, taskStart, taskSource, baseUrl,
    });
    if (processCapability) Object.assign(env, processCapability.env);
    applyRouterMcpEnv(env, cli, routerMcpNode, routerMcpScript);
    let proc;
    try {
      proc = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      processCapability?.revoke();
      throw error;
    }
    processCapability?.bind(proc);
    return proc;
  }

  return Object.freeze({
    clear,
    configure,
    mount,
    processContext,
    refreshPersistentProcess,
    releasePersistentProcess,
    spawnProcess,
  });
}

module.exports = { createRouterToolHost };
