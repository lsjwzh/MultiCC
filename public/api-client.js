'use strict';

(function initMultiCCApi(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MultiCCApi = api;
})(typeof window !== 'undefined' ? window : null, function createMultiCCApi(root) {
  const DEFAULT_TIMEOUT_MS = 15000;
  const SENSITIVE_QUERY_KEY = /^(?:token|access[_-]?token|auth(?:orization)?|api[_-]?key)$/i;
  const SENSITIVE_HEADER = /^(?:authorization|proxy-authorization|cookie|x-access-token|x-api-key)$/i;
  const SENSITIVE_DATA_KEY = /(?:token|secret|password|authorization|cookie|api[_-]?key|credential)/i;
  const errorModel = (root && root.MultiCCErrorEnvelope)
    || (typeof module === 'object' && module.exports ? require('./error-envelope') : null);

  class ApiError extends Error {
    constructor(message, options = {}) {
      super(message);
      this.name = 'ApiError';
      this.code = options.code || 'API_ERROR';
      this.status = Number(options.status) || 0;
      this.requestId = options.requestId || null;
      this.correlationId = options.correlationId || null;
      this.upstreamRequestId = options.upstreamRequestId || null;
      this.details = options.details || null;
      this.category = options.category || 'unknown';
      this.family = options.family || 'internal';
      this.retryable = options.retryable === true;
      this.action = options.action || null;
      this.scope = options.scope || 'request';
      this.occurredAt = options.occurredAt || null;
      this.envelope = options.envelope || null;
    }
  }

  function truncate(value, max = 300) {
    const text = String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    return text.length > max ? text.slice(0, max) + '…' : text;
  }

  function safeData(value, depth = 0) {
    if (depth > 4 || value == null) return value == null ? value : undefined;
    if (typeof value === 'string') {
      return errorModel ? errorModel.redactText(value, 1000) : truncate(value, 500);
    }
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) {
      return value.slice(0, 100).map(item => safeData(item, depth + 1)).filter(item => item !== undefined);
    }
    if (typeof value !== 'object') return undefined;
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (SENSITIVE_DATA_KEY.test(key)) continue;
      const safe = safeData(item, depth + 1);
      if (safe !== undefined) out[key] = safe;
    }
    return out;
  }

  function getRuntime() {
    if (!root || !root.location || typeof root.fetch !== 'function') {
      throw new ApiError('Browser API client is unavailable', { code: 'API_UNAVAILABLE' });
    }
    return {
      URL: root.URL || URL,
      Headers: root.Headers || Headers,
      AbortController: root.AbortController || AbortController,
    };
  }

  function resolveUrl(input) {
    const runtime = getRuntime();
    const raw = input && typeof input === 'object' && typeof input.url === 'string'
      ? input.url
      : String(input || '');
    const url = new runtime.URL(raw, root.location.href);
    for (const key of url.searchParams.keys()) {
      if (SENSITIVE_QUERY_KEY.test(key)) {
        throw new ApiError('Authentication data is not allowed in request URLs', {
          code: 'URL_AUTH_FORBIDDEN',
        });
      }
    }
    if (url.username || url.password) {
      throw new ApiError('Authentication data is not allowed in request URLs', {
        code: 'URL_AUTH_FORBIDDEN',
      });
    }
    return { url, sameOrigin: url.origin === root.location.origin };
  }

  function responseHeader(response, name) {
    if (!response || !response.headers || typeof response.headers.get !== 'function') return '';
    return truncate(response.headers.get(name) || '', 160);
  }

  function responseIds(response, data) {
    const body = data && typeof data === 'object' ? data : {};
    return {
      requestId: responseHeader(response, 'x-request-id') ||
        responseHeader(response, 'x-multicc-request-id') || truncate(body.requestId || '', 160) || null,
      correlationId: responseHeader(response, 'x-correlation-id') ||
        truncate(body.correlationId || '', 160) || null,
      upstreamRequestId: responseHeader(response, 'x-multicc-upstream-request-id') ||
        truncate(body.upstreamRequestId || '', 160) || null,
    };
  }

  async function readResponse(response) {
    if (!response || response.status === 204 || response.status === 205) {
      return { text: '', data: null, isJson: true };
    }
    const text = typeof response.text === 'function' ? await response.text() : '';
    if (!text) return { text: '', data: null, isJson: true };
    try {
      return { text, data: JSON.parse(text), isJson: true };
    } catch (_) {
      return { text, data: null, isJson: false };
    }
  }

  function httpError(response, parsed) {
    const details = parsed.isJson ? safeData(parsed.data) : null;
    const ids = responseIds(response, details);
    const envelope = errorModel ? errorModel.normalize(details || {}, {
      status: response.status,
      requestId: ids.requestId,
      correlationId: ids.correlationId,
      upstreamRequestId: ids.upstreamRequestId,
      source: 'http',
      scope: 'request',
      defaultCode: 'HTTP_ERROR',
      fallbackMessage: `HTTP ${response.status || 0}`,
    }) : null;
    const bodyMessage = details && (details.error || details.message);
    const message = envelope ? envelope.message
      : typeof bodyMessage === 'string' && bodyMessage.trim()
        ? truncate(bodyMessage)
        : `HTTP ${response.status || 0}`;
    return new ApiError(message, {
      code: envelope ? envelope.code : (details && truncate(details.code || '', 80)) || 'HTTP_ERROR',
      status: envelope ? envelope.httpStatus : response.status,
      requestId: ids.requestId,
      correlationId: ids.correlationId,
      upstreamRequestId: ids.upstreamRequestId,
      details,
      category: envelope && envelope.category,
      family: envelope && envelope.family,
      retryable: envelope && envelope.retryable,
      action: envelope && envelope.action,
      scope: envelope && envelope.scope,
      occurredAt: envelope && envelope.occurredAt,
      envelope,
    });
  }

  function errorFromPayload(payload, options = {}) {
    const response = options.response || {
      status: Number(options.status) || 0,
      headers: options.headers || null,
    };
    return httpError(response, { isJson: payload != null, data: payload });
  }

  async function errorFromResponse(response) {
    return httpError(response, await readResponse(response));
  }

  function abortError(code) {
    return new ApiError(code === 'API_TIMEOUT' ? 'Request timed out' : 'Request was aborted', { code });
  }

  async function request(input, options = {}) {
    const runtime = getRuntime();
    const { url, sameOrigin } = resolveUrl(input);
    const allowExternal = options.allowExternal === true;
    if (!sameOrigin && !allowExternal) {
      throw new ApiError('Cross-origin requests require explicit opt-in', {
        code: 'CROSS_ORIGIN_FORBIDDEN',
      });
    }

    const headers = new runtime.Headers(options.headers || {});
    if (!sameOrigin) {
      for (const key of Array.from(headers.keys())) {
        if (SENSITIVE_HEADER.test(key)) headers.delete(key);
      }
    }
    let body = options.body;
    if (Object.prototype.hasOwnProperty.call(options, 'json')) {
      body = JSON.stringify(options.json);
      if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    }

    const controller = new runtime.AbortController();
    const callerSignal = options.signal;
    if (callerSignal && callerSignal.aborted) throw abortError('API_ABORTED');
    const timeoutMs = options.timeoutMs === undefined
      ? DEFAULT_TIMEOUT_MS
      : Math.max(0, Number(options.timeoutMs) || 0);
    let timer = null;
    let settledAbort = false;
    let rejectAbort;
    const abortPromise = new Promise((_, reject) => { rejectAbort = reject; });
    const stop = (code) => {
      if (settledAbort) return;
      settledAbort = true;
      controller.abort();
      rejectAbort(abortError(code));
    };
    const onCallerAbort = () => stop('API_ABORTED');
    if (callerSignal) {
      callerSignal.addEventListener('abort', onCallerAbort, { once: true });
    }
    if (timeoutMs > 0) timer = root.setTimeout(() => stop('API_TIMEOUT'), timeoutMs);

    const fetchOptions = {
      method: options.method || 'GET',
      headers,
      body,
      signal: controller.signal,
      credentials: sameOrigin ? (options.credentials || 'same-origin') : 'omit',
    };
    if (options.cache !== undefined) fetchOptions.cache = options.cache;
    if (options.redirect !== undefined) fetchOptions.redirect = options.redirect;
    if (options.referrerPolicy !== undefined) fetchOptions.referrerPolicy = options.referrerPolicy;
    if (!sameOrigin) fetchOptions.referrerPolicy = 'no-referrer';

    try {
      if (sameOrigin && root.multiccAuthReady) {
        await Promise.race([Promise.resolve(root.multiccAuthReady).catch(() => undefined), abortPromise]);
      }
      const response = await Promise.race([root.fetch(url.href, fetchOptions), abortPromise]);
      const parsed = await Promise.race([readResponse(response), abortPromise]);
      if (!response.ok) throw httpError(response, parsed);
      if (options.expectJson === true && !parsed.isJson) {
        const ids = responseIds(response, null);
        throw new ApiError('Response was not valid JSON', {
          code: 'INVALID_JSON',
          status: response.status,
          requestId: ids.requestId,
          correlationId: ids.correlationId,
          upstreamRequestId: ids.upstreamRequestId,
        });
      }
      const ids = responseIds(response, parsed.data);
      return {
        data: parsed.isJson ? parsed.data : parsed.text,
        response,
        requestId: ids.requestId,
        correlationId: ids.correlationId,
        upstreamRequestId: ids.upstreamRequestId,
      };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (settledAbort) throw abortError(callerSignal && callerSignal.aborted ? 'API_ABORTED' : 'API_TIMEOUT');
      const envelope = errorModel ? errorModel.normalize({
        code: error && error.code || 'NETWORK_ERROR',
        message: error && error.message || 'Network request failed',
        cause: error && error.cause && error.cause.message,
        retryable: true,
      }, { category: 'network', source: 'fetch', scope: 'request' }) : null;
      throw new ApiError(envelope ? envelope.message : 'Network request failed', {
        code: envelope ? envelope.code : 'NETWORK_ERROR',
        category: envelope && envelope.category,
        family: envelope && envelope.family,
        retryable: true,
        action: envelope && envelope.action,
        scope: envelope && envelope.scope,
        occurredAt: envelope && envelope.occurredAt,
        envelope,
      });
    } finally {
      if (timer !== null) root.clearTimeout(timer);
      if (callerSignal) callerSignal.removeEventListener('abort', onCallerAbort);
    }
  }

  async function json(input, options = {}) {
    const result = await request(input, { ...options, expectJson: true });
    return result.data;
  }

  function errorDisplay(error) {
    if (!(error instanceof ApiError)) {
      const envelope = errorModel ? errorModel.normalize(error || {}, {
        defaultCode: 'API_ERROR', fallbackMessage: 'Request failed', source: 'browser',
      }) : null;
      return {
        message: envelope ? envelope.message : 'Request failed',
        displayMessage: envelope ? errorModel.visibleMessage(envelope) : 'Request failed',
        code: envelope ? envelope.code : 'API_ERROR',
        status: envelope ? envelope.httpStatus : 0,
        requestId: envelope && envelope.requestId,
        correlationId: envelope && envelope.correlationId,
        upstreamRequestId: envelope && envelope.upstreamRequestId,
        category: envelope ? envelope.category : 'unknown',
        family: envelope ? envelope.family : 'internal',
        retryable: envelope ? envelope.retryable : false,
        action: envelope && envelope.action,
        envelope,
        diagnostics: envelope ? errorModel.diagnosticText(envelope) : '错误: Request failed',
      };
    }
    const envelope = error.envelope || (errorModel && errorModel.normalize(error, {
      status: error.status,
      code: error.code,
      requestId: error.requestId,
      correlationId: error.correlationId,
      upstreamRequestId: error.upstreamRequestId,
      source: 'http',
    }));
    return {
      message: truncate(error.message) || 'Request failed',
      displayMessage: envelope ? errorModel.visibleMessage(envelope) : truncate(error.message) || 'Request failed',
      code: envelope ? envelope.code : error.code,
      status: error.status,
      requestId: error.requestId,
      correlationId: error.correlationId,
      upstreamRequestId: envelope ? envelope.upstreamRequestId : error.upstreamRequestId,
      category: envelope ? envelope.category : error.category,
      family: envelope ? envelope.family : error.family,
      retryable: envelope ? envelope.retryable : error.retryable,
      action: envelope ? envelope.action : error.action,
      envelope,
      diagnostics: envelope ? errorModel.diagnosticText(envelope) : truncate(error.message) || 'Request failed',
    };
  }

  function errorText(error) {
    const detail = errorDisplay(error);
    const status = detail.status ? ` · HTTP ${detail.status}` : '';
    const request = detail.requestId ? ` · request ${detail.requestId}` : '';
    const correlation = detail.correlationId && detail.correlationId !== detail.requestId
      ? ` · correlation ${detail.correlationId}` : '';
    const upstream = detail.upstreamRequestId ? ` · upstream ${detail.upstreamRequestId}` : '';
    return `${detail.displayMessage || detail.message}${status}${request}${correlation}${upstream}`;
  }

  return {
    ApiError,
    DEFAULT_TIMEOUT_MS,
    request,
    json,
    errorDisplay,
    errorFromPayload,
    errorFromResponse,
    errorText,
  };
});
