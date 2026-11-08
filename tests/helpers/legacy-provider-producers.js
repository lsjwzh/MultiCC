'use strict';
// Frozen pre-migration behavior. Test-only differential oracle; never imported by product code.
function legacyProducerOperations(port) {
  const { runtimeEpoch, proxyProducers, nonMainProxyProducers, resolveProviderRevision,
    snapshot, poisonProxyAttempt, auditOnly, now, producerStaleGraceMs, ProviderAttemptError, proxyContext } = port;
  const clean = value => value == null ? '' : String(value).trim();
  const backgroundLingers = record => !!(record && record.lifecycle.succeeded() && record.spawnKey
    && require('../../src/cli/cli-capability').isResident(record.cli));
  const sameAttempt = (record, reference) => !!(record && reference && record.lifecycle.matches(reference));
  function markAmbiguousProducer(sessionId) {
    const producer = proxyProducers.getActive(sessionId);
    if (producer && producer.count > 0) {
      producer.count += 1;
      producer.ambiguous = true;
      producer.lastRequestAt = Number(now());
    } else {
      proxyProducers.setActive(sessionId, null, null, 1, true, Number(now()));
    }
  }

  // Cancel/kill hook: the stopped CLI process was the proxy request's only
  // downstream consumer, so its in-flight upstream can no longer produce a
  // meaningful 'end'. Release the session's MAIN producer accounting
  // immediately (non-main/background producers are untouched: background work
  // legitimately outlives the cancelled turn). Attributability stays safe
  // because proxyRouteToken rotates on every physical attempt.
  function forceReleaseProducers(sessionId, reason = 'force_release') {
    const id = clean(sessionId);
    if (!id) return Object.freeze({ ok: false, code: 'invalid_session' });
    const producer = proxyProducers.getActive(id);
    if (!producer || producer.count <= 0) {
      return Object.freeze({ ok: true, code: 'no_producers', released: 0 });
    }
    const released = producer.count;
    auditOnly(id, {
      type: 'provider_producer_force_drained',
      runtimeEpoch,
      turnId: producer.attempt ? producer.attempt.turnId : null,
      count: released,
      ageMs: Number(now()) - (Number(producer.lastRequestAt) || 0),
      reason: clean(reason) || 'force_release',
    });
    proxyProducers.deleteActive(id);
    proxyProducers.deleteEnded(id);
    return Object.freeze({ ok: true, code: 'released', released });
  }

  function nonMainProducerKey(context, event, role) {
    return [context.sessionId, context.token || (role === 'aux' ? 'aux' : ''),
      role, clean(event.providerId)].join('\u0000');
  }

  function onNonMainProxyActivity(context, event, role, phase) {
    const { sessionId, record } = context;
    const key = nonMainProducerKey(context, event, role);
    if (phase === 'request') {
      if (role !== 'aux' && (!context.exact || !record
          || (!record.lifecycle.running() && !backgroundLingers(record)))) return null;
      nonMainProxyProducers.start(key);
      return Object.freeze({ sessionId });
    }
    if (!nonMainProxyProducers.hasActive(key)) return null;
    if (phase === 'end') nonMainProxyProducers.end(key);
    return Object.freeze({ sessionId });
  }

  function onProxyActivity(event = {}) {
    const context = proxyContext(event);
    const { sessionId, record } = context;
    if (!sessionId) return null;
    const role = clean(event.role || event.roleKind).toLowerCase();
    const phase = clean(event.phase).toLowerCase();
    if (role && role !== 'main') {
      return onNonMainProxyActivity(context, event, role, phase);
    }
    if (!context.exact) {
      if (phase === 'request') {
        markAmbiguousProducer(sessionId);
        poisonProxyAttempt(record, 'proxy_route_token_mismatch');
      } else if (phase === 'end') {
        const producer = proxyProducers.getActive(sessionId);
        if (producer) {
          producer.count = Math.max(0, producer.count - 1);
          if (producer.count === 0) proxyProducers.deleteActive(sessionId);
        }
      }
      return null;
    }
    if (role !== 'main') return record && record.lifecycle.running() ? snapshot(record) : null;
    // A background request may end after the next turn started; its end still
    // belongs to the background ledger unless a main request is in flight.
    const backgroundOpen = nonMainProxyProducers.hasActive(nonMainProducerKey(context, event, 'background'));
    if (phase === 'request' ? backgroundLingers(record)
      : backgroundOpen && !(proxyProducers.getActive(sessionId)?.count > 0)) {
      return onNonMainProxyActivity(context, event, 'background', phase);
    }
    if (phase === 'request') {
      proxyProducers.deleteEnded(sessionId);
      const producer = proxyProducers.getActive(sessionId);
      let revisionMatches = true;
      if (record && resolveProviderRevision) {
        try { revisionMatches = clean(resolveProviderRevision(record, event)) === record.providerRevision; }
        catch (_) { revisionMatches = false; }
      }
      if (!record || !record.lifecycle.running()
          || !revisionMatches
          || (clean(event.providerId) && clean(event.providerId) !== record.providerId)) {
        markAmbiguousProducer(sessionId);
        poisonProxyAttempt(record, !revisionMatches
          ? 'provider_revision_mismatch' : 'provider_route_mismatch');
        return null;
      }
      if (producer && producer.count > 0) {
        producer.count += 1;
        producer.ambiguous = true;
        producer.lastRequestAt = Number(now());
      } else {
        proxyProducers.setActive(sessionId, snapshot(record), record.proxyRouteToken,
          1, false, Number(now()));
      }
      return snapshot(record);
    }
    if (phase === 'end') {
      const producer = proxyProducers.getActive(sessionId);
      if (!producer) return null;
      producer.count = Math.max(0, producer.count - 1);
      if (producer.count === 0) {
        proxyProducers.deleteActive(sessionId);
        if (!producer.ambiguous && producer.attempt) {
          proxyProducers.setEnded(sessionId, producer.attempt, producer.proxyRouteToken);
        } else {
          proxyProducers.deleteEnded(sessionId);
        }
      }
      return producer.attempt || null;
    }
    return record && record.lifecycle.running() ? snapshot(record) : null;
  }

  function boundProxyAttempt(input = {}) {
    const context = proxyContext(input);
    if (!context.exact) return null;
    const producer = proxyProducers.getActive(context.sessionId);
    if (!producer || producer.count !== 1 || producer.ambiguous || !producer.attempt
        || producer.proxyRouteToken !== context.token) return null;
    const record = context.record;
    if (!sameAttempt(record, producer.attempt) || !record.lifecycle.running()) return null;
    if (clean(input.providerId) && clean(input.providerId) !== record.providerId) return null;
    if (clean(input.role || input.roleKind).toLowerCase() !== 'main') return null;
    return snapshot(record);
  }

  function drainStaleProducers(sessionId, turnId, producer) {
    if (producer && producer.count > 0) {
      const ageMs = Number(now()) - (Number(producer.lastRequestAt) || 0);
      // Draining normally requires the proxy 'end'. A request whose CLI
      // consumer was killed or crashed mid-stream never gets one, so waiting
      // forever would wedge every later attempt of this session (the in-memory
      // counter previously only cleared on server restart). Past the grace the
      // entry is orphaned: proxyRouteToken rotation already makes any late
      // traffic from it unattributable to the new attempt.
      if (Number.isFinite(ageMs) && producer.lastRequestAt
          && ageMs >= producerStaleGraceMs) {
        auditOnly(sessionId, {
          type: 'provider_producer_force_drained',
          runtimeEpoch,
          turnId,
          count: producer.count,
          ageMs,
          graceMs: producerStaleGraceMs,
          reason: 'stale_producer_grace',
        });
        proxyProducers.deleteActive(sessionId);
        proxyProducers.deleteEnded(sessionId);
      } else {
        throw new ProviderAttemptError(
          'previous provider request has not drained',
          'PROVIDER_PRODUCER_NOT_DRAINED',
        );
      }
    }

  }
  return { onProxyActivity, boundProxyAttempt, forceReleaseProducers, drainStaleProducers, nonMainProducerKey };
}
module.exports = { legacyProducerOperations };
