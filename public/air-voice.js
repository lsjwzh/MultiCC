'use strict';

// Air 原生「语音设置」面板 —— 旧 manage 页 voice 那一格（原生 DOM，不再嵌旧 manage 页）。
//
// 这一格是四块拼出来的，来源不同、i18n 规矩也不同：
//   ① 全局实时语音 Gateway 那一块**直接复用**旧页的 manage-qwen-audio.js：它本来就是纯
//      id 驱动的（读 #qwen-audio-key 那几个输入框、往 #qwen-audio-global 里画一行状态），
//      所以这里只要按同一批 id 把输入框画出来，渲染完调一次 initialize()，之后每次
//      refresh() 再调 loadPanel()。它的文案是硬编码中文 —— 同一份模块还挂在旧页上，
//      不能为 Air 改词，所以这一块不参与 t()。
//   ② 精修（OpenRouter）、③ Whisper STT、④ 流式 ASR：旧页的实现在 manage.js 里，函数
//      绑死在旧页的 DOM 上（全局弹窗、id 查找），搬不过来，这里按原字段重写。t() 只覆盖
//      这三块（含我自己画的卡片抬头）。
//
// 密钥栏三条规矩跟旧页一致，也是最容易写错的一条：
//   · 列表接口回来的是打码值，只配当「有没有」的证据，永远不写进 value；
//   · value 一律留空，把「已配置（留空不修改）」写进 placeholder；
//   · 提交时只带有值的字段 —— 打码值绝不会被当明文回传。
(function initAirVoice(root) {
  if (!root || !root.document) return;
  const document = root.document;
  const el = id => document.getElementById(id);
  const make = (tag, text, className) => {
    const value = document.createElement(tag);
    if (text != null) value.textContent = text;
    if (className) value.className = className;
    return value;
  };
  const trim = id => (el(id)?.value || '').trim();

  // 三家流式 ASR 的 provider id：选项顺序、徽标顺序、摘要里点名的顺序都是这一份。
  const ASR_PROVIDERS = ['openai', 'volcano', 'funasr'];

  let context = null;
  // ASR 那一块默认收起：它一共九栏、平时只改一次，摘要行已经说清了现状。
  // 状态放在模块上而不是 DOM 上 —— 面板重开时用户上次展开过的那一版还在。
  let asrOpen = false;

  const style = document.createElement('style');
  style.textContent = `
.air-voice { display: grid; gap: 14px; min-width: 0; }
.air-voice-card { min-width: 0; }
.air-voice-desc { margin: 0; color: var(--muted); font-size: 11px; line-height: 1.6; }
/* 旧页那种「左标签右控件」的一行。窄屏上标签先落一行，控件不再被挤成一条缝。 */
.air-voice-row { display: grid; grid-template-columns: 132px minmax(0, 1fr); align-items: center; gap: 8px 10px; margin-top: 10px; }
.air-voice-row > label { color: var(--muted); font-size: 11px; }
.air-voice-cell { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; min-width: 0; }
.air-voice-cell > input, .air-voice-cell > select { flex: 1 1 220px; min-width: 0; }
.air-voice-inline { display: flex; flex: 1 1 220px; align-items: center; gap: 8px; min-width: 0; }
.air-voice-inline > input { flex: 0 1 120px; }
.air-voice-hint { color: var(--faint); font-size: 10.5px; line-height: 1.5; }
.air-voice-hint-block { margin: 6px 0 0 142px; }
.air-voice-save { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin-top: 14px; }
.air-voice-save > button { width: auto; }
.air-voice-status { color: var(--muted); font-size: 10.5px; }
.air-voice-status.ok { color: #2c7d5c; }
.air-voice-status.err { color: #b34b34; }
.air-voice-summary { margin: 8px 0 0; font-size: 11px; line-height: 1.5; }
.air-voice-toggle { width: auto; min-height: 30px; padding: 4px 8px; color: #537493; border-color: transparent; background: transparent; font-size: 10px; }
.air-voice-group { padding-top: 12px; margin-top: 12px; border-top: 1px solid var(--hairline); }
.air-voice-group:first-child { padding-top: 0; margin-top: 0; border-top: 0; }
.air-voice-group-head { display: flex; align-items: center; gap: 8px; margin-bottom: 2px; }
.air-voice-group-head strong { color: var(--text); font-size: 12.5px; }
.air-voice-badge { color: var(--faint); font-size: 10.5px; }
.air-voice-error { margin: 0; }
.air-voice-asr-body { margin-top: 4px; }
.air-voice-asr-body[hidden] { display: none; }
@media (max-width: 620px) {
  .air-voice-row { grid-template-columns: 1fr; }
  .air-voice-hint-block { margin-left: 0; }
}`;

  function button(text, handler, className = '') {
    const node = make('button', text, className);
    node.type = 'button';
    node.onclick = handler;
    return node;
  }

  // 左标签右控件的一行。controls 是把控件塞进第二格的内容（多数时候就一个 input）。
  function row(labelText, ...controls) {
    const line = make('div', null, 'air-voice-row');
    line.append(make('label', labelText));
    const cell = make('div', null, 'air-voice-cell');
    cell.append(...controls.filter(Boolean));
    line.append(cell);
    return line;
  }

  function input(id, type = 'text', placeholder = null) {
    const node = make('input');
    node.id = id;
    node.type = type;
    node.autocomplete = 'off';
    node.spellcheck = false;
    if (placeholder) node.placeholder = placeholder;
    return node;
  }

  // 密钥栏：打码值不进 value，只当「是否已配置」用。
  function keyInput(id, placeholder) {
    const node = input(id, 'password', placeholder);
    node.autocomplete = 'new-password';
    return node;
  }

  // 卡片外壳：抬头（eyebrow + 标题，右边可以挂一个动作）+ 正文。抬头由这里一次装好，
  // 调用方只负责往返回的节点上追加正文 —— 「忘了把抬头拼进 DOM」这种事就无从发生。
  function card(eyebrow, title, extra = null) {
    const section = make('section', null, 'admin-panel air-voice-card');
    const head = make('div', null, 'admin-panel-head');
    const titleBox = make('div');
    titleBox.append(make('span', eyebrow, 'eyebrow'), make('h3', title));
    head.append(titleBox);
    if (extra) head.append(extra);
    section.append(head);
    return section;
  }

  function setStatus(nodes, text, tone) {
    for (const node of nodes) {
      if (!node) continue;
      node.textContent = text;
      node.className = `air-voice-status${tone ? ' ' + tone : ''}`;
    }
  }

  // ── ① 全局实时语音 Gateway（复用 manage-qwen-audio.js）──────────────────
  // 这几个 id 是那份模块的接口，不是我的排版选择：它按 id 读写，认不得别的名字。
  // 三个按钮的 onclick 直接落到它挂在 window 上的函数（保存 / 安装 / 安装并启用）。
  function qwenCard() {
    const section = card('VOICE', t('airVoiceQwenTitle'));
    // 这一段是旧页那张卡的说明，跟它下面那行状态属于同一块功能；但它是**我**画在面板里的
    // 文案（不是 manage-qwen-audio.js 渲染的），所以照样走 t()。真正没走 t() 的是那份模块
    // 自己渲染的东西：#qwen-audio-global 里那一行、它的状态文字，以及安装按钮的文案
    // —— 那些字符串还挂在旧 manage 页上，不能为 Air 单独改词。
    section.append(make('p', t('airVoiceQwenDesc'), 'air-voice-desc'));
    section.append(
      row(t('airVoiceQwenKey'), keyInput('qwen-audio-key', 'sk-...')),
      row(t('airVoiceQwenUrl'), input('qwen-audio-url', 'text', 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime')),
      row(t('airVoiceQwenModel'), input('qwen-audio-model', 'text', 'qwen-audio-3.0-realtime-plus')),
      row(t('airVoiceQwenVoice'), input('qwen-audio-voice', 'text', 'longanqian')),
    );
    const global = make('div', null, 'air-voice-global');
    global.id = 'qwen-audio-global';
    section.append(global);
    const status = make('span');
    status.id = 'qwen-audio-status';
    status.className = 'air-voice-status';
    // install / enable 两个 id 由那份模块读（它要改安装按钮的文案与禁用态）。
    const save = button(t('airVoiceQwenSave'), () => root.saveQwenAudioSettings?.());
    save.id = 'qwen-audio-save';
    const install = button(t('airVoiceQwenInstall'), () => root.installQwenAudioRuntime?.());
    install.id = 'qwen-audio-install';
    const enable = button(t('airVoiceQwenEnable'), () => root.enableQwenAudioGlobal?.(), 'primary');
    enable.id = 'qwen-audio-enable';
    const footer = make('div', null, 'air-voice-save');
    footer.append(save, install, enable, status);
    section.append(footer);
    return section;
  }

  // ── ④ 实时语音识别（流式 ASR）────────────────────────────────────────
  // 旧页是一个嵌套弹窗。Air 里不再叠弹窗：整块收在卡片里，抬头那行摘要说清「默认哪家 /
  // 已配置哪几家」，展开才出九栏，配置能力跟旧弹窗一样。
  function asrGroup(title, badgeId, fields) {
    const group = make('div', null, 'air-voice-group');
    const head = make('div', null, 'air-voice-group-head');
    head.append(make('strong', title));
    const badge = make('span');
    badge.id = badgeId;
    badge.className = 'air-voice-badge';
    head.append(badge);
    group.append(head, ...fields);
    return group;
  }

  function asrCard() {
    const toggle = button(asrOpen ? t('airVoiceAsrCollapse') : t('airVoiceAsrExpand'), () => setAsrOpen(!asrOpen), 'air-voice-toggle');
    toggle.id = 'air-voice-asr-toggle';
    const section = card('ASR', t('airVoiceAsrTitle'), toggle);
    section.append(make('p', t('airVoiceAsrDesc'), 'air-voice-desc'));
    const summary = make('p', '', 'air-voice-summary');
    summary.id = 'asr-summary';
    section.append(summary);

    const body = make('div', null, 'air-voice-asr-body');
    body.id = 'air-voice-asr-body';
    body.hidden = !asrOpen;
    // 三家的显示名：取值顺序跟 ASR_PROVIDERS 一致，key 一张一张列出来，别用模板拼
    // ——i18n 清单要能一眼数清这一块到底用了哪些 key。
    const providerLabels = {
      openai: t('airVoiceAsrProviderOpenai'),
      volcano: t('airVoiceAsrProviderVolcano'),
      funasr: t('airVoiceAsrProviderFunasr'),
    };
    const select = make('select');
    select.id = 'asr-provider';
    for (const provider of ASR_PROVIDERS) {
      const option = make('option', providerLabels[provider]);
      option.value = provider;
      select.append(option);
    }
    body.append(row(t('airVoiceAsrProviderLabel'), select));
    body.append(
      asrGroup(t('airVoiceAsrGroupOpenai'), 'asr-openai-badge', [
        row(t('airVoiceFieldApiKey'), keyInput('asr-openai-key', 'sk-...')),
        row(t('airVoiceFieldEndpoint'), input('asr-openai-url', 'text', 'wss://api.openai.com/v1/realtime')),
        row(t('airVoiceFieldModel'), input('asr-openai-model', 'text', 'gpt-4o-transcribe')),
      ]),
      asrGroup(t('airVoiceAsrGroupVolcano'), 'asr-volc-badge', [
        row(t('airVoiceFieldAppId'), keyInput('asr-volc-appid', t('airVoicePhVolcAppId'))),
        row(t('airVoiceFieldAccessToken'), keyInput('asr-volc-token', t('airVoicePhVolcToken'))),
        row(t('airVoiceFieldResourceId'), input('asr-volc-resource', 'text', 'volc.bigasr.sauc.duration')),
        row(t('airVoiceFieldEndpoint'), input('asr-volc-url', 'text', 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel')),
      ]),
      asrGroup(t('airVoiceAsrGroupFunasr'), 'asr-funasr-badge', [
        row(t('airVoiceFieldWsUrl'), input('asr-funasr-url', 'text', 'ws://127.0.0.1:10095')),
        row(t('airVoiceFieldMode'), input('asr-funasr-mode', 'text', '2pass')),
      ]),
    );
    const status = make('span');
    status.id = 'asr-status';
    status.className = 'air-voice-status';
    const footer = make('div', null, 'air-voice-save');
    const save = button(t('save'), () => saveAsr(), 'primary');
    save.id = 'asr-save';
    footer.append(save, status);
    body.append(footer);
    section.append(body);
    return section;
  }

  // ── ② 精修（OpenRouter）＋ ③ Whisper STT ──────────────────────────────
  // 两块共用一条保存路径：旧页那张 Save 写的就是同一个 body（精修三项 + Whisper 五项），
  // 拆成两个接口反而是我编出来的。所以两边都调 saveVoice()，两张卡各自显示同一结果。
  function refineCard() {
    const section = card('REFINE', t('airVoiceRefineTitle'));
    section.append(
      row(t('airVoiceFieldEndpoint'), input('vs-base-url', 'text', 'https://openrouter.ai/api/v1')),
      row(t('airVoiceFieldApiKey'), keyInput('vs-api-key', 'sk-or-v1-...')),
      row(t('airVoiceFieldModel'), input('vs-model', 'text', 'google/gemini-2.0-flash-001')),
    );
    const status = make('span');
    status.id = 'vs-status';
    status.className = 'air-voice-status';
    const save = button(t('save'), () => saveVoice(), 'primary');
    save.id = 'vs-save';
    const footer = make('div', null, 'air-voice-save');
    footer.append(save, status);
    section.append(footer);
    return section;
  }

  function whisperCard() {
    const section = card('STT', t('airVoiceWhisperTitle'));
    section.append(
      row(t('airVoiceFieldEndpoint'), input('ws-base-url', 'text', 'https://openrouter.ai/api/v1')),
      row(t('airVoiceFieldApiKey'), keyInput('ws-api-key', t('airVoiceWhisperKeyHint'))),
      row(t('airVoiceFieldModel'), input('ws-model', 'text', 'whisper-large-v3-turbo')),
      row(t('airVoiceFieldLanguage'), (() => {
        const inline = make('div', null, 'air-voice-inline');
        inline.append(input('ws-language', 'text', 'zh'), make('span', t('airVoiceWhisperLangHint'), 'air-voice-hint'));
        return inline;
      })()),
      row(t('airVoiceFieldPrompt'), input('ws-prompt', 'text', 'React, useState, TypeScript, Claude Code, MultiCC, SSE')),
    );
    // prompt 的说明在输入框下面两行，跟旧页一样左缩进对齐到控件那一列。
    const hint = make('div', null, 'air-voice-hint air-voice-hint-block');
    hint.append(make('div', t('airVoiceWhisperPromptHint')), make('div', t('airVoiceWhisperPromptHint2')));
    section.append(hint);
    const status = make('span');
    status.id = 'ws-status';
    status.className = 'air-voice-status';
    const save = button(t('save'), () => saveVoice(), 'primary');
    save.id = 'ws-save';
    const footer = make('div', null, 'air-voice-save');
    footer.append(save, status);
    section.append(footer);
    return section;
  }

  // ── 读回与回填 ───────────────────────────────────────────────────────
  function setValue(id, value) {
    const node = el(id);
    if (node) node.value = value || '';
  }

  // 打码值只决定 placeholder：value 永远留空，回传的也只有用户新填的值。
  function setKeyHint(id, hasKey, example) {
    const node = el(id);
    if (!node) return;
    node.value = '';
    node.placeholder = hasKey ? t('airVoiceKeyConfiguredHint') : example;
  }

  function setBadge(id, ready) {
    const node = el(id);
    if (!node) return;
    node.textContent = ready ? t('airVoiceAsrReady') : t('airVoiceAsrNotConfigured');
    node.style.color = ready ? 'var(--accent)' : 'var(--faint)';
  }

  // 服务端默认是 auto（「按会话挑」）。旧页那个 select 只有三家，遇到 auto 会选成空 ——
  // 这里按需补一项，默认状态下这一栏不至于看起来没选任何东西。
  function setAsrProvider(value) {
    const select = el('asr-provider');
    if (!select) return;
    const known = ASR_PROVIDERS.includes(value);
    const extra = select.querySelector('option[value="auto"]');
    if (!known && !extra) {
      const option = make('option', t('airVoiceAsrProviderAuto'));
      option.value = 'auto';
      select.append(option);
    } else if (known && extra) {
      extra.remove();
    }
    select.value = known ? value : 'auto';
  }

  function paintAsrSummary(asr, status) {
    const node = el('asr-summary');
    if (!node) return;
    const full = {
      openai: t('airVoiceAsrNameOpenai'),
      volcano: t('airVoiceAsrNameVolcano'),
      funasr: t('airVoiceAsrNameFunasr'),
    };
    const short = {
      openai: t('airVoiceAsrShortOpenai'),
      volcano: t('airVoiceAsrShortVolcano'),
      funasr: t('airVoiceAsrShortFunasr'),
    };
    const provider = asr.provider || '';
    const ready = ASR_PROVIDERS.filter(name => status[name] && status[name].ready).map(name => short[name]);
    node.textContent = t('airVoiceAsrSummary', { provider: full[provider] || provider || '—' })
      + (ready.length
        ? t('airVoiceAsrSummaryReady', { list: ready.join(t('airVoiceAsrListSep')) })
        : t('airVoiceAsrSummaryNone'));
    // 一家都没配时这句话是要人去动手的，给它一个能被看见的颜色。
    node.style.color = ready.length ? 'var(--muted)' : 'var(--accent)';
  }

  function apply(data) {
    const asr = data.asr || {};
    const status = asr.status || {};
    setValue('vs-base-url', data.baseUrl);
    setKeyHint('vs-api-key', data.hasKey, 'sk-or-v1-...');
    setValue('vs-model', data.model);
    setValue('ws-base-url', data.whisperBaseUrl);
    setKeyHint('ws-api-key', data.hasWhisperKey, t('airVoiceWhisperKeyHint'));
    setValue('ws-model', data.whisperModel);
    setValue('ws-language', data.whisperLanguage || 'zh');
    setValue('ws-prompt', data.whisperPrompt);
    setAsrProvider(asr.provider || '');
    setKeyHint('asr-openai-key', asr.hasOpenaiKey, 'sk-...');
    setValue('asr-openai-url', asr.openaiUrl);
    setValue('asr-openai-model', asr.openaiModel);
    setKeyHint('asr-volc-appid', asr.hasVolcAppId, t('airVoicePhVolcAppId'));
    setKeyHint('asr-volc-token', asr.hasVolcToken, t('airVoicePhVolcToken'));
    setValue('asr-volc-resource', asr.volcResourceId);
    setValue('asr-volc-url', asr.volcUrl);
    setValue('asr-funasr-url', asr.funasrUrl);
    setValue('asr-funasr-mode', asr.funasrMode);
    setBadge('asr-openai-badge', status.openai && status.openai.ready);
    setBadge('asr-volc-badge', status.volcano && status.volcano.ready);
    setBadge('asr-funasr-badge', status.funasr && status.funasr.ready);
    paintAsrSummary(asr, status);
  }

  async function load() {
    const error = el('air-voice-error');
    if (error) { error.textContent = ''; error.hidden = true; }
    try {
      apply((await context.api('/api/settings/voice')) || {});
    } catch (err) {
      if (error) {
        error.textContent = t('airAdminLoadFailed', { message: err.message || String(err) });
        error.hidden = false;
      }
    }
  }

  function setAsrOpen(open) {
    asrOpen = open;
    const body = el('air-voice-asr-body');
    if (body) body.hidden = !open;
    const toggle = el('air-voice-asr-toggle');
    if (toggle) toggle.textContent = open ? t('airVoiceAsrCollapse') : t('airVoiceAsrExpand');
  }

  // ── 写回 ─────────────────────────────────────────────────────────────
  // 精修 + Whisper 共用一个 body（旧页就是这么组装的）：只带有值的键，但 language /
  // prompt 这两项**无条件带上** —— 它们是纯文本，清空就是「改成空」。（因此 body 实际上
  // 不会为空，下面那条 No changes 分支只是照搬旧页的口径留着。）
  async function saveVoice() {
    const status = [el('vs-status'), el('ws-status')];
    const buttons = ['vs-save', 'ws-save'].map(el).filter(Boolean);
    const body = {};
    const put = (key, id) => { const value = trim(id); if (value) body[key] = value; };
    put('baseUrl', 'vs-base-url');
    put('apiKey', 'vs-api-key');
    put('model', 'vs-model');
    put('whisperBaseUrl', 'ws-base-url');
    put('whisperApiKey', 'ws-api-key');
    put('whisperModel', 'ws-model');
    body.whisperLanguage = trim('ws-language');
    body.whisperPrompt = trim('ws-prompt');

    if (!Object.keys(body).length) { setStatus(status, t('airVoiceNoChanges'), ''); return; }
    buttons.forEach(node => { node.disabled = true; });
    setStatus(status, t('airAdminSaving'), '');
    try {
      await context.api('/api/settings/voice', body);
      setStatus(status, t('saved'), 'ok');
      context.notice(t('airVoiceSavedNotice'));
      // 存完重新读一次：服务端回显才是唯一真相，也顺手清掉刚填进去的明文密钥。
      await load();
    } catch (err) {
      setStatus(status, t('saveFailed', { error: err.message || String(err) }), 'err');
    } finally {
      buttons.forEach(node => { node.disabled = false; });
    }
  }

  async function saveAsr() {
    const status = el('asr-status');
    const asr = { provider: trim('asr-provider') }; // provider 永远带上
    const put = (key, id) => { const value = trim(id); if (value) asr[key] = value; };
    put('openaiApiKey', 'asr-openai-key');
    put('openaiUrl', 'asr-openai-url');
    put('openaiModel', 'asr-openai-model');
    put('volcAppId', 'asr-volc-appid');
    put('volcAccessToken', 'asr-volc-token');
    put('volcResourceId', 'asr-volc-resource');
    put('volcUrl', 'asr-volc-url');
    put('funasrUrl', 'asr-funasr-url');
    put('funasrMode', 'asr-funasr-mode');
    try {
      await context.api('/api/settings/voice', { asr });
      setStatus([status], t('saved'), 'ok');
      context.notice(t('airVoiceAsrSavedNotice'));
      await load();
    } catch (err) {
      setStatus([status], t('saveFailed', { error: err.message || String(err) }), 'err');
    }
  }

  function render(host, ctx) {
    context = ctx;
    const wrap = make('div', null, 'air-voice');
    wrap.append(style);
    const error = make('p', null, 'admin-empty error air-voice-error');
    error.id = 'air-voice-error';
    error.hidden = true;
    wrap.append(error, qwenCard(), asrCard(), refineCard(), whisperCard());
    host.replaceChildren(wrap);
    // qwen 那块是纯 id 驱动的：DOM 已经就位，这时挂上它（initialize 会设 notify 并立刻
    // loadPanel），之后每次 refresh() 只要再调一次 loadPanel 就行，不会重复绑事件。
    void root.MultiCCManageQwenAudio?.initialize({ notify: ctx.notice });
    return load();
  }

  // 工具条那颗「刷新」落到这里：qwen 那块自己拉它那几条接口（runtime / gateway），
  // 跟着这一轮一起重画 —— 它装完运行时状态就在那一行里，不重拉的话按钮文案会停在旧值。
  // render() 不需要走这一条：initialize() 里已经 loadPanel 过一次了。
  function refresh() {
    void root.MultiCCManageQwenAudio?.loadPanel();
    return load();
  }

  root.MultiCCAirVoice = Object.freeze({ render, refresh });
})(typeof window !== 'undefined' ? window : null);
