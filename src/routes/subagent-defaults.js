'use strict';

// 迁移桥接：子任务默认线路（每个 CLI 家族一条 `{providerId, model}`）与「一键同步到
// 同家族全部会话」。Rust（native/core/src/subagent_defaults.rs）负责归一化存储值、
// 校验目标线路并生成整批计划；Node 只提供宿主事实（会话表、provider 是否可用/可代理/
// 是否官方）并通过现有端口执行：默认值走 providers.js 的原子配置文件写入，会话逐个走
// session-profile.js 的 applySessionPatch / previewSessionPatch（与单会话 AI 配置同一个
// 校验、暂存与广播路径）。Rust 接管会话存储与 provider 默认值后本模块即可删除。
const { sanitizePublicText } = require('../http/public-safety');
const { desiredSession } = require('../session/pending-configuration');

// 响应是 UI 负载，不是导出：400 个会话的机队不能把一个弹窗变成多兆的帧。
const MAX_RESULTS = 200;
const FAMILY_BY_CLI = Object.freeze({
  claude: 'claude', 'claude-exp': 'claude',
  codex: 'codex', 'codex-exp': 'codex',
});

function familyForCli(cli) {
  return typeof cli === 'string' ? FAMILY_BY_CLI[cli] || null : null;
}

function listSessions(sessions) {
  if (sessions instanceof Map) return [...sessions.values()];
  return Array.isArray(sessions) ? sessions : [];
}

// The desired state (pending configuration applied) is what the sync will
// actually produce, so eligibility, "unchanged" and the Codex main-provider
// check all read the same draft a busy session will apply on its next turn.
function planSessions(sessions) {
  const list = [];
  for (const session of listSessions(sessions)) {
    if (!session || typeof session !== 'object') continue;
    let desired = session;
    try { desired = desiredSession(session); } catch (_) { desired = session; }
    list.push({
      id: String(session.id || ''),
      name: String(session.label || session.name || session.id || ''),
      cli: desired.cli || '',
      kind: desired.kind || '',
      type: desired.type == null ? null : desired.type,
      ephemeral: desired.ephemeral === true,
      loginFlow: desired.loginFlow == null ? null : desired.loginFlow,
      provider: desired.provider == null ? null : desired.provider,
      subagent: desired.subagent == null ? null : desired.subagent,
      pending: !!session.pendingConfiguration,
    });
  }
  return list;
}

function routeOrNull(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function mountSubagentDefaultsRoutes(app, options = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
    throw new TypeError('[subagent-defaults] Express-compatible app is required');
  }
  const providerDefaults = options.providerDefaults;
  if (!providerDefaults || typeof providerDefaults !== 'object') {
    throw new TypeError('[subagent-defaults] providerDefaults object is required');
  }
  const sessions = options.sessions;
  const validProviderId = options.validProviderId;
  const providers = options.providers || {};
  const persistDefaults = options.persistDefaults;
  if (typeof validProviderId !== 'function' || typeof persistDefaults !== 'function') {
    throw new TypeError('[subagent-defaults] validProviderId and persistDefaults are required');
  }
  const applySessionPatch = options.applySessionPatch;
  const previewSessionPatch = options.previewSessionPatch;
  // Tests inject a stub; production resolves the same addon every other Rust
  // bridge uses, once per request so a rebuilt addon needs no restart.
  const getNative = options.getNative || (() => require('../native/runtime').getNative('subagent_defaults'));

  function nativeModule() {
    try {
      const native = getNative();
      if (native && typeof native.normalizeSubagentDefaults === 'function'
        && typeof native.planSubagentSync === 'function') return native;
    } catch (_) { /* 原生模块缺失或加载失败 → 503，由调用方提示更新 */ }
    return null;
  }

  function unavailable(res) {
    return res.status(503).json({
      error: '子任务默认线路接口尚未就绪，请更新原生模块',
      code: 'rust_backend_unavailable',
    });
  }

  function isOfficialCodexProvider(providerId) {
    let provider = null;
    try { provider = typeof providers.getProvider === 'function' ? providers.getProvider('codex', providerId) : null; } catch (_) { provider = null; }
    if (!provider) return false;
    if (typeof providers.isOfficialCodexOAuthProvider === 'function') {
      try { return !!providers.isOfficialCodexOAuthProvider(provider); } catch (_) { return false; }
    }
    return provider.isOfficial === true;
  }

  app.get('/api/subagent-defaults', (req, res) => {
    const native = nativeModule();
    if (!native) return unavailable(res);
    try {
      const stored = Object.prototype.hasOwnProperty.call(providerDefaults, 'subagent')
        ? providerDefaults.subagent : null;
      const defaults = JSON.parse(native.normalizeSubagentDefaults(JSON.stringify({ stored })));
      return res.json({
        ok: true,
        defaults: { claude: defaults?.claude ?? null, codex: defaults?.codex ?? null },
      });
    } catch (_) {
      return unavailable(res);
    }
  });

  app.post('/api/subagent-defaults/sync', (req, res) => {
    const native = nativeModule();
    if (!native) return unavailable(res);
    const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
    const cli = typeof body.cli === 'string' ? body.cli.trim() : '';
    const dryRun = body.dryRun === true || body.dryRun === '1' || body.dryRun === 'true';
    const family = familyForCli(cli);
    const rawTarget = body.subagent;
    const rawProviderId = routeOrNull(rawTarget) ? String(rawTarget.providerId ?? '').trim() : '';
    // Host facts only: Rust owns the rules, Node answers the two questions it
    // alone can (provider store lookup, Codex HTTP-proxy capability).
    let providerValid = false;
    let providerProxyable = false;
    let providerOfficial = false;
    if (family && rawProviderId) {
      try { providerValid = validProviderId(family, rawProviderId)?.ok === true; } catch (_) { providerValid = false; }
      if (family === 'codex') {
        try { providerProxyable = !!providers.codexProviderProxyable?.(rawProviderId); } catch (_) { providerProxyable = false; }
        providerOfficial = isOfficialCodexProvider(rawProviderId);
      }
    }

    let plan;
    try {
      plan = JSON.parse(native.planSubagentSync(JSON.stringify({
        cli,
        subagent: rawTarget === undefined ? null : rawTarget,
        providerValid, providerProxyable, providerOfficial,
        defaults: providerDefaults.subagent ?? null,
        sessions: planSessions(sessions),
      })));
    } catch (_) {
      return unavailable(res);
    }
    if (!plan || typeof plan !== 'object') return unavailable(res);
    if (plan.status !== 200) {
      return res.status(plan.status || 400).json({
        error: plan.error || 'invalid subagent sync request',
        code: plan.code || 'invalid_subagent',
      });
    }

    const targetRoute = routeOrNull(plan.subagent);
    const plannedDefaults = {
      claude: plan.defaults?.claude ?? null,
      codex: plan.defaults?.codex ?? null,
    };
    const groups = { applied: [], deferred: [], skipped: [] };
    const unchanged = [];

    // Persist first: a failed write must leave the file and every session
    // exactly as they were, so the defaults land before the first PATCH.
    if (!dryRun) {
      const next = { ...providerDefaults, subagent: plannedDefaults };
      try {
        persistDefaults(next);
      } catch (_) {
        return res.status(500).json({ error: '无法保存子任务默认线路', code: 'save_failed' });
      }
      Object.assign(providerDefaults, next);
    }

    // One session failing (rejected, or its patch throwing) must not hide what
    // already happened to the others: by now the defaults are saved and earlier
    // sessions are patched, so every failure is reported per session instead.
    function runPatch(sessionId, patch) {
      try {
        const run = dryRun ? previewSessionPatch : applySessionPatch;
        return run(sessionId, patch);
      } catch (error) {
        return { status: 500, body: { error: error && error.message } };
      }
    }

    for (const entry of Array.isArray(plan.targets) ? plan.targets : []) {
      const sessionId = String(entry?.sessionId || '');
      if (!sessionId) continue;
      const base = { sessionId, sessionName: entry.sessionName, cli: entry.cli };
      const patch = { subagent: targetRoute };
      let outcome = 'applied';
      let reason = null;
      let detail = null;
      if (dryRun && typeof previewSessionPatch !== 'function') {
        // Compatibility-only prediction: an already staged configuration is
        // the one deferral a dry run can know without the runtime.
        if (entry.pending === true) outcome = 'deferred';
      } else {
        // Dry runs never write; the preview runs the same validation on a
        // detached desired-state draft.
        const result = runPatch(sessionId, patch);
        if (!result || result.status !== 200) {
          outcome = 'skipped'; reason = 'patch_rejected';
          detail = sanitizePublicText(result && result.body && result.body.error, 'session patch rejected');
        } else if (dryRun ? entry.pending === true : (result.body && result.body.deferred === true)) {
          outcome = 'deferred';
        }
      }
      groups[outcome].push({
        ...base, outcome,
        ...(reason ? { reason } : {}),
        ...(detail ? { detail } : {}),
      });
    }
    for (const entry of Array.isArray(plan.skipped) ? plan.skipped : []) {
      groups.skipped.push({
        sessionId: String(entry?.sessionId || ''),
        sessionName: entry?.sessionName,
        cli: entry?.cli,
        outcome: 'skipped',
        reason: entry?.reason || 'patch_rejected',
      });
    }
    for (const entry of Array.isArray(plan.unchanged) ? plan.unchanged : []) {
      unchanged.push({
        sessionId: String(entry?.sessionId || ''),
        sessionName: entry?.sessionName,
        cli: entry?.cli,
        outcome: 'unchanged',
      });
    }

    const counts = {
      applied: groups.applied.length,
      deferred: groups.deferred.length,
      unchanged: unchanged.length,
      skipped: groups.skipped.length,
    };
    const listed = [...groups.applied, ...groups.deferred, ...groups.skipped, ...unchanged];
    return res.json({
      ok: true,
      dryRun,
      family: plan.family,
      subagent: targetRoute,
      defaults: plannedDefaults,
      counts,
      sessions: listed.slice(0, MAX_RESULTS),
      truncated: listed.length > MAX_RESULTS,
    });
  });
}

module.exports = { mountSubagentDefaultsRoutes, MAX_RESULTS };
