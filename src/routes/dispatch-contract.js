// Curl-friendly mid-turn dispatch contract routes.
// Callable as POST /api/sessions/:id/dispatch or /api/v1/sessions/:id/dispatch.
// Result flows back automatically as a 【target 回复】message via finalizeDispatch.

function mountDispatchContractRoutes(app, deps) {
  const {
    persistedSessions,
    validateDispatchTarget,
    dispatchToSession,
    appendEvent,
    toDispatchResultDto,
    requestContext,
    withApiMeta,
    createErrorDto,
    logger,
  } = deps;

  async function executeDispatchContract(fromId, body, options = {}) {
    const from = persistedSessions.get(fromId);
    if (!from) return { status: 404, error: 'session not found', code: 'session_not_found' };
    const target = String((body && body.target) || '').trim();
    const message = String((body && body.message) || '').trim();
    if (!target || !message) return { status: 400, error: 'target 和 message 必填', code: 'invalid_dispatch' };
    if (target === from.id) return { status: 400, error: '不能把任务分发给自己', code: 'self_dispatch' };
    const validation = validateDispatchTarget(target, from.id);
    if (!validation.ok) return { status: 400, error: validation.error, code: 'invalid_target' };
    if (validation.rec.dirId !== from.dirId) return { status: 400, error: '只能分发给同目录会话', code: 'cross_directory' };
    appendEvent(from.dirId, 'dispatch', `→ ${validation.rec.label || target}`, from.id);
    try {
      const result = await dispatchToSession(target, message, {
        replyTo: from.id,
        idempotencyKey: options.idempotencyKey || null,
      });
      if (!result.ok) return { status: 409, error: result.error, code: 'dispatch_rejected' };
      return {
        status: 200,
        value: {
          ...toDispatchResultDto({
          ok: true,
          target,
          chatId: result.chatId,
          note: '任务已投递；完成后结果会以【回复】消息自动回流到本会话',
          }),
          operationId: result.operationId,
          status: result.status,
        },
      };
    } catch (error) {
      logger.error('dispatch_failed', { fromId, target, error: error && error.message });
      if (error && error.statusCode === 409) {
        return { status: 409, error: error.message, code: 'dispatch_conflict' };
      }
      return { status: 500, error: 'internal_error', code: 'internal_error' };
    }
  }

  function sendDispatchContract(req, res, result) {
    const context = requestContext(req, res);
    if (result.status === 200) {
      const dto = withApiMeta(result.value, context);
      if (req.path.startsWith('/api/v1/')) {
        delete dto.operationId;
        delete dto.status;
      }
      return res.json(dto);
    }
    return res.status(result.status).json(createErrorDto({
      ...context,
      message: result.error,
      code: result.code,
    }));
  }

  function dispatchContractHandler(req, res) {
    executeDispatchContract(req.params.id, req.body, {
      idempotencyKey: req.get('Idempotency-Key') || null,
    })
      .then(result => sendDispatchContract(req, res, result))
      .catch(error => {
        logger.error('dispatch_contract_failed', { sessionId: req.params.id, error: error && error.message });
        sendDispatchContract(req, res, { status: 500, error: 'internal_error', code: 'internal_error' });
      });
  }

  app.post('/api/sessions/:id/dispatch', dispatchContractHandler);
  app.post('/api/v1/sessions/:id/dispatch', dispatchContractHandler);
}

module.exports = { mountDispatchContractRoutes };
