'use strict';

const { sanitizePublicText } = require('../http/public-safety');
const SPEEDTEST_DEADLINE_MS = 15000;
const SPEEDTEST_MAX_RESPONSE_BYTES = 64 * 1024;
const publicText = (value, fallback) => sanitizePublicText(typeof value === 'string' ? value : '', fallback);
const publicError = (error, fallback) => publicText(error && error.message, fallback);

function runSpeedtestRequest(options) {
  const {
    client,
    requestOptions,
    body,
    model,
    res,
    elapsed,
    setTimeoutFn,
    clearTimeoutFn,
  } = options;
  return new Promise((resolve) => {
    let settled = false;
    let request = null;
    let deadlineTimer = null;
    let responseBytes = 0;

    const finish = (payload) => {
      if (settled) return false;
      settled = true;
      if (deadlineTimer) clearTimeoutFn(deadlineTimer);
      res.json(payload);
      resolve();
      return true;
    };
    const destroyAfter = (payload) => {
      if (!finish(payload)) return;
      if (request && typeof request.destroy === 'function') request.destroy();
    };
    const timeout = () => destroyAfter({ ok: false, ms: elapsed(), error: 'timeout' });

    try {
      request = client.request(requestOptions, (response) => {
        let data = '';
        response.on('data', (chunk) => {
          if (settled) return;
          responseBytes += Buffer.byteLength(chunk);
          if (responseBytes > SPEEDTEST_MAX_RESPONSE_BYTES) {
            destroyAfter({
              ok: false,
              ms: elapsed(),
              status: response.statusCode,
              model,
              error: 'response too large',
            });
            return;
          }
          data += chunk.toString();
        });
        response.on('error', (error) => {
          destroyAfter({
            ok: false,
            ms: elapsed(),
            error: publicError(error, 'provider speedtest failed'),
          });
        });
        response.on('end', () => {
          if (settled) return;
          const ms = elapsed();
          // CPR's proxy can return HTTP 200 and report an upstream failure in
          // its SSE envelope. Treat that as a failed probe; status-only checks
          // would paint an OAuth/account failure as a healthy provider.
          const failedEnvelope = /response\.failed|"error"\s*:\s*\{|"status"\s*:\s*"failed"/.test(data);
          if (failedEnvelope) {
            let message = 'provider speedtest failed';
            try {
              const parsed = JSON.parse(data);
              message = parsed.error?.message || parsed.response?.error?.message || message;
            } catch (_) {
              const match = /message["']?\s*:\s*["']([^"']+)/i.exec(data);
              if (match) message = match[1];
            }
            finish({ ok: false, ms, model, error: publicText(message, 'provider speedtest failed') });
            return;
          }
          if (response.statusCode >= 200 && response.statusCode < 300) {
            finish({ ok: true, ms, status: response.statusCode, model });
            return;
          }
          let message = `HTTP ${response.statusCode}`;
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) message = parsed.error.message || JSON.stringify(parsed.error);
          } catch (_) {}
          finish({
            ok: false,
            ms,
            status: response.statusCode,
            model,
            error: publicText(message, `HTTP ${response.statusCode}`),
          });
        });
      });
      request.on('error', (error) => {
        finish({ ok: false, ms: elapsed(), error: publicError(error, 'provider speedtest failed') });
      });
      request.setTimeout(SPEEDTEST_DEADLINE_MS, timeout);
      deadlineTimer = setTimeoutFn(timeout, SPEEDTEST_DEADLINE_MS);
      if (deadlineTimer && typeof deadlineTimer.unref === 'function') deadlineTimer.unref();
      request.write(body);
      request.end();
    } catch (error) {
      finish({ ok: false, ms: elapsed(), error: publicError(error, 'provider speedtest failed') });
    }
  });
}

module.exports = { runSpeedtestRequest };
