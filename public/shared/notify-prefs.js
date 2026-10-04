'use strict';

// 通知与播报的统一偏好 —— 只此一份，Air 外壳和聊天帧（chat.html 的 iframe）共用。
//
// 之前同样的意思散在三处 key 里：air:notify-voice（Air 的任务提醒，布尔）、
// voiceOutputEnabled（chat.js 的朗读回复）、multicc_notify:<sessionId>（聊天帧按会话
// 的任务提醒）。这里不收编最后一类（按会话开关仍然有意义），只把「全局要不要出声」
// 收成一个三档开关 + 一个提醒开关，聊天帧和 Air 读同一份：
//
//   multicc:notify:voice   'off' | 'away' | 'always'   朗读那一句话
//     off    什么都不念；
//     away   只有人不在（标签页隐藏，或可见但 5 分钟没输入，见 shared/user-presence.js）
//            才念 —— 这是引入本模块之前的默认行为；
//     always 不管在不在都念。
//   multicc:notify:remind  '1' | '0'                   提示音与提醒卡片
//
// 旧 key（air:notify-voice 的 '0'/'1'）在第一次读取时迁移：'1' → away，'0' → off，
// 迁移完删掉，不留第二个真相。Web 推送的订阅状态不在这里：它活在 pwa.js 的模块
// 变量和浏览器的 PushManager 里，面板只现读 pwa.js（见 air-push.js 的口径纪律）。
//
// 同源的两个文档（外壳 / iframe）共享 localStorage；本文档改完派发
// multicc-notify-prefs，别的文档靠 storage 事件，两个都要听 —— onChange 把它们
// 合成一个订阅。
(function installNotifyPrefs(root) {
  const LS_VOICE = 'multicc:notify:voice';
  const LS_REMIND = 'multicc:notify:remind';
  const LEGACY_VOICE = 'air:notify-voice';
  const MODES = ['off', 'away', 'always'];
  const DEFAULT_VOICE = 'away';   // 迁移前的行为：只在离开时朗读

  function storage() {
    try { return root.localStorage; } catch (_) { return null; }
  }

  // 幂等：新 key 已有值就什么都不动，所以每帧各自跑一遍也没有竞态。
  let migrated = false;
  function migrate() {
    if (migrated) return;
    migrated = true;
    const s = storage();
    if (!s) return;
    try {
      if (s.getItem(LS_VOICE) == null) {
        const old = s.getItem(LEGACY_VOICE);
        if (old != null) {
          s.setItem(LS_VOICE, old === '0' ? 'off' : DEFAULT_VOICE);
          s.removeItem(LEGACY_VOICE);
        }
      }
    } catch (_) { /* quota / 隐私模式 → 保持默认 */ }
  }

  function announce() {
    try { root.dispatchEvent(new Event('multicc-notify-prefs')); } catch (_) {}
  }

  function getVoice() {
    migrate();
    const s = storage();
    if (!s) return DEFAULT_VOICE;
    const value = s.getItem(LS_VOICE);
    return MODES.indexOf(value) >= 0 ? value : DEFAULT_VOICE;
  }

  function setVoice(mode) {
    if (MODES.indexOf(mode) < 0) return;
    const s = storage();
    if (!s) return;
    try { s.setItem(LS_VOICE, mode); } catch (_) { return; }
    announce();
  }

  function remindEnabled() {
    const s = storage();
    if (!s) return true;
    return s.getItem(LS_REMIND) !== '0';
  }

  function setRemind(on) {
    const s = storage();
    if (!s) return;
    try { s.setItem(LS_REMIND, on ? '1' : '0'); } catch (_) { return; }
    announce();
  }

  // 出声判定只此一处：air-task-notify.js 的批处理和 chat-notifications.js 的
  // speak() 都拿同一个答案，两个页面不可能一个念一个不念。
  function shouldSpeak(away) {
    const mode = getVoice();
    return mode === 'always' || (mode === 'away' && !!away);
  }

  function onChange(callback) {
    if (typeof callback !== 'function') return () => {};
    root.addEventListener('storage', callback);
    root.addEventListener('multicc-notify-prefs', callback);
    return () => {
      root.removeEventListener('storage', callback);
      root.removeEventListener('multicc-notify-prefs', callback);
    };
  }

  root.MultiCCNotifyPrefs = Object.freeze({
    MODES,
    getVoice,
    setVoice,
    remindEnabled,
    setRemind,
    shouldSpeak,
    onChange,
    __resetForTest() {
      migrated = false;
      const s = storage();
      if (!s) return;
      try { s.removeItem(LS_VOICE); s.removeItem(LS_REMIND); s.removeItem(LEGACY_VOICE); } catch (_) {}
    },
  });
})(typeof window !== 'undefined' ? window : globalThis);
