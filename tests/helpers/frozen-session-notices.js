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
function stuckDeliveryText({ reason = 'session_busy', reasons = [], waitedMs = 0 } = {}) {
  const list = reasons.length ? reasons.join('、') : reason;
  const cause = reason === 'delivery_locked'
    ? `上一条投递尚未结算（${list}）`
    : `工作区被占用（${list}）`;
  return `⏳ 这条消息等了 ${formatWait(waitedMs)}还没能开始：${cause}，`
    + '而且当前没有轮次在跑。在聊天队列里点「立刻插入」可以强制释放并马上执行这条；'
    + '不想等也可以先取消占用它的后台任务。';
}

// A held turn is not a wedged workspace: the turn is running by design (the
// user's rule — background work is part of the turn), and the message will be
// executed as soon as that work ends. Saying "no turn is running" here would be
// false, so this notice names the real owner of the wait.
function heldBackgroundText({ waitedMs = 0 } = {}) {
  return `⏳ 这条消息等了 ${formatWait(waitedMs)}还没能开始：本轮的回复已经给出，但本轮的`
    + '后台任务（Agent / 后台命令 / Monitor）还没结束，回合会一直保持到它们结束。'
    + '后台任务结束后这条会自动执行；想马上开始，可以在聊天队列里点「立刻插入」'
    + '（会先结束本轮并停掉这些后台任务）。';
}

// The hold cap is visibility, not release (L2): a turn whose background work
// runs abnormally long must say so out loud instead of staying open silently.
// Rust fires this exactly once per held turn; the turn itself stays open.
function heldCapText({ minutes = 0 } = {}) {
  const span = Number(minutes) >= 1 ? `${Math.round(Number(minutes))} 分钟` : '一段时间';
  return `⏱ 本轮的后台任务（Agent / 后台命令 / Monitor）已经跑了 ${span}，`
    + '回合会继续保持开启，直到它们结束（后台工作属于本轮，回复已给出不等于本轮结束）。'
    + '想马上结束本轮，可以在聊天队列里点「立刻插入」或停止本轮（会同时停掉这些后台任务）。';
}

function createSessionNotices({ appendChatMessage, chatBroadcast, now = Date.now, logger = console }) {
  function warn(event, fields) {
    try { logger?.warn?.(event, fields); } catch (_) {}
  }

  // A notice is a live broadcast on top of a durable append. Neither side may
  // reject through the caller: most call sites fire this without awaiting it
  // (a stuck-delivery notice sits inside a synchronous try/catch), so an
  // unhandled rejection here would take the whole server down.
  function broadcastNotice(sessionId, text) {
    try {
      chatBroadcast?.(sessionId, { type: 'system', subtype: 'notice', message: text });
    } catch (error) {
      warn('chat_notice_broadcast_failed', {
        sessionId,
        message: error && error.message ? error.message : String(error),
      });
    }
  }

  // Persist first: a live broadcast that no client happened to receive is the
  // same silence this exists to end, and the append is what a reload shows.
  // The returned promise always resolves (true = durable and broadcast;
  // false = the line did not land) so a fire-and-forget caller is safe.
  function say(sessionId, text) {
    if (!sessionId || typeof appendChatMessage !== 'function') return undefined;
    let saved;
    try {
      saved = appendChatMessage(sessionId, { role: 'system', content: text, ts: now() });
    } catch (error) {
      warn('chat_notice_persist_failed', {
        sessionId,
        message: error && error.message ? error.message : String(error),
      });
      return false;
    }
    if (saved && typeof saved.then === 'function') {
      return Promise.resolve(saved).then(ok => {
        if (!ok) return false;
        broadcastNotice(sessionId, text);
        return true;
      }, error => {
        warn('chat_notice_persist_failed', {
          sessionId,
          message: error && error.message ? error.message : String(error),
        });
        return false;
      });
    }
    if (!saved) return false;
    broadcastNotice(sessionId, text);
    return true;
  }
  return {
    notifyLostMessage({ sessionId, error }) { return say(sessionId, lostMessageText(error)); },
    notifyStuckDelivery({ sessionId, reason, reasons, waitedMs, heldForBackground = false }) {
      return say(sessionId, heldForBackground
        ? heldBackgroundText({ waitedMs })
        : stuckDeliveryText({ reason, reasons, waitedMs }));
    },
    notifyHoldCap({ sessionId, minutes }) { return say(sessionId, heldCapText({ minutes })); },
  };
}

module.exports = {
  createSessionNotices, lostMessageText, stuckDeliveryText, heldBackgroundText, heldCapText,
};
