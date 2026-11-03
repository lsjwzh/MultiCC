'use strict';

// Live output speed of the turn that is streaming right now — the chip under
// the composer that answers "is the reply still moving, or is it stuck?".
//
// The exact output count only arrives once per API request (message_delta), so
// a live rate has to be measured off what actually streams in: answer text,
// reasoning and tool-call arguments. That is estimated (CJK ≈ 1 token per
// character, everything else ≈ 4 characters per token) and labelled as such;
// the per-request exact figure, when the lane reports one, goes in the tooltip.
//
// Silence is only alarming when nothing explains it. A running tool, an open
// thinking block, a background task still working or a request still waiting
// for its first token are all quiet for a reason, so each gets its own neutral
// state; only unexplained silence (or output that stopped mid-stream) turns
// amber, then red.
(function attachChatTokenRate(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MultiCCChatTokenRate = api;
})(typeof window !== 'undefined' ? window : globalThis, function createApi() {
  // 数字格式的唯一来源（shared/format.js，页面里先于本文件加载）。Node 侧的沙箱里
  // 没有页面全局，也没有 require，所以三种取法都留着。
  const FMT = (typeof window !== 'undefined' && window.MultiCCFormat)
    || (typeof globalThis !== 'undefined' && globalThis.MultiCCFormat)
    || (typeof require === 'function' ? require('./shared/format.js') : null);

  // 文案走 i18n：浏览器里用 i18n.js 的 t()，Node 测试里回落到中文默认值。
  function tt(key, fallback, params) {
    const scope = typeof window !== 'undefined' ? window : null;
    const out = scope && typeof scope.t === 'function' ? scope.t(key, params) : '';
    if (out && out !== key) return out;
    return Object.keys(params || {}).reduce((text, name) => (
      text.split(`{${name}}`).join(String(params[name]))
    ), fallback);
  }

  const WINDOW_MS = 3000;
  // One observation this large is a reconnect or replay restoring the reply in
  // one go, not tokens generated in that instant — it re-anchors, never counts.
  const RESYNC_TOKENS = 2000;
  // [amber, red] in ms. A first token can legitimately take a while on a large
  // context; output that stops mid-stream is suspicious much sooner.
  const WAITING_MS = Object.freeze([30000, 90000]);
  const PAUSED_MS = Object.freeze([10000, 45000]);

  const WIDE = /[⺀-鿿가-힯豈-﫿＀-￯]/g;

  /** Rough token count of a streamed fragment; fractional on purpose. */
  function estimateTokens(text) {
    const value = typeof text === 'string' ? text : '';
    if (!value) return 0;
    const wide = (value.match(WIDE) || []).length;
    return wide + (value.length - wide) / 4;
  }

  function createTokenRateMeter(options) {
    const now = (options && typeof options.now === 'function') ? options.now : () => Date.now();
    let active = false;
    let beganAt = 0;
    let samples = [];
    let total = 0;
    let firstAt = 0;
    let lastAt = 0;
    let textMark = 0;
    let block = null;
    let blockAt = 0;
    let requestAt = 0;
    let exact = null;

    function prune(t) {
      while (samples.length && t - samples[0].t > WINDOW_MS) samples.shift();
    }
    function add(tokens) {
      if (!active || !(tokens > 0) || tokens > RESYNC_TOKENS) return;
      const t = now();
      samples.push({ t, n: tokens });
      total += tokens;
      if (!firstAt) firstAt = t;
      lastAt = t;
      prune(t);
    }

    return Object.freeze({
      /** Turn started. `textLength` is what the bubble already shows (reconnect). */
      begin(textLength) {
        active = true;
        beganAt = now();
        samples = [];
        total = 0;
        firstAt = 0;
        lastAt = 0;
        textMark = Math.max(0, Number(textLength) || 0);
        block = null;
        requestAt = 0;
        exact = null;
      },
      end() { active = false; samples = []; },
      isActive: () => active,
      /**
       * The visible reply buffer, read where the bubble renders it. Only its
       * growth counts, so a delta and the authoritative snapshot that repeats
       * it are not counted twice; a shrink (new bubble) just re-anchors.
       */
      noteText(text) {
        if (!active) return;
        const value = typeof text === 'string' ? text : '';
        if (value.length > textMark) add(estimateTokens(value.slice(textMark)));
        textMark = value.length;
      },
      /** Reasoning or tool-argument fragments, which never reach the text buffer. */
      noteChunk(text) { if (active) add(estimateTokens(text)); },
      /** An API request started streaming (message_start). */
      noteRequest() { if (active) requestAt = now(); },
      /** A content block opened ('thinking' / other) or closed (null). */
      noteBlock(kind) {
        if (!active) return;
        block = kind || null;
        blockAt = now();
      },
      /** The request's exact output count (message_delta) — the tooltip's figure. */
      noteUsage(outputTokens) {
        if (!active || !requestAt) return;
        const tokens = Number(outputTokens);
        const ms = now() - requestAt;
        if (Number.isFinite(tokens) && tokens > 0 && ms >= 500) {
          exact = { tokens, ms, rate: tokens / (ms / 1000) };
        }
        requestAt = 0;
      },
      /**
       * @param {{toolRunning?:boolean, toolSince?:number, toolEndedAt?:number, bgRunning?:boolean}} context
       *   the host's view of tool cards: whether one is still running, when the
       *   newest running one started, when the latest finished one ended; and
       *   whether background tasks (monitor / background Bash) are still going.
       */
      snapshot(context) {
        const ctx = context || {};
        const t = now();
        prune(t);
        const base = { active, total, exact, ttftMs: firstAt && beganAt ? firstAt - beganAt : null };
        if (!active) return { ...base, phase: 'idle', rate: 0, phaseMs: 0, tone: 'idle' };
        if (samples.length) {
          const windowTokens = samples.reduce((sum, sample) => sum + sample.n, 0);
          // A burst younger than the window is measured over its own age, so
          // the first second of output does not read as a third of its speed.
          const span = Math.min(WINDOW_MS, Math.max(1000, t - samples[0].t));
          return { ...base, phase: 'flowing', rate: windowTokens / (span / 1000), phaseMs: 0, tone: 'flowing' };
        }
        if (ctx.toolRunning) {
          return { ...base, phase: 'tool', rate: 0, phaseMs: t - Math.max(Number(ctx.toolSince) || 0, lastAt, beganAt), tone: 'busy' };
        }
        if (block === 'thinking') {
          return { ...base, phase: 'thinking', rate: 0, phaseMs: t - Math.max(blockAt, lastAt), tone: 'busy' };
        }
        const segmentAt = Math.max(beganAt, Number(ctx.toolEndedAt) || 0);
        // Background tasks explain the quiet the same way a foreground tool
        // does: the AI request is idle on purpose, so never escalate to amber.
        if (ctx.bgRunning) {
          return { ...base, phase: 'bg', rate: 0, phaseMs: t - Math.max(lastAt, segmentAt), tone: 'busy' };
        }
        const waiting = lastAt < segmentAt;
        const phaseMs = t - (waiting ? segmentAt : lastAt);
        const limits = waiting ? WAITING_MS : PAUSED_MS;
        const tone = phaseMs >= limits[1] ? 'danger' : phaseMs >= limits[0] ? 'warning' : 'idle';
        return { ...base, phase: waiting ? 'waiting' : 'paused', rate: 0, phaseMs, tone };
      },
    });
  }

  function rateNumber(rate) {
    const value = Number(rate) || 0;
    return value >= 10 ? String(Math.round(value)) : value.toFixed(1);
  }

  /** Snapshot → { text, tone, title } for the chip. Empty text hides it. */
  function describe(snapshot) {
    const snap = snapshot || {};
    if (!snap.active) return { text: '', tone: 'idle', title: '' };
    const dur = FMT.formatDuration(snap.phaseMs);
    let text;
    switch (snap.phase) {
      case 'flowing': text = tt('tokenRateFlowing', '⚡ {rate} tok/s', { rate: rateNumber(snap.rate) }); break;
      case 'tool': text = tt('tokenRateTool', '🔧 工具运行 {dur}', { dur }); break;
      case 'thinking': text = tt('tokenRateThinking', '💭 思考中 {dur}', { dur }); break;
      case 'waiting': text = tt('tokenRateWaiting', '⏳ 等待响应 {dur}', { dur }); break;
      case 'bg': text = tt('tokenRateBg', '⏸ AI 请求已停 {dur} · 后台任务执行中', { dur }); break;
      default: text = tt('tokenRatePaused', '⏸ 0 tok/s · AI 请求已停 {dur}', { dur }); break;
    }
    const lines = [tt('tokenRateTitle', '实时输出速度（按流式文本估算，近 3 秒）')];
    if (snap.total > 0) {
      lines.push(tt('tokenRateTitleTotal', '本轮已输出 ≈{total} tokens', { total: FMT.formatTokenCount(Math.round(snap.total)) }));
    }
    if (snap.ttftMs != null && snap.ttftMs >= 0) {
      lines.push(tt('tokenRateTitleFirst', '首字耗时 {dur}', { dur: FMT.formatDuration(snap.ttftMs) }));
    }
    if (snap.exact) {
      lines.push(tt('tokenRateTitleExact', '上个请求实测 {rate} tok/s（{tokens} tokens / {dur}）', {
        rate: rateNumber(snap.exact.rate),
        tokens: FMT.formatTokenCount(snap.exact.tokens),
        dur: FMT.formatDuration(snap.exact.ms),
      }));
    }
    return { text, tone: snap.tone || 'idle', title: lines.join('\n') };
  }

  return Object.freeze({
    WINDOW_MS, RESYNC_TOKENS, WAITING_MS, PAUSED_MS,
    estimateTokens, createTokenRateMeter, describe,
  });
});
