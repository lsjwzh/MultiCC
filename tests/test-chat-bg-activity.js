'use strict';

// 聊天页后台任务活动行（public/chat-bg-activity.js）的行为测试：轮次等待期间
// 在呼吸灯下方展示运行中的后台任务（描述 + 走字时长 + 最近输出），任务收尾或
// 轮次结束后收行。DOM 用手写 fake（同 tests/test-chat-dispatch-activity.js 的
// 手法），timer 注入以便驱动走字与轮询。

const assert = require('node:assert/strict');
const test = require('node:test');

const { create } = require('../public/chat-bg-activity');

function makeNode(tag, className) {
  const node = {
    tagName: tag,
    className: className || '',
    children: [],
    parentElement: null,
    isConnected: false,
    textContent: '',
    hidden: false,
    title: '',
    dataset: {},
    attrs: {},
    setAttribute(name, value) { this.attrs[name] = value; },
    _attach(child) {
      if (child.parentElement) child.parentElement._detach(child);
      child.parentElement = this;
      child.isConnected = true;
      this.children.push(child);
    },
    _detach(child) {
      const index = this.children.indexOf(child);
      if (index >= 0) this.children.splice(index, 1);
      child.parentElement = null;
      child.isConnected = false;
    },
    append(...kids) { kids.forEach(kid => this._attach(kid)); },
    appendChild(kid) { this._attach(kid); return kid; },
    insertBefore(kid, ref) {
      this._detach(kid);
      kid.parentElement = this;
      kid.isConnected = true;
      const index = ref ? this.children.indexOf(ref) : -1;
      if (index >= 0) this.children.splice(index, 0, kid);
      else this.children.push(kid);
      return kid;
    },
    get nextSibling() {
      if (!this.parentElement) return null;
      const index = this.parentElement.children.indexOf(this);
      return this.parentElement.children[index + 1] || null;
    },
    remove() { if (this.parentElement) this.parentElement._detach(this); },
    querySelector(selector) {
      const cls = selector.startsWith('.') ? selector.slice(1) : null;
      if (!cls) return null;
      for (const kid of this.children) {
        if (kid.className === cls) return kid;
        const deep = kid.querySelector(selector);
        if (deep) return deep;
      }
      return null;
    },
  };
  return node;
}

function makeTimers() {
  const timers = {
    handles: [],
    setInterval(fn, ms) { const handle = { fn, ms }; timers.handles.push(handle); return handle; },
    clearInterval(handle) { timers.handles = timers.handles.filter(entry => entry !== handle); },
    tick(ms) {
      for (const handle of [...timers.handles]) {
        if (handle.ms === ms) handle.fn();
      }
    },
  };
  return timers;
}

function makeHarness(overrides = {}) {
  const messagesEl = makeNode('div', 'messages');
  const doc = { createElement: tag => makeNode(tag) };
  const timers = makeTimers();
  const clock = { now: 1_000_000 };
  const state = { streaming: true, tasksPayload: null, fetchUrl: '' };
  const translate = (key, params) => ({
    bgActivityRunning: '后台任务执行中',
    bgActivityRunningCount: `后台任务 ×${params && params.n} 执行中`,
    bgActivityLatest: '最近输出',
  })[key] || key;
  const controller = create({
    document: doc,
    getMessagesEl: () => messagesEl,
    getIsStreaming: () => state.streaming,
    translate,
    getSessionId: () => 'sess-1',
    fetchJson: async url => {
      state.fetchUrl = url;
      if (!state.tasksPayload) throw new Error('offline');
      return state.tasksPayload;
    },
    now: () => clock.now,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    ...overrides,
  });
  return { controller, messagesEl, timers, clock, state };
}

function stripOf(messagesEl) { return messagesEl.querySelector('.bg-activity'); }
function mainText(harness) {
  const strip = stripOf(harness.messagesEl);
  return strip ? strip.querySelector('.bg-activity-main').textContent : '';
}
function tailText(harness) {
  const strip = stripOf(harness.messagesEl);
  if (!strip) return '';
  const tail = strip.querySelector('.bg-activity-tail');
  return tail && !tail.hidden ? tail.textContent : '';
}

test('shows running background task under the thinking bubble while streaming', () => {
  const harness = makeHarness();
  const thinking = makeNode('div', 'thinking-bubble');
  harness.messagesEl.appendChild(thinking);
  harness.controller.onEvent({ type: 'monitor_started', task_id: 't1', description: '编译 Android 安装包', background: true });
  const strip = stripOf(harness.messagesEl);
  assert.ok(strip, 'strip 应挂到消息流');
  assert.equal(strip.parentElement.children[strip.parentElement.children.length - 2], thinking, '呼吸灯在前');
  assert.equal(strip.parentElement.children[strip.parentElement.children.length - 1], strip, '活动行紧跟呼吸灯');
  assert.match(mainText(harness), /后台任务执行中/);
  assert.match(mainText(harness), /编译 Android 安装包/);
  assert.match(mainText(harness), /0ms/);
  harness.controller.dispose();
});

test('elapsed time walks with the tick', () => {
  const harness = makeHarness();
  harness.controller.onEvent({ type: 'monitor_started', task_id: 't1', description: '审计 Rust 迁移', background: true });
  harness.clock.now += 287_000; // 4m 47s，对齐截图里的等待时长
  harness.timers.tick(1000);
  assert.match(mainText(harness), /4m 47s/);
  harness.controller.dispose();
});

test('multi-task label counts and appends +N', () => {
  const harness = makeHarness();
  harness.controller.onEvent({ type: 'monitor_started', task_id: 't1', description: '任务甲', background: true });
  harness.clock.now += 30_000;
  harness.controller.onEvent({ type: 'monitor_started', task_id: 't2', description: '任务乙', background: true });
  const text = mainText(harness);
  assert.match(text, /后台任务 ×2 执行中/);
  assert.match(text, /任务甲/);
  assert.match(text, /\+1/);
  assert.doesNotMatch(text, /任务乙/);
  harness.controller.dispose();
});

test('monitor_done removes the strip when no task is left', () => {
  const harness = makeHarness();
  harness.controller.onEvent({ type: 'monitor_started', task_id: 't1', description: '任务甲', background: true });
  assert.ok(stripOf(harness.messagesEl));
  harness.controller.onEvent({ type: 'monitor_done', task_id: 't1', status: 'done' });
  assert.equal(stripOf(harness.messagesEl), null, '无任务应收行');
  assert.equal(harness.timers.handles.length, 0, '定时器应停');
  harness.controller.dispose();
});

test('hidden while the turn is not streaming even with tasks running', () => {
  const harness = makeHarness({ getIsStreaming: () => false });
  harness.controller.onEvent({ type: 'monitor_started', task_id: 't1', description: '任务甲', background: true });
  assert.equal(stripOf(harness.messagesEl), null);
  harness.controller.dispose();
});

test('strip disappears when streaming ends and returns when a new turn starts', () => {
  const harness = makeHarness();
  harness.controller.onEvent({ type: 'monitor_started', task_id: 't1', description: '任务甲', background: true });
  assert.ok(stripOf(harness.messagesEl));
  harness.state.streaming = false;
  harness.controller.onEvent({ type: 'stream_end' });
  assert.equal(stripOf(harness.messagesEl), null, '轮次结束应收行');
  harness.state.streaming = true;
  harness.controller.onEvent({ type: 'stream_start' });
  assert.ok(stripOf(harness.messagesEl), '新轮次且任务仍在跑应重新出现');
  harness.controller.dispose();
});

test('sync bash (background:false) is not a background task', () => {
  const harness = makeHarness();
  harness.controller.onEvent({ type: 'monitor_started', task_id: 'sync1', description: '同步命令', background: false });
  assert.equal(stripOf(harness.messagesEl), null);
  harness.controller.dispose();
});

test('background_tasks snapshot reconciles unknown and vanished tasks', () => {
  const harness = makeHarness();
  harness.controller.onEvent({ type: 'monitor_started', task_id: 't1', description: '任务甲', background: true });
  harness.controller.onEvent({
    type: 'background_tasks',
    tasks: [
      { task_id: 't1', description: '任务甲（更新）', background: true },
      { task_id: 't2', description: '快照新任务', background: true },
    ],
  });
  const text = mainText(harness);
  assert.match(text, /×2/);
  assert.match(text, /任务甲（更新）/, '快照描述应覆盖');
  harness.controller.onEvent({ type: 'background_tasks', tasks: [] });
  assert.ok(stripOf(harness.messagesEl), '宽限内快照缺席不闪收');
  harness.clock.now += 60_000;
  harness.controller.onEvent({ type: 'monitor_progress', task_id: 't1', description: '任务甲', background: true });
  harness.clock.now += 60_000;
  harness.controller.onEvent({ type: 'background_tasks', tasks: [] });
  assert.ok(stripOf(harness.messagesEl), '进度心跳刷新宽限，快照缺席仍不收');
  harness.clock.now += 91_000;
  harness.controller.onEvent({ type: 'background_tasks', tasks: [] });
  assert.equal(stripOf(harness.messagesEl), null, '宽限过后快照仍缺席才收行');
  harness.controller.dispose();
});

test('tasks poll calibrates startedAt and surfaces the latest output line', async () => {
  const harness = makeHarness();
  harness.controller.onEvent({ type: 'monitor_started', task_id: 't1', description: '跑批任务', background: true });
  // 让 monitor_started 触发的空轮询（tasksPayload 尚未就绪）先落定，否则它
  // 的 in-flight 锁会把同窗口内的后续轮询全部吞掉。
  await Promise.resolve();
  await Promise.resolve();
  harness.clock.now += 60_000;
  // 服务端台账：任务实际 5 分钟前创建（createdAt 更早），最新输出两行。
  harness.state.tasksPayload = {
    tasks: [{
      taskId: 't1',
      status: 'running',
      createdAt: harness.clock.now - 300_000,
      updatedAt: harness.clock.now - 1000,
      lastOutput: 'RUN 41/100 ok\nRUN 42/100 ok\n',
    }],
  };
  // 直接驱动 5s 轮询定时器（monitor_progress 的即时轮询与它是同一把锁）。
  harness.controller.onEvent({ type: 'monitor_progress', task_id: 't1', description: '跑批任务', background: true });
  harness.timers.tick(5000);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(harness.state.fetchUrl, '/api/sessions/sess-1/tasks');
  assert.match(mainText(harness), /5m/, '时长应采用服务端 createdAt');
  assert.match(tailText(harness), /↳ 最近输出 · RUN 42\/100 ok/);
  harness.controller.dispose();
});

test('poll settles a task the WS done event never delivered', async () => {
  const harness = makeHarness();
  harness.controller.onEvent({ type: 'monitor_started', task_id: 't1', description: '任务甲', background: true });
  await Promise.resolve();
  await Promise.resolve();
  harness.state.tasksPayload = { tasks: [{ taskId: 't1', status: 'done', createdAt: 1, updatedAt: 2, lastOutput: '' }] };
  harness.controller.onEvent({ type: 'monitor_progress', task_id: 't1', description: '任务甲', background: true });
  harness.timers.tick(5000);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(stripOf(harness.messagesEl), null, '台账 terminal 应回收行');
  harness.controller.dispose();
});

test('re-mounts after a history rerender wiped the container', () => {
  const harness = makeHarness();
  harness.controller.onEvent({ type: 'monitor_started', task_id: 't1', description: '任务甲', background: true });
  assert.ok(stripOf(harness.messagesEl));
  stripOf(harness.messagesEl).remove(); // 历史重渲染会把容器清掉
  harness.clock.now += 10_000;
  harness.timers.tick(1000);
  assert.ok(stripOf(harness.messagesEl), 'tick 应重挂活动行');
  assert.match(mainText(harness), /10s/);
  harness.controller.dispose();
});

test('no timers leak after dispose', () => {
  const harness = makeHarness();
  harness.controller.onEvent({ type: 'monitor_started', task_id: 't1', description: '任务甲', background: true });
  assert.ok(harness.timers.handles.length > 0);
  harness.controller.dispose();
  assert.equal(harness.timers.handles.length, 0);
  assert.equal(stripOf(harness.messagesEl), null);
});

test('merges into the streaming bubble status row when the host accepts it', () => {
  const writes = [];
  let accept = true;
  const harness = makeHarness({ setStatus: (text, title) => { writes.push({ text, title }); return accept; } });
  harness.controller.onEvent({ type: 'monitor_started', task_id: 't1', description: '跑核心测试', background: true });
  assert.equal(stripOf(harness.messagesEl), null, '状态行接手后不再挂独立胶囊');
  const last = writes[writes.length - 1];
  assert.match(last.text, /后台任务执行中 · 跑核心测试/);
  assert.match(last.title, /跑核心测试/);
  // 宿主没有生成中的气泡（返回 false）→ 退回胶囊。
  accept = false;
  harness.clock.now += 1000;
  harness.timers.tick(1000);
  assert.ok(stripOf(harness.messagesEl), '无状态行可写时退回胶囊');
  // 任务收尾：清空状态槽。
  accept = true;
  harness.controller.onEvent({ type: 'monitor_done', task_id: 't1' });
  assert.equal(writes[writes.length - 1].text, '', '没有后台任务时清空 bg 槽，让位给最新工具调用');
  assert.equal(stripOf(harness.messagesEl), null);
  harness.controller.dispose();
});
