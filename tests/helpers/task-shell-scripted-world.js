'use strict';

// Scripted Node-side facts for the task-shell migration differential.
// `buildDeps(scenario)` returns the exact dependency bag the retired
// `mountTaskShellRoutes` received — getRuntime plus the taskEntry/taskIndex/
// artifact/history/operations/attribution/relations/independent ports — and a
// scripted runtime object behind getRuntime. Every semantic call is recorded in
// `effects.calls` so the differential can prove the frozen Node handlers and
// the Rust front door (through the real host port) ask Node for the same things
// in the same order.
//
// `scenario.answers` maps a call key (`method` or `method:firstArg`) to the
// canned result, or to `{ throw: { code, message, status, conflicts, detail,
// receiptId, taskId, notDelivered } }` for a structured refusal. Anything the
// scenario does not override falls back to the default below. Values are plain
// JSON so a body round-trips byte for byte through the host port.

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function makeError(spec) {
  const error = Object.assign(new Error(spec.message || spec.code || 'scripted'), {
    code: spec.code, status: spec.status,
  });
  if (spec.conflicts !== undefined) error.conflicts = spec.conflicts;
  if (spec.detail !== undefined) error.detail = spec.detail;
  if (spec.receiptId !== undefined) error.receiptId = spec.receiptId;
  if (spec.taskId !== undefined) error.taskId = spec.taskId;
  if (spec.notDelivered !== undefined) error.notDelivered = spec.notDelivered;
  return error;
}

function defaultEntry(id) {
  return {
    ok: true,
    task: { id, title: `Task ${id}` },
    messages: [
      { id: `session:${id}:m0`, sourceMessageId: 'm0', role: 'assistant', content: '0' },
      { id: `session:${id}:m1`, sourceMessageId: 'm1', role: 'assistant', content: '1' },
      { id: `session:${id}:m2`, sourceMessageId: 'm2', role: 'assistant', content: '2' },
    ],
    execution: { busy: false, status: 'idle' },
    readOnly: false,
    sessionId: `task-${id}`,
    url: `/air?task=${encodeURIComponent(id)}`,
    returnUrl: null,
  };
}

function buildDeps(scenario = {}) {
  const answers = scenario.answers || {};
  const effects = { calls: [] };
  const record = (call, args) => { effects.calls.push({ call, args: clone(args) }); };
  const lookup = keys => {
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(answers, key)) return { found: true, spec: answers[key] };
    }
    return { found: false, spec: undefined };
  };
  const resolve = spec => {
    if (spec === undefined) return undefined;
    if (spec && typeof spec === 'object' && Object.prototype.hasOwnProperty.call(spec, 'throw')) {
      throw makeError(spec.throw || {});
    }
    return clone(spec);
  };
  const answer = (keys, fallback) => {
    const hit = lookup(keys);
    return resolve(hit.found ? hit.spec : fallback);
  };

  const runtime = {
    bindPlannedTask(id, options) {
      record('bindPlannedTask', { id, options });
      return answer([`bindPlannedTask:${id}`, 'bindPlannedTask'], defaultEntry(id));
    },
    taskEntry(id) {
      record('taskEntry', { id });
      return answer([`taskEntry:${id}`, 'taskEntry'], defaultEntry(id));
    },
    assertBoardWritable(id) {
      record('assertBoardWritable', { id });
      return answer(['assertBoardWritable'], undefined);
    },
    sendExplicit(shellId, body, options) {
      record('sendExplicit', { shellId, body, taskId: options && options.taskId, taskStart: options && options.taskStart });
      return answer([`sendExplicit:${shellId}`, 'sendExplicit'],
        { ok: true, receiptId: `rc_send_${shellId}`, taskId: options && options.taskId });
    },
    forkTask(id, body) {
      record('forkTask', { id, body });
      return answer([`forkTask:${id}`, 'forkTask'], { ok: true, taskId: `tsk_fork_${id}` });
    },
    contextTrace(sessionId, traceId, options) {
      record('contextTrace', { sessionId, traceId, includeMessages: options && options.includeMessages });
      return answer([`contextTrace:${sessionId}`, 'contextTrace'],
        { traceId: traceId === undefined ? null : traceId, currentTask: { taskId: 'tsk_ctx' } });
    },
    view(id) {
      record('view', { id });
      return answer([`view:${id}`, 'view'], { id, currentTaskId: 'tsk_view', cursorVersion: 1 });
    },
    chatScope(id) {
      record('chatScope', { id });
      return answer([`chatScope:${id}`, 'chatScope'], { shellId: id, taskId: 'tsk_scope', sessionIds: [id] });
    },
    remove(id) {
      record('remove', { id });
      return answer([`remove:${id}`, 'remove'], { ok: true, removed: true });
    },
    link(id, taskId) {
      record('link', { id, taskId });
      return answer([`link:${id}`, 'link'], { ok: true, taskId });
    },
    selectTarget(id, options = {}) {
      record('selectTarget', { id, taskId: options.taskId, expectedCursorVersion: options.expectedCursorVersion });
      return answer([`selectTarget:${id}`, 'selectTarget'], { ok: true, changed: true, cursorVersion: 2 });
    },
    resolveTask(id, options = {}) {
      record('resolveTask', { id, taskId: options.taskId, taskText: options.taskText, title: options.title });
      return answer([`resolveTask:${id}`, 'resolveTask'], { ok: true, taskId: options.taskId || 'tsk_resolved' });
    },
    detail(shellId, taskId) {
      record('detail', { shellId, taskId });
      return answer([`detail:${taskId}`, 'detail'], { taskId, execution: { busy: true } });
    },
    send(id, body) {
      record('send', { id, body });
      return answer([`send:${id}`, 'send'], { ok: true, receiptId: `rc_message_${id}`, taskId: 'tsk_send' });
    },
    retry(shellId, receiptId) {
      record('retry', { shellId, receiptId });
      return answer([`retry:${shellId}`, 'retry'], { ok: true, receiptId });
    },
    separation: {
      latest(id) {
        record('separation.latest', { id });
        return answer([`separation.latest:${id}`, 'separation.latest'], { state: 'pending', taskId: 'tsk_sep' });
      },
      decide(id, suggestionId, decision) {
        record('separation.decide', { id, suggestionId, decision });
        return answer([`separation.decide:${id}`, 'separation.decide'], { ok: true, state: 'accepted' });
      },
    },
  };

  const operations = {
    list(shellId) {
      record('operations.list', { shellId });
      return answer([`operations.list:${shellId}`, 'operations.list'], []);
    },
    preview(options = {}) {
      record('operations.preview', { scope: options.scope, turns: options.turns, range: options.range, target: options.target });
      return answer(['operations.preview'], { previewToken: 'pv_1', moves: [] });
    },
    apply(options = {}) {
      record('operations.apply', {
        scope: options.scope, clientMsgId: options.clientMsgId, previewToken: options.previewToken,
        expectedRevision: options.expectedRevision, turns: options.turns, range: options.range,
        target: options.target, queue: options.queue,
      });
      return answer(['operations.apply'], { ok: true, id: 'op_1', status: 'applied' });
    },
    get(operationId) {
      record('operations.get', { operationId });
      return answer([`operations.get:${operationId}`, 'operations.get'], { id: operationId, status: 'applied' });
    },
    cancel(options = {}) {
      record('operations.cancel', { operationId: options.operationId, clientMsgId: options.clientMsgId });
      return answer(['operations.cancel'], { id: options.operationId, status: 'cancelled' });
    },
    undo(options = {}) {
      record('operations.undo', { operationId: options.operationId, clientMsgId: options.clientMsgId });
      return answer(['operations.undo'], { id: options.operationId, status: 'undone' });
    },
  };

  const attribution = {
    list(shellId, options = {}) {
      record('attribution.list', { shellId, includeHidden: options.includeHidden });
      return answer([`attribution.list:${shellId}`, 'attribution.list'], []);
    },
    accept(shellId, decisionId, options = {}) {
      record('attribution.accept', { shellId, decisionId, clientMsgId: options.clientMsgId });
      return answer(['attribution.accept'], { ok: true, id: decisionId, action: 'apply' });
    },
    dismiss(shellId, decisionId) {
      record('attribution.dismiss', { shellId, decisionId });
      return answer(['attribution.dismiss'], { ok: true, id: decisionId, action: 'dismiss' });
    },
    defer(shellId, decisionId) {
      record('attribution.defer', { shellId, decisionId });
      return answer(['attribution.defer'], { ok: true, id: decisionId, action: 'defer' });
    },
    undo(shellId, decisionId) {
      record('attribution.undo', { shellId, decisionId });
      return answer(['attribution.undo'], { ok: true, id: decisionId, action: 'undo' });
    },
  };

  const independentApi = {
    request(shellId, taskId, options = {}) {
      record('independent.request', { shellId, taskId, clientMsgId: options.clientMsgId });
      return answer(['independent.request'], { ok: true, id: 'c_1', state: 'waiting' });
    },
    list(options = {}) {
      record('independent.list', { shellId: options.shellId });
      return answer([`independent.list:${options.shellId}`, 'independent.list'], []);
    },
    get(continuationId) {
      record('independent.get', { continuationId });
      return answer([`independent.get:${continuationId}`, 'independent.get'], { id: continuationId, state: 'waiting' });
    },
    publicOp(item) {
      record('independent.publicOp', { id: item && item.id, state: item && item.state });
      return answer(['independent.publicOp'], item);
    },
    apply(continuationId) {
      record('independent.apply', { continuationId });
      return answer(['independent.apply'], { ok: true, id: continuationId, state: 'applied' });
    },
    cancel(continuationId) {
      record('independent.cancel', { continuationId });
      return answer(['independent.cancel'], { ok: true, id: continuationId, state: 'cancelled' });
    },
    retry(continuationId) {
      record('independent.retry', { continuationId });
      return answer(['independent.retry'], { ok: true, id: continuationId, state: 'waiting' });
    },
  };

  const relationsApi = {
    list(shellId) {
      record('relations.list', { shellId });
      return answer([`relations.list:${shellId}`, 'relations.list'], []);
    },
    create(shellId, options = {}) {
      record('relations.create', { shellId, kind: options.kind, fromTaskId: options.fromTaskId, toTaskId: options.toTaskId, clientMsgId: options.clientMsgId });
      return answer(['relations.create'], { ok: true, id: 'r_1' });
    },
    remove(shellId, options = {}) {
      record('relations.remove', { shellId, relationId: options.relationId, clientMsgId: options.clientMsgId });
      return answer(['relations.remove'], { ok: true, id: options.relationId });
    },
  };

  const deps = {
    getRuntime: () => runtime,
    open(sessionId) {
      record('open', { sessionId });
      return answer([`open:${sessionId}`, 'open'], { id: 'sh_open', currentTaskId: null });
    },
    taskEntry: (id, options) => runtime.bindPlannedTask(id, options),
    taskIndex(id, options = {}) {
      record('taskIndex', { id, includeEmpty: options.includeEmpty });
      return answer([`taskIndex:${id}`, 'taskIndex'], { shellId: id, tasks: [] });
    },
    taskOperations: () => operations,
    attributionDecisions: () => attribution,
    independent: () => independentApi,
    relations: () => relationsApi,
    artifacts(id) {
      record('artifacts', { id });
      return answer([`artifacts:${id}`, 'artifacts'], { taskId: id, title: '', items: [] });
    },
    history(id, options = {}) {
      record('history', { id, before: options.before, around: options.around, limit: options.limit, includeHidden: options.includeHidden });
      return answer([`history:${id}`, 'history'], { messages: [], hasMore: false });
    },
  };

  return { scenario, deps, runtime, effects };
}

module.exports = { buildDeps, defaultEntry };

// Stable dependency bag for a mount that outlives the per-request world: each
// function looks the current `buildDeps()` result up when it is called, so a
// pre-request hook can swap the world and the already-mounted handlers (and the
// artifact memo wrapped around `artifacts`) follow it.
function bindDeps(getBag) {
  const call = name => (...args) => getBag().deps[name](...args);
  return {
    getRuntime: () => getBag().deps.getRuntime(),
    open: call('open'),
    history: call('history'),
    artifacts: call('artifacts'),
    taskEntry: call('taskEntry'),
    taskIndex: call('taskIndex'),
    taskOperations: call('taskOperations'),
    attributionDecisions: call('attributionDecisions'),
    independent: call('independent'),
    relations: call('relations'),
  };
}

module.exports.bindDeps = bindDeps;
