'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createComposerTarget } = require('../public/chat-task-target');

class FakeNode {
  constructor(tag) {
    this.tagName = tag; this.hidden = false; this.textContent = ''; this.dataset = {};
    this.attributes = {}; this.title = ''; this.removed = false;
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
  remove() { this.removed = true; }
}

const translate = key => ({
  taskTargetChip: '下一条发给 {code}',
  taskTargetChipTitle: '打开任务索引 {code}',
}[key] || key);

function chip() { return new FakeNode('button'); }

test('the chip stays hidden until a task owns a real four-character handle', () => {
  const element = chip();
  const target = createComposerTarget({ element, translate });
  assert.equal(target.element, element);
  assert.equal(element.hidden, true);
  assert.equal(element.textContent, '');
  // A taskId suffix is not a display handle: only a minted code may be shown.
  target.update({ taskId: 'tsk_abcdef', code: 'abcdef' });
  assert.equal(element.hidden, true);
  assert.equal(element.textContent, '');
  target.update({ taskId: 'tsk_a', taskShortCode: 'a1b2' });
  assert.equal(element.hidden, false);
  assert.equal(element.textContent, '下一条发给 #A1B2');
  assert.equal(element.title, '打开任务索引 #A1B2');
  assert.equal(element.dataset.code, 'A1B2');
  target.update({ taskId: null, taskShortCode: '' });
  assert.equal(element.hidden, true, 'a shell without a current task shows nothing');
  assert.equal(element.attributes['aria-label'], undefined);
});

test('clicking the chip opens the index, and only a change flashes', () => {
  const element = chip();
  let opened = 0;
  const target = createComposerTarget({ element, translate, openIndex: () => { opened += 1; } });
  target.update({ taskId: 'tsk_a', code: 'A1B2' });
  assert.equal(element.dataset.flash, undefined, 'the first paint is not a change');
  element.onclick();
  assert.equal(opened, 1);
  target.update({ taskId: 'tsk_a', code: 'A1B2' }, { flash: true });
  assert.equal(element.dataset.flash, undefined, 'an echoed target is not a change');
  target.update({ taskId: 'tsk_c', code: 'C3D4' }, { flash: true });
  assert.equal(element.dataset.flash, 'true');
  assert.equal(element.textContent, '下一条发给 #C3D4');
});

test('an accepted index choice updates the chip before any broadcast arrives', () => {
  const element = chip();
  const target = createComposerTarget({ element, translate });
  assert.deepEqual(target.target(), { taskId: null, code: '' });
  target.applySelection({ code: 'b002', taskId: 'tsk_b' }, { ok: true, taskId: 'tsk_b' });
  assert.equal(element.textContent, '下一条发给 #B002');
  assert.deepEqual(target.target(), { taskId: 'tsk_b', code: 'B002' });
  // A row that cannot show a handle cannot set one either.
  assert.equal(target.applySelection({ taskId: 'tsk_c' }, {}), null);
  assert.equal(element.textContent, '下一条发给 #B002');
});

test('a target moved in another page is re-read once, and a same-target echo is not', async () => {
  const element = chip();
  const reads = [];
  const target = createComposerTarget({ element, translate,
    load: async () => { reads.push(1); return { ok: true, taskId: 'tsk_b', taskShortCode: 'B002' }; } });
  target.update({ taskId: 'tsk_a', code: 'A001' });
  assert.equal(target.sync({ shellId: 'sh_1', taskId: 'tsk_a' }), null, 'the same target is not re-read');
  assert.equal(target.sync(null), null, 'nothing to sync without a state source');
  const pending = target.sync({ shellId: 'sh_1', taskId: 'tsk_b' });
  assert.equal(target.sync({ shellId: 'sh_1', taskId: 'tsk_c' }), pending, 'concurrent syncs share one read');
  await pending;
  assert.equal(reads.length, 1);
  assert.equal(element.textContent, '下一条发给 #B002');
  assert.equal(element.dataset.flash, 'true', 'a cursor moved elsewhere is announced on the chip');
});

test('a failed or impossible re-read never blanks the chip', async () => {
  const element = chip();
  const target = createComposerTarget({ element, translate,
    load: async () => { throw new Error('offline'); } });
  target.update({ taskId: 'tsk_a', code: 'A001' });
  await target.sync({ shellId: 'sh_1', taskId: 'tsk_b' });
  assert.equal(element.textContent, '下一条发给 #A001');
  assert.deepEqual(target.target(), { taskId: 'tsk_a', code: 'A001' });
  // No loader at all: sync is a no-op rather than a thrown error.
  const bare = createComposerTarget({ element: chip(), translate });
  assert.equal(bare.sync({ shellId: 'sh_1', taskId: 'tsk_b' }), null);
});

test('without a place to render there is no controller', () => {
  assert.equal(createComposerTarget({ document: { getElementById: () => null } }), null);
  const element = chip();
  assert.equal(createComposerTarget({ document: { getElementById: id => (id === 'next-task-target' ? element : null) } })
    .element, element);
});
