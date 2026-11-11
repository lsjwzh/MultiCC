'use strict';

/**
 * test-chat-duplicate-guards.js — chat 前端重复气泡守卫回归
 *
 * 复现并锁定「当前页面出现重复消息、刷新后消失」这类 bug 的修复：
 * 用最小假 DOM 驱动真实的 chat-event-controller / chat-history-store /
 * chat-history-view，回放 WS 事件序列，断言 DOM 中不出现重复消息气泡。
 *
 * 覆盖的重复路径（修复见 chat-history-view.js / chat-event-controller.js）：
 *  S2  result 后迟到/回放的全量快照新建第二个气泡
 *  S4  result 后、commit 前重连，历史页含已完成消息而本地气泡无 id
 *  S5  codex 同一 assistant 帧被投递两次导致文本自我翻倍
 *  S7  重连把直播气泡升级为 interim id，最终 commit 换正式 id 再追加一份
 *  S6（todo）🔇 nudge 重试产生内容相同的持久化双胞胎——需在落库层做
 *      supersede 去重，属于另一类 bug（刷新后也可见），待后续任务修复。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { createRig, scanDuplicates, SCENARIOS } = require(
  path.join(__dirname, '..', 'scripts', 'chat-dup-harness.js'),
);
const { createTransportAdapter } = require('../public/chat-shell-entry');

function shellRig() {
  const rig = createRig();
  const adapter = createTransportAdapter({ send: () => true });
  adapter.ingest({ type: 'system', subtype: 'init', is_streaming: false, taskShell: true });
  return { ...rig, adapter, receive: event => rig.feed(adapter.ingest(event).events) };
}

function shellEvents(clientMsgId, receiptId, id) {
  const message = { id, role: 'user', content: 'same message', clientMsgId: receiptId };
  return {
    ack: { type: 'task_shell_routed', clientMsgId, receiptId, sessionId: 'diag-session' },
    admission: { type: 'message_admission_progress', state: 'waiting', message: message.content, clientMsgId: receiptId },
    committed: { type: 'chat_msg_meta', id, role: 'user', clientMsgId: receiptId, message },
    history: { type: 'chat_history', messages: [message], hasMore: false },
  };
}

function stageInput(rig, text, clientMsgId) {
  const node = rig.historyView.createUserNode(text, clientMsgId);
  rig.messagesEl.appendChild(node);
  rig.state.lastUserBubble = node;
  return node;
}

for (const event of ['queued', 'snapshot']) {
  test(`FIFO ${event} moves only the optimistic input out of the transcript`, () => {
    const rig = createRig();
    const previous = stageInput(rig, '同文消息', 'previous');
    previous.dataset.msgId = 'persisted';
    stageInput(rig, '同文消息', 'pending');
    const item = { entryId: 'q', clientMsgId: 'pending', text: '同文消息' };
    rig.feed([{ type: 'session_queue', event, queued: true, items: [item] }]);
    assert.deepEqual(rig.messagesEl.querySelectorAll('.msg.user'), [previous]);
    assert.equal(rig.state.lastUserBubble, null, 'no detached optimistic anchor remains');
    assert.equal(rig.queues.at(-1).items.length, 1);
    // Late preparation progress must not put the queued input back in history.
    rig.feed([{ type: 'message_admission_progress', clientMsgId: 'pending', message: '同文消息', state: 'waiting' }]);
    assert.deepEqual(rig.messagesEl.querySelectorAll('.msg.user'), [previous]);
    rig.feed([{ type: 'session_queue', event: 'claimed', items: [], active: item }]);
    assert.equal(rig.messagesEl.querySelectorAll('.msg.user').length, 2);
    assert.equal(rig.queues.at(-1).items.length, 0);
  });
}

test('queued edits and cancellation never leave a phantom transcript bubble', () => {
  const rig = createRig();
  stageInput(rig, '旧正文', 'pending');
  const queue = { type: 'session_queue', items: [{ entryId: 'q', clientMsgId: 'pending', text: '旧正文' }] };
  rig.feed([{ ...queue, event: 'queued', queued: true }]);
  rig.feed([{ ...queue, event: 'queued_edited', items: [{ ...queue.items[0], text: '新正文' }] }]);
  assert.equal(rig.messagesEl.querySelectorAll('.msg.user').length, 0);
  assert.equal(rig.queues.at(-1).items[0].text, '新正文');
  rig.feed([{ ...queue, event: 'queued_cancelled', items: [] }]);
  assert.equal(rig.queues.at(-1).items.length, 0);
  assert.equal(rig.messagesEl.querySelectorAll('.msg.user').length, 0);
});

test('a durable user commit retires a stale queue row without deleting history', () => {
  const rig = createRig();
  const item = { entryId: 'q', clientMsgId: 'client', text: '消息' };
  const queue = { type: 'session_queue', event: 'snapshot', state: 'assessing', items: [item] };
  stageInput(rig, item.text, item.clientMsgId);
  rig.feed([queue, { type: 'chat_msg_meta', message: { id: 'stored', role: 'user', content: item.text, clientMsgId: item.clientMsgId } }]);
  assert.equal(rig.queues.at(-1).items.length, 0, 'committed input is no longer pending');
  rig.feed([queue]);
  assert.equal(rig.queues.at(-1).items.length, 0, 'late snapshot cannot requeue committed input');
  assert.equal(rig.messagesEl.querySelectorAll('.msg.user').length, 1);
  assert.equal(rig.historyView.findById('stored').dataset.clientMsgId, 'client');
});

for (const ackFirst of [true, false]) {
  test(`shell FIFO maps nested receipt IDs and restores the claimed bubble (ACK first: ${ackFirst})`, () => {
    const rig = shellRig();
    const events = shellEvents('client', 'sr_receipt', 'stored');
    rig.adapter.send({ type: 'user_message', text: 'same message', clientMsgId: 'client' });
    stageInput(rig, 'same message', 'client');
    if (ackFirst) rig.receive(events.ack);
    const item = Object.freeze({ entryId: 'q', clientMsgId: 'sr_receipt', text: 'same message' });
    rig.receive({ type: 'session_queue', event: 'snapshot', items: Object.freeze([item]) });
    if (!ackFirst) rig.receive(events.ack);
    assert.equal(rig.queues.at(-1).items[0].clientMsgId, 'client');
    assert.equal(rig.messagesEl.querySelectorAll('.msg.user').length, 0);
    rig.receive({ type: 'session_queue', event: 'claimed', items: [], active: item });
    assert.equal(rig.queues.at(-1).items.length, 0);
    assert.equal(rig.messagesEl.querySelectorAll('.msg.user').length, 1);
    assert.equal(rig.state.lastUserBubble.dataset.clientMsgId, 'client');
    rig.receive(events.committed);
    assert.equal(rig.messagesEl.querySelectorAll('.msg.user').length, 1);
    assert.equal(rig.state.lastUserBubble.dataset.msgId, 'stored');
    assert.equal(item.clientMsgId, 'sr_receipt', 'wire records remain immutable');
  });
}

test('a late shell ACK cannot resurrect the FIFO snapshot preceding started', () => {
  const rig = shellRig();
  const events = shellEvents('client', 'sr_receipt', 'stored');
  rig.adapter.send({ type: 'user_message', text: 'same message', clientMsgId: 'client' });
  stageInput(rig, 'same message', 'client');
  rig.receive({ type: 'session_queue', event: 'queued', queued: true, clientMsgId: 'sr_receipt',
    items: [{ entryId: 'q', clientMsgId: 'sr_receipt', text: 'same message' }] });
  rig.receive({ type: 'session_queue', event: 'started', state: 'running', items: [] });
  rig.receive(events.ack);
  assert.deepEqual(rig.queues.at(-1).items, []);
  assert.equal(rig.queues.at(-1).metadata.state, 'running');
  assert.equal(rig.messagesEl.querySelectorAll('.msg.user').length, 1, 'started input stays visible');
});

test('replaying an immediate shell ACK never flashes its input in FIFO', () => {
  const rig = shellRig();
  const events = shellEvents('client', 'sr_receipt', 'stored');
  rig.adapter.send({ type: 'user_message', text: 'same message', clientMsgId: 'client' });
  stageInput(rig, 'same message', 'client');
  rig.receive({ type: 'session_queue', event: 'queued', queued: false, entryId: 'q',
    clientMsgId: 'sr_receipt', message: 'same message',
    items: [{ entryId: 'q', clientMsgId: 'sr_receipt', text: 'same message' }] });
  rig.receive(events.ack);
  rig.receive(events.ack);
  assert.ok(rig.queues.every(queue => queue.items.length === 0));
  assert.equal(rig.messagesEl.querySelectorAll('.msg.user').length, 1);
});

test('reconnect history retires queued input even when the live commit was missed', () => {
  const rig = createRig();
  const item = { entryId: 'q', clientMsgId: 'client', text: '消息' };
  rig.feed([{ type: 'session_queue', event: 'snapshot', items: [item] }]);
  rig.feed([{ type: 'chat_history', hasMore: false,
    messages: [{ id: 'stored', role: 'user', content: item.text, clientMsgId: item.clientMsgId }] }]);
  assert.equal(rig.queues.at(-1).items.length, 0);
  assert.equal(rig.historyView.findById('stored').dataset.clientMsgId, 'client');
});

test('an immediate send keeps its optimistic bubble while sibling messages stay queued', () => {
  const rig = createRig();
  const immediate = stageInput(rig, '立即发送', 'now');
  stageInput(rig, '排队消息', 'later');
  rig.feed([{ type: 'session_queue', event: 'queued', queued: false, entryId: 'now',
    message: '立即发送', clientMsgId: 'now', items: [
      { entryId: 'now', clientMsgId: 'now', text: '立即发送' },
      { entryId: 'later', clientMsgId: 'later', text: '排队消息' },
    ] }]);
  assert.deepEqual(rig.messagesEl.querySelectorAll('.msg.user'), [immediate]);
  assert.deepEqual(rig.queues.at(-1).items.map(item => item.entryId), ['later']);
});

test('shell claimed input waits for its nested receipt identity, then restores one bubble', () => {
  const rig = shellRig();
  const events = shellEvents('client', 'sr_receipt', 'stored');
  rig.adapter.send({ type: 'user_message', text: 'same message', clientMsgId: 'client' });
  stageInput(rig, 'same message', 'client');
  rig.receive({ type: 'session_queue', event: 'claimed', items: [],
    active: { entryId: 'q', clientMsgId: 'sr_receipt', text: 'same message' } });
  assert.equal(rig.messagesEl.querySelectorAll('.msg.user').length, 1);
  rig.receive(events.ack);
  assert.equal(rig.messagesEl.querySelectorAll('.msg.user').length, 1);
  rig.receive(events.committed);
  assert.equal(rig.state.lastUserBubble.dataset.msgId, 'stored');
});

test('a queued input in another window works without sender receipt mappings', () => {
  const rig = shellRig();
  const item = { entryId: 'q', clientMsgId: 'sr_other', text: '消息' };
  rig.receive({ type: 'session_queue', event: 'snapshot', items: [item] });
  assert.equal(rig.queues.at(-1).items.length, 1);
  assert.equal(rig.messagesEl.querySelectorAll('.msg.user').length, 0);
  rig.receive({ type: 'session_queue', event: 'claimed', items: [], active: item });
  assert.equal(rig.messagesEl.querySelectorAll('.msg.user').length, 1);
  assert.equal(rig.state.lastUserBubble.dataset.clientMsgId, 'sr_other');
});

test('Chrome renders FIFO input once across admission, edit, claim and durable commit', async t => {
  const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');
  if (!findChromeBinary()) return t.skip('需要 Chrome');
  const fs = require('node:fs');
  const modules = ['shared/format.js', 'status-presentation.js', 'chat-history-store.js',
    'chat-history-view.js', 'chat-event-controller.js', 'chat-shell-entry.js', 'chat-session-queue.js'];
  const routes = Object.fromEntries(modules.map(file => ['/' + file, {
    headers: { 'content-type': 'text/javascript' },
    body: fs.readFileSync(path.join(__dirname, '../public', file)),
  }]));
  routes['/'] = { headers: { 'content-type': 'text/html' }, body: `<!doctype html><meta charset="utf-8">
    <div id="messages"></div><section id="session-queue-dock" hidden>
    <span id="session-queue-count"></span><span id="session-queue-hint"></span><div id="session-queue-list"></div></section>
    ${modules.map(file => `<script src="/${file}"></script>`).join('')}` };
  await withCdpHarness({ routes }, async page => {
    await page.navigate('/');
    assert.ok(await page.waitFor('window.MultiCCChatSessionQueue && document.readyState === "complete"'));
    const observed = await page.evaluate(`(() => {
      const messages = document.getElementById('messages');
      const state = { isStreaming: false, lastUserBubble: null };
      const view = MultiCCChatHistoryView.createHistoryView({ document, messagesEl: messages });
      const host = {
        renderSessionQueue: MultiCCChatSessionQueue.render,
        addUserMessage(text, id) {
          const node = view.createUserNode(text, id); messages.appendChild(node); state.lastUserBubble = node;
        },
      };
      const controller = MultiCCChatEventController.createEventController({ state, host, historyView: view,
        historyStore: MultiCCChatHistoryStore.createHistoryStore(), liveUi: { hideThinking() {}, showThinking() {} } });
      const generation = controller.beginGeneration();
      const adapter = MultiCCChatShellEntry.createTransportAdapter({ send: () => true });
      const feed = message => adapter.ingest(message).events.forEach(event => controller.handleEvent(event, generation));
      const snapshot = () => ({ bubbles: messages.querySelectorAll('.msg.user').length,
        queued: document.querySelectorAll('.session-queue-item').length,
        hidden: document.getElementById('session-queue-dock').hidden });
      feed({ type: 'system', subtype: 'init', taskShell: true, is_streaming: false });
      adapter.send({ type: 'user_message', text: '旧正文', clientMsgId: 'client' });
      host.addUserMessage('旧正文', 'client');
      const item = { entryId: 'q', clientMsgId: 'sr_receipt', text: '旧正文' };
      feed({ type: 'session_queue', event: 'queued', queued: true, clientMsgId: 'sr_receipt', items: [item] });
      feed({ type: 'task_shell_routed', clientMsgId: 'client', receiptId: 'sr_receipt' });
      const queued = snapshot();
      item.text = '新正文';
      feed({ type: 'session_queue', event: 'queued_edited', items: [item] });
      const editedText = document.querySelector('.session-queue-text').textContent;
      feed({ type: 'session_queue', event: 'claimed', active: item, items: [] });
      const claimed = snapshot();
      feed({ type: 'chat_msg_meta', message: { id: 'stored', role: 'user', content: '新正文', clientMsgId: 'sr_receipt' } });
      feed({ type: 'session_queue', event: 'snapshot', state: 'assessing', items: [item] });
      return { queued, claimed, committed: snapshot(), editedText,
        stored: messages.querySelector('.msg.user').dataset.msgId,
        text: messages.querySelector('.msg.user').textContent };
    })()`);
    assert.deepEqual(observed.queued, { bubbles: 0, queued: 1, hidden: false });
    assert.deepEqual(observed.claimed, { bubbles: 1, queued: 0, hidden: true });
    assert.deepEqual(observed.committed, observed.claimed);
    assert.equal(observed.editedText, '新正文');
    assert.equal(observed.stored, 'stored');
    assert.match(observed.text, /新正文/);
  });
});

// Run the actual shell adapter and chat renderer together: receipt identity
// must reconcile the admission bubble with both live commits and reconnects.
for (const source of ['committed', 'nested-only', 'history']) {
  for (const ackPosition of [0, 1, 2]) {
    test(`shell user bubble stays single: ${source}, ACK position ${ackPosition}`, () => {
      const rig = shellRig();
      const events = shellEvents('client-1', 'sr_1', 'stored-1');
      rig.adapter.send({ type: 'user_message', text: 'same message', clientMsgId: 'client-1' });
      const committed = source === 'nested-only'
        ? { type: 'chat_msg_meta', message: events.committed.message }
        : events[source];
      const sequence = [events.admission, committed];
      sequence.splice(ackPosition, 0, events.ack);
      sequence.forEach(rig.receive);
      const bubbles = rig.messagesEl.querySelectorAll('.msg.user');
      assert.equal(bubbles.length, 1);
      assert.equal(bubbles[0].dataset.msgId, 'stored-1');
      assert.equal(bubbles[0].dataset.clientMsgId, 'client-1');
      rig.receive(events.committed);
      rig.receive(events.history);
      rig.receive(events.admission);
      assert.equal(rig.messagesEl.querySelectorAll('.msg.user').length, 1, 'replay must stay idempotent');
    });
  }
}

test('shell commit keeps distinct sends with identical text apart', () => {
  const rig = shellRig();
  for (const index of [1, 2]) {
    const clientMsgId = `client-${index}`;
    const events = shellEvents(clientMsgId, `sr_${index}`, `stored-${index}`);
    rig.adapter.send({ type: 'user_message', text: 'same message', clientMsgId });
    rig.receive(index === 1 ? events.admission : {
      type: 'session_queue', event: 'queued', queued: false, items: [],
      message: 'same message', clientMsgId: `sr_${index}`,
    });
    rig.receive(events.ack);
    rig.receive(events.committed);
    assert.equal(rig.state.lastUserBubble.dataset.msgId, `stored-${index}`);
    rig.receive(events.committed);
    assert.equal(rig.messagesEl.querySelectorAll('.msg.user').length, index);
  }
});

test('a second send during a running turn lands once, in order, with no failure path', () => {
  const rig = shellRig();
  // 上一轮还在跑时再发一条：回执要等第一条 turn 起来才回，这一段窗口里两条
  // 都在途。旧实现把第二条当成「socket 没开」拦回去（输入框被填回原文）。
  const sends = ['first', 'second'].map((text, index) => ({
    text, clientMsgId: `client-${index + 1}`, receiptId: `sr_${index + 1}`, id: `stored-${index + 1}`,
  }));
  for (const send of sends) {
    assert.equal(rig.adapter.send({ type: 'user_message', text: send.text, clientMsgId: send.clientMsgId }), true);
  }
  for (const send of sends) {
    rig.receive({ type: 'session_queue', event: 'queued', queued: false, items: [], message: send.text, clientMsgId: send.receiptId });
  }
  for (const send of sends) {
    rig.receive({ type: 'task_shell_routed', clientMsgId: send.clientMsgId, receiptId: send.receiptId, sessionId: 'diag-session' });
  }
  assert.deepEqual([...rig.messagesEl.querySelectorAll('.msg.user')].map(node => node.dataset.clientMsgId),
    ['client-1', 'client-2'], 'both sends must be on screen once the receipts land');
  for (const send of sends) {
    const record = { id: send.id, role: 'user', content: send.text, clientMsgId: send.receiptId };
    rig.receive({ type: 'chat_msg_meta', id: send.id, role: 'user', clientMsgId: send.receiptId, message: record });
    rig.receive({ type: 'chat_history', messages: [record], hasMore: false });
  }
  const bubbles = rig.messagesEl.querySelectorAll('.msg.user');
  assert.equal(bubbles.length, 2, 'commits and history must not duplicate the in-flight pair');
  assert.deepEqual([...bubbles].map(node => node.dataset.msgId), ['stored-1', 'stored-2']);
  assert.equal(rig.adapter.state().pending, null);
});

test('shell identity translation leaves persisted event records untouched', () => {
  const rig = shellRig();
  const events = shellEvents('client-1', 'sr_1', 'stored-1');
  Object.freeze(events.committed.message);
  Object.freeze(events.committed);
  Object.freeze(events.history.messages);
  Object.freeze(events.history);
  rig.receive(events.ack);
  const committed = rig.adapter.ingest(events.committed).events[0];
  const history = rig.adapter.ingest(events.history).events[0];
  assert.equal(committed.clientMsgId, 'client-1');
  assert.equal(committed.message.clientMsgId, 'client-1');
  assert.equal(history.messages[0].clientMsgId, 'client-1');
  assert.equal(events.committed.clientMsgId, 'sr_1');
  assert.equal(events.committed.message.clientMsgId, 'sr_1');
  assert.equal(events.history.messages[0].clientMsgId, 'sr_1');
});

test('a second window renders shell messages without the sender client mapping', () => {
  const rig = shellRig();
  const events = shellEvents('other-client', 'sr_other', 'stored-other');
  rig.receive(events.admission);
  rig.receive(events.committed);
  rig.receive(events.history);
  assert.equal(rig.messagesEl.querySelectorAll('.msg.user').length, 1);
  assert.equal(rig.state.lastUserBubble.dataset.clientMsgId, 'sr_other');
});

test('a rejected pending send still releases authoritative reconnect history', () => {
  const rig = shellRig();
  rig.adapter.send({ type: 'user_message', text: 'rejected', clientMsgId: 'client-new' });
  const events = shellEvents('client-old', 'sr_old', 'stored-old');
  rig.receive(events.history);
  rig.receive(events.committed);
  rig.receive({ type: 'error', notDelivered: true, clientMsgId: 'client-new', error: 'rejected' });
  assert.equal(rig.adapter.state().pending, null);
  const bubbles = rig.messagesEl.querySelectorAll('.msg.user');
  assert.equal(bubbles.length, 1);
  assert.equal(bubbles[0].dataset.msgId, 'stored-old');
});

for (const scenario of SCENARIOS) {
  const isKnownDup = scenario.name.startsWith('S6');
  const runner = isKnownDup ? test.todo : test;
  runner(`重复气泡场景 ${scenario.name}`, (t) => {
    const rig = createRig(scenario.cli || 'claude');
    rig.feed(scenario.events(rig));
    const { findings } = scanDuplicates(rig.messagesEl);
    if (isKnownDup) {
      // 已知遗留：持久化双胞胎需落库层 supersede；转绿后把本场景改为 test()。
      assert.ok(findings.length > 0, 'S6 已修复？请把本场景从 todo 转为正式断言');
      return;
    }
    assert.deepEqual(findings, [], `场景复现了重复气泡：\n${findings.join('\n')}`);
  });
}

// stream_start 契约回归（commit 714acf1）：adapter CLI（opencode 等）没有
// message_start 透传，server 改在回合开始广播 stream_start。注意这两个用例
// 不进 SCENARIOS 循环——跨两轮产出两个同文气泡是【正确行为】，
// scanDuplicates 会把同文当重复误报。
const { streamStart, assistantSnapshot, result } = require(
  path.join(__dirname, '..', 'scripts', 'chat-dup-harness.js'),
).helpers;

test('stream_start 契约：opencode 连续两轮相同回复各得一个完整气泡', () => {
  const T = '构建已完成，APK 产物已同步到仓库的 public 目录，可以直接下载安装。';
  const rig = createRig('opencode');
  rig.feed([
    streamStart(), assistantSnapshot(T), result(),
    streamStart(), assistantSnapshot(T), result(),
  ]);
  const bubbles = rig.messagesEl.querySelectorAll('.msg.assistant');
  assert.equal(bubbles.length, 2, `期望 2 个 assistant 气泡，实际 ${bubbles.length}（第二轮快照被 S2 守卫误杀？）`);
  for (const [i, b] of bubbles.entries()) {
    assert.ok(b.textContent.includes(T), `气泡 ${i + 1} 缺完整回复文本：「${b.textContent}」`);
  }
});

test('stream_start 重置直播状态（isStreaming=true、lastFinishedText 清空）', () => {
  const T = '这是一段用于验证回合收尾状态的回复文本，长度足够触发守卫。';
  const rig = createRig('opencode');
  rig.feed([streamStart(), assistantSnapshot(T), result()]);
  assert.ok(rig.state.lastFinishedText, 'result 后 lastFinishedText 应记住已完结文本');
  rig.feed([streamStart()]);
  assert.equal(rig.state.isStreaming, true, 'stream_start 必须把回合标记为 streaming');
  assert.equal(rig.state.lastFinishedText, '', 'stream_start 必须清空 lastFinishedText');
  // 旧契约（无 stream_start）下，第二轮同文快照会因 !isStreaming && text===lastFinishedText
  // 被 S2 守卫跳过、气泡消失——这正是 714acf1 修复前的症状，此处不做硬断言。
});
