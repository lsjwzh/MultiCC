'use strict';

// ── Auto Provider · 难度路由「测试一下」 ─────────────────────────────────────
// One real Jev call on a two-tier ladder, so the editor can prove a key works
// right after it is pasted. The key is read from the vault in-process and never
// leaves it: the response carries the verdict or an error code, nothing else.
//
// The body names the same target a pool would persist — { gateway, endpoint,
// model, apiKeyName } — and is validated by the very reader that validates the
// config, so a target this route accepts is one the pool can save.

const { createJevClient } = require('../providers/jev-client');
const { jevTarget, validateRoutingTarget } = require('../providers/auto-provider-config');
const { safeCode, sanitizePublicText } = require('../http/public-safety');

const MAX_TEXT_LENGTH = 2000;
const TEST_TIMEOUT_MS = 8000;
const SAMPLE_TEXT = '把 README 里的一个错别字改掉';
// Bad input is reported under this one code: the editor only needs to know that
// what it sent cannot be used, and `detail` says which field was wrong.
const INVALID_TARGET_CODE = 'invalid_routing_target';

function vaultKeyResolver(vaultOf) {
  return name => {
    const result = vaultOf().reveal(name);
    return result && result.entry ? result.entry.value : null;
  };
}

function createRoutingTest(options = {}) {
  // Loaded on first use: mounting the route must not read the vault file.
  const vaultOf = () => options.vault || require('../secrets-vault');
  const jev = options.jev || createJevClient({
    fetchImpl: options.fetchImpl,
    resolveApiKey: vaultKeyResolver(vaultOf),
    logger: options.logger,
  });

  async function run(body = {}) {
    const target = validateRoutingTarget(body);
    if (target.ok === false) {
      // The address and the entry name come from the page, so the reason is
      // scrubbed like any other public text before it is echoed back.
      return {
        status: 400,
        body: {
          ok: false,
          code: INVALID_TARGET_CODE,
          detail: sanitizePublicText(String(target.error || ''), '-'),
        },
      };
    }
    const text = String(body.text || '').trim().slice(0, MAX_TEXT_LENGTH) || SAMPLE_TEXT;
    // Resolved through the same reader the runtime uses, so a preset's host and
    // model come from the table here exactly as they do for a prepared turn.
    const call = jevTarget(target.value);
    const verdict = await jev.classify({
      text,
      tiers: ['t1', 't2'],
      apiKeyName: call.apiKeyName,
      endpoint: call.endpoint,
      model: call.model,
      timeoutMs: TEST_TIMEOUT_MS,
    });
    const latencyMs = Math.round(Number(verdict && verdict.latencyMs) || 0);
    // A gateway's own error text is safe to show once scrubbed; '-' marks "nothing left".
    const detail = verdict && verdict.detail ? sanitizePublicText(String(verdict.detail), '-') : '-';
    if (verdict && verdict.ok) {
      return { status: 200, body: { ok: true, tier: verdict.tier === 't1' ? 't1' : 't2', latencyMs } };
    }
    return {
      status: 200,
      body: {
        ok: false,
        code: safeCode(String((verdict && verdict.code) || ''), 'jev_failed'),
        ...(verdict && verdict.status ? { status: Number(verdict.status) || 0 } : {}),
        ...(detail !== '-' ? { detail: detail.slice(0, 240) } : {}),
        latencyMs,
      },
    };
  }

  function mount(app) {
    app.post('/api/auto-provider/routing/test', async (req, res) => {
      try {
        const result = await run(req.body || {});
        res.status(result.status).json(result.body);
      } catch (_) {
        res.status(500).json({ ok: false, code: 'routing_test_failed' });
      }
    });
  }

  return Object.freeze({ run, mount });
}

module.exports = {
  INVALID_TARGET_CODE,
  MAX_TEXT_LENGTH,
  SAMPLE_TEXT,
  createRoutingTest,
};
