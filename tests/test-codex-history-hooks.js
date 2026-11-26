'use strict';

// MultiCC's cross-upstream Codex history correction, as the router's local
// request hooks see it (CPR capability `requestHooks`). The hooks are pure
// functions of the request copy: they either return a repaired body or nothing
// at all, and nothing at all is what keeps an uncorrected turn byte-exact.
const test = require('node:test');
const assert = require('node:assert/strict');

const { createCodexHistoryHooks } = require('../src/providers/codex-history-hooks');

function hooks(logs) {
  return createCodexHistoryHooks({
    logger: logs ? { warn: (event, fields) => logs.push({ event, fields }) } : null,
  });
}

function requestContext(body, overrides = {}) {
  return Object.freeze({
    protocol: 'openai-responses',
    mode: 'responses-compat',
    providerId: 'provider-1',
    providerName: 'Provider One',
    sessionId: 'session-1',
    role: 'main',
    roleKind: 'main',
    agentRole: null,
    routeName: 'main',
    model: 'wire-model',
    isStream: true,
    body,
    bodyText: JSON.stringify(body),
    ...overrides,
  });
}

function rejectionContext(body, { status = 400, error = {}, ...overrides } = {}) {
  return Object.freeze({
    ...requestContext(body),
    status,
    message: JSON.stringify({ error }),
    attempt: 1,
    errorCode: 'UPSTREAM_HTTP_ERROR',
    ...overrides,
  });
}

test('an uncorrected turn is left alone so the router forwards it byte-for-byte', () => {
  const body = {
    model: 'wire-model',
    input: [
      { type: 'message', id: 'msg_keep', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      { type: 'function_call', id: 'fc_keep', call_id: 'call_1', name: 'exec', arguments: '{}' },
      { type: 'function_call_output', id: 'fco_keep', call_id: 'call_1', output: 'done' },
    ],
  };
  assert.equal(hooks().onRequest(requestContext(body)), undefined);
});

test('the pre-dial hook drops the reference shapes an upstream can never resolve', () => {
  const logs = [];
  const body = {
    model: 'wire-model',
    store: false,
    previous_response_id: 'resp_foreign',
    input: [
      { type: 'message', id: 'msg_keep', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      { type: 'reasoning', id: 'rs_foreign', summary: [{ type: 'summary_text', text: 'thought' }] },
      { type: 'reasoning', id: 'rs_hollow' },
      { type: 'item_reference', id: 'msg_foreign' },
      { type: 'function_call', id: 'tool_a', call_id: 'tool_a', name: 'exec', arguments: '{}' },
    ],
  };
  const original = structuredClone(body);
  const result = hooks(logs).onRequest(requestContext(body));
  assert.ok(result && result.body, 'a body needing correction is returned');
  assert.equal(result.body.previous_response_id, undefined);
  assert.deepEqual(result.body.input, [
    { type: 'message', id: 'msg_keep', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    { type: 'reasoning', summary: [{ type: 'summary_text', text: 'thought' }] },
    { type: 'function_call', id: result.body.input[2].id, call_id: 'tool_a', name: 'exec', arguments: '{}' },
  ]);
  // The Responses-API id prefix is normalized in the same pass, and tool pairing
  // survives it (call_id is untouched).
  assert.match(result.body.input[2].id, /^fc_/);
  assert.equal(result.body.input[2].call_id, 'tool_a');
  // Request copies only: the caller's object is never mutated.
  assert.deepEqual(body, original);
  assert.deepEqual(logs.map(item => item.event), ['model_history_preprocessed']);
  assert.equal(logs[0].fields.providerId, 'provider-1');
  assert.equal(logs[0].fields.sessionId, 'session-1');
  assert.ok(logs[0].fields.changes.length > 0);
});

test('third-party reasoning content is real context and survives; only its id goes', () => {
  const body = {
    input: [
      { type: 'reasoning', id: 'rs_third', content: [{ type: 'reasoning_text', text: 'chain of thought' }] },
      { type: 'message', id: 'msg_after', role: 'user', content: [{ type: 'input_text', text: 'go' }] },
    ],
  };
  const result = hooks().onRequest(requestContext(body));
  assert.equal(result.body.input[0].id, undefined);
  assert.deepEqual(result.body.input[0].content, [{ type: 'reasoning_text', text: 'chain of thought' }]);
  assert.equal(result.body.input[1].id, 'msg_after');
});

test('the hooks only touch Responses bodies', () => {
  const body = { input: [{ type: 'item_reference', id: 'msg_foreign' }] };
  assert.equal(hooks().onRequest(requestContext(body, { protocol: 'anthropic-messages' })), undefined);
  assert.equal(hooks().onUpstreamRejected(rejectionContext(body, {
    error: { message: 'Unknown parameter: \'input[0].status\'.', param: 'input[0].status' },
  })), undefined);
  // A non-JSON body has no structure to repair and is passed through untouched.
  assert.equal(hooks().onRequest(requestContext('not json')), undefined);
});

test('a rejected optional field is omitted and the turn is authorized to re-dial once', () => {
  const logs = [];
  const body = {
    input: [{
      type: 'function_call', id: 'tool_a', call_id: 'tool_a', name: 'exec',
      arguments: '{}', status: 'completed',
    }],
  };
  const context = rejectionContext(body, {
    error: { message: "Unknown parameter: 'input[0].status'.", param: 'input[0].status', type: 'invalid_request_error' },
  });
  const result = hooks(logs).onUpstreamRejected(context);
  assert.equal(result.retry, true);
  assert.equal(Object.hasOwn(result.body.input[0], 'status'), false);
  assert.equal(result.body.input[0].call_id, 'tool_a');
  assert.deepEqual(logs.map(item => item.event), ['model_history_repaired_after_rejection']);
  assert.equal(logs[0].fields.status, 400);
  assert.equal(logs[0].fields.error.param, 'input[0].status');
});

test('an item-not-found rejection repairs the named id once, including over 404', () => {
  const body = {
    input: [
      { type: 'message', id: 'msg_keep', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      { type: 'reasoning', id: 'rs_foreign', summary: [{ type: 'summary_text', text: 'thought' }] },
    ],
  };
  const context = rejectionContext(body, {
    status: 404,
    error: {
      message: "Item with id 'rs_foreign' not found. Items are not persisted when store is set to false.",
      type: 'invalid_request_error',
    },
  });
  const result = hooks().onUpstreamRejected(context);
  assert.equal(result.retry, true);
  assert.equal(result.body.input[1].id, undefined);
  assert.deepEqual(result.body.input[1].summary, [{ type: 'summary_text', text: 'thought' }]);
  assert.equal(result.body.input[0].id, 'msg_keep');
});

test('a rejection the converter does not recognize is never replayed', () => {
  const body = { input: [{ type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'exec', arguments: '{}' }] };
  const unrepairable = rejectionContext(body, {
    error: { message: "Unknown parameter: 'tools[0].name'.", param: 'tools[0].name', type: 'invalid_request_error' },
  });
  assert.equal(hooks().onUpstreamRejected(unrepairable), undefined);
  // A rejection that only an operator can fix stays fail-fast, and a semantic
  // tool rejection never costs a second attempt.
  for (const status of [401, 403, 429, 500, 502]) {
    assert.equal(hooks().onUpstreamRejected(rejectionContext(body, {
      status,
      error: { message: "Unknown parameter: 'input[0].status'.", param: 'input[0].status' },
    })), undefined, `status ${status} must not be replayed`);
  }
  // A non-JSON error body still matches on the text alone, but only when the
  // converter recognizes the shape.
  assert.equal(hooks().onUpstreamRejected({
    ...requestContext(body), status: 400, message: 'upstream exploded', attempt: 1,
  }), undefined);
});

test('a working hook never lets its own logging break the turn', () => {
  const body = { previous_response_id: 'resp_foreign', input: [] };
  const thrown = createCodexHistoryHooks({
    logger: { warn: () => { throw new Error('logger is broken'); } },
  });
  assert.deepEqual(thrown.onRequest(requestContext(body)), { body: { input: [] } });
});

const oldHooks = require('./helpers/legacy-codex-history-hooks').createCodexHistoryHooks;

test('both hook results, diagnostics and untouched item identities match the 1e43b66f hooks', t => {
  const keep = { type: 'message', id: 'msg_keep', content: ['keep'] };
  const bodies = [
    null, 0, 'raw', [], {}, { input: [keep] },
    { previous_response_id: 'previous', input: [keep, { type: 'item_reference', id: 'previous' }] },
    { input: [keep, { type: 'function_call', id: 'old', status: 'alien', arguments: { x: 3 } }] },
    { input: [keep, { type: 'reasoning', id: 'r', encrypted_content: 'opaque', summary: ['s'] }] },
    { input: [keep, { type: 'web_search_call', action: { type: 'search', query: 'q' } }], tools: [{ type: 'function', strict: true }] },
  ];
  const messages = [
    undefined, 'upstream failure', '{}', 'null', '["unknown"]', '{"error":[]}', '{"error":null}',
    JSON.stringify({ error: { message: 'Unsupported parameter', param: 'input[1].status', code: 'invalid_value' } }),
    JSON.stringify({ message: "Unsupported parameter 'tools[0].strict'" }),
    "Item with id 'r' not found", '{"error":{"message":"Encrypted content x could not be decrypted"}}',
  ];
  function run(create, method, context) {
    const logs = [];
    const logger = { warn(event, fields) { assert.equal(this, logger); logs.push([event, fields]); } };
    const hook = create({ logger });
    const result = hook[method](context);
    if (result && context.body.input?.[0] === keep) assert.equal(result.body.input[0], keep);
    return { result, logs };
  }
  let comparisons = 0;
  for (const body of bodies) for (const protocol of ['openai-responses', 'anthropic-messages']) {
    const base = { body, protocol, providerId: 'p', sessionId: 's', role: 'main' };
    assert.deepEqual(run(createCodexHistoryHooks, 'onRequest', base), run(oldHooks, 'onRequest', base));
    comparisons++;
    for (const status of [400, 404, ' 404 ', 400n, 401, 429, 500, NaN]) for (const message of messages) {
      const context = { ...base, status, message };
      assert.deepEqual(run(createCodexHistoryHooks, 'onUpstreamRejected', context), run(oldHooks, 'onUpstreamRejected', context));
      comparisons++;
    }
  }
  t.diagnostic(`${comparisons} request and rejection comparisons matched`);
});

test('getter and coercion failures retain identity and logger failures remain best effort', t => {
  const failure = Object.freeze({ code: 'injected' });
  function observe(create, method, failAt, loggerEnabled) {
    const trace = [];
    function seen(key) {
      trace.push(key);
      if (trace.length === failAt) throw failure;
    }
    const token = key => ({ [Symbol.toPrimitive](hint) {
      seen(key + ':' + hint);
      return key === 'status' ? '404' : '{"error":{"param":"input[0].status","message":"Unknown parameter"}}';
    } });
    const logger = { get warn() {
      seen('logger.warn');
      return function () { seen('logger.call'); assert.equal(this, logger); };
    } };
    const options = { get logger() { seen('options.logger'); return loggerEnabled ? logger : null; } };
    const context = new Proxy({
      protocol: 'openai-responses', body: { input: [{ type: 'message', id: 'old', content: [], status: 'x' }] },
      status: token('status'), message: token('message'), role: 'aux',
    }, { get(target, key) { seen('context.' + key); return target[key]; } });
    let result, error;
    try { result = create(options)[method](context); } catch (e) { error = e; }
    if (error !== undefined) assert.equal(error, failure);
    return { trace, result, threw: error === failure };
  }
  let count = 0;
  for (const method of ['onRequest', 'onUpstreamRejected']) for (const enabled of [true, false]) {
    const normal = observe(oldHooks, method, 0, enabled);
    assert.deepEqual(observe(createCodexHistoryHooks, method, 0, enabled), normal);
    for (let i = 1; i <= normal.trace.length; i++) {
      assert.deepEqual(observe(createCodexHistoryHooks, method, i, enabled), observe(oldHooks, method, i, enabled));
      count++;
    }
  }
  t.diagnostic(`${count} injected failure positions matched`);
});

test('the frozen hook facade supports detached synchronous calls and reentrant diagnostics', () => {
  for (const create of [oldHooks, createCodexHistoryHooks]) {
    let again, outer, nested;
    const logger = { warn(event, fields) {
      if (nested !== undefined) return;
      nested = false;
      nested = again({ protocol: 'openai-responses', body: { previous_response_id: 'inner' } });
      fields.changes.length = 0;
      throw new Error('log sink unavailable');
    } };
    const facade = create({ logger });
    assert.ok(Object.isFrozen(facade));
    assert.deepEqual(Object.keys(facade), ['onRequest', 'onUpstreamRejected']);
    again = facade.onRequest;
    outer = again({ protocol: 'openai-responses', body: { previous_response_id: 'outer', input: [] } });
    assert.deepEqual(outer, { body: { input: [] } });
    assert.deepEqual(nested, { body: {} });
  }
});
