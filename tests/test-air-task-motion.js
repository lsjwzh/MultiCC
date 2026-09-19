'use strict';
// 侧栏换位动画的几何部分：air-task-motion.js 不读全局状态，所以这一组用假元素
// 把三件事钉住 —— 量的是哪一行的哪个位置、谁真的动了、以及「飞上去」和「就地
// 抽掉」两种收尾各自写下什么。
const test = require('node:test');
const assert = require('node:assert/strict');
const { capture, moves, lift, clear, play, topSlotVisible, rowById } = require('../public/air-task-motion');

const ROW_HEIGHT = 40;

class FakeRow {
  constructor(id, top, left = 0) {
    this.dataset = id ? { task: id } : {};
    this.style = {};
    this.offsetHeight = ROW_HEIGHT;
    this.rect = { top, left };
    this.classes = new Set();
    this.classList = {
      add: (...names) => names.forEach(name => this.classes.add(name)),
      remove: (...names) => names.forEach(name => this.classes.delete(name)),
      contains: name => this.classes.has(name),
    };
  }
  getBoundingClientRect() {
    return { top: this.rect.top, left: this.rect.left, bottom: this.rect.top + ROW_HEIGHT, right: this.rect.left + 200 };
  }
}

class FakeList {
  constructor(rows, top = 0, height = 400) {
    this.children = rows;
    this.offsetHeight = height;
    this.scrollTop = 0;
    this.rect = { top, left: 0, bottom: top + height, right: 220 };
  }
  getBoundingClientRect() { return { ...this.rect }; }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('capture records the current slot of every row that owns a task id', () => {
  const list = new FakeList([new FakeRow('a', 10), new FakeRow(null, 50), new FakeRow('b', 90, 8)]);
  const rects = capture(list);
  assert.deepEqual([...rects.keys()], ['a', 'b']);
  assert.deepEqual(rects.get('b'), { top: 90, left: 8 });
  assert.equal(capture(null).size, 0);
});

test('moves keeps only rows that really changed slot', () => {
  const before = new Map([['a', { top: 0, left: 0 }], ['b', { top: 40, left: 0 }], ['c', { top: 80, left: 0 }]]);
  const after = new Map([['a', { top: 40, left: 0 }], ['b', { top: 40.2, left: 0 }], ['c', { top: 0, left: 0 }]]);
  const list = moves(before, after);
  assert.deepEqual(list.map(move => move.id).sort(), ['a', 'c'], 'b 只差了 0.2px（亚像素抖动），不算动过');
  assert.deepEqual(list.find(move => move.id === 'c'), { id: 'c', dx: 0, dy: 80 }, '从第 3 位飞回顶：往上 80px');
  assert.deepEqual(moves(before, new Map([['new', { top: 0, left: 0 }]])), [], '起点里没有的行不参与动画');
});

test('the top slot counts as visible only while it still shows inside the band', () => {
  const atTop = new FakeList([new FakeRow('a', 12), new FakeRow('b', 52)]);
  assert.equal(topSlotVisible(atTop), true, '顶端那条还在可视带里 → 卡片可以飞上去');
  const showing = new FakeList([new FakeRow('a', -20), new FakeRow('b', 20)], 4, 300);
  assert.equal(topSlotVisible(showing), true, '只露出半条也算看得见 —— 飞上去不会凭空消失');
  const scrolled = new FakeList([new FakeRow('a', -60), new FakeRow('b', -20)], 4, 300);
  assert.equal(topSlotVisible(scrolled), false, '顶端整条都缩到带子上沿以外 → 就地收掉');
});

test('play flies the lifted row up and puts every inline style back afterwards', async () => {
  const rows = [new FakeRow('a', 0), new FakeRow('b', 40), new FakeRow('c', 80)];
  const list = new FakeList(rows);
  const before = capture(list);
  // 把 c 换到最前面：c 的原位空出来，a/b 各下滑一格。
  rows[2].rect.top = 0; rows[0].rect.top = 40; rows[1].rect.top = 80;
  list.children = [rows[2], rows[0], rows[1]];
  assert.equal(play(list, before, { liftId: 'c', duration: 20 }), 3);
  assert.ok(rows[2].classes.has('is-flying'), '飞上去的那张要抬起来');
  assert.ok(rows[2].style.transition.includes('transform 20ms'), '终点走 transform 过渡');
  assert.equal(rows[2].style.transform, '', '终点是回原位（位移为 0），起点由过渡演出来');
  assert.ok(rows[0].classes.has('is-reordering') && rows[1].classes.has('is-reordering'), '让路的行也一起滑');
  lift(list, 'c');
  assert.ok(rows[2].classes.has('is-lifting'), '抬起只加一个类，位置留给 FLIP');
  await sleep(160);
  assert.equal(rows[2].style.transform, '', '动画结束后行内样式要还回去');
  assert.equal(rows[2].style.transition, '');
  for (const name of ['is-reordering', 'is-flying']) assert.equal(rows[2].classes.has(name), false, name);
  // 抬起的类由调用方收拾：换位完成后这条带子会重画，new 出来的行本来就不带它；
  // 中途换了主意（点了别条）时才需要 clear 把它摘掉。
  clear(list, 'c');
  assert.equal(rows[2].classes.has('is-lifting'), false);
});

test('a list scrolled past the top drops the card in place instead of flying it', async () => {
  const rows = [new FakeRow('a', -80), new FakeRow('b', -40), new FakeRow('c', 0)];
  const list = new FakeList(rows, 4, 300);
  const before = capture(list);
  rows[2].rect.top = -80; rows[0].rect.top = -40; rows[1].rect.top = 0;
  list.children = [rows[2], rows[0], rows[1]];
  assert.equal(play(list, before, { liftId: 'c', flight: false, duration: 20 }), 3);
  assert.equal(rows[2].style.transform, 'translate(0px, 80px)', '就地收掉：位置停在原来那一格（不跟着飞）');
  assert.ok(rows[2].style.transition.startsWith('opacity '), '只有透明度在过渡，位置不动');
  assert.equal(rows[2].style.opacity, '0');
  assert.ok(rows[2].classes.has('is-collapsing'));
  assert.ok(rows[0].style.transition.includes('transform'), '其它行照旧滑到位');
  assert.equal(rowById(list, 'c').dataset.task, 'c');
  await sleep(160);
  assert.equal(rows[2].style.opacity, '');
  assert.equal(rows[2].style.transform, '', '收尾要把行内样式还回去');
  assert.equal(rows[2].classes.has('is-collapsing'), false);
});

test('nothing moved means no animation, no leftover inline styles and no lingering lift', () => {
  const rows = [new FakeRow('a', 0), new FakeRow('b', 40)];
  const list = new FakeList(rows);
  const before = capture(list);
  lift(list, 'a');
  assert.equal(play(list, before, { liftId: 'a' }), 0);
  assert.deepEqual(rows[0].style, {});
  assert.equal(rows[0].classes.has('is-lifting'), false, '没有位移就没有后续，抬起那张不能一直悬着');
  assert.equal(play(list, new Map(), {}), 0);
});
