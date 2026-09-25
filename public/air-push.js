'use strict';

// Air 原生「推送通知」面板 —— 从旧 manage 页的推送那一格搬过来（原生 DOM，不嵌旧 manage 页）。
// 三块：① 本机浏览器的订阅状态 ② 服务端投递健康度 ③ 备用通道（Bark / Webhook）。
// 后端契约：GET /api/push/health、GET|POST /api/settings/notify（src/routes/host-read.js 的
// createPushHealthHandler / createNotifySettingsHandler）、POST /api/push/test|test-bark|
// test-webhook（src/push/runtime.js）。
//
// 三条口径照旧页（manage-host-settings.js 的 loadPushDiagnostics / loadNotifySettings /
// saveNotifySettings），别按直觉「修正」：
//   ① 订阅状态只从 pwa.js 现读：订阅活在 pwa.js 的模块变量和浏览器的 PushManager 里，
//      前端再存一份就有两个真相。开关也只能调 pwa.js 的 togglePush() —— 只有它会去申请
//      通知权限、向服务端登记那条订阅；面板自己调 pushManager 是绕开它再写一遍那份逻辑。
//   ② Bark 值服务端只回掩码（host-read.js 的 summarizeSecretUrl：`https://域名/••••`）。
//      掩码只当 placeholder 用，绝不写进 value —— 写进去它就成了「用户填的值」，下一次
//      保存会把这段掩码当明文提交回去。
//   ③ 保存时 Bark 与 Webhook 的空值含义不同：Bark 空着 = 这次不动它（所以不带这个字段），
//      Webhook 空串 = 清空（所以每次都要带）。两者不能一起按「有值才带」处理。
(function initAirPush(root) {
  if (!root || !root.document) return;
  const document = root.document;
  const el = id => document.getElementById(id);
  // 数字格式的唯一来源（shared/format.js，页面里先于本文件加载）。Node 侧的沙箱里
  // 没有页面全局，也没有 require，所以三种取法都留着 —— 测试要么注入
  // MultiCCFormat，要么让它落到 require 上。
  const FMT = (typeof window !== 'undefined' && window.MultiCCFormat)
    || (typeof globalThis !== 'undefined' && globalThis.MultiCCFormat)
    || (typeof require === 'function' ? require('./shared/format.js') : null);
  const make = (tag, text, className) => {
    const value = document.createElement(tag);
    if (text != null) value.textContent = text;
    if (className) value.className = className;
    return value;
  };
  // 推送端点整条能到几百字符（它就是各家推送服务的 URL，中间一长段是加密密钥）。
  // 旧页只留头尾：头 40 + 尾 15 —— 中间那段对用户没用，全塞进 DOM 只会把这一行
  // 撑成横向滚动条（手机上整页跟着会左右晃）。
  const ENDPOINT_HEAD = 40, ENDPOINT_TAIL = 15;
  // 读不到服务端数据时的占位符。跟旧页一样是一个破折号，不是「0」——
  // 「发了 0 条」和「还没读到」是两件事，把后者画成前者会让人以为推送真的没发出去。
  const UNKNOWN = '—';

  // render/refresh 每进一次面板都会重画，回调里要用的 context 只能存这儿 ——
  // 它由 air.js / air-admin.js 每次渲染递进来（同 air-secrets.js 的规矩）。
  let context = null;

  // 样式跟着面板走：air.css 不认识 air-push-* 这些类，这一格只有这个文件是主人。
  // 节点只建一次并缓存 —— 重画时是把它移过去，不是再往文档里插一份。
  let styleNode = null;
  function style() {
    if (styleNode) return styleNode;
    styleNode = document.createElement('style');
    styleNode.textContent = `
      .air-push-page { display: grid; gap: 18px; }
      .air-push-note { margin: 0 0 12px; max-width: 760px; color: var(--muted); font-size: 11.5px; line-height: 1.65; }
      .air-push-rows { display: grid; gap: 8px; }
      .air-push-row { display: flex; align-items: baseline; gap: 12px; }
      .air-push-row > span { flex: 0 0 92px; color: var(--faint); font-size: 10.5px; }
      .air-push-value { min-width: 0; color: var(--text); font-size: 11.5px; font-weight: 600; overflow-wrap: anywhere; }
      .air-push-endpoint { color: var(--muted); font-family: var(--mono, monospace); font-size: 10.5px; font-weight: 500; }
      .air-push-value.is-ok { color: var(--st-success); }
      .air-push-value.is-warn { color: var(--st-waiting); }
      .air-push-value.is-bad { color: var(--st-danger); }
      .air-push-value.is-idle { color: var(--muted); }
      .air-push-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
      .air-push-actions > button { width: auto; }
      .air-push-status { color: var(--faint); font-size: 11px; }
      .air-push-status.ok { color: var(--st-success); }
      .air-push-status.error { color: var(--st-danger); }
      .air-push-hint { margin: 0; color: var(--faint); font-size: 10.5px; line-height: 1.6; }
      .air-push-hint > a { color: var(--accent); }
    `;
    return styleNode;
  }

  function button(text, handler, className = '') {
    const node = make('button', text, className);
    node.type = 'button';
    node.onclick = handler;
    return node;
  }

  // 时间是相对的：这一格是排查用的，「5 分钟前」比一个绝对时刻好读（旧页同样只给
  // 相对量）。走全站唯一那份（shared/format.js）—— 原来这里用 Intl.RelativeTimeFormat
  // 自己拼，于是同一页上「多久以前」有两套词（这一格说「5分钟前」，别处说「5 分钟前」），
  // 而且这一格只分到小时，一天前的推送会被说成一个很大的时数。
  function formatTime(ts) {
    return FMT.formatRelativeTime(ts);
  }

  // 端点那格是 URL，用等宽字体（其它几格是短标签，普通字体就够）——类名按 id 定死，
  // 值的元素每次重画只换类名里的状态后缀。
  const VALUE_CLASS = { 'air-push-endpoint': 'air-push-value air-push-endpoint' };

  // 一格读数：标签 + 值。state 决定值的颜色（ok / warn / bad / idle），空字符串就是
  // 普通文字色 —— 只有「成功率、权限、错误」这三类有颜色语义。
  function readRow(labelText, valueId) {
    const row = make('div', null, 'air-push-row');
    const value = make(valueId === 'air-push-endpoint' ? 'code' : 'strong', UNKNOWN, VALUE_CLASS[valueId] || 'air-push-value');
    value.id = valueId;
    row.append(make('span', labelText), value);
    return row;
  }

  function setValue(id, text, state = '') {
    const node = el(id);
    if (!node) return;
    node.textContent = text;
    node.className = `${VALUE_CLASS[id] || 'air-push-value'}${state ? ` is-${state}` : ''}`;
  }

  function setStatus(id, text, state = '') {
    const node = el(id);
    if (!node) return;
    node.textContent = text;
    node.className = `air-push-status${state ? ` ${state}` : ''}`;
  }

  // 客户端信息由 pwa.js 提供（air.html 已加载它）。取不到就当「不支持」——
  // 让这一块空着跟「一切正常」在屏幕上长得一样，那是最坏的一种沉默。
  function clientInfo() {
    const info = typeof root.getPushInfo === 'function' ? root.getPushInfo() : null;
    return info || { permission: 'unsupported', subscribed: false, endpoint: null, platform: t('airPushUnknown') };
  }

  function paintClient(info = clientInfo()) {
    // 权限三态照旧页：给了绿、拒了红、还没问黄；浏览器没有这套 API 才是灰的。
    const permission = String(info.permission || '');
    setValue('air-push-permission', permission || UNKNOWN,
      permission === 'granted' ? 'ok' : permission === 'denied' ? 'bad' : permission === 'unsupported' ? 'idle' : 'warn');
    setValue('air-push-subscription', info.subscribed ? t('airPushSubscribed') : t('airPushUnsubscribed'),
      info.subscribed ? 'ok' : 'idle');
    const endpoint = info.endpoint ? String(info.endpoint) : '';
    setValue('air-push-endpoint', endpoint
      ? (endpoint.length > ENDPOINT_HEAD + ENDPOINT_TAIL
        ? `${endpoint.slice(0, ENDPOINT_HEAD)}...${endpoint.slice(-ENDPOINT_TAIL)}`
        : endpoint)
      : UNKNOWN);
    const platform = el('air-push-platform');
    if (platform) platform.textContent = info.platform || UNKNOWN;
    const toggle = el('air-push-toggle');
    if (toggle) {
      toggle.textContent = info.subscribed ? t('airPushEnabled') : t('airPushEnable');
      toggle.className = info.subscribed ? 'primary' : '';
    }
  }

  function paintHealth(data) {
    const global = (data && data.global) || {};
    // 类型只有服务端认得的几个（succeeded / waiting / …），认不出时它给空串 ——
    // 那就只说时间，别把一对空括号画出来。
    const lastPush = global.lastPushTime
      ? `${formatTime(global.lastPushTime)}${global.lastPushType ? ` (${global.lastPushType})` : ''}`
      : t('airPushNever');
    setValue('air-push-last-push', lastPush);
    const success = Number(global.totalSuccess || 0);
    const total = success + Number(global.totalFail || 0);
    if (total > 0) {
      const pct = Math.round(success / total * 100);
      // 阈值照旧页：≥90 绿、≥70 黄、其余红。这三个数是「这一格能不能信」的判断，
      // 不是审美 —— 别顺手改。
      setValue('air-push-rate', `${pct}% (${success}/${total})`, pct >= 90 ? 'ok' : pct >= 70 ? 'warn' : 'bad');
    } else {
      setValue('air-push-rate', t('airPushNoData'), 'idle');
    }
    setValue('air-push-total', String(global.totalSent || 0));
    setValue('air-push-subcount', String((data && data.subscriptionCount) || 0));
    // 「最近出错」取所有订阅里最后一次失败：服务端按订阅分别记时间，面板要的是
    // 「这套推送最近一次出问题是什么时候、为什么」。
    let newest = null;
    for (const subscription of (data && data.subscriptions) || []) {
      if (subscription.lastFailTime && (!newest || subscription.lastFailTime > newest.time)) {
        newest = { time: subscription.lastFailTime, reason: subscription.lastFailReason };
      }
    }
    setValue('air-push-last-error', newest ? `${newest.reason} (${formatTime(newest.time)})` : t('airPushNone'),
      newest ? 'bad' : 'ok');
  }

  async function loadHealth() {
    const banner = el('air-push-health-error');
    if (banner) { banner.hidden = true; banner.textContent = ''; }
    try {
      paintHealth(await context.api('/api/push/health'));
    } catch (error) {
      // 读不到就把这几个数字退回占位符：上一轮的数字留在屏幕上，跟刚读到的新数字
      // 长得一样，而这个面板就是拿来看「现在什么状况」的。
      for (const id of ['air-push-last-push', 'air-push-rate', 'air-push-total', 'air-push-subcount', 'air-push-last-error']) {
        setValue(id, UNKNOWN, 'idle');
      }
      if (banner) {
        banner.textContent = t('airAdminLoadFailed', { message: error.message || String(error) });
        banner.hidden = false;
      }
    }
  }

  async function loadNotify() {
    const banner = el('air-push-notify-error');
    if (banner) { banner.hidden = true; banner.textContent = ''; }
    const bark = el('air-push-bark');
    const webhook = el('air-push-webhook');
    try {
      const cfg = (await context.api('/api/settings/notify')) || {};
      // 口径②：掩码进 placeholder，不进 value。没配过时 placeholder 留着那句例子
      // （表单里得有个「该填成什么样」的样子）。
      if (bark) bark.placeholder = cfg.hasBark ? (cfg.barkUrl || t('airPushBarkConfigured')) : t('airPushBarkPlaceholder');
      if (webhook) webhook.value = cfg.webhookUrl || '';
    } catch (error) {
      if (banner) {
        banner.textContent = t('airAdminLoadFailed', { message: error.message || String(error) });
        banner.hidden = false;
      }
    }
  }

  function load() {
    paintClient(); // 这一块是本地读，不发请求
    return Promise.all([loadHealth(), loadNotify()]);
  }

  // ── 订阅开关 ───────────────────────────────────────────────────────────
  async function togglePush() {
    const status = el('air-push-test-status');
    const trigger = el('air-push-toggle');
    const before = clientInfo();
    if (trigger) trigger.disabled = true;
    setStatus('air-push-test-status', t('airPushSwitching'));
    try {
      // togglePush 在浏览器不支持、权限被拒时会抛或返回 false —— 两条都要接住：
      // 抛出的原因（VAPID 失败、subscribe 被拒）直接说给用户，返回 false 的按下面
      // 「状态有没有真的变」判断。
      const result = await root.togglePush?.();
      const after = clientInfo();
      paintClient(after);
      setStatus('air-push-test-status', '');
      // false 有两种含义：刚关掉订阅（这次成功），或者没能订阅上（权限被拒 /
      // 环境不支持）。只有「本来就订着、现在没订」才算成功，其余都是失败。
      if (!after.subscribed && !before.subscribed && !result) {
        setStatus('air-push-test-status', t('airPushToggleDenied'), 'error');
      }
    } catch (error) {
      setStatus('air-push-test-status', t('airPushToggleFailed', { error: error.message || String(error) }), 'error');
      // 抛错也可能已经换了一半状态（比如退订成功、注销失败），重读一次才是真相。
      paintClient();
    } finally {
      if (trigger) trigger.disabled = false;
    }
  }

  async function testPush() {
    const trigger = el('air-push-test');
    if (trigger) trigger.disabled = true;
    setStatus('air-push-test-status', t('airPushSending'));
    try {
      const data = await context.api('/api/push/test', {});
      setStatus('air-push-test-status', t('airPushSentTo', { n: (data && data.subscribers) || 0 }), 'ok');
      // 刚发过一轮，健康度那几个数字已经变了 —— 顺手重读，别让面板停在发之前那一份。
      await loadHealth();
    } catch (error) {
      setStatus('air-push-test-status', t('airPushTestFailed', { error: error.message || String(error) }), 'error');
    } finally {
      if (trigger) trigger.disabled = false;
    }
  }

  // ── 备用通道 ───────────────────────────────────────────────────────────
  async function testChannel(kind) {
    const isBark = kind === 'bark';
    const trigger = el(isBark ? 'air-push-test-bark' : 'air-push-test-webhook');
    if (trigger) trigger.disabled = true;
    setStatus('air-push-notify-status', isBark ? t('airPushTestingBark') : t('airPushTestingWebhook'));
    try {
      const data = await context.api(isBark ? '/api/push/test-bark' : '/api/push/test-webhook', {});
      // 「没配」服务端回 4xx，api() 会抛；但配了却投递失败时它也可能回 200 + {error}
      // （见 src/push/runtime.js）—— 只看状态码会把这种失败报成成功。
      if (data && data.error) throw new Error(data.error);
      setStatus('air-push-notify-status', isBark ? t('airPushBarkSent') : t('airPushWebhookSent'), 'ok');
    } catch (error) {
      setStatus('air-push-notify-status',
        t(isBark ? 'airPushBarkFailed' : 'airPushWebhookFailed', { error: error.message || String(error) }), 'error');
    } finally {
      if (trigger) trigger.disabled = false;
    }
  }

  async function saveNotify() {
    const submit = el('air-push-save');
    const barkValue = (el('air-push-bark')?.value || '').trim();
    const webhookValue = (el('air-push-webhook')?.value || '').trim();
    // 口径③：Bark 只在真的填了东西时才带上（留空 = 这次不动它），Webhook 每次都带
    // （空串是「清空」，不是「不动」）。旧页就是这么组装的。
    const body = {};
    if (barkValue) body.barkUrl = barkValue;
    body.webhookUrl = webhookValue;
    if (submit) submit.disabled = true;
    setStatus('air-push-notify-status', t('airAdminSaving'));
    try {
      await context.api('/api/settings/notify', body);
      // 保存成功就把 Bark 输入框清空：值已经落到服务端，留在这儿的明文只是多一份暴露；
      // 重新读一次会把这轮的新掩码放进 placeholder，用户看得见「已经存下了」。
      if (el('air-push-bark')) el('air-push-bark').value = '';
      context.notice(t('airPushNotifySaved'));
      setStatus('air-push-notify-status', t('airPushSaved'), 'ok');
      await loadNotify();
    } catch (error) {
      setStatus('air-push-notify-status', t('saveFailed', { error: error.message || String(error) }), 'error');
    } finally {
      if (submit) submit.disabled = false;
    }
  }

  // ── DOM ────────────────────────────────────────────────────────────────
  function card(eyebrow, title, noteKey) {
    const section = make('section', null, 'admin-panel');
    const head = make('div', null, 'admin-panel-head');
    const heading = make('div');
    heading.append(make('span', eyebrow, 'eyebrow'), make('h3', title));
    head.append(heading);
    section.append(head, make('p', t(noteKey), 'air-push-note'));
    return section;
  }

  function clientCard() {
    const section = card('SUBSCRIPTION', t('airPushClientTitle'), 'airPushClientNote');
    const rows = make('div', null, 'air-push-rows');
    rows.append(
      readRow(t('airPushPermission'), 'air-push-permission'),
      readRow(t('airPushSubscription'), 'air-push-subscription'),
      readRow(t('airPushEndpoint'), 'air-push-endpoint'),
      readRow(t('airPushPlatform'), 'air-push-platform'),
    );
    const toggle = button(t('airPushEnable'), () => void togglePush());
    toggle.id = 'air-push-toggle';
    const test = button(t('airPushTest'), () => void testPush());
    test.id = 'air-push-test';
    const status = make('span', '', 'air-push-status');
    status.id = 'air-push-test-status';
    const actions = make('div', null, 'air-push-actions');
    actions.append(toggle, test, status);
    section.append(rows, actions);
    return section;
  }

  function healthCard() {
    const section = card('HEALTH', t('airPushHealthTitle'), 'airPushHealthNote');
    const banner = make('p', '', 'admin-empty error');
    banner.id = 'air-push-health-error';
    banner.hidden = true;
    const rows = make('div', null, 'air-push-rows');
    rows.append(
      readRow(t('airPushLastPush'), 'air-push-last-push'),
      readRow(t('airPushSuccessRate'), 'air-push-rate'),
      readRow(t('airPushTotalSent'), 'air-push-total'),
      readRow(t('airPushSubscriptions'), 'air-push-subcount'),
      readRow(t('airPushLastError'), 'air-push-last-error'),
    );
    section.append(banner, rows);
    return section;
  }

  function backupCard() {
    const section = card('CHANNELS', t('airPushBackupTitle'), 'airPushBackupNote');
    const bark = make('input');
    bark.type = 'text';
    bark.id = 'air-push-bark';
    bark.autocomplete = 'off';
    bark.spellcheck = false;
    bark.placeholder = t('airPushBarkPlaceholder');
    const webhook = make('input');
    webhook.type = 'text';
    webhook.id = 'air-push-webhook';
    webhook.autocomplete = 'off';
    webhook.spellcheck = false;
    webhook.placeholder = t('airPushWebhookPlaceholder');
    for (const input of [bark, webhook]) {
      input.onkeydown = event => { if (event.key === 'Enter') void saveNotify(); };
    }
    const barkField = make('label', null, 'air-aux-field');
    barkField.append(make('span', t('airPushBarkUrl')), bark);
    // 这行说明只在 Bark 那一格下面（装 App、去哪儿抄 URL），跟着输入框走。
    const hint = make('p', null, 'air-push-hint');
    const link = make('a', t('airPushBarkApp'));
    link.href = 'https://apps.apple.com/app/bark-push/id1403753865';
    link.target = '_blank';
    link.rel = 'noopener';
    // 中间那个空格是排版用的：两句之间没有它，链接会直接粘在前一句的句号后面。
    hint.append(make('span', t('airPushBarkHint')), ' ', link);
    const webhookField = make('label', null, 'air-aux-field');
    webhookField.append(make('span', t('airPushWebhookUrl')), webhook);

    const status = make('span', '', 'air-push-status');
    status.id = 'air-push-notify-status';
    const save = button(t('save'), () => void saveNotify(), 'primary');
    save.id = 'air-push-save';
    const barkTest = button(t('airPushTestBark'), () => void testChannel('bark'));
    barkTest.id = 'air-push-test-bark';
    const webhookTest = button(t('airPushTestWebhook'), () => void testChannel('webhook'));
    webhookTest.id = 'air-push-test-webhook';
    const actions = make('div', null, 'air-push-actions');
    actions.append(save, barkTest, webhookTest, status);

    const form = make('div', null, 'air-aux-form');
    form.append(barkField, hint, webhookField);
    section.append(form, actions);
    return section;
  }

  function build() {
    const page = make('div', null, 'air-push-page');
    page.append(style(), clientCard(), healthCard(), backupCard());
    return page;
  }

  function render(host, ctx) {
    context = ctx;
    host.replaceChildren(build());
    return load();
  }

  root.MultiCCAirPush = Object.freeze({ render, refresh: () => load() });
})(typeof window !== 'undefined' ? window : null);
