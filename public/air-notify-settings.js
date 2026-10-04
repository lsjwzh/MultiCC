'use strict';

// 品牌行的「通知与播报」面板 —— 语音播报 / 任务提醒 / 系统推送 / 推送通道的唯一入口。
//
// 之前这些设置散在三处：air:notify-voice（Air 任务提醒要不要念，布尔）、聊天帧自己的
// 朗读、控制台推送页里的订阅开关。现在：
//   · 语音播报三档（off / away / always）与任务提醒开关写在 shared/notify-prefs.js
//     的统一 key 里，air-task-notify.js 和 chat-notifications.js 读同一份 —— 这里只是
//     面板，不是真相的第二个存放处；
//   · 系统推送的订阅状态仍然只从 pwa.js 现读（getPushInfo），开关也只调 pwa.js 的
//     togglePush()（air-push.js 的口径纪律：只有它会申请权限、向服务端登记订阅）；
//   · Bark / Webhook 不在这页配（服务端设置，值还是掩码回显），给两个跳转去
//     控制台的推送面板（/air?view=push，air-push.js）。
//
// 自初始化，同 air-cli-update.js：浮层锚在品牌行那颗 M 猫图标下方，结构照抄它的
// 开合规矩（外点 / Esc / 侧栏滚动即收，浮层自己滚动不算）。
(function initAirNotifySettings(root) {
  if (!root || !root.document) return;
  const document = root.document;
  const el = id => document.getElementById(id);

  function prefs() { return root.MultiCCNotifyPrefs || null; }

  // ── 语音播报试听：一句和正式播报同款的话，念给正在调档的人听 ───────────
  function previewVoice() {
    if (!root.speechSynthesis || typeof root.SpeechSynthesisUtterance !== 'function') return;
    try {
      const utterance = new root.SpeechSynthesisUtterance(t('airNotifyTestSpoken'));
      utterance.lang = (typeof root.getLang === 'function' && root.getLang() === 'zh') ? 'zh-CN' : 'en-US';
      utterance.rate = 1.1;
      utterance.volume = 0.75;
      root.speechSynthesis.cancel();
      root.speechSynthesis.speak(utterance);
    } catch (_) { /* 无语音库 → 静默，档位仍然保存 */ }
  }

  // ── 行构造 ─────────────────────────────────────────────────────────────
  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function row(labelKey, hintNode) {
    const box = make('div', 'notify-row');
    const name = make('span', 'notify-row-name');
    name.append(make('strong', null, t(labelKey)));
    if (hintNode) name.append(hintNode);
    box.append(name);
    return { box, name };
  }

  // 开关：role="switch" 的按钮，样式在 air.css（.notify-switch）。
  function switchButton(labelKey, checked, onToggle) {
    const button = make('button', 'notify-switch');
    button.type = 'button';
    button.role = 'switch';
    button.setAttribute('aria-label', t(labelKey));
    button.setAttribute('aria-checked', checked ? 'true' : 'false');
    button.onclick = () => onToggle(button.getAttribute('aria-checked') !== 'true');
    return button;
  }

  // ── 各行 ───────────────────────────────────────────────────────────────
  // ① 语音播报：三档分段钮（复用任务排序那套 .task-sort-switch 的形制）+ 试听。
  function buildVoiceRow() {
    const hint = make('small', 'notify-row-hint', t('airNotifyVoiceHint'));
    const { box, name } = row('airNotifyVoiceLabel', hint);
    const side = make('div', 'notify-row-side');
    const seg = make('div', 'task-sort-switch notify-voice-seg');
    const options = [
      ['off', 'airNotifyVoiceOff'],
      ['away', 'airNotifyVoiceAway'],
      ['always', 'airNotifyVoiceAlways'],
    ];
    const buttons = options.map(([mode, key]) => {
      const button = make('button', null, t(key));
      button.type = 'button';
      button.onclick = () => { prefs()?.setVoice(mode); render(); };
      seg.append(button);
      return [mode, button];
    });
    const test = make('button', 'notify-test', '🔊 ' + t('airNotifyVoiceTest'));
    test.type = 'button';
    test.title = t('airNotifyVoiceTest');
    test.onclick = previewVoice;
    side.append(seg, test);
    box.append(side);
    return { box, name, buttons };
  }

  // ② 任务提醒：提示音与提醒卡片。卡片/提示音都关掉时侧栏的未读高亮仍在 ——
  //    那是服务端 attention 的镜像（air-task-notify.js 的口径），不是提醒器。
  function buildRemindRow() {
    const hint = make('small', 'notify-row-hint', t('airNotifyRemindHint'));
    const { box } = row('airNotifyRemindLabel', hint);
    const toggle = switchButton('airNotifyRemindLabel', true, on => {
      prefs()?.setRemind(on);
      render();
    });
    box.append(toggle);
    return { box, toggle };
  }

  // ③ 系统推送：状态只从 pwa.js 现读；权限被浏览器拒掉时开关置灰，只留去设置
  //    的提示（权限要自己去浏览器的站点设置里开，页面里再点也没用）。
  function pushState() {
    const info = typeof root.getPushInfo === 'function' ? root.getPushInfo() : null;
    return {
      supported: !!info && info.permission !== 'unsupported',
      subscribed: !!(info && info.subscribed),
      denied: !!info && info.permission === 'denied',
    };
  }

  function buildPushRow() {
    const state = pushState();
    const hintText = !state.supported ? t('airNotifyPushUnsupported')
      : state.denied ? t('airNotifyPushDenied')
      : state.subscribed ? t('airNotifyPushHintOn') : t('airNotifyPushHintOff');
    const hint = make('small', 'notify-row-hint', hintText);
    const { box } = row('airNotifyPushLabel', hint);
    const toggle = switchButton('airNotifyPushLabel', state.subscribed, async on => {
      toggle.disabled = true;
      try {
        if (on && typeof root.ensurePushSubscribed === 'function') await root.ensurePushSubscribed();
        else if (!on && typeof root.unsubscribePush === 'function') await root.unsubscribePush();
      } finally {
        toggle.disabled = false;
        render();
      }
    });
    if (!state.supported || state.denied) toggle.disabled = true;
    box.append(toggle);
    return { box, toggle };
  }

  // ④ 推送通道：Bark / Webhook 配在控制台的推送面板（/air?view=push），这里只
  //    给入口，不在这页再写一份表单（那会有两处保存逻辑、两处掩码口径）。
  function buildChannelsRow() {
    const hint = make('small', 'notify-row-hint', t('airNotifyChannelHint'));
    const { box } = row('airNotifyChannelLabel', hint);
    const side = make('div', 'notify-row-side');
    for (const key of ['airNotifyChannelBark', 'airNotifyChannelWebhook']) {
      const button = make('button', 'notify-channel', t(key));
      button.type = 'button';
      button.onclick = () => { close(); root.location.assign('/air?view=push'); };
      side.append(button);
    }
    box.append(side);
    return { box };
  }

  // ── 渲染 ───────────────────────────────────────────────────────────────
  function render() {
    const host = el('notify-pop-rows');
    if (!host) return;
    const p = prefs();
    const voice = p ? p.getVoice() : 'away';
    const remind = p ? p.remindEnabled() : true;

    host.replaceChildren();
    const voiceRow = buildVoiceRow();
    for (const [mode, button] of voiceRow.buttons) {
      button.setAttribute('aria-pressed', mode === voice ? 'true' : 'false');
    }
    const remindRow = buildRemindRow();
    remindRow.toggle.setAttribute('aria-checked', remind ? 'true' : 'false');
    host.append(voiceRow.box, remindRow.box, buildPushRow().box, buildChannelsRow().box);

    // 全关时入口图标褪色：平时那颗 M 猫就是「通知都在岗」的样子。
    const entry = el('notify-entry-btn');
    if (entry) entry.classList.toggle('is-muted', voice === 'off' && !remind);
  }

  // ── 开合（照 air-cli-update.js 的规矩） ────────────────────────────────
  let opened = false;
  function place() {
    const panel = el('notify-pop');
    const anchor = el('notify-entry-btn');
    if (!panel || !anchor) return;
    const rect = anchor.getBoundingClientRect();
    const width = panel.offsetWidth || 300;
    const viewport = Number(root.innerWidth) || 0;
    const left = viewport ? Math.min(Math.max(8, rect.right - width), Math.max(8, viewport - width - 8)) : 8;
    panel.style.top = `${Math.round(rect.bottom + 8)}px`;
    panel.style.left = `${Math.round(left)}px`;
  }

  function onKey(event) {
    if (event.key === 'Escape') { event.preventDefault(); close(); }
  }
  function onOutside(event) {
    const panel = el('notify-pop');
    const button = el('notify-entry-btn');
    if (!panel || panel.hidden) return;
    if (panel.contains(event.target) || (button && button.contains(event.target))) return;
    close();
  }
  // 侧栏滚动时浮层不跟锚点走，一滚就收；滚浮层自己是在读内容，不算离开。
  function onScroll(event) {
    const panel = el('notify-pop');
    const target = event.target;
    if (panel && target && (target === panel || panel.contains(target))) return;
    close();
  }

  function close() {
    const panel = el('notify-pop');
    const button = el('notify-entry-btn');
    if (!panel || panel.hidden) return;
    panel.hidden = true;
    opened = false;
    if (button) button.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
    root.removeEventListener('resize', close);
    root.removeEventListener('scroll', onScroll, true);
  }

  function open() {
    const panel = el('notify-pop');
    const button = el('notify-entry-btn');
    if (!panel || !button) return;
    panel.hidden = false;
    opened = true;
    button.setAttribute('aria-expanded', 'true');
    render();
    place();   // 量宽度要在显示之后：hidden 的元素 offsetWidth 是 0
    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('keydown', onKey, true);
    root.addEventListener('resize', close);
    root.addEventListener('scroll', onScroll, true);
  }

  // ── 接线 ───────────────────────────────────────────────────────────────
  function initialize() {
    const button = el('notify-entry-btn');
    if (!button) return; // 不在 Air 外壳上
    button.onclick = () => { if (opened) close(); else open(); };
    const closeButton = el('notify-pop-close');
    if (closeButton) closeButton.onclick = () => close();
    // 偏好在别处改了（聊天帧、另一个标签页）也要跟上：storage 事件跨文档，
    // 同文档的自定义事件由 notify-prefs.js 派发。
    prefs()?.onChange(() => { render(); });
    // 订阅状态由 pwa.js 广播（申请权限是异步的，按钮点完它才回来）。
    root.addEventListener('multicc-push-state', () => { if (opened) render(); });
    render();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize);
  } else {
    initialize();
  }
})(typeof window !== 'undefined' ? window : null);
