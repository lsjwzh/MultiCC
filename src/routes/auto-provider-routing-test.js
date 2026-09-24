'use strict';

// ── Auto Provider · 难度路由「测试一下」 ─────────────────────────────────────
// One real Jev call on a two-tier ladder, so the editor can prove a key works
// right after it is pasted. The key is read from the vault in-process and never
// leaves it: the response carries the verdict or an error code, nothing else.

const { createJevClient } = require('../providers/jev-client');
const { safeCode, sanitizePublicText } = require('../http/public-safety');

const DEFAULT_API_KEY_NAME = 'vercel-api-key';
const MAX_TEXT_LENGTH = 2000;
const TEST_TIMEOUT_MS = 8000;
const SAMPLE_TEXT = '把 README 里的一个错别字改掉';

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
    const apiKeyName = body.apiKeyName == null || body.apiKeyName === ''
      ? DEFAULT_API_KEY_NAME : String(body.apiKeyName);
    if (!vaultOf().NAME_RE.test(apiKeyName)) {
      return { status: 400, body: { ok: false, code: 'invalid_api_key_name' } };
    }
    const text = String(body.text || '').trim().slice(0, MAX_TEXT_LENGTH) || SAMPLE_TEXT;
    const verdict = await jev.classify({ text, tiers: ['t1', 't2'], apiKeyName, timeoutMs: TEST_TIMEOUT_MS });
    const latencyMs = Math.round(Number(verdict && verdict.latencyMs) || 0);
    // Vercel's own error text is safe to show once scrubbed; '-' marks "nothing left".
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
  DEFAULT_API_KEY_NAME,
  MAX_TEXT_LENGTH,
  SAMPLE_TEXT,
  createRoutingTest,
};
