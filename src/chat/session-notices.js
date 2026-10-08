'use strict';

// ── Session notices ──────────────────────────────────────────────────────────
//
// Two ways a message a human typed can fail to reach its session, and both used
// to be invisible: the delivery never arrives (`lastError` plus a log line), or
// it never even starts (a `delivery_skipped` log line, over and over). That is
// the "任务永久卡在 queued，无任何 UI 提示" report. The transport layer
// (src/orchestration/runtime.js) is the only place that knows which of the two
// just happened, and the transcript is where the human typed the message — so
// that is where it is said.
//
// Written as a system line — the same shape a task.interrupted notice uses — so
// it survives a reload, and broadcast so whoever is watching right now sees it
// without refreshing. The wording lives here rather than at the wiring site so
// the host only has to hand over the two chat ports.

function lostMessageText(error) {
  const code = error?.code || 'delivery_failed';
  // `detail` is the full remedy — the macOS privacy steps, the Command Line
  // Tools install line — and the transcript is where the human is, so it is
  // shown whole. `message` is only the first line of it (that is what lastError
  // and the queue API return verbatim), so it is the fallback, not the choice.
  const detail = String(error?.detail || '').trim();
  const reason = detail || String(error?.message || '').split('\n')[0] || code;
  return `🚫 这条消息没能送达（${code}）：${reason}\n修好后请重新发送。`;
}

function formatWait(ms) {
  const minutes = Math.round(Number(ms || 0) / 60_000);
  return minutes >= 1 ? `${minutes} 分钟` : '一会儿';
}

// The remedy has to be something the user can actually do from where they are:
// the chat queue's own insert button (「立刻插入」) force-releases the hold, and
// it is the manual escape the workspace layer deliberately refuses to take on
// its own. `reasons` is the busy-reason vocabulary, so it stays a code here
// rather than prose — the same codes the log and the insert-now response carry.
function stuckDeliveryText({ reasons = [], waitedMs = 0 } = {}) {
  const list = reasons.length ? reasons.join('、') : 'workspace_occupied';
  return `⏳ 这条消息等了 ${formatWait(waitedMs)}还没能开始：工作区被占用（${list}），`
    + '而且当前没有轮次在跑。在聊天队列里点「立刻插入」可以强制释放并马上执行这条；'
    + '不想等也可以先取消占用它的后台任务。';
}

function createSessionNotices({ appendChatMessage, chatBroadcast, now = Date.now }) {
  // Persist first: a live broadcast that no client happened to receive is the
  // same silence this exists to end, and the append is what a reload shows.
  function say(sessionId, text) {
    if (!sessionId || typeof appendChatMessage !== 'function') return;
    if (!appendChatMessage(sessionId, { role: 'system', content: text, ts: now() })) return;
    chatBroadcast?.(sessionId, { type: 'system', subtype: 'notice', message: text });
  }
  return {
    notifyLostMessage({ sessionId, error }) { say(sessionId, lostMessageText(error)); },
    notifyStuckDelivery({ sessionId, reasons, waitedMs }) {
      say(sessionId, stuckDeliveryText({ reasons, waitedMs }));
    },
  };
}

module.exports = { createSessionNotices, lostMessageText, stuckDeliveryText };
