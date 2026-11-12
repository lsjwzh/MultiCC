'use strict';

// Live model catalogs for cross-device Provider relays.
//
// A share code still carries a bootstrap snapshot so an import works against an
// older/offline lender.  New lenders additionally expose an authenticated
// `/models` endpoint under the already provider-scoped relay path.  Borrowers
// pull that endpoint periodically and persist the last successful catalog;
// failures never erase the bootstrap/last-known-good list.

const crypto = require('node:crypto');
const { outboundFetch } = require('../network/outbound');

const MAX_MODELS = 100;
const MAX_MODEL_LENGTH = 160;
const MAX_RESPONSE_BYTES = 128 * 1024;
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/\-\[\]]*$/;
const DEFAULT_SYNC_INTERVAL_MS = 15 * 60 * 1000;
const DEFAULT_RETRY_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 5000;

const RELAY_MODEL_ROUTES = Object.freeze([
  { appType: 'claude', path: '/claude-proxy/:id/remote/models' },
  { appType: 'codex', path: '/codex-proxy/:id/models' },
]);

function normalizeModels(values) {
  const result = [];
  const seen = new Set();
  for (const raw of Array.isArray(values) ? values : []) {
    const model = String(raw || '').trim();
    if (model.length > MAX_MODEL_LENGTH || !MODEL_ID_RE.test(model) || seen.has(model)) continue;
    seen.add(model);
    result.push(model);
    if (result.length >= MAX_MODELS) break;
  }
  return result;
}

function catalogRevision(preferredModel, models) {
  return crypto.createHash('sha256')
    .update(JSON.stringify({ preferredModel: String(preferredModel || ''), models }))
    .digest('hex').slice(0, 24);
}

function safeReason(error) {
  const code = String(error && error.code || '');
  if (code === 'relay_models_timeout') return code;
  if (/^remote_http_\d{3}$/.test(code)) return code;
  if (code === 'remote_response_too_large' || code === 'invalid_remote_catalog') return code;
  return 'relay_models_unavailable';
}

function failure(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

async function readBoundedJson(response) {
  const declared = Number(response && response.headers && response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw failure('remote_response_too_large');
  }
  let text = '';
  const reader = response && response.body && typeof response.body.getReader === 'function'
    ? response.body.getReader() : null;
  if (reader) {
    const chunks = [];
    let bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const value = Buffer.from(chunk.value || []);
        bytes += value.length;
        if (bytes > MAX_RESPONSE_BYTES) {
          try { await reader.cancel(); } catch (_) {}
          throw failure('remote_response_too_large');
        }
        chunks.push(value);
      }
    } finally {
      try { reader.releaseLock(); } catch (_) {}
    }
    text = Buffer.concat(chunks, bytes).toString('utf8');
  } else {
    // Lightweight test doubles and older fetch implementations may not expose
    // a Web ReadableStream. Production undici responses take the bounded path
    // above; this fallback still validates the final byte size.
    text = String(await response.text());
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
      throw failure('remote_response_too_large');
    }
  }
  try { return JSON.parse(text); }
  catch (_) { throw failure('invalid_remote_catalog'); }
}

function relayTargetIdentity(target) {
  return crypto.createHash('sha256')
    .update(String(target && target.relayUrl || ''))
    .update('\0')
    .update(String(target && target.apiKey || ''))
    .digest('hex');
}

function createProviderRelayModelCatalogRuntime(options = {}) {
  const providers = options.providers;
  if (!providers
      || typeof providers.getProviderSummary !== 'function'
      || typeof providers.getProviderLimitTarget !== 'function'
      || typeof providers.listProviders !== 'function'
      || typeof providers.updateProviderRelayModelCatalog !== 'function') {
    throw new TypeError('relay model catalog runtime requires provider catalog operations');
  }
  const fetchImpl = options.fetch || outboundFetch;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const codexModelsRuntime = options.codexModelsRuntime || null;
  const syncIntervalMs = Number(options.syncIntervalMs) || DEFAULT_SYNC_INTERVAL_MS;
  const retryIntervalMs = Number(options.retryIntervalMs) || DEFAULT_RETRY_INTERVAL_MS;
  const timeoutMs = Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS;
  const logger = options.logger || console;
  const attempts = new Map();
  const inflight = new Map();

  // The gateway owns the public catalog DTO. This bridge exposes only the
  // live provider projection and the account runtime's last-known snapshot.
  async function sourceCatalogFacts(appType, id) {
    const summary = providers.getProviderSummary(appType, id);
    if (!summary) return { summary: null, catalog: null };
    let catalog = null;
    if (appType === 'codex' && summary.isOfficial === true && codexModelsRuntime) {
      try {
        const record = typeof providers.getProvider === 'function'
          ? providers.getProvider(appType, id) : summary;
        const managed = !!(record && (record.activeAccountId && record.activeAccountId !== 'global'
          || require('../official-accounts').officialAccountIdFromProvider(record)));
        catalog = typeof codexModelsRuntime.peekProvider === 'function'
          ? codexModelsRuntime.peekProvider(record)
          : !managed && typeof codexModelsRuntime.peek === 'function' ? codexModelsRuntime.peek() : null;
      } catch (_) { /* Preserve the account's own last-known model metadata. */ }
    }
    return { summary, catalog };
  }

  function isDue(key, force, targetIdentity) {
    if (force) return true;
    const last = attempts.get(key);
    if (!last) return true;
    // Editing/re-importing a relay must invalidate the old lender's TTL
    // immediately. Store only a one-way identity, never the relay credential.
    if (last.targetIdentity !== targetIdentity) return true;
    const wait = last.ok ? syncIntervalMs : retryIntervalMs;
    return now() - last.at >= wait;
  }

  async function pullRemoteCatalog(target, appType) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(failure('relay_models_timeout')), timeoutMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    try {
      const response = await fetchImpl(`${String(target.relayUrl).replace(/\/+$/, '')}/models`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${target.apiKey}`, Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response || !response.ok) {
        throw failure(`remote_http_${response && Number(response.status) || 0}`);
      }
      const body = await readBoundedJson(response);
      const models = normalizeModels(body && body.models);
      const remoteType = String(body && body.appType || '');
      const preferred = String(body && body.preferredModel || '').trim();
      if (!body || body.ok !== true || remoteType !== appType || !models.length
          || (preferred && !models.includes(preferred))) {
        throw failure('invalid_remote_catalog');
      }
      return {
        models,
        preferredModel: preferred || models[0],
        revision: String(body.revision || catalogRevision(preferred || models[0], models)).slice(0, 128),
        sourceGeneratedAt: Number(body.generatedAt) || null,
        sourceCatalogFetchedAt: Number(body.catalogFetchedAt) || null,
      };
    } catch (error) {
      if (controller.signal.aborted) throw failure('relay_models_timeout');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function syncProvider(appType, id, optionsForSync = {}) {
    const key = `${appType}:${id}`;
    const target = providers.getProviderLimitTarget(appType, id);
    if (!target || target.strategy !== 'relay-quota') {
      return { ok: false, skipped: true, reason: 'not_relay', appType, providerId: id };
    }
    const targetIdentity = relayTargetIdentity(target);
    if (!isDue(key, optionsForSync.force === true, targetIdentity)) {
      return { ok: true, skipped: true, reason: 'fresh', appType, providerId: id };
    }
    const active = inflight.get(key);
    if (active) {
      if (active.targetIdentity === targetIdentity) return active.promise;
      // A provider was edited while its previous lender was in flight. Let the
      // old request settle, then immediately sync the new identity.
      return active.promise.then(() => syncProvider(appType, id, optionsForSync));
    }

    const promise = (async () => {
      try {
        const catalog = await pullRemoteCatalog(target, appType);
        const currentTarget = providers.getProviderLimitTarget(appType, id);
        if (!currentTarget || currentTarget.strategy !== 'relay-quota'
            || relayTargetIdentity(currentTarget) !== targetIdentity) {
          return {
            ok: true, skipped: true, reason: 'relay_changed', appType, providerId: id,
          };
        }
        const updated = providers.updateProviderRelayModelCatalog(appType, id, catalog);
        attempts.set(key, { at: now(), ok: true, targetIdentity });
        return {
          ok: true,
          skipped: false,
          appType,
          providerId: id,
          changed: updated.changed === true,
          model: updated.model || catalog.preferredModel,
          models: catalog.models,
          revision: catalog.revision,
          syncedAt: updated.syncedAt || now(),
        };
      } catch (error) {
        attempts.set(key, { at: now(), ok: false, targetIdentity });
        const reason = safeReason(error);
        if (logger && typeof logger.warn === 'function') {
          logger.warn('[multicc] relay model catalog sync failed', { appType, providerId: id, reason });
        }
        return { ok: false, skipped: false, reason, appType, providerId: id };
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, { targetIdentity, promise });
    return promise;
  }

  async function refreshDue(filter = {}) {
    const appType = filter.appType === 'claude' || filter.appType === 'codex'
      ? filter.appType : undefined;
    const cli = String(filter.cli || '').trim();
    const catalog = providers.listProviders(appType)
      .filter(provider => !cli || typeof providers.providerSupportsCli !== 'function'
        || providers.providerSupportsCli(provider, cli));
    const candidates = catalog.filter(provider => {
      const target = providers.getProviderLimitTarget(provider.appType, provider.id);
      return target && target.strategy === 'relay-quota';
    });
    const results = await Promise.all(candidates.map(provider => syncProvider(
      provider.appType,
      provider.id,
      { force: filter.force === true },
    )));
    return {
      checked: candidates.length,
      updated: results.filter(result => result.ok && result.changed).length,
      failed: results.filter(result => !result.ok && !result.skipped).length,
      results,
    };
  }

  return Object.freeze({ sourceCatalogFacts, syncProvider, refreshDue });
}


module.exports = {
  DEFAULT_RETRY_INTERVAL_MS,
  DEFAULT_SYNC_INTERVAL_MS,
  DEFAULT_TIMEOUT_MS,
  MAX_MODELS,
  RELAY_MODEL_ROUTES,
  catalogRevision,
  createProviderRelayModelCatalogRuntime,
  normalizeModels,
};
