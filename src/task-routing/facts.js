'use strict';

const { isDeepStrictEqual } = require('node:util');
const PREFIX = 'task-first:';
const FACT_KINDS = new Set(['run-result', 'integration']);

function failure(code) { return Object.assign(new Error(code), { code }); }
function identity(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/.test(id)) throw failure('invalid_record_id');
  return id;
}
function valueCopy(value) {
  const json = JSON.stringify(value, (_key, item) => {
    if (['undefined', 'function', 'symbol', 'bigint'].includes(typeof item)
      || typeof item === 'number' && !Number.isFinite(item)) throw failure('invalid_record_value');
    return item;
  });
  if (!json || Buffer.byteLength(json) > 1024 * 1024) throw failure('invalid_record_value');
  return JSON.parse(json);
}

// Foundation only: namespaced records in the existing transactional store.
// Does not create tasks, migrate authority, schedule runs, or apply attribution.
function createTaskFactsRepository(store) {
  for (const method of ['get', 'set', 'list', 'transaction']) {
    if (typeof store?.[method] !== 'function') throw new TypeError('transactional store required');
  }
  const get = (kind, id) => store.get(PREFIX + kind, identity(id));
  const set = (kind, id, body) => store.set(PREFIX + kind, id, body);

  function appendFact(kind, fact) {
    if (!FACT_KINDS.has(kind)) throw failure('invalid_fact_kind');
    const body = valueCopy(fact);
    identity(body?.id);
    return store.transaction(() => {
      const previous = get(kind, body.id);
      if (previous && !isDeepStrictEqual(previous, body)) throw failure('immutable_fact_conflict');
      if (!previous) set(kind, body.id, body);
      return previous || body;
    });
  }

  function createProposal(definition) {
    const body = valueCopy(definition);
    identity(body?.id);
    identity(body?.runId);
    identity(body?.attemptId);
    identity(body?.sourceTaskId);
    return store.transaction(() => {
      const previous = get('proposal', body.id);
      if (previous) {
        if (!isDeepStrictEqual(previous.definition, body)) throw failure('proposal_definition_conflict');
        return previous;
      }
      const record = { id: body.id, definition: body, state: 'pending', version: 1, evaluation: null };
      set('proposal', body.id, record);
      return record;
    });
  }

  function recordEvaluation(id, { expectedVersion, evaluation, eventId }) {
    identity(id); identity(eventId);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw failure('expected_version_required');
    const checked = valueCopy(evaluation);
    if (!['pending', 'ready', 'stale', 'rejected'].includes(checked?.state)
      || checked.eligible !== (checked.state === 'ready') || checked.requiresAtomicRecheck !== true
      || !Array.isArray(checked.blockers) || checked.blockers.some(x => typeof x !== 'string')
      || checked.state === 'ready' && checked.blockers.length) throw failure('invalid_evaluation');
    const intent = { proposalId: id, expectedVersion, evaluation: checked };
    return store.transaction(() => {
      const priorEvent = get('event', eventId);
      if (priorEvent) {
        if (!isDeepStrictEqual(priorEvent.intent, intent)) throw failure('event_id_conflict');
        return priorEvent.result;
      }
      const previous = get('proposal', id);
      if (!previous) throw failure('proposal_not_found');
      if (previous.version !== expectedVersion) throw failure('proposal_version_conflict');
      if (!['pending', 'ready'].includes(previous.state)) throw failure('proposal_terminal');
      const record = { ...previous, state: checked.state, evaluation: checked, version: previous.version + 1 };
      set('proposal', id, record);
      set('event', eventId, { id: eventId, type: 'attribution.evaluated', delivery: 'pending', intent, result: record });
      return record;
    });
  }

  function pendingEvents(limit = 100) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw failure('invalid_limit');
    return store.list(PREFIX + 'event').filter(event => event.delivery === 'pending').slice(0, limit);
  }
  function acknowledge(eventId) {
    return store.transaction(() => {
      const event = get('event', eventId);
      if (!event) throw failure('event_not_found');
      if (event.delivery !== 'acknowledged') set('event', eventId, { ...event, delivery: 'acknowledged' });
      return { id: eventId, acknowledged: true };
    });
  }
  return Object.freeze({ appendFact, createProposal, recordEvaluation, pendingEvents, acknowledge,
    getProposal: id => get('proposal', id),
    getFact: (kind, id) => {
      if (!FACT_KINDS.has(kind)) throw failure('invalid_fact_kind');
      return get(kind, id);
    },
  });
}

module.exports = { createTaskFactsRepository };
