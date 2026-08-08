'use strict';
/**
 * diagnose-chat-duplicate.js — 前端重复消息诊断工具
 *
 * 用途：chat 页「当前页面出现重复消息、刷新后消失」这类 bug 的系统性排查。
 * 方法：加载【真实】前端模块（chat-event-controller / chat-history-store /
 * chat-history-view），接到一个最小假 DOM 上，回放各种 WS 事件序列
 * （重连竞态、回放帧、nudge 重试、双击提交……），每个场景结束后扫描 DOM，
 * 判定是否出现了重复气泡。哪个场景 DUPLICATE，哪条代码路径就是嫌疑犯。
 *
 * 运行：node scripts/diagnose-chat-duplicate.js [--verbose]
 */

const path = require('path');
const PUBLIC = path.join(__dirname, '..', 'public');

/* ───────────────────────── 最小假 DOM ───────────────────────── */

let _uid = 0;
class El {
  constructor(tag) {
    this.tagName = (tag || 'div').toUpperCase();
    this._classSet = new Set();
    this.children = [];
    this.parent = null;
    this.dataset = {};
    this.style = {};
    this._text = '';
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this._uid = ++_uid;
    const self = this;
    this.classList = {
      add: (...cs) => cs.forEach(c => self._classSet.add(c)),
      remove: (...cs) => cs.forEach(c => self._classSet.delete(c)),
      contains: c => self._classSet.has(c),
      toggle: c => (self._classSet.has(c) ? self._classSet.delete(c) : self._classSet.add(c)),
    };
  }
  get className() { return [...this._classSet].join(' '); }
  set className(v) { this._classSet = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get textContent() {
    return this._text + this.children.map(c => c.textContent).join('');
  }
  set textContent(v) { this.children = []; this._text = String(v ?? ''); }
  set innerHTML(v) {
    // 诊断场景只关心文本等价性：剥标签当文本存（markdown 渲染的占位）。
    this.children = [];
    this._text = String(v ?? '').replace(/<[^>]*>/g, '');
  }
  get innerHTML() { return this._text; }
  appendChild(node) {
    if (node._isFragment) {
      const moved = [...node.children];
      node.children = [];
      moved.forEach(c => this.appendChild(c));
      return node;
    }
    if (node.parent) node.parent.children = node.parent.children.filter(c => c !== node);
    node.parent = this;
    this.children.push(node);
    return node;
  }
  insertBefore(node, ref) {
    if (node._isFragment) {
      const moved = [...node.children];
      node.children = [];
      moved.forEach(c => this.insertBefore(c, ref));
      return node;
    }
    if (node.parent) node.parent.children = node.parent.children.filter(c => c !== node);
    node.parent = this;
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i >= 0) this.children.splice(i, 0, node); else this.children.push(node);
    return node;
  }
  replaceChildren(...nodes) {
    this.children.forEach(c => { c.parent = null; });
    this.children = [];
    nodes.forEach(n => this.appendChild(n));
  }
  replaceWith(node) {
    if (!this.parent) return;
    const p = this.parent;
    const i = p.children.indexOf(this);
    p.children.splice(i, 1, node);
    node.parent = p;
    this.parent = null;
  }
  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter(c => c !== this);
    this.parent = null;
  }
  get firstElementChild() { return this.children[0] || null; }
  get lastElementChild() { return this.children[this.children.length - 1] || null; }
  get previousElementSibling() {
    if (!this.parent) return null;
    const i = this.parent.children.indexOf(this);
    return i > 0 ? this.parent.children[i - 1] : null;
  }
  _descendants(out = []) {
    for (const c of this.children) { out.push(c); c._descendants(out); }
    return out;
  }
  _matches(sel) {
    // 支持形如 .a.b / .a[data-x] / .a:not([data-x]) / [data-x] 的简单选择器
    const notMatch = sel.match(/:not\(\[data-([\w-]+)\]\)/);
    let base = sel.replace(/:not\(\[data-[\w-]+\]\)/, '');
    const attrMatch = base.match(/\[data-([\w-]+)\]/);
    if (attrMatch) base = base.replace(/\[data-[\w-]+\]/, '');
    const classes = base.split('.').filter(Boolean);
    if (classes.some(c => !this._classSet.has(c))) return false;
    const dataKey = k => k.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
    if (attrMatch && !this.dataset[dataKey(attrMatch[1])]) return false;
    if (notMatch && this.dataset[dataKey(notMatch[1])]) return false;
    return true;
  }
  querySelectorAll(sel) { return this._descendants().filter(d => d._matches(sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}
function createDocument() {
  return {
    createElement: tag => new El(tag),
    createDocumentFragment: () => { const f = new El('#fragment'); f._isFragment = true; return f; },
  };
}

/* ─────────────────────── 加载真实前端模块 ─────────────────────── */

global.window = undefined; // 强制模块走 module.exports 分支
global.document = createDocument();

const storeApi = require(path.join(PUBLIC, 'chat-history-store.js'));
const viewApi = require(path.join(PUBLIC, 'chat-history-view.js'));
const controllerApi = require(path.join(PUBLIC, 'chat-event-controller.js'));

/* ─────────────────────── 会话装配（复刻 chat.js 接线） ─────────────────────── */

function createRig(cli = 'claude') {
  const messagesEl = new El('div');
  messagesEl.className = 'messages';
  const state = {
    currentMsgEl: null,
    currentTextContent: '',
    currentToolCards: new Map(),
    isStreaming: false,
    currentCli: cli,
    roleTokens: { main: null, sub: null, subByProvider: [] },
    sessionTokens: { input: 0, output: 0 },
    liveStreamUsage: null,
    turnStartMs: 0,
    pendingCancel: false,
    lastUserBubble: null,
  };
  const historyStore = storeApi.createHistoryStore();
  const historyView = viewApi.createHistoryView({ messagesEl, document: global.document });
  const liveUi = {
    hideThinking() {}, showThinking() {},
    pushDanmaku() {}, attachUsageLine() {}, buildTimingLine() { return null; },
    fmtDuration: ms => `${ms}ms`,
    accumulateLiveUsage: (u, acc) => acc || u || null,
    renderAuxClassify() {}, classifyDisplay: () => ({}),
    reconcileDanmakuTasks() {}, settleTurnScopedDanmaku() {},
  };
  const host = {
    debug() {}, warn() {},
    maybeScrollToBottom() {}, forceScrollToBottom() {},
    startTitleAnimation() {}, stopTitleAnimation() {},
    updateUI() {}, updateContextBar() {}, refreshNotifyPreference() {},
    updateTabIdentity() {}, updateCwdDisplay() {}, applyCliUi() {},
    updateEffortBtn() {}, updateModelBtn() {}, applyCliSwitchState() {},
    loadSessionModel() {}, autoCommitIfNeeded() {}, rearmUnread() {},
    translate: (k) => k,
    addSystemMsg() {}, addAgentNotes() {}, showNotifyToast() {},
    renderSessionQueue() {}, renderPendingUserInput: () => false,
    consumeUserInputRequestId() {}, removeHistoryMessageById() {},
    resetHistoryPagination() {}, getSessionName: () => 'diag-session',
    speakNotify() {},
    addUserMessage(text, clientMsgId) {
      const div = new El('div');
      div.className = 'msg user';
      div.textContent = text;
      if (clientMsgId) div.dataset.clientMsgId = clientMsgId;
      messagesEl.appendChild(div);
      state.lastUserBubble = div;
    },
    // 与 chat.js renderCurrentText / applyHistoryPlan 等价：
    renderCurrentText(final = false) {
      return historyView.renderCurrentText(state.currentMsgEl, state.currentTextContent, {
        final, streaming: state.isStreaming,
      });
    },
    applyHistoryPlan(plan) {
      const viewPlan = historyView.applyPlan(plan, {
        currentElement: state.currentMsgEl,
        lastUserElement: state.lastUserBubble,
        currentText: state.currentTextContent || state.lastFinishedText,
      });
      state.currentMsgEl = viewPlan.currentElement;
      state.lastUserBubble = viewPlan.lastUserElement;
      if (viewPlan.streamingTail && viewPlan.streamingTail.element) {
        state.isStreaming = true;
        state.currentMsgEl = viewPlan.streamingTail.element;
        state.currentTextContent = viewPlan.streamingTail.content;
        state.currentToolCards = viewPlan.streamingTail.toolCards;
      } else if (!viewPlan.streamingTail) {
        // chat.js: 无 streamingTail 时清空直播状态
        if (!state.isStreaming) { /* keep */ }
      }
    },
  };
  const controller = controllerApi.createEventController({
    state, host, liveUi, historyStore, historyView,
  });
  const generation = controller.beginGeneration();
  return {
    state, messagesEl, historyView, historyStore, controller,
    feed(events) {
      for (const evt of events) controller.handleEvent(evt, generation);
    },
  };
}

/* ───────────────────────── 事件构造小工具 ───────────────────────── */

const msgStart = () => ({ type: 'stream_event', event: { type: 'message_start', message: {} } });
const delta = text => ({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
const result = () => ({ type: 'result', total_cost_usd: 0.001, usage: { input_tokens: 10, output_tokens: 5 } });
const assistantSnapshot = text => ({
  type: 'assistant',
  message: { textSnapshot: true, content: [{ type: 'text', text }] },
});
const assistantBlock = text => ({
  type: 'assistant',
  message: { content: [{ type: 'text', text }] },
});
const commit = (id, role, content, extra = {}) => ({
  type: 'chat_msg_meta',
  message: { id, role, content, ...extra },
});
const reconnectInit = isStreaming => ({
  type: 'system', subtype: 'init', is_streaming: isStreaming, session_id: 'diag-session', cli: 'claude',
});
const chatHistory = (messages, extra = {}) => ({ type: 'chat_history', messages, hasMore: false, ...extra });

/* ───────────────────────── 重复气泡扫描器 ───────────────────────── */

function scanDuplicates(messagesEl) {
  const bubbles = messagesEl.children
    .filter(c => c.classList.contains('msg'))
    .map(c => ({
      kind: c.classList.contains('assistant') ? 'assistant'
        : c.classList.contains('user') ? 'user' : 'system',
      text: (c.dataset.rawText || c.textContent || '').trim(),
      msgId: c.dataset.msgId || null,
      uid: c._uid,
    }))
    .filter(b => b.text);
  const findings = [];
  for (let i = 0; i < bubbles.length; i++) {
    for (let j = i + 1; j < bubbles.length; j++) {
      const a = bubbles[i], b = bubbles[j];
      if (a.kind !== 'assistant' || b.kind !== 'assistant') continue;
      if (a.text.length < 8) continue;
      if (a.text === b.text) {
        findings.push(`两个完全相同的 assistant 气泡（${a.text.length}字，msgId=${a.msgId}/${b.msgId}）：「${a.text.slice(0, 40)}…」`);
      } else if (a.text.length >= 16 && b.text.startsWith(a.text)) {
        findings.push(`相邻包含：气泡${i} 是气泡${j} 的前缀（${a.text.length} ⊂ ${b.text.length} 字）`);
      } else if (b.text.length >= 16 && a.text.startsWith(b.text)) {
        findings.push(`相邻包含：气泡${j} 是气泡${i} 的前缀（${b.text.length} ⊂ ${a.text.length} 字）`);
      }
    }
    // 单气泡内部自我重复（codex += 双倍）
    const t = bubbles[i].text;
    if (bubbles[i].kind === 'assistant' && t.length >= 32 && t.length % 2 === 0) {
      const half = t.length / 2;
      if (t.slice(0, half) === t.slice(half)) {
        findings.push(`单个气泡内容自我重复（${half}+${half} 字）：「${t.slice(0, 40)}…」`);
      }
    }
  }
  return { findings, bubbles };
}

/* ───────────────────────────── 场景集 ───────────────────────────── */

const T1 = '好的，我来修复 fleet 展开卡片的几何问题。先看一下 main_shell 的现状。';
const T2 = '修复完成：面板改为从底部上弹，支持下拉坠落消失。commit 98ab038。';

const SCENARIOS = [
  {
    name: 'S1 基线：claude 正常流式一轮',
    cli: 'claude',
    events: () => [msgStart(), delta(T1.slice(0, 20)), delta(T1.slice(20)), result()],
    expect: 'CLEAN',
  },
  {
    name: 'S2 result 之后又收到 assistant 全量快照（迟到/回放帧）',
    cli: 'claude',
    events: () => [msgStart(), delta(T1), result(), assistantSnapshot(T1)],
    expect: 'UNKNOWN',
  },
  {
    name: 'S3 流式中途 WS 重连（无 id 流式尾巴 → 重放 → result → commit）',
    cli: 'claude',
    events: () => [
      msgStart(), delta(T1.slice(0, 20)),
      reconnectInit(true),
      chatHistory([
        { id: 'u1', role: 'user', content: '修一下 fleet 卡片' },
        { role: 'assistant', content: T1.slice(0, 20), streaming: true },
      ]),
      delta(T1.slice(20)), result(),
      commit('a1', 'assistant', T1),
    ],
    expect: 'UNKNOWN',
  },
  {
    name: 'S4 result 后、commit 前 WS 重连（历史页含已完成 assistant，本地气泡无 id）',
    cli: 'claude',
    events: () => [
      msgStart(), delta(T1), result(),
      reconnectInit(false),
      chatHistory([
        { id: 'u1', role: 'user', content: '修一下 fleet 卡片' },
        { id: 'a1', role: 'assistant', content: T1 },
      ]),
      commit('a1', 'assistant', T1),
    ],
    expect: 'UNKNOWN',
  },
  {
    name: 'S5 codex 同一 assistant 帧被投递两次（WS 重复帧）',
    cli: 'codex',
    events: () => [
      { type: 'system', subtype: 'init', is_streaming: true, session_id: 'diag', cli: 'codex' },
      assistantBlock(T1), assistantBlock(T1), result(),
    ],
    expect: 'UNKNOWN',
  },
  {
    name: 'S6 🔇 nudge 重试：同内容回答两次（commit 去重守卫路径）',
    cli: 'claude',
    events: () => [
      msgStart(), delta(T1), result(), commit('a1', 'assistant', T1),
      { type: 'session_queue', event: 'queued', queued: false, message: '🔇刚才因 API 异常中断，回答可能不完整，请从中断处继续。', clientMsgId: 'c-nudge' },
      msgStart(), delta(T1), result(), commit('a2', 'assistant', T1),
    ],
    expect: 'UNKNOWN',
  },
  {
    name: 'S7 重连后流式尾巴带 interim id，最终 commit 换正式 id',
    cli: 'claude',
    events: () => [
      msgStart(), delta(T1.slice(0, 20)),
      reconnectInit(true),
      chatHistory([
        { id: 'u1', role: 'user', content: '修一下 fleet 卡片' },
        { id: 'interim-1', role: 'assistant', content: T1.slice(0, 20), streaming: true },
      ]),
      delta(T1.slice(20)), result(),
      commit('a-final', 'assistant', T1),
    ],
    expect: 'UNKNOWN',
  },
  {
    name: 'S8 用户气泡：本地即时渲染 + commit + 重连历史页（三连）',
    cli: 'claude',
    events: (rig) => [
      { type: 'session_queue', event: 'queued', queued: false, message: '继续', clientMsgId: 'c1' },
      commit('u1', 'user', '继续', { clientMsgId: 'c1' }),
      reconnectInit(false),
      chatHistory([
        { id: 'u1', role: 'user', content: '继续' },
        { id: 'a1', role: 'assistant', content: T2 },
      ]),
    ],
    expect: 'UNKNOWN',
  },
];


module.exports = { createRig, scanDuplicates, SCENARIOS, helpers: { msgStart, delta, result, assistantSnapshot, assistantBlock, commit, reconnectInit, chatHistory } };
