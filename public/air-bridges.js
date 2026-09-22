'use strict';

// Air 原生「消息桥接 Bridges」面板 —— 微信 / 飞书 / Telegram / Discord / Slack 五个
// 平台的网关生命周期、SSE 日志流、微信扫码轮询、凭证读写，共 800 多行都在
// public/manage-bridges.js 里（它同时还是旧 manage 页那一格的实现）。这一格**不重写**
// 它，只做三件事：
//
//   ① 画一套和旧页**一模一样 id** 的骨架。manage-bridges.js 全程按 id 取元素（内部
//      `_bid(p, suffix)` 拼 'tg-' / 'dc-' / 'sk-' 前缀 + 'config' / 'status' / 'log' /
//      'botToken' 等后缀），所以下面每一个 id 都和 public/manage.html 1679-1966 行
//      逐字对应 —— 改一个，那个平台就整块哑掉（查询拿到 null，状态画不上去，
//      而且取值的那几处是 `if (!el) return`，静默失败，最难查）。
//   ② 把旧页那段折叠卡样式搬进来（scoped 到 .air-bridges，见 styles()）。
//   ③ 渲染完调 `MultiCCManageBridges.initialize()`：它对五个平台各做一次
//      loadConfig + checkStatus 并画状态。
//
// ── 每次重建骨架之前必须先 disconnect()（这一步最容易漏，也最要命）──────────────
// initialize() 只会「按当前状态连」，从不「拆」：某个平台上一轮开着、这一轮状态已经
// 变成未运行时，checkStatus 不会走到 connectSSE，那条上一轮的 EventSource 就永远没人
// 关。它不只是漏一条连接：它的 onmessage 是按 id 找日志容器的，重建之后照样命中**新**
// 画出来的那个容器，于是旧连接把日志灌进新 DOM。用户每进出这一页一次，就多攒一条。
// 所以 render() 的第一件事是 disconnect()，它把五个平台当前那几条连接一次全关掉。
//
// ── 旧页的四个全局由这一格补齐 ────────────────────────────────────────────────
// manage-bridges.js 直接引用 tokenQS / showToast / showConfirm（三个都定义在
// public/manage.js）和 qrcode（qrcode.min.js，air.html 已经加载）。Air 不加载
// manage.js，缺了 tokenQS 就是每个 fetch 都抛 ReferenceError，五个平台一起哑。
//
// 旧页里写死的内联回调（onclick="wechatGetQR()"）在这儿改成按 id 接一遍：内联处理器
// 依赖全局函数，Air 的原生面板不写内联属性（同 air-secrets.js / air-tunnel.js）。
//
// ── 哪些文案没走 t() ────────────────────────────────────────────────────────
// manage-bridges.js 自己写进 DOM 的那些中文（'未创建' / '未配置' / '已配置' /
// '已登录微信'、日志前缀 '← WeChat' / '→ Claude' / 'SYS' / 'ERR'、toast 与确认弹窗）
// 是硬编码的，它同时被旧 manage 页用，这一格不改它的词 —— 也就是说英文界面下这些
// 运行时文案仍是中文。本模块自己写的静态文案（卡片抬头、按钮、说明、初始状态）全部
// 走 t()，key 以 airBridges 开头。
(function initAirBridges(root) {
  if (!root || !root.document) return;
  const document = root.document;

  // 文案只在渲染时查。t() 由 air.html 的 i18n.js 提供；万一没挂上（缓存半套静态资源）
  // 只退化成 key 本身，不让整页因为文案层缺失而崩。
  const t = (key, params) => (typeof root.t === 'function' ? root.t(key, params) : key);
  const esc = value => String(value == null ? '' : value)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');

  // air.js 每次渲染递进来的 context：notice(...) 写右下角全局提示，setMode(...) 回上一步。
  // 工具条（返回设置中心 / 刷新）由 air-admin.js 统一装，这一格只画正文。
  let context = null;

  // 旧 manage 页的三个全局。tokenQS 在旧页就是个恒返回 '' 的占位（manage.js:6），这里
  // 保持一致（Air 的 fetch 认证由 auth-client.js 统一包在 window.fetch 上，不走查询串）。
  if (typeof root.tokenQS !== 'function') root.tokenQS = () => '';
  if (typeof root.showToast !== 'function') {
    root.showToast = message => { if (context) context.notice(String(message == null ? '' : message)); };
  }
  // 旧页的 showConfirm 是一套自定义弹窗（属于 manage 侧，不复用）。调用点只关心真假
  // （`if (!(await showConfirm(...))) return;`），所以用浏览器原生 confirm 包成 Promise。
  if (typeof root.showConfirm !== 'function') {
    root.showConfirm = message => Promise.resolve(root.confirm(String(message)));
  }

  // ── 三个 token 平台的数据（Telegram / Discord / Slack）────────────────────
  // 三者的网关模型、REST 面、卡片结构完全一样，只有凭证字段与少数文案不同；
  // 旧页是三段复制粘贴，这里一份生成器出三份。idp 决定 id 前缀（tg-/dc-/sk-），
  // 必须和 manage-bridges.js 的 TOKEN_BRIDGES（627-631 行）逐字一致。
  const TOKEN_PLATFORMS = [
    {
      platform: 'telegram', idp: 'tg', icon: '📡', name: 'Telegram',
      fields: [{ id: 'botToken', label: 'Bot Token', placeholder: '123456:ABC...' }],
      runBadge: 'airBridgesBadgeLongPoll', // 旧页写死「长轮询」
    },
    {
      platform: 'discord', idp: 'dc', icon: '🎮', name: 'Discord',
      fields: [{ id: 'botToken', label: 'Bot Token', placeholder: 'Bot Token' }],
      runBadge: 'airBridgesBadgeGatewayWs', // 旧页写死「Gateway WS」
    },
    {
      platform: 'slack', idp: 'sk', icon: '💼', name: 'Slack',
      fields: [
        { id: 'botToken', label: 'Bot Token', placeholder: 'xoxb-...' },
        { id: 'appToken', label: 'App Token', placeholder: 'xapp-...' },
      ],
      runBadge: 'airBridgesBadgeSocketMode', // 旧页写死「Socket Mode」
    },
  ];

  // 状态小药丸（.bridge-badge / #<>-cfg-state、#wx-gw-state…）与「Running」徽标的初始
  // 文案。注意：这些初始文本随后会被 manage-bridges.js 用它自己硬编码的中文覆盖
  // （'未创建' / '未配置' / '已配置'），这里给 t() 只是为了首帧不露出源码 key。
  const unconfigured = () => t('airBridgesStateUnconfigured');
  const uncreated = () => t('airBridgesStateUncreated');

  // ── 样式 ────────────────────────────────────────────────────────────────
  // ① 旧页那段折叠卡样式，逐字搬来（选择器加 .air-bridges 前缀，只在这一页生效；
  //    <style> 节点随面板一起被 replaceChildren 换掉，不会漏到别的页面）。
  // ② 旧页的卡片类（.settings-card / .sc-* / .setting-row / .btn*）定义在 manage.html
  //    的内联 <style> 里，Air 这边没有 —— 不补的话卡片会变成没有边框和留白的裸 div。
  //    这里按 manage-air-embed.css 的浅色口径（这是 embed 皮肤里唯一一份官方浅色
  //    适配）写一份 scoped 版本，数值对齐 Air 自己的变量。
  // ③ 旧页那套 --radius / --elev / --accent-line / --mono 在 air.css 里没有，补在这个
  //    容器上，搬过来的那段样式才能原样解析。
  function styles() {
    return `
.air-bridges{display:flex;flex-direction:column;gap:12px;min-width:0;
  --radius:14px;--elev:var(--shadow-1);--elev-hi:var(--shadow-2);
  --accent-line:#a9cff6;--accent-dim:#eaf4ff;--panel-2:#f5f9fd;--well:#fbfdff;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;}
.air-bridges-intro{margin:0;font-size:12px;line-height:1.65;color:var(--muted);}

.air-bridges .bridge-acc{border:1px solid var(--line-strong);border-radius:var(--radius);margin-bottom:0;overflow:hidden;background:linear-gradient(180deg,rgba(255,255,255,.022),transparent 90px),var(--panel);box-shadow:var(--elev);transition:box-shadow .18s,border-color .18s;}
.air-bridges .bridge-acc[open]{box-shadow:var(--elev-hi);}
.air-bridges .bridge-acc:hover{border-color:var(--accent-line);}
.air-bridges .bridge-sum{cursor:pointer;padding:14px 17px;font-size:14px;font-weight:640;display:flex;align-items:center;gap:10px;user-select:none;list-style:none;transition:background .15s;}
.air-bridges .bridge-sum:hover{background:var(--bg-soft);}
.air-bridges .bridge-sum::-webkit-details-marker{display:none;}
.air-bridges .bridge-sum::before{content:'▸';color:var(--accent);font-size:12px;transition:transform .18s;opacity:.85;}
.air-bridges .bridge-acc[open] > .bridge-sum::before{transform:rotate(90deg);}
.air-bridges .bridge-acc[open] > .bridge-sum{border-bottom:1px solid var(--line-strong);}
.air-bridges .bridge-sum .ic{font-size:16px;}
.air-bridges .bridge-hint{font-size:11px;font-weight:400;color:var(--faint);margin-left:auto;}
.air-bridges .bridge-badge{font-size:11px;font-weight:400;padding:1px 8px;border-radius:10px;margin-left:8px;background:var(--bg-soft);color:var(--muted);border:1px solid var(--line);}
.air-bridges .bridge-body{padding:16px;display:flex;flex-direction:column;gap:14px;background:var(--bg-soft);}
.air-bridges .bridge-body .settings-card{margin:0;box-shadow:none;}

.air-bridges .settings-card{border:1px solid var(--line-strong);border-radius:var(--radius);overflow:hidden;background:var(--panel);box-shadow:var(--elev);}
.air-bridges .settings-card .sc-header{padding:13px 17px;border-bottom:1px solid var(--line-strong);font-size:14px;font-weight:620;color:var(--text);display:flex;align-items:center;}
.air-bridges .settings-card .sc-body{padding:17px;display:flex;flex-direction:column;gap:13px;}
.air-bridges .setting-row{display:flex;align-items:center;gap:14px;min-width:0;}
.air-bridges .setting-row label{flex:0 0 112px;font-size:13px;color:var(--muted);text-align:right;}
.air-bridges .setting-row input,.air-bridges .setting-row select{flex:1;min-width:0;font-size:13px;font-family:var(--mono);background:var(--well);}
.air-bridges .setting-row > span{font-size:11px;color:var(--muted);line-height:1.6;}
.air-bridges .sc-footer{padding:12px 17px;border-top:1px solid var(--line);display:flex;align-items:center;gap:12px;flex-wrap:wrap;}
.air-bridges .sc-footer .status-text{font-size:12px;color:var(--muted);}
/* 旧页的 .btn 只在 manage.html 的内联样式里；Air 的通用 button 规则已经把尺寸和边框
   给足了，这里只补旧页那三个变体。变体选择器写成 .btn.btn-green 是为了压过上面的
   .btn:hover（同权重下后者在后就赢，悬停时蓝底会把绿底盖掉）。 */
.air-bridges .btn{min-height:34px;padding:6px 13px;font-size:13px;font-weight:500;}
.air-bridges .btn.btn-green{color:#fff;border-color:transparent;background:#1678e8;}
.air-bridges .btn.btn-green:hover{background:#1678e8;filter:brightness(1.05);}
.air-bridges .btn.btn-danger{color:var(--danger);border-color:#edcbc6;background:#fff;}
.air-bridges .btn.btn-danger:hover{background:#fdf1ef;border-color:var(--danger);}
.air-bridges .bridge-log{max-height:260px;overflow-y:auto;padding:8px 12px;font-size:12px;font-family:var(--mono);background:var(--bg-soft);display:flex;flex-direction:column;gap:2px;}
.air-bridges .bridge-idle{color:var(--faint);text-align:center;padding:20px 0;}

@media (max-width:760px){
  .air-bridges .setting-row{flex-direction:column;align-items:stretch;gap:6px;}
  .air-bridges .setting-row label{flex:none;text-align:left;}
  .air-bridges .bridge-hint{display:none;}
}`;
  }

  // ── 骨架 ────────────────────────────────────────────────────────────────
  // id / name / 内联 style 全部照 public/manage.html 1679-1966 行。两处刻意保留的内联
  // 写法，改了就坏：
  //   · `style="display:none;"`：manage-bridges.js 用 `el.style.display = ''` 还原显示。
  //     换成 class 隐藏的话，清掉内联值会回落到 class 的 display:none，永远显示不出来。
  //     需要这样切换的有：wx-btn-logout / wx-qr-img / 每个 gw-open|reset|destroy /
  //     每个 running-badge 与 ws-badge。
  //   · 日志容器里那句 `text-align:center`：appendBridgeLogRow 靠
  //     `div[style*="text-align:center"]` 找占位行并删掉它。
  function wechatBlock() {
    return `
  <details class="bridge-acc" open>
    <summary class="bridge-sum"><span class="ic">💬</span> WeChat (iLink) <span class="bridge-hint">${t('airBridgesHintWechat')}</span></summary>
    <div class="bridge-body">
      <div class="settings-card">
        <div class="sc-header">${t('airBridgesCardLogin')}</div>
        <div class="sc-body" style="align-items:center;">
          <img id="wx-qr-img" style="max-width:180px;border-radius:8px;border:2px solid var(--line);display:none;" alt="QR" />
          <div id="wx-login-status" style="font-size:12px;margin:4px 0;"></div>
          <div style="display:flex;gap:8px;">
            <button class="btn" id="wx-btn-qr" type="button">${t('airBridgesBtnGetQr')}</button>
            <button class="btn btn-danger" id="wx-btn-logout" type="button" style="display:none;">${t('airBridgesBtnLogout')}</button>
          </div>
          <div style="font-size:11px;color:var(--faint);line-height:1.5;text-align:center;margin-top:4px;">${t('airBridgesWechatQrHint')}</div>
        </div>
      </div>
      <div class="settings-card">
        <div class="sc-header">${t('airBridgesCardGateway')} <span id="wx-gw-state" class="bridge-badge" style="margin-left:8px;">${uncreated()}</span></div>
        <div class="sc-body">
          <div class="setting-row" id="wx-gw-cli-row">
            <label>Agent</label>
            <div style="display:flex;gap:12px;">
              <label style="display:flex;align-items:center;gap:4px;font-size:12px;cursor:pointer;flex:none;"><input type="radio" name="wx-gw-cli" value="claude" checked /> Claude</label>
              <label style="display:flex;align-items:center;gap:4px;font-size:12px;cursor:pointer;flex:none;"><input type="radio" name="wx-gw-cli" value="codex" /> Codex</label>
            </div>
          </div>
          <div class="setting-row"><span>${t('airBridgesWechatGatewayHint')}</span></div>
        </div>
        <div class="sc-footer">
          <button class="btn btn-green" id="wx-gw-create" type="button">${t('airBridgesBtnCreateGateway')}</button>
          <button class="btn" id="wx-gw-open" type="button" style="display:none;">${t('airBridgesBtnOpenChat')}</button>
          <button class="btn" id="wx-gw-reset" type="button" style="display:none;">${t('airBridgesBtnResetChat')}</button>
          <button class="btn btn-danger" id="wx-gw-destroy" type="button" style="display:none;">${t('airBridgesBtnDestroy')}</button>
          <span class="status-text" id="wx-gw-status"></span>
        </div>
      </div>
      <div class="settings-card">
        <div class="sc-header">${t('airBridgesCardRun')}</div>
        <div class="sc-body"><div class="setting-row"><label>${t('airBridgesFieldIdle')}</label><input id="wx-idle" type="number" value="5000" min="2000" step="500" /></div></div>
        <div class="sc-footer">
          <button class="btn btn-green" id="wx-btn-start" type="button">${t('airBridgesBtnStart')}</button>
          <button class="btn btn-danger" id="wx-btn-stop" type="button" disabled>${t('airBridgesBtnStop')}</button>
          <button class="btn" id="wx-btn-save" type="button">${t('airBridgesBtnSave')}</button>
          <span class="status-text" id="wx-status"></span>
        </div>
      </div>
      <div class="settings-card">
        <div class="sc-header">${t('airBridgesCardLog')} <span id="wx-running-badge" class="bridge-badge" style="display:none;margin-left:8px;">Running</span></div>
        <div id="wx-log" class="bridge-log">
          <div class="bridge-idle" style="text-align:center;">${t('airBridgesLogIdle')}</div>
        </div>
      </div>
    </div>
  </details>`;
  }

  function feishuBlock() {
    return `
  <details class="bridge-acc">
    <summary class="bridge-sum"><span class="ic">📨</span> ${t('airBridgesPlatformFeishu')} <span class="bridge-hint">${t('airBridgesHintFeishu')}</span></summary>
    <div class="bridge-body">
      <div class="settings-card">
        <div class="sc-header">${t('airBridgesCardCredentials')} <span id="fs-cfg-state" class="bridge-badge" style="margin-left:8px;">${unconfigured()}</span></div>
        <div class="sc-body">
          <div class="setting-row"><label>App ID</label><input id="fs-appid" type="text" placeholder="cli_xxxxxxxx" autocomplete="off" /></div>
          <div class="setting-row"><label>App Secret</label><input id="fs-appsecret" type="password" placeholder="${t('airBridgesKeepSecret')}" autocomplete="off" /></div>
          <div class="setting-row"><label>${t('airBridgesFieldDomain')}</label>
            <select id="fs-domain">
              <option value="feishu" selected>${t('airBridgesDomainFeishu')}</option>
              <option value="lark">${t('airBridgesDomainLark')}</option>
            </select>
          </div>
          <div class="setting-row"><span>${t('airBridgesFeishuCredHint')}</span></div>
        </div>
        <div class="sc-footer">
          <button class="btn" id="fs-btn-save" type="button">${t('airBridgesBtnSaveCredentials')}</button>
          <span class="status-text" id="fs-cfg-status"></span>
        </div>
      </div>
      <div class="settings-card">
        <div class="sc-header">${t('airBridgesCardGateway')} <span id="fs-gw-state" class="bridge-badge" style="margin-left:8px;">${uncreated()}</span></div>
        <div class="sc-body">
          <div class="setting-row" id="fs-gw-cli-row">
            <label>Agent</label>
            <div style="display:flex;gap:12px;">
              <label style="display:flex;align-items:center;gap:4px;font-size:12px;cursor:pointer;flex:none;"><input type="radio" name="fs-gw-cli" value="claude" checked /> Claude</label>
              <label style="display:flex;align-items:center;gap:4px;font-size:12px;cursor:pointer;flex:none;"><input type="radio" name="fs-gw-cli" value="codex" /> Codex</label>
            </div>
          </div>
          <div class="setting-row"><span>${t('airBridgesTokenGatewayHint', { session: '__feishu_gateway__' })}</span></div>
        </div>
        <div class="sc-footer">
          <button class="btn btn-green" id="fs-gw-create" type="button">${t('airBridgesBtnCreateGateway')}</button>
          <button class="btn" id="fs-gw-open" type="button" style="display:none;">${t('airBridgesBtnOpenChat')}</button>
          <button class="btn" id="fs-gw-reset" type="button" style="display:none;">${t('airBridgesBtnResetChat')}</button>
          <button class="btn btn-danger" id="fs-gw-destroy" type="button" style="display:none;">${t('airBridgesBtnDestroy')}</button>
          <span class="status-text" id="fs-gw-status"></span>
        </div>
      </div>
      <div class="settings-card">
        <div class="sc-header">${t('airBridgesCardRun')} <span id="fs-ws-badge" class="bridge-badge" style="display:none;margin-left:8px;">${t('airBridgesBadgeLongConn')}</span></div>
        <div class="sc-body"><div class="setting-row"><span>${t('airBridgesFeishuRunHint')}</span></div></div>
        <div class="sc-footer">
          <button class="btn btn-green" id="fs-btn-start" type="button">${t('airBridgesBtnStart')}</button>
          <button class="btn btn-danger" id="fs-btn-stop" type="button" disabled>${t('airBridgesBtnStop')}</button>
          <span class="status-text" id="fs-status"></span>
        </div>
      </div>
      <div class="settings-card">
        <div class="sc-header">${t('airBridgesCardLog')} <span id="fs-running-badge" class="bridge-badge" style="display:none;margin-left:8px;">Running</span></div>
        <div id="fs-log" class="bridge-log">
          <div class="bridge-idle" style="text-align:center;">${t('airBridgesLogIdle')}</div>
        </div>
      </div>
    </div>
  </details>`;
  }

  function tokenBlock(spec) {
    const { idp, icon, name, fields, runBadge } = spec;
    const rows = fields.map(field => `
          <div class="setting-row"><label>${esc(field.label)}</label><input id="${idp}-${field.id}" type="password" placeholder="${esc(field.placeholder)}${esc(t('airBridgesKeepSecret'))}" autocomplete="off" /></div>`).join('');
    const badge = runBadge ? ` <span id="${idp}-ws-badge" class="bridge-badge" style="display:none;margin-left:8px;">${t(runBadge)}</span>` : '';
    // 桥接运行卡上的说明：feishu 那条是「WebSocket 长连接」，三个 token 平台各自不同
    // （长轮询 / Gateway WS / Socket Mode），所以按平台给 key。
    const runHintKey = {
      telegram: 'airBridgesTelegramRunHint',
      discord: 'airBridgesDiscordRunHint',
      slack: 'airBridgesSlackRunHint',
    }[spec.platform];
    const credHintKey = {
      telegram: 'airBridgesTelegramCredHint',
      discord: 'airBridgesDiscordCredHint',
      slack: 'airBridgesSlackCredHint',
    }[spec.platform];
    return `
  <details class="bridge-acc">
    <summary class="bridge-sum"><span class="ic">${icon}</span> ${esc(name)} <span id="${idp}-cfg-state" class="bridge-badge">${unconfigured()}</span></summary>
    <div class="bridge-body">
      <div class="settings-card">
        <div class="sc-header">${t('airBridgesCardCredentials')}</div>
        <div class="sc-body">${rows}
          <div class="setting-row"><span>${t(credHintKey)}</span></div>
        </div>
        <div class="sc-footer">
          <button class="btn" id="${idp}-btn-save" type="button">${t('airBridgesBtnSaveCredentials')}</button>
          <span class="status-text" id="${idp}-cfg-status"></span>
        </div>
      </div>
      <div class="settings-card">
        <div class="sc-header">${t('airBridgesCardGateway')} <span id="${idp}-gw-state" class="bridge-badge" style="margin-left:8px;">${uncreated()}</span></div>
        <div class="sc-body">
          <div class="setting-row" id="${idp}-gw-cli-row">
            <label>Agent</label>
            <div style="display:flex;gap:12px;">
              <label style="display:flex;align-items:center;gap:4px;font-size:12px;cursor:pointer;flex:none;"><input type="radio" name="${idp}-gw-cli" value="claude" checked /> Claude</label>
              <label style="display:flex;align-items:center;gap:4px;font-size:12px;cursor:pointer;flex:none;"><input type="radio" name="${idp}-gw-cli" value="codex" /> Codex</label>
            </div>
          </div>
          <div class="setting-row"><span>${t('airBridgesTokenGatewayHint', { session: `__${spec.platform}_gateway__` })}</span></div>
        </div>
        <div class="sc-footer">
          <button class="btn btn-green" id="${idp}-gw-create" type="button">${t('airBridgesBtnCreateGateway')}</button>
          <button class="btn" id="${idp}-gw-open" type="button" style="display:none;">${t('airBridgesBtnOpenChat')}</button>
          <button class="btn" id="${idp}-gw-reset" type="button" style="display:none;">${t('airBridgesBtnResetChat')}</button>
          <button class="btn btn-danger" id="${idp}-gw-destroy" type="button" style="display:none;">${t('airBridgesBtnDestroy')}</button>
          <span class="status-text" id="${idp}-gw-status"></span>
        </div>
      </div>
      <div class="settings-card">
        <div class="sc-header">${t('airBridgesCardRun')}${badge}</div>
        <div class="sc-body"><div class="setting-row"><span>${t(runHintKey)}</span></div></div>
        <div class="sc-footer">
          <button class="btn btn-green" id="${idp}-btn-start" type="button">${t('airBridgesBtnStart')}</button>
          <button class="btn btn-danger" id="${idp}-btn-stop" type="button" disabled>${t('airBridgesBtnStop')}</button>
          <span class="status-text" id="${idp}-status"></span>
        </div>
      </div>
      <div class="settings-card">
        <div class="sc-header">${t('airBridgesCardLog')} <span id="${idp}-running-badge" class="bridge-badge" style="display:none;margin-left:8px;">Running</span></div>
        <div id="${idp}-log" class="bridge-log">
          <div class="bridge-idle" style="text-align:center;">${t('airBridgesLogIdle')}</div>
        </div>
      </div>
    </div>
  </details>`;
  }

  function markup() {
    return `<style>${styles()}</style>
<div class="air-bridges">
  <section class="admin-panel">
    <div class="admin-panel-head">
      <div><span class="eyebrow">BRIDGES</span><h3>${t('airBridgesTitle')}</h3></div>
    </div>
    <p class="air-bridges-intro">${t('airBridgesIntro')}</p>
  </section>${wechatBlock()}${feishuBlock()}${TOKEN_PLATFORMS.map(tokenBlock).join('')}
</div>`;
  }

  // ── 按 id 接旧页那些内联回调 ─────────────────────────────────────────────
  // 旧页是 `onclick="wechatGetQR()"`（依赖 window 上的全局函数）；Air 的原生面板不写
  // 内联属性，改成这里按 id 接一遍。名字与 manage-bridges.js 挂出来的全局一一对应。
  // 保存凭证那几颗旧页压根没有 id（只有内联 onclick），这里补上 id 才接得到。
  const SIMPLE_BINDINGS = {
    'wx-btn-qr': () => root.wechatGetQR(),
    'wx-btn-logout': () => root.wechatLogout(),
    'wx-gw-create': () => root.wechatGatewayCreate(),
    'wx-gw-open': () => root.wechatGatewayOpen(),
    'wx-gw-reset': () => root.wechatGatewayReset(),
    'wx-gw-destroy': () => root.wechatGatewayDestroy(),
    'wx-btn-start': () => root.wechatStart(),
    'wx-btn-stop': () => root.wechatStop(),
    'wx-btn-save': () => root.wechatSaveConfig(),
    'fs-btn-save': () => root.feishuSaveConfig(),
    'fs-gw-create': () => root.feishuGatewayCreate(),
    'fs-gw-open': () => root.feishuGatewayOpen(),
    'fs-gw-reset': () => root.feishuGatewayReset(),
    'fs-gw-destroy': () => root.feishuGatewayDestroy(),
    'fs-btn-start': () => root.feishuStart(),
    'fs-btn-stop': () => root.feishuStop(),
  };

  function wire(fragment) {
    for (const [id, handler] of Object.entries(SIMPLE_BINDINGS)) {
      const node = fragment.querySelector('#' + id);
      if (node) node.onclick = handler;
    }
    // Telegram / Discord / Slack 共用一组全局，第一个参数是平台名。
    for (const spec of TOKEN_PLATFORMS) {
      const call = name => () => root[name](spec.platform);
      const pairs = [
        [`${spec.idp}-btn-save`, call('bridgeSaveConfig')],
        [`${spec.idp}-btn-start`, call('bridgeStart')],
        [`${spec.idp}-btn-stop`, call('bridgeStop')],
        [`${spec.idp}-gw-create`, call('bridgeGatewayCreate')],
        [`${spec.idp}-gw-open`, call('bridgeGatewayOpen')],
        [`${spec.idp}-gw-reset`, call('bridgeGatewayReset')],
        [`${spec.idp}-gw-destroy`, call('bridgeGatewayDestroy')],
      ];
      for (const [id, handler] of pairs) {
        const node = fragment.querySelector('#' + id);
        if (node) node.onclick = handler;
      }
    }
  }

  function build() {
    const template = document.createElement('template');
    template.innerHTML = markup();
    wire(template.content);
    return template.content;
  }

  function render(host, ctx) {
    context = ctx;
    // 顺序要紧：先把上一轮那几条 EventSource 关掉，再换骨架，最后才 initialize()。
    // 反过来的话 initialize() 会把新连接建在被 replaceChildren 掉的旧节点旁边，
    // 而上一轮那几条永远不会有人关（见文件头那段说明）。
    root.MultiCCManageBridges?.disconnect();
    host.replaceChildren(build());
    return root.MultiCCManageBridges?.initialize();
  }

  // 刷新就是让五个平台各自重读一次 config + status（不重建骨架：日志容器里已经画好的
  // 那几十行、以及用户展开/收起哪一个平台的状态，都不该被一次刷新抹掉）。
  function refresh() { return root.MultiCCManageBridges?.initialize(); }

  root.MultiCCAirBridges = Object.freeze({ render, refresh });
})(typeof window !== 'undefined' ? window : null);
