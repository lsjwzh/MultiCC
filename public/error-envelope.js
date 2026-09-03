'use strict';

(function initMultiCCErrorEnvelope(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MultiCCErrorEnvelope = api;
})(typeof window !== 'undefined' ? window : null, function createErrorEnvelopeApi(root) {
  const CODE_RE = /^[A-Za-z0-9_.-]{1,96}$/;
  const ID_RE = /^[A-Za-z0-9._:-]{1,160}$/;
  const SECRET_KEY_RE = /(?:token|secret|password|passwd|authorization|cookie|api[_-]?key|credential)/i;
  const SECRET_QUERY_RE = /([?&](?:token|access_token|auth_token|api_key|apikey|authorization)=)[^&#\s]*/gi;
  const FAMILY_LABELS = Object.freeze({
    auth: '登录或权限错误',
    network: '本机网络或连接错误',
    remote: '外部 Fleet 不可达',
    route: 'Provider 路由失败',
    provider: 'Provider / 模型错误',
    conflict: '状态冲突',
    runtime: '运行时错误',
    lifecycle: '服务生命周期错误',
    internal: '内部错误',
  });
  const DEFAULT_ACTIONS = Object.freeze({
    auth: 'login',
    network: 'retry',
    remote: 'retry',
    route: 'retry_turn',
    provider: 'open_settings',
    conflict: 'revise',
    runtime: 'retry',
    lifecycle: 'restart',
    internal: 'copy_details',
  });

  function cleanId(value) {
    const text = typeof value === 'string' ? value.trim() : '';
    return ID_RE.test(text) ? text : null;
  }

  function cleanCode(value, fallback = null) {
    const text = typeof value === 'string' ? value.trim() : '';
    return CODE_RE.test(text) ? text : fallback;
  }

  function redactText(value, max = 4000) {
    let text = String(value == null ? '' : value)
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
      .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
      .replace(/\b(?:sk|gh[pousr])[-_][A-Za-z0-9_-]{8,}\b/g, '[redacted]')
      .replace(/\bfleet_share_[A-Za-z0-9_-]{24,96}\b/g, 'fleet_share_[redacted]')
      .replace(/\b(token|secret|password|passwd|authorization|api[_ -]?key|credential)\s*[:=]\s*([^\s,;]+)/gi, '$1=[redacted]')
      .replace(SECRET_QUERY_RE, '$1[redacted]')
      .replace(/[A-Za-z]:\\(?:[^\\\s]+\\){1,}[^\s]*/g, '[path]')
      .replace(/\/(?:Users|home)\/[^/\s]+\/(?:[^\s,;])*/g, '[path]')
      .trim();
    if (text.length > max) text = `${text.slice(0, max)}…`;
    return text;
  }

  function safeValue(value, depth = 0, seen = new Set()) {
    if (value == null) return value;
    if (typeof value === 'string') return redactText(value, 1000);
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value !== 'object' || depth > 5 || seen.has(value)) return undefined;
    seen.add(value);
    if (Array.isArray(value)) {
      const list = value.slice(0, 100)
        .map(item => safeValue(item, depth + 1, seen))
        .filter(item => item !== undefined);
      seen.delete(value);
      return list;
    }
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_KEY_RE.test(key) || ['stack', 'stderr', 'stdout'].includes(key.toLowerCase())) continue;
      const safe = safeValue(item, depth + 1, seen);
      if (safe !== undefined) out[key] = safe;
    }
    seen.delete(value);
    return out;
  }

  function firstText(...values) {
    for (const value of values) {
      if (typeof value === 'string' && value.trim()) return redactText(value, 1000);
      if (value && typeof value === 'object' && typeof value.message === 'string' && value.message.trim()) {
        return redactText(value.message, 1000);
      }
    }
    return '';
  }

  function headerValue(headers, name) {
    if (!headers) return '';
    if (typeof headers.get === 'function') return headers.get(name) || '';
    const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
    return found ? found[1] : '';
  }

  function statusOf(raw, context) {
    const nested = raw && typeof raw.error === 'object' ? raw.error : {};
    const value = context.httpStatus ?? context.status ?? raw.httpStatus ?? raw.status
      ?? nested.httpStatus ?? nested.status;
    const status = Number(value);
    return Number.isInteger(status) && status >= 100 && status <= 599 ? status : 0;
  }

  function familyOf({ category, code, message, httpStatus, source }) {
    const joined = `${category || ''} ${code || ''} ${message || ''} ${source || ''}`.toLowerCase();
    if (httpStatus === 401 || httpStatus === 403
        || /auth|unauthori[sz]ed|forbidden|permission|access.denied|wrong.password/.test(joined)) return 'auth';
    if (/server.shutting|shutdown|restart|required|service.restart|upgrade|update/.test(joined)) return 'lifecycle';
    if (/external|fleet|remote/.test(joined)
        && (/unavailable|unreachable|timeout|network|connect|invalid.remote|ticket/.test(joined)
          || httpStatus >= 500)) return 'remote';
    if (/route|attempt|circuit|provider.in.use|provider.route/.test(joined)) return 'route';
    if (/network|dns|tls|econn|enotfound|fetch.failed|socket|websocket|ws.abnormal|connection/.test(joined)) return 'network';
    if (/provider|model|quota|billing|rate.limit|context.token|tool.protocol|adapter.configuration|upstream/.test(joined)) return 'provider';
    if (httpStatus === 409 || /conflict|already|busy|locked|revision/.test(joined)) return 'conflict';
    if (/timeout|abort|cancel|spawn|cli|runtime/.test(joined)) return 'runtime';
    return 'internal';
  }

  function retryableOf(raw, family, httpStatus, code) {
    if (typeof raw.retryable === 'boolean') return raw.retryable;
    const token = String(code || '').toLowerCase();
    if (family === 'network' || family === 'remote') return true;
    if (family === 'auth' || family === 'conflict') return false;
    if ([408, 425, 429, 500, 502, 503, 504, 529].includes(httpStatus)) return true;
    return /timeout|temporary|transient|rate.limit|unavailable|abnormal.close/.test(token);
  }

  function normalize(rawInput, context = {}) {
    const carried = rawInput && rawInput.envelope && typeof rawInput.envelope === 'object'
      ? rawInput.envelope : null;
    const sourceRaw = carried || rawInput || {};
    const raw = safeValue(sourceRaw) || {};
    const nested = raw && raw.error && typeof raw.error === 'object' && !Array.isArray(raw.error)
      ? raw.error : {};
    const httpStatus = statusOf(raw, context);
    const explicitCode = cleanCode(
      context.code || raw.code || nested.code || raw.errorCode || nested.errorCode,
    );
    const code = explicitCode || cleanCode(
      context.defaultCode,
      httpStatus ? `HTTP_${httpStatus}` : 'UNKNOWN_ERROR',
    );
    const message = firstText(
      context.message,
      typeof raw.error === 'string' ? raw.error : null,
      nested.message,
      raw.message,
      sourceRaw && sourceRaw.message,
      raw.reason,
      context.fallbackMessage,
    ) || (httpStatus ? `HTTP ${httpStatus}` : 'Unknown error');
    const detail = firstText(
      context.detail,
      raw.detail,
      nested.detail,
      raw.rootCause,
      raw.cause,
      message,
    );
    const category = cleanCode(context.category || raw.category || nested.category, 'unknown').toLowerCase();
    const source = cleanCode(context.source || raw.source, 'unknown').toLowerCase();
    const family = familyOf({ category, code, message: `${message} ${detail}`, httpStatus, source });
    const requestId = cleanId(context.requestId || raw.requestId || nested.requestId
      || headerValue(context.headers, 'x-multicc-request-id')
      || headerValue(context.headers, 'x-request-id'));
    const correlationId = cleanId(context.correlationId || raw.correlationId || nested.correlationId
      || headerValue(context.headers, 'x-correlation-id')) || requestId;
    const upstreamRequestId = cleanId(context.upstreamRequestId || raw.upstreamRequestId
      || nested.upstreamRequestId || headerValue(context.headers, 'x-multicc-upstream-request-id'));
    const retryable = retryableOf(raw, family, httpStatus, code);
    const action = cleanCode(context.action || raw.action || nested.action, DEFAULT_ACTIONS[family]);
    const scope = cleanCode(context.scope || raw.scope || nested.scope, 'request').toLowerCase();
    const occurredAtRaw = context.occurredAt || raw.occurredAt || raw.at;
    const occurredAtDate = occurredAtRaw ? new Date(occurredAtRaw) : new Date();
    const occurredAt = Number.isFinite(occurredAtDate.getTime())
      ? occurredAtDate.toISOString() : new Date().toISOString();
    return Object.freeze({
      version: 'v1',
      code,
      category,
      family,
      message,
      detail,
      retryable,
      action,
      scope,
      requestId,
      correlationId,
      upstreamRequestId,
      httpStatus,
      source,
      occurredAt,
      original: Object.freeze(raw),
    });
  }

  function visibleMessage(input) {
    const envelope = input && input.version === 'v1' ? input : normalize(input);
    return envelope.code ? `[${envelope.code}] ${envelope.message}` : envelope.message;
  }

  function presentation(input, options = {}) {
    const envelope = input && input.version === 'v1' ? input : normalize(input, options);
    const retrySuffix = envelope.retryable && Number(options.retrySeconds) > 0
      ? `，${Math.max(1, Math.round(Number(options.retrySeconds)))}s 后重试`
      : '';
    return Object.freeze({
      envelope,
      headline: FAMILY_LABELS[envelope.family] || FAMILY_LABELS.internal,
      message: `${visibleMessage(envelope)}${retrySuffix}`,
      tone: envelope.retryable ? 'warning' : 'danger',
      action: envelope.action,
    });
  }

  function diagnosticText(input) {
    const envelope = input && input.version === 'v1' ? input : normalize(input);
    const lines = [
      `错误: ${visibleMessage(envelope)}`,
      envelope.httpStatus ? `HTTP: ${envelope.httpStatus}` : '',
      `分类: ${envelope.category} (${envelope.family})`,
      `可重试: ${envelope.retryable ? 'yes' : 'no'}`,
      `建议动作: ${envelope.action}`,
      `作用域: ${envelope.scope}`,
      envelope.requestId ? `requestId: ${envelope.requestId}` : '',
      envelope.correlationId ? `correlationId: ${envelope.correlationId}` : '',
      envelope.upstreamRequestId ? `upstreamRequestId: ${envelope.upstreamRequestId}` : '',
      `时间: ${envelope.occurredAt}`,
      envelope.detail && envelope.detail !== envelope.message ? `原始详情: ${envelope.detail}` : '',
    ].filter(Boolean);
    const original = safeValue(envelope.original);
    if (original && typeof original === 'object' && Object.keys(original).length) {
      const serialized = redactText(JSON.stringify(original, null, 2), 6000);
      if (serialized && serialized !== '{}') lines.push(`原始错误对象:\n${serialized}`);
    }
    return lines.join('\n');
  }

  function createDetails(doc, input, options = {}) {
    if (!doc || typeof doc.createElement !== 'function') return null;
    const envelope = input && input.version === 'v1' ? input : normalize(input);
    const details = doc.createElement('details');
    details.className = 'mc-error-details';
    const summary = doc.createElement('summary');
    summary.textContent = options.summary || '诊断详情';
    const pre = doc.createElement('pre');
    pre.textContent = diagnosticText(envelope);
    const copy = doc.createElement('button');
    copy.type = 'button';
    copy.className = 'mc-error-copy';
    copy.textContent = '复制';
    copy.addEventListener('click', async (event) => {
      if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
      try {
        const nav = (root && root.navigator) || (typeof navigator !== 'undefined' ? navigator : null);
        if (!nav || !nav.clipboard || typeof nav.clipboard.writeText !== 'function') throw new Error('clipboard unavailable');
        await nav.clipboard.writeText(pre.textContent);
        copy.textContent = '已复制';
      } catch (_) {
        copy.textContent = '复制失败';
      }
    });
    details.append(summary, pre, copy);
    return details;
  }

  async function fromHttpResponse(response, context = {}) {
    let data = null;
    let text = '';
    try {
      if (response && typeof response.text === 'function') {
        text = await response.text();
        if (text) {
          try { data = JSON.parse(text); }
          catch (_) { data = { message: redactText(text, 1000) }; }
        }
      } else if (response && typeof response.json === 'function') {
        data = await response.json();
      }
    } catch (_) { /* unreadable bodies still retain status + response ids */ }
    const envelope = normalize(data || {}, {
      ...context,
      status: response && response.status,
      headers: response && response.headers,
      fallbackMessage: context.fallbackMessage || `HTTP ${response && response.status || 0}`,
    });
    const error = new Error(envelope.message);
    error.name = 'MultiCCError';
    Object.assign(error, {
      code: envelope.code,
      status: envelope.httpStatus,
      requestId: envelope.requestId,
      correlationId: envelope.correlationId,
      upstreamRequestId: envelope.upstreamRequestId,
      category: envelope.category,
      family: envelope.family,
      retryable: envelope.retryable,
      action: envelope.action,
      details: envelope.original,
      envelope,
    });
    return error;
  }

  function fromWsClose(event = {}, context = {}) {
    const closeCode = Number(event.code) || 1006;
    const reason = firstText(event.reason);
    const meanings = {
      1000: 'WebSocket 正常关闭',
      1001: 'WebSocket 端点离开',
      1006: 'WebSocket 异常断开，未收到关闭帧',
      1008: 'WebSocket 请求违反服务端策略',
      1011: 'WebSocket 服务端发生异常',
      1012: 'WebSocket 服务正在重启',
      1013: 'WebSocket 服务暂时过载',
    };
    return normalize({
      code: `WS_CLOSE_${closeCode}`,
      message: reason || meanings[closeCode] || `WebSocket 已关闭 (${closeCode})`,
      retryable: ![1000, 1008].includes(closeCode),
    }, {
      ...context,
      category: closeCode === 1008 ? 'authentication_permission'
        : closeCode === 1012 ? 'lifecycle' : 'network',
      source: 'websocket',
      scope: context.scope || 'session',
    });
  }

  return Object.freeze({
    cleanCode,
    createDetails,
    diagnosticText,
    fromHttpResponse,
    fromWsClose,
    normalize,
    presentation,
    redactText,
    safeValue,
    visibleMessage,
  });
});
