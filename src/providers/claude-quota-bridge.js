'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const { claudeQuota } = require('../quota/claude-header-quota');

// The pinned Node CPR only exposes its 5h DTO. Observe forwarded response headers
// at the host boundary, so both transports use the same Rust parser without
// modifying the dependency or moving routing/credential policy into this bridge.
// Remove this Express/SDK adapter once CPR exposes response-header callbacks.
function createClaudeQuotaBridge(app, options) {
  if (typeof options.onRateLimit !== 'function' || claudeQuota('extract', { headers: {} }) === undefined) return { app, options };
  const contexts = new AsyncLocalStorage();
  return {
    app: {
      use(path, handler) {
        return app.use(path, (req, res, next) => {
          const state = { context: null, fallback: null };
          const writeHead = res.writeHead;
          res.writeHead = function (status, ...args) {
            res.writeHead = writeHead;
            try {
              if ((status >= 200 && status < 300 || status === 429) && state.context) {
                const headers = { ...res.getHeaders?.(), ...(typeof args[0] === 'string' ? args[1] : args[0]) };
                const rateLimitInfo = claudeQuota('extract', { headers });
                if (rateLimitInfo) options.onRateLimit({ ...state.context, rateLimitInfo });
                else if (rateLimitInfo === undefined && state.fallback) options.onRateLimit(state.fallback);
              }
            } catch (_) { /* Host observers cannot disturb header forwarding. */ }
            return writeHead.call(this, status, ...args);
          };
          return contexts.run(state, () => handler(req, res, next));
        });
      },
    },
    options: {
      ...options,
      onActivity(event) {
        const state = contexts.getStore();
        if (state && event.phase === 'request') {
          const { sessionId, role, providerId, providerName } = event;
          state.context = { sessionId, role, providerId, providerName };
        }
        return options.onActivity?.(event);
      },
      onRateLimit(event) {
        const state = contexts.getStore();
        if (!state) return options.onRateLimit(event);
        const { rateLimitInfo, ...context } = event;
        state.context = context;
        state.fallback = event;
      },
    },
  };
}

module.exports = { createClaudeQuotaBridge };
