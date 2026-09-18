'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createController, createAnchorJump, currentCodeAt } = require('../public/chat-task-index');

class FakeNode {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.dataset = {}; this.hidden = false;
    this.className = ''; this.classList = { values: new Set(), add: (...v) => v.forEach(x => this.classList.values.add(x)),
      remove: (...v) => v.forEach(x => this.classList.values.delete(x)), contains: v => this.classList.values.has(v) };
    this.attributes = {}; this.listeners = {}; this.scrolls = 0;
  }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  remove() { this.removed = true; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  scrollIntoView() { this.scrolls += 1; }
  querySelectorAll(selector) {
    if (selector === '.msg[data-task-short-code]') return this.children.filter(node => node.className === 'msg' && node.dataset.taskShortCode);
    if (selector === '.msg[data-msg-id]') return this.children.filter(node => node.dataset?.msgId);
    return [];
  }
}

function fixture() {
  const messages = new FakeNode('section'), body = new FakeNode('body');
  const doc = { body, createElement: tag => new FakeNode(tag) };
  const storage = new Map();
  return { messages, doc, storage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) } };
}

test('index is hidden without task codes, then lists unique four-character codes and jumps', () => {
  const f = fixture(), detached = [];
  const controller = createController({ document: f.doc, messagesEl: f.messages, storage: f.storage,
    onDetach: item => detached.push(item) });
  assert.equal(f.doc.body.children[0].hidden, true);
  const first = new FakeNode('article'); first.className = 'msg'; first.dataset = { taskShortCode: 'b002', taskId: 'tsk-b', taskName: 'Beta' };
  const second = new FakeNode('article'); second.className = 'msg'; second.dataset = { taskShortCode: 'A001', taskId: 'tsk-a', taskName: 'Alpha' };
  f.messages.children.push(first, second); controller.refresh();
  const toggle = f.doc.body.children[0], rail = f.doc.body.children[1];
  assert.equal(toggle.hidden, false); toggle.onclick();
  assert.equal(rail.hidden, false); assert.equal(rail.children.length, 2);
  assert.equal(rail.children[0].children[0].textContent, 'A001');
  rail.children[1].children[0].onclick();
  assert.equal(first.scrolls, 1); assert.ok(first.classList.contains('task-index-target'));
  rail.children[0].children[1].onclick({ stopPropagation() {} });
  assert.equal(detached[0].taskId, 'tsk-a');
  controller.dispose();
});

test('toggle preference is persisted and detach action is omitted when no task id exists', () => {
  const f = fixture(); f.storage.setItem('multicc:task-index-open', '1');
  const controller = createController({ document: f.doc, messagesEl: f.messages, storage: f.storage });
  const message = new FakeNode('article'); message.className = 'msg'; message.dataset.taskShortCode = 'C003';
  f.messages.children.push(message); controller.refresh();
  assert.equal(f.doc.body.children[1].hidden, false);
  assert.equal(f.doc.body.children[1].children[0].children.length, 1);
});

test('server index drives the rail in conversation order and jumps to an unloaded turn', async () => {
  const f = fixture(), navigated = [];
  const controller = createController({ document: f.doc, messagesEl: f.messages, storage: f.storage,
    navigate: ref => navigated.push(ref),
    loadIndex: async () => ({ scopeRevision: 'r1', tasks: [
      { taskId: 'tsk_b', shortCode: 'B002', title: 'Beta', segments: [{ firstMessageRef: { id: 's1:m9' } }], capabilities: {} },
      { taskId: 'tsk_a', shortCode: 'A001', title: 'Alpha', segments: [{ firstMessageRef: { id: 's1:m1' } }], capabilities: {} },
    ] }) });
  assert.equal(f.doc.body.children[0].hidden, true);
  await controller.reload();
  const toggle = f.doc.body.children[0], rail = f.doc.body.children[1];
  assert.equal(toggle.hidden, false);
  toggle.onclick();
  assert.equal(rail.hidden, false);
  // Appearance order, not alphabetical: the list must match scrolling.
  assert.deepEqual(rail.children.map(row => row.children[0].textContent), ['B002', 'A001']);
  rail.children[0].children[0].onclick();
  assert.deepEqual(navigated, [{ id: 's1:m9' }]);
  const anchor = new FakeNode('article'); anchor.className = 'msg'; anchor.dataset = { msgId: 's1:m9' };
  f.messages.children.push(anchor);
  controller.markLocated('s1:m9');
  assert.equal(anchor.scrolls, 1);
  assert.ok(anchor.classList.contains('task-index-target'));
  controller.dispose();
});

test('a multi-segment task exposes per-segment jumps and read-only entries hide detach', () => {
  const f = fixture(), navigated = [], detached = [];
  const controller = createController({ document: f.doc, messagesEl: f.messages, storage: f.storage,
    onDetach: entry => detached.push(entry), navigate: ref => navigated.push(ref),
    loadIndex: async () => ({ tasks: [
      { taskId: 'tsk_a', shortCode: 'A001', title: 'Alpha', capabilities: { canDetach: true }, segments: [
        { firstMessageRef: { id: 's1:m1' } }, { firstMessageRef: { id: 's1:m7' } }] },
      { taskId: 'tsk_c', shortCode: 'C003', title: 'Gamma', capabilities: { canDetach: false }, segments: [
        { firstMessageRef: { id: 's1:m3' } }, { firstMessageRef: { id: 's1:m5' } }] },
    ] }) });
  return controller.reload().then(() => {
    const rail = f.doc.body.children[1];
    // A multi-segment directory leads with the segment nav, then one row per task.
    assert.equal(rail.children[0].className, 'task-index-nav');
    assert.equal(rail.children[1].children.length, 3); // code + segment strip + detach
    assert.equal(rail.children[2].children.length, 2); // code + strip, no detach
    rail.children[1].children[1].children[1].onclick({ stopPropagation() {} });
    assert.deepEqual(navigated, [{ id: 's1:m7' }]);
    controller.dispose();
  });
});

test('a stale entry is dimmed, a dead anchor reports instead of failing silently', async () => {
  const f = fixture(), navigated = [], missing = [];
  const controller = createController({ document: f.doc, messagesEl: f.messages, storage: f.storage,
    onMissing: entry => missing.push(entry.code),
    navigate: ref => { navigated.push(ref.id); return ref.id === 's1:m1'; },
    loadIndex: async () => ({ tasks: [
      { taskId: 'tsk_a', shortCode: 'A001', title: 'Alpha', stale: true, capabilities: {},
        segments: [{ firstMessageRef: { id: 's1:m1' } }] },
      { taskId: 'tsk_b', shortCode: 'B002', title: 'Beta', capabilities: {},
        segments: [{ firstMessageRef: { id: 's1:m2' } }] },
    ] }) });
  await controller.reload();
  const rail = f.doc.body.children[1];
  assert.equal(rail.children[0].dataset.stale, 'true', 'a trimmed task must not look live');
  assert.equal(rail.children[1].dataset.stale, undefined);
  rail.children[0].children[0].onclick();
  assert.deepEqual(navigated, ['s1:m1']);
  assert.deepEqual(missing, [], 'a landed jump reports nothing');
  rail.children[1].children[0].onclick();
  assert.deepEqual(navigated, ['s1:m1', 's1:m2']);
  assert.deepEqual(missing, ['B002'], 'a jump that cannot land says so');
  // The row stays, but a code that cannot be located must not keep looking live.
  assert.equal(rail.children[1].dataset.stale, 'true');
  assert.equal(rail.children[0].dataset.stale, 'true', 'the server-side stale flag is preserved');
  controller.dispose();
});

test('an entry with no anchor at all reports missing without a navigation', () => {
  const f = fixture(), missing = [], navigated = [];
  const controller = createController({ document: f.doc, messagesEl: f.messages, storage: f.storage,
    onMissing: entry => missing.push(entry.code), navigate: ref => { navigated.push(ref.id); return true; },
    loadIndex: async () => ({ tasks: [
      { taskId: 'tsk_z', shortCode: 'Z009', title: 'Zeta', capabilities: {}, segments: [] },
    ] }) });
  return controller.reload().then(() => {
    f.doc.body.children[1].children[0].children[0].onclick();
    assert.deepEqual(navigated, []);
    assert.deepEqual(missing, ['Z009']);
    controller.dispose();
  });
});

test('a jump falls back from a deleted segment anchor to the task boundary', async () => {
  const loaded = [], located = [];
  const jump = createAnchorJump({
    findById: () => false,
    fetchAround: async id => (id === 's1:gone' ? { found: false } : { found: true, messages: [{ id }] }),
    merge: messages => loaded.push(...messages.map(message => message.id)),
    locate: id => { located.push(id); return true; },
  });
  const entry = { segments: [{ firstMessageRef: { id: 's1:gone' } }],
    firstMessageRef: { id: 's1:m1' }, lastMessageRef: { id: 's1:m9' } };
  assert.equal(await jump({ id: 's1:gone' }, entry), true);
  assert.deepEqual(loaded, ['s1:m1'], 'the first visible boundary record is what lands');
  assert.deepEqual(located, ['s1:m1']);
});

test('a jump reports failure only after every anchor missed, and never repeats one', async () => {
  const fetched = [];
  const located = [];
  const jump = createAnchorJump({
    findById: () => false,
    fetchAround: async id => { fetched.push(id); return { found: true, messages: [] }; },
    merge: () => {},
    locate: id => { located.push(id); return false; },
  });
  const entry = { segments: [{ firstMessageRef: { id: 's1:a' } }],
    firstMessageRef: { id: 's1:a' }, lastMessageRef: { id: 's1:b' } };
  assert.equal(await jump({ id: 's1:a' }, entry), false);
  assert.deepEqual(fetched, ['s1:a', 's1:b'], 'the segment anchor is not fetched twice');
  assert.deepEqual(located, ['s1:a', 's1:b']);
});

test('a jump that throws while paginating keeps trying the remaining anchors', async () => {
  const errors = [], located = [];
  const jump = createAnchorJump({
    findById: () => false,
    fetchAround: async id => { if (id === 's1:a') throw new Error('network'); return { found: true, messages: [] }; },
    merge: () => {}, locate: id => { located.push(id); return true; },
    report: error => errors.push(error.message),
  });
  const entry = { firstMessageRef: { id: 's1:a' }, lastMessageRef: { id: 's1:b' } };
  assert.equal(await jump({ id: 's1:a' }, entry), true);
  assert.deepEqual(errors, ['network']);
  assert.deepEqual(located, ['s1:b']);
});

test('the reading line picks the last measurable message above it', () => {
  const node = (code, top) => ({ dataset: { taskShortCode: code }, getBoundingClientRect: () => ({ top }) });
  const nodes = [node('A001', 0), node('B002', 120), { dataset: { taskShortCode: 'C003' } }, node('C003', 400)];
  assert.equal(currentCodeAt(nodes, 200), 'B002', 'the last message above the line is the current one');
  assert.equal(currentCodeAt(nodes, -10), '', 'nothing above the line yet');
  assert.equal(currentCodeAt([{ dataset: { taskShortCode: 'A001' } }], 100), '',
    'a node with no measurable rect is skipped, never guessed');
});

test('a long directory gets search and ID ordering, and both survive a reopen', async () => {
  const f = fixture();
  const tasks = Array.from({ length: 9 }, (_, index) => ({
    taskId: `tsk_${index}`, shortCode: `T00${index}`.slice(-4).toUpperCase(),
    title: `Topic ${index}`, capabilities: {}, segments: [{ firstMessageRef: { id: `s1:m${index}` } }],
  })).reverse();
  const controller = createController({ document: f.doc, messagesEl: f.messages, storage: f.storage,
    loadIndex: async () => ({ tasks }) });
  await controller.reload();
  const toggle = f.doc.body.children[0], rail = f.doc.body.children[1];
  toggle.onclick();
  const rows = () => rail.children.slice(1, rail.children.length - 1); // filter bar first, empty note last
  const shown = () => rows().filter(row => row.hidden !== true).map(row => row.children[0].textContent);
  assert.equal(rail.children.length, 11, 'filter bar + 9 rows + the empty note');
  assert.equal(rail.children[0].className, 'task-index-filters');
  assert.deepEqual(shown(),
    ['T008', 'T007', 'T006', 'T005', 'T004', 'T003', 'T002', 'T001', 'T000'], 'conversation order by default');

  rail.children[0].children[1].onclick();
  assert.equal(f.storage.getItem('multicc:task-index-sort'), 'code');
  assert.deepEqual(shown(),
    ['T000', 'T001', 'T002', 'T003', 'T004', 'T005', 'T006', 'T007', 'T008'], 'ID order on request');

  const search = rail.children[0].children[0];  // no nav row in this directory
  search.value = 'topic 3';
  search.oninput({ target: { value: 'topic 3' } });
  assert.deepEqual(shown(), ['T003'],
    'search matches the title, not only the code');
  search.value = 'nope';
  search.oninput({ target: { value: 'nope' } });
  assert.deepEqual(shown(), [], 'nothing matches');
  assert.equal(rail.hidden, false, 'a filter matching nothing must not drop the rail');
  assert.equal(rail.children[rail.children.length - 1].className, 'task-index-empty');
  assert.equal(rail.children[rail.children.length - 1].hidden, false, 'the empty note is shown');
  search.value = '';
  search.oninput({ target: { value: '' } });
  assert.equal(shown().length, 9, 'clearing the filter restores every row without a rebuild');
  assert.equal(rail.children[rail.children.length - 1].hidden, true);
  controller.dispose();
});

test('choosing the next input target is an explicit action, never a side effect of locating', async () => {
  const f = fixture(), calls = [], toasts = [];
  const controller = createController({ document: f.doc, messagesEl: f.messages, storage: f.storage,
    loadIndex: async () => ({ tasks: [
      { taskId: 'tsk_a', shortCode: 'A001', title: 'Alpha', target: true, capabilities: { canSelectTarget: true },
        segments: [{ firstMessageRef: { id: 's1:m1' } }] },
      { taskId: 'tsk_b', shortCode: 'B002', title: 'Beta', capabilities: { canSelectTarget: true },
        segments: [{ firstMessageRef: { id: 's1:m2' } }] },
    ] }),
    selectTarget: { shellId: () => 'sh_1', alert: message => toasts.push(message),
      request: async (path, body) => { calls.push({ path, body }); return { ok: true, taskId: body.taskId }; } } });
  await controller.reload();
  const toggle = f.doc.body.children[0], rail = f.doc.body.children[1];
  toggle.onclick();
  assert.equal(rail.children[0].dataset.target, 'true', 'the server says which task the next message goes to');
  assert.equal(rail.children[0].children[1].className, 'task-index-target-mark');
  assert.equal(rail.children[1].children[1].className, 'task-index-select');
  rail.children[1].children[0].onclick();
  assert.deepEqual(calls, [], 'locating a row must not move the send target');
  rail.children[1].children[1].onclick({ stopPropagation() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [{ path: '/api/task-shells/sh_1/select-target', body: { taskId: 'tsk_b' } }]);
  assert.equal(rail.children[1].dataset.target, 'true');
  assert.equal(rail.children[0].dataset.target, undefined);
  assert.deepEqual(toasts, []);
  controller.dispose();
});

test('a rejected target choice keeps the previous one and says why', async () => {
  const f = fixture(), toasts = [];
  const controller = createController({ document: f.doc, messagesEl: f.messages, storage: f.storage,
    loadIndex: async () => ({ tasks: [
      { taskId: 'tsk_a', shortCode: 'A001', title: 'Alpha', target: true, capabilities: { canSelectTarget: true },
        segments: [{ firstMessageRef: { id: 's1:m1' } }] },
      { taskId: 'tsk_b', shortCode: 'B002', title: 'Beta', capabilities: { canSelectTarget: true },
        segments: [{ firstMessageRef: { id: 's1:m2' } }] },
    ] }),
    selectTarget: { shellId: () => 'sh_1', alert: message => toasts.push(message),
      request: async () => { throw Object.assign(new Error('stale_shell_cursor'), { code: 'stale_shell_cursor' }); } } });
  await controller.reload();
  const toggle = f.doc.body.children[0], rail = f.doc.body.children[1];
  toggle.onclick();
  rail.children[1].children[1].onclick({ stopPropagation() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(rail.children[1].dataset.target, undefined, 'a failed choice does not repaint the target');
  assert.equal(rail.children[0].dataset.target, 'true');
  assert.deepEqual(toasts, ['taskIndexTargetFailed']);
  controller.dispose();
});

test('prev/next segment buttons walk the visible segments and never move the send target', async () => {
  const f = fixture(), navigated = [], calls = [];
  const controller = createController({ document: f.doc, messagesEl: f.messages, storage: f.storage,
    navigate: ref => { navigated.push(ref.id); return true; },
    loadIndex: async () => ({ tasks: [
      { taskId: 'tsk_a', shortCode: 'A001', title: 'Alpha', target: true, capabilities: { canSelectTarget: true }, segments: [
        { firstMessageRef: { id: 's1:m1' } }, { firstMessageRef: { id: 's1:m5' } }] },
      { taskId: 'tsk_b', shortCode: 'B002', title: 'Beta', capabilities: { canSelectTarget: true }, segments: [
        { firstMessageRef: { id: 's1:m9' } }] },
    ] }),
    selectTarget: { shellId: () => 'sh_1', alert: () => {},
      request: async (path, body) => { calls.push({ path, body }); return { ok: true, taskId: body.taskId }; } } });
  await controller.reload();
  const toggle = f.doc.body.children[0], rail = f.doc.body.children[1];
  toggle.onclick();
  const nav = rail.children[0];
  assert.equal(nav.className, 'task-index-nav');
  const [prev, position, next] = nav.children;
  assert.deepEqual(navigated, [], 'nothing moves before a click');
  assert.equal(position.textContent, '-/3', 'the reader has not been located yet');
  assert.equal(prev.disabled, true);
  next.onclick();
  assert.deepEqual(navigated, ['s1:m1'], 'next from an unknown position starts at the first segment');
  assert.equal(position.textContent, '1/3');
  assert.equal(prev.disabled, true, 'the first segment has nothing above it');
  next.onclick();
  assert.deepEqual(navigated, ['s1:m1', 's1:m5'], 'the second segment of the same task comes next');
  assert.equal(position.textContent, '2/3');
  assert.equal(prev.disabled, false, 'the way back opens once we are past the first segment');
  next.onclick();
  assert.deepEqual(navigated, ['s1:m1', 's1:m5', 's1:m9']);
  assert.equal(position.textContent, '3/3');
  assert.equal(next.disabled, true, 'the last segment is the end of the directory');
  prev.onclick();
  assert.deepEqual(navigated.slice(-1), ['s1:m5']);
  assert.equal(position.textContent, '2/3');
  assert.deepEqual(calls, [], 'stepping only locates; it must never choose a send target');
  assert.equal(rail.children[1].dataset.target, 'true', 'the target stays where the server put it');
  controller.dispose();
});

test('a one-segment-per-task directory has no segment nav, filters narrow it when it exists', async () => {
  const f = fixture(), navigated = [];
  const tasks = Array.from({ length: 9 }, (_, index) => ({ taskId: `tsk_${index}`,
    shortCode: `T00${index}`.slice(-4).toUpperCase(), title: `Topic ${index}`, capabilities: {},
    segments: [{ firstMessageRef: { id: `s1:m${index * 2}` } }] }));
  tasks[0].segments.push({ firstMessageRef: { id: 's1:m99' } });
  const controller = createController({ document: f.doc, messagesEl: f.messages, storage: f.storage,
    navigate: ref => { navigated.push(ref.id); return true; }, loadIndex: async () => ({ tasks }) });
  await controller.reload();
  const toggle = f.doc.body.children[0], rail = f.doc.body.children[1];
  toggle.onclick();
  // The nav leads (both in the DOM and, via `order`, on screen), then the filter bar.
  const nav = rail.children[0];
  assert.equal(nav.className, 'task-index-nav');
  assert.equal(rail.children[1].className, 'task-index-filters');
  nav.children[2].onclick();
  assert.deepEqual(navigated, ['s1:m0'], 'conversation order starts with the first task');
  nav.children[2].onclick();
  assert.deepEqual(navigated, ['s1:m0', 's1:m99'], 'its second segment follows before the next task');
  const search = rail.children[1].children[0];
  search.value = 'topic 3';
  search.oninput({ target: { value: 'topic 3' } });
  assert.equal(nav.children[1].textContent, '-/1', 'only the matching segment is reachable');
  nav.children[2].onclick();
  assert.deepEqual(navigated.slice(-1), ['s1:m6']);
  assert.equal(nav.children[2].disabled, true, 'one visible segment is both ends');
  assert.equal(nav.children[0].disabled, true);
  controller.dispose();
});

test('a directory with no multi-segment task does not render the nav row', async () => {
  const f = fixture();
  const controller = createController({ document: f.doc, messagesEl: f.messages, storage: f.storage,
    navigate: () => true, loadIndex: async () => ({ tasks: [
      { taskId: 'tsk_a', shortCode: 'A001', title: 'Alpha', capabilities: {}, segments: [{ firstMessageRef: { id: 's1:m1' } }] },
      { taskId: 'tsk_b', shortCode: 'B002', title: 'Beta', capabilities: {}, segments: [{ firstMessageRef: { id: 's1:m2' } }] },
    ] }) });
  await controller.reload();
  const rail = f.doc.body.children[1];
  assert.equal(rail.children[0].className, 'task-index-row', 'one segment per row needs no stepper');
  controller.dispose();
});
