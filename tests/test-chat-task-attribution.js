'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createController } = require('../public/chat-task-attribution');

class FakeNode {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.dataset = {}; this.hidden = false;
    this.className = ''; this.textContent = ''; this.title = ''; this.value = ''; this.disabled = false;
    this.classList = { values: new Set(),
      add: (...v) => v.forEach(x => this.classList.values.add(x)),
      remove: (...v) => v.forEach(x => this.classList.values.delete(x)),
      toggle: (v, on) => { if (on) this.classList.values.add(v); else this.classList.values.delete(v); },
      contains: v => this.classList.values.has(v) };
    this.attributes = {}; this.listeners = {}; this.parentNode = null;
  }
  append(...nodes) { for (const node of nodes) { node.parentNode = this; this.children.push(node); } }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  insertBefore(node, before) {
    node.parentNode = this;
    const index = before ? this.children.indexOf(before) : -1;
    if (index < 0) this.children.unshift(node); else this.children.splice(index, 0, node);
  }
  remove() { const parent = this.parentNode; this.removed = true; if (parent) parent.children = parent.children.filter(c => c !== this); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  querySelectorAll(selector) {
    if (selector === '.msg[data-msg-id][data-turn-id]') {
      return this.children.filter(node => node.className === 'msg' && node.dataset.msgId && node.dataset.turnId);
    }
    return [];
  }
}

function fixture() {
  const messages = new FakeNode('section'), body = new FakeNode('body');
  const doc = { body, createElement: tag => new FakeNode(tag), addEventListener() {} };
  return { messages, doc, body };
}

function turn(owner, turnId, taskId, code) {
  const node = new FakeNode('article');
  node.className = 'msg';
  node.dataset = { msgId: `${owner}:${turnId}:u`, sourceSessionId: owner, turnId, taskId, taskShortCode: code, taskName: `${code} task` };
  return node;
}

function controllerFor(extra = {}) {
  const f = fixture();
  const calls = [];
  const controller = createController({
    document: f.doc, messagesEl: f.messages, translate: key => key,
    scope: async () => ({ shellId: 'sh_1' }),
    request: async (method, path, body) => {
      calls.push({ method, path, body });
      if (path.endsWith('/preview')) return { previewToken: 'tok', scopeRevision: 'rev', changed: (body.turns || []).length, blocked: [] };
      if (path.includes('/task-operations') && method === 'POST') return { id: 'op_1', status: 'applied', effects: body.turns };
      if (path.includes('/undo')) return { id: 'op_1', status: 'reverted' };
      throw new Error(`unexpected ${method} ${path}`);
    },
    loadIndex: async () => ({ tasks: [
      { taskId: 'tsk_a', shortCode: 'A001', title: 'Alpha' },
      { taskId: 'tsk_b', shortCode: 'B002', title: 'Beta' },
    ] }),
    makeId: () => 'attr-1',
    ...extra,
  });
  return { f, calls, controller };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test('recorded automatic suggestions are counted on the toggle and can be accepted', async () => {
  // The fake server keeps its own state, so the refresh after a decision has to
  // see the same resolved queue a real host would return.
  const state = [
    { id: 'dec_1', fromTaskId: 'tsk_a', toTaskId: 'tsk_b', state: 'pending', taskName: 'Beta' },
    { id: 'dec_2', fromTaskId: 'tsk_a', toTaskId: 'tsk_c', state: 'dismissed' },
  ];
  const decide = [];
  const { f, controller } = controllerFor({
    loadSuggestions: async () => ({ decisions: state.map(item => ({ ...item })) }),
    request: async (method, path, body) => {
      if (path.endsWith('/preview')) return { previewToken: 'tok', scopeRevision: 'rev', changed: 0, blocked: [] };
      if (path.includes('/attribution-decisions/')) {
        decide.push({ path, body });
        state[0] = { ...state[0], state: 'applied' };
        return { id: 'dec_1', state: 'applied', toTaskId: 'tsk_b', apply: { kind: 'overlay' } };
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
  });
  await settle();
  const toggle = f.doc.body.children[0];
  assert.equal(toggle.dataset.suggestions, '1', 'only pending suggestions are counted');
  const bar = f.doc.body.children[1];
  const proposals = bar.children[0];
  assert.equal(proposals.hidden, false);
  assert.equal(proposals.children.length, 1, 'a dismissed suggestion is not offered again');
  assert.equal(proposals.children[0].children[0].textContent, 'taskAttributionSuggestion');
  proposals.children[0].children[1].onclick();
  await settle();
  assert.equal(decide.length, 1);
  assert.equal(decide[0].path, '/api/task-shells/sh_1/attribution-decisions/dec_1/accept');
  assert.match(decide[0].body.clientMsgId, /^attr-/);
  assert.equal(toggle.dataset.suggestions, '0', 'an accepted suggestion leaves the queue');
  assert.equal(proposals.hidden, true);
  assert.deepEqual(proposals.children, []);
  controller.dispose();
});

test('dismissing a suggestion never previews or applies anything', async () => {
  let pending = [{ id: 'dec_9', fromTaskId: 'tsk_a', toTaskId: 'tsk_b', state: 'pending' }];
  const calls = [];
  const { f, controller } = controllerFor({
    loadSuggestions: async () => ({ decisions: pending.map(item => ({ ...item })) }),
    request: async (method, path) => {
      calls.push(path);
      pending = [{ id: 'dec_9', fromTaskId: 'tsk_a', toTaskId: 'tsk_b', state: 'dismissed' }];
      return { id: 'dec_9', state: 'dismissed' };
    },
  });
  await settle();
  const proposals = f.doc.body.children[1].children[0];
  proposals.children[0].children[2].onclick();
  await settle();
  assert.deepEqual(calls, ['/api/task-shells/sh_1/attribution-decisions/dec_9/dismiss']);
  assert.equal(f.doc.body.children[0].dataset.suggestions, '0');
  assert.equal(proposals.hidden, true);
  controller.dispose();
});

test('postponing a suggestion keeps it pending, folds it away, and still allows a later accept', async () => {
  let state = [{ id: 'dec_7', fromTaskId: 'tsk_a', toTaskId: 'tsk_b', state: 'pending' }];
  const calls = [];
  const { f, controller } = controllerFor({
    loadSuggestions: async () => ({ decisions: state.map(item => ({ ...item })) }),
    request: async (method, path) => {
      calls.push(path);
      if (path.endsWith('/preview')) return { previewToken: 'tok', scopeRevision: 'rev', changed: 0, blocked: [] };
      if (path.endsWith('/defer')) { state = [{ ...state[0], state: 'deferred' }]; return { id: 'dec_7', state: 'deferred' }; }
      state = [{ ...state[0], state: 'applied' }];
      return { id: 'dec_7', state: 'applied', toTaskId: 'tsk_b' };
    },
  });
  await settle();
  const toggle = f.doc.body.children[0];
  const proposals = f.doc.body.children[1].children[0];
  assert.equal(proposals.children[0].children.length, 4, 'accept, dismiss and later are offered');
  proposals.children[0].children[3].onclick();
  await settle();
  assert.deepEqual(calls.filter(path => path.includes('attribution-decisions')),
    ['/api/task-shells/sh_1/attribution-decisions/dec_7/defer']);
  assert.equal(toggle.dataset.suggestions, '1', 'a postponed suggestion is still open work');
  assert.equal(proposals.hidden, true, 'the closed bar does not keep the postponed card on screen');
  // The bar is the durable pending entry the card collapses into: opening it is
  // the way back to a postponed suggestion.
  controller.setEnabled(true);
  await settle();
  assert.equal(proposals.hidden, false);
  assert.equal(proposals.children[0].children.length, 3, 'a postponed card no longer offers "later" again');
  proposals.children[0].children[1].onclick();
  await settle();
  assert.equal(calls.filter(path => path.endsWith('/accept')).length, 1);
  assert.equal(toggle.dataset.suggestions, '0', 'accepting clears the postponed row');
  controller.dispose();
});

test('the toggle stays hidden until a movable turn exists', () => {
  const { f, controller } = controllerFor();
  const toggle = f.doc.body.children[0];
  assert.equal(toggle.hidden, true);
  f.messages.children.push(turn('s1', 't1', 'tsk_a', 'A001'));
  controller.refresh();
  assert.equal(toggle.hidden, false);
  // A message without a turn id is not a movable unit and gets no control.
  const legacy = new FakeNode('article'); legacy.className = 'msg'; legacy.dataset = { msgId: 's1:x' };
  f.messages.children.push(legacy);
  controller.refresh();
  assert.equal(legacy.children.length, 0);
  controller.dispose();
});

test('picking a turn previews, applies with the preview token, and offers undo', async () => {
  const applied = [];
  const { f, calls, controller } = controllerFor({ onApplied: (result, meta) => applied.push({ result, meta }) });
  f.messages.children.push(turn('s1', 't1', 'tsk_a', 'A001'), turn('s1', 't2', 'tsk_b', 'B002'));
  controller.setEnabled(true);
  await settle();
  const first = f.messages.children[0].children[0];
  assert.equal(first.className, 'task-attribution-pick');
  first.onclick({ stopPropagation() {} });
  await settle();
  const preview = calls.find(call => call.path.endsWith('/preview'));
  assert.deepEqual(preview.body.turns, [{ sessionId: 's1', turnId: 't1' }]);
  assert.equal(preview.body.target.taskId, 'tsk_a');
  assert.equal(first.textContent, '●');
  await controller.applyNow();
  const apply = calls.find(call => call.path.endsWith('/task-operations'));
  assert.equal(apply.body.previewToken, 'tok');
  assert.equal(apply.body.expectedRevision, 'rev');
  assert.equal(apply.body.clientMsgId, 'attr-1');
  assert.equal(applied.length, 1);
  assert.equal(applied[0].meta.undone, false);
  const toast = f.doc.body.children.find(node => node.className === 'task-attribution-toast');
  assert.ok(toast, 'a result toast is shown');
  const undo = toast.children.find(node => node.className === 'task-attribution-undo');
  assert.ok(undo, 'the toast offers an undo');
  undo.onclick();
  await settle();
  const undoCall = calls.find(call => call.path.includes('/undo'));
  assert.equal(undoCall.path, '/api/task-operations/op_1/undo');
  assert.equal(applied[1].meta.undone, true);
  controller.dispose();
});

test('the target picker offers every task in the shell and re-previews on switch', async () => {
  const { f, calls, controller } = controllerFor();
  f.messages.children.push(turn('s1', 't1', 'tsk_a', 'A001'));
  controller.setEnabled(true);
  await settle();
  const select = f.doc.body.children[1].children.find(node => node.className === 'task-attribution-target');
  assert.deepEqual(select.children.map(option => option.value), ['tsk_a', 'tsk_b']);
  assert.deepEqual(select.children.map(option => option.textContent), ['A001 · Alpha', 'B002 · Beta']);
  f.messages.children[0].children[0].onclick({ stopPropagation() {} });
  await settle();
  select.value = 'tsk_b';
  select.onchange();
  await settle();
  const previews = calls.filter(call => call.path.endsWith('/preview'));
  assert.equal(previews.at(-1).body.target.taskId, 'tsk_b');
  const summary = f.doc.body.children[1].children.find(node => node.className === 'task-attribution-summary');
  assert.equal(summary.textContent, 'taskAttributionPreview');
  assert.equal(summary.dataset.tone, 'ok');
  controller.dispose();
});

test('independent continue asks once, applies a ready request, and reuses one operation id', async () => {
  const seen = [];
  const { f, controller } = controllerFor({
    confirmContinue: async () => true,
    request: async (method, path, body) => {
      seen.push({ method, path, body });
      if (path.endsWith('/preview')) return { previewToken: 'tok', scopeRevision: 'rev', changed: 0, blocked: [] };
      if (path.endsWith('/independent-continue')) return { id: 'ind_1', taskId: 'tsk_a', state: 'ready' };
      if (path.endsWith('/apply')) return { id: 'ind_1', taskId: 'tsk_a', state: 'applied' };
      throw new Error(`unexpected ${method} ${path}`);
    },
  });
  f.messages.children.push(turn('s1', 't1', 'tsk_a', 'A001'));
  controller.setEnabled(true);
  await settle();
  const bar = f.doc.body.children[1];
  const resume = bar.children.find(node => node.className === 'task-attribution-continue');
  assert.equal(resume.disabled, false, 'the selected target is enough to ask for an independent environment');
  await controller.continueTask();
  assert.deepEqual(seen.map(call => call.path), ['/api/task-shells/sh_1/tasks/tsk_a/independent-continue',
    '/api/task-continuations/ind_1/apply']);
  assert.match(seen[0].body.clientMsgId, /^attr-/);
  // The link is rendered into the toast: this code runs after an await, so a
  // window.open here would be an unsolicited popup the browser blocks.
  const toast = f.doc.body.children.find(node => node.className === 'task-attribution-toast');
  assert.ok(toast, 'the applied continuation reports its result');
  const link = toast.children.find(node => node.className === 'task-attribution-link');
  assert.equal(link?.href, '/air?task=tsk_a');
  assert.equal(link?.target, '_blank');
  assert.equal(link?.rel, 'noopener');
  controller.dispose();
});

test('a waiting independent-continue answer is reported as a state, not a failure', async () => {
  const { f, controller } = controllerFor({
    confirmContinue: async () => true,
    request: async (method, path) => {
      if (path.endsWith('/preview')) return { previewToken: 'tok', scopeRevision: 'rev', changed: 0, blocked: [] };
      if (path.endsWith('/independent-continue')) return { id: 'ind_1', taskId: 'tsk_a', state: 'waiting', reason: 'turn_busy' };
      throw new Error(`unexpected ${method} ${path}`);
    },
  });
  f.messages.children.push(turn('s1', 't1', 'tsk_a', 'A001'));
  controller.setEnabled(true);
  await settle();
  const bar = f.doc.body.children[1];
  const summary = bar.children.find(node => node.className === 'task-attribution-summary');
  await controller.continueTask();
  assert.equal(summary.textContent, 'taskAttributionContinueWaiting');
  assert.equal(summary.dataset.tone, 'warn');
  assert.equal(bar.children.find(node => node.className === 'task-attribution-continue').disabled, false,
    'a suspended request can be asked about again');
  controller.dispose();
});

test('a blocked preview disables apply and explains why', async () => {
  const { f, controller } = controllerFor({
    request: async (method, path, body) => (path.endsWith('/preview')
      ? { previewToken: 'tok', scopeRevision: 'rev', changed: 1, blocked: [{ reason: 'turn_busy' }] }
      : { id: 'op_1', status: 'applied', effects: body.turns }),
  });
  f.messages.children.push(turn('s1', 't1', 'tsk_a', 'A001'));
  controller.setEnabled(true);
  await settle();
  f.messages.children[0].children[0].onclick({ stopPropagation() {} });
  await settle();
  const bar = f.doc.body.children[1];
  const apply = bar.children.find(node => node.className === 'task-attribution-apply');
  const summary = bar.children.find(node => node.className === 'task-attribution-summary');
  assert.equal(apply.disabled, true);
  assert.equal(summary.textContent, 'taskAttributionBlocked');
  assert.equal(summary.dataset.tone, 'warn');
  controller.dispose();
});

test('a needs-attention continuation is reported as a condition, not a failure', async () => {
  const { f, controller } = controllerFor({
    confirmContinue: async () => true,
    request: async (method, path) => {
      if (path.endsWith('/preview')) return { previewToken: 'tok', scopeRevision: 'rev', changed: 0, blocked: [] };
      if (path.endsWith('/independent-continue')) {
        return { id: 'ind_1', taskId: 'tsk_a', state: 'needs_attention', reason: 'execution_shared',
          detail: { tasks: ['tsk_b'] } };
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
  });
  f.messages.children.push(turn('s1', 't1', 'tsk_a', 'A001'));
  controller.setEnabled(true);
  await settle();
  const bar = f.doc.body.children[1];
  const summary = bar.children.find(node => node.className === 'task-attribution-summary');
  await controller.continueTask();
  assert.equal(summary.textContent, 'taskAttributionContinueAttention');
  assert.equal(summary.dataset.tone, 'warn', 'attention is a state to clear, not an error to report');
  assert.equal(bar.children.find(node => node.className === 'task-attribution-continue').disabled, false,
    'the same request can be re-asked once the condition clears');
  controller.dispose();
});

test('a broadcast from another page clears the card and only an applied change reloads history', async () => {
  let pending = [{ id: 'dec_5', fromTaskId: 'tsk_a', toTaskId: 'tsk_b', state: 'pending' }];
  const calls = [];
  const { f, controller } = controllerFor({
    loadSuggestions: async () => ({ decisions: pending.map(item => ({ ...item })) }),
    onExternalApply: () => calls.push('history'),
    request: async (method, path) => { calls.push(path); return {}; },
  });
  await settle();
  const proposals = f.doc.body.children[1].children[0];
  assert.equal(proposals.children.length, 1, 'the card is on screen before the other page decides');
  pending = [];
  controller.onBroadcast({ decisionId: 'dec_5', kind: 'dismissed', state: 'dismissed' });
  await settle();
  assert.equal(proposals.hidden, true, 'another page dismissing it removes the card here too');
  assert.deepEqual(calls, [], 'a dismissal moved nothing, so history is not re-read');
  controller.onBroadcast({ decisionId: 'dec_6', kind: 'applied', state: 'applied' });
  await settle();
  assert.deepEqual(calls, ['history'], 'an applied change does re-read the projection');
  controller.dispose();
});

test('a broadcast about a decision this page just made is not replayed at itself', async () => {
  let pending = [{ id: 'dec_8', fromTaskId: 'tsk_a', toTaskId: 'tsk_b', state: 'pending' }];
  const calls = [];
  const { f, controller } = controllerFor({
    loadSuggestions: async () => ({ decisions: pending.map(item => ({ ...item })) }),
    onExternalApply: () => calls.push('history'),
    request: async (method, path) => {
      calls.push(path);
      if (path.endsWith('/preview')) return { previewToken: 'tok', scopeRevision: 'rev', changed: 0, blocked: [] };
      pending = [];
      return { id: 'dec_8', state: 'applied', toTaskId: 'tsk_b' };
    },
  });
  await settle();
  f.doc.body.children[1].children[0].children[0].children[1].onclick();
  await settle();
  const before = calls.length;
  controller.onBroadcast({ decisionId: 'dec_8', kind: 'applied' });
  await settle();
  assert.equal(calls.length, before, 'the deciding page does not re-fetch on its own broadcast');
  assert.deepEqual(calls.filter(path => path === 'history'), [], 'and does not reload history twice');
  controller.dispose();
});

test('an accepted change that is still waiting for the turn stays visible and can be withdrawn', async () => {
  let state = [{ id: 'dec_5', fromTaskId: 'tsk_a', toTaskId: 'tsk_b', state: 'pending' }];
  const calls = [];
  const { f, controller } = controllerFor({
    loadSuggestions: async () => ({ decisions: state.map(item => ({ ...item })) }),
    request: async (method, path) => {
      calls.push(path);
      if (path.endsWith('/accept')) {
        state = [{ ...state[0], state: 'queued', queuedAt: Date.now() }];
        return { id: 'dec_5', state: 'queued', toTaskId: 'tsk_b' };
      }
      state = [{ ...state[0], state: 'dismissed' }];
      return { id: 'dec_5', state: 'dismissed' };
    },
  });
  await settle();
  const toggle = f.doc.body.children[0];
  const proposals = f.doc.body.children[1].children[0];
  proposals.children[0].children[1].onclick();
  await settle();
  assert.deepEqual(calls, ['/api/task-shells/sh_1/attribution-decisions/dec_5/accept']);
  assert.equal(toggle.dataset.suggestions, '1', 'a queued change is still waiting work, not done');
  assert.equal(proposals.hidden, false);
  assert.equal(proposals.children[0].children[0].textContent, 'taskAttributionQueued');
  assert.equal(proposals.children[0].children[1].textContent, 'taskAttributionQueueCancel');
  proposals.children[0].children[1].onclick();
  await settle();
  assert.deepEqual(calls[1], '/api/task-shells/sh_1/attribution-decisions/dec_5/dismiss',
    'withdrawing a queued change uses the durable dismiss, not a second accept');
  assert.equal(toggle.dataset.suggestions, '0');
  controller.dispose();
});
