'use strict';

(function initAirTunnel(root) {
  if (!root || !root.document) return;
  const document = root.document;
  const PROVIDERS = Object.freeze([
    { id: 'phddns', name: '花生壳', cli: false, placeholder: 'https://xxxx.vicp.fun/manage' },
    { id: 'natapp', name: 'Natapp', cli: true, placeholder: 'https://your-tunnel.example.com' },
    { id: 'cpolar', name: 'cpolar', cli: true, placeholder: 'https://your-tunnel.example.com' },
  ]);

  let host = null;
  let context = null;
  let snapshot = null;
  let loadGeneration = 0;

  const byId = id => document.getElementById(id);
  const esc = value => String(value == null ? '' : value)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');

  function compatibilityCard(provider) {
    const secret = provider.cli ? `
      <label><span>访问凭证</span><input id="air-${provider.id}-token" type="password" autocomplete="new-password" placeholder="未设置；已设置时留空不修改"></label>
      <label><span>本地端口</span><input id="air-${provider.id}-port" type="number" min="1" max="65535" value="3000"></label>
      <label class="wide"><span>启动命令（高级）</span><input id="air-${provider.id}-cmd" type="text" placeholder="支持 {authtoken} / {port} 占位符"></label>` : '';
    return `
      <article class="air-tunnel-compat" data-provider="${provider.id}">
        <div class="air-tunnel-compat-head">
          <div><strong>${esc(provider.name)}</strong><small id="air-${provider.id}-availability">正在读取客户端…</small></div>
          <span id="air-${provider.id}-health" class="air-tunnel-chip neutral">读取中</span>
        </div>
        <div class="air-tunnel-form-grid">
          <label><span>公网探活 URL</span><input id="air-${provider.id}-url" type="url" placeholder="${esc(provider.placeholder)}"></label>
          ${secret}
        </div>
        <div class="air-tunnel-switches">
          <label><input id="air-${provider.id}-enabled" type="checkbox"> 启用健康监控</label>
          <label><input id="air-${provider.id}-monitor" type="checkbox"> 仅告警，不自动重启</label>
        </div>
        <div class="air-tunnel-actions">
          <button type="button" data-save-provider="${provider.id}">保存</button>
          <button type="button" data-restart-provider="${provider.id}">立即重启</button>
          <span id="air-${provider.id}-message" class="air-tunnel-message" role="status"></span>
        </div>
      </article>`;
  }

  function markup() {
    return `
      <div class="air-tunnel-page">
        <section class="air-tunnel-hero">
          <div class="air-tunnel-hero-copy">
            <span class="eyebrow">ONE-STOP REMOTE ACCESS</span>
            <h2>按所在地区，走更合适的公网入口</h2>
            <p>中国大陆优先使用 SakuraFrp，获得更稳定的境内链路；海外优先使用 Tailscale Funnel，登录后即可发布 HTTPS。两条路径都在本页完成配置与诊断。</p>
          </div>
          <div class="air-tunnel-route-map" aria-label="地区分流方案">
            <a href="#air-tunnel-cn"><b>中国大陆</b><span>SakuraFrp · 国内节点</span><em>推荐</em></a>
            <span aria-hidden="true">或</span>
            <a href="#air-tunnel-global"><b>海外地区</b><span>Tailscale · 全球边缘</span><em>推荐</em></a>
          </div>
        </section>

        <section class="air-tunnel-security admin-panel" aria-labelledby="air-tunnel-security-title">
          <div class="air-tunnel-security-mark">⌁</div>
          <div class="air-tunnel-security-copy">
            <span class="eyebrow">PUBLIC ACCESS GUARD</span>
            <h3 id="air-tunnel-security-title">先保护公网入口</h3>
            <p id="air-access-copy">正在检查 MultiCC 访问密码…</p>
          </div>
          <span id="air-access-status" class="air-tunnel-chip neutral">读取中</span>
          <div id="air-access-editor" class="air-tunnel-security-editor" hidden>
            <input id="air-access-token" type="password" autocomplete="new-password" placeholder="输入新的访问密码">
            <button id="air-access-save" type="button">保存 / 更新</button>
            <button id="air-access-clear" class="subtle" type="button" hidden>清除</button>
          </div>
          <span id="air-access-message" class="air-tunnel-message" role="status"></span>
        </section>

        <div class="air-tunnel-route-grid">
          <section id="air-tunnel-cn" class="air-tunnel-route cn" aria-labelledby="air-tunnel-cn-title">
            <header>
              <span class="air-tunnel-region">CN</span>
              <div><span class="eyebrow">中国大陆方案</span><h3 id="air-tunnel-cn-title">SakuraFrp · 樱花内网穿透</h3><p>适合国内网络与没有公网 IPv6 的设备。</p></div>
              <span class="air-tunnel-recommend">国内推荐</span>
            </header>
            <div class="air-tunnel-facts">
              <div><span>账户</span><strong id="air-sf-account">读取中…</strong></div>
              <div><span>命令行客户端</span><strong id="air-sf-client">检测中…</strong></div>
              <div class="wide"><span>隧道</span><strong id="air-sf-tunnel">读取中…</strong></div>
            </div>
            <ol class="air-tunnel-steps">
              <li>
                <div class="air-tunnel-step-no">1</div>
                <div class="air-tunnel-step-body">
                  <h4>绑定 SakuraFrp 访问密钥</h4>
                  <p>还没有账号时先到官方控制台注册、实名并创建隧道；已有启动器登录会自动读取密钥。</p>
                  <div class="air-tunnel-inline-form">
                    <input id="air-sf-key" type="password" autocomplete="new-password" placeholder="输入访问密钥；已绑定时留空不修改">
                    <button id="air-sf-bind" type="button">绑定密钥</button>
                    <a href="https://www.natfrp.com/user/" target="_blank" rel="noopener noreferrer">打开官方控制台 ↗</a>
                  </div>
                  <small>密钥只发送到本机 MultiCC，不会在页面中回显。</small>
                </div>
              </li>
              <li>
                <div class="air-tunnel-step-no">2</div>
                <div class="air-tunnel-step-body">
                  <h4>安装独立 frpc 客户端</h4>
                  <p>直接下载官方二进制并校验，无需安装 SakuraLauncher。</p>
                  <button id="air-sf-install" type="button">安装 / 校验 frpc</button>
                </div>
              </li>
              <li>
                <div class="air-tunnel-step-no">3</div>
                <div class="air-tunnel-step-body">
                  <h4>确认公网地址并开启监控</h4>
                  <label class="air-tunnel-field"><span>公网 URL</span><input id="air-sf-url" type="url" placeholder="回填后会显示在这里，也可手动填写"></label>
                  <div id="air-sf-domain-wrap" class="air-tunnel-domain" hidden>
                    <label class="air-tunnel-field"><span>控制台绑定的 nyat.app 域名</span><input id="air-sf-domain" type="text" placeholder="例如 app.example.nyat.app"></label>
                    <button id="air-sf-backfill" type="button">回填 HTTPS 地址</button>
                  </div>
                  <div class="air-tunnel-switches">
                    <label><input id="air-sf-enabled" type="checkbox"> 启用健康监控</label>
                    <label><input id="air-sf-monitor" type="checkbox"> 仅告警，不自动重启</label>
                  </div>
                  <div class="air-tunnel-actions">
                    <button id="air-sf-save" class="primary" type="button">保存国内方案</button>
                    <button id="air-sf-restart" type="button">启动 / 重启隧道</button>
                  </div>
                </div>
              </li>
            </ol>
            <p id="air-sf-message" class="air-tunnel-message" role="status"></p>
          </section>

          <section id="air-tunnel-global" class="air-tunnel-route global" aria-labelledby="air-tunnel-global-title">
            <header>
              <span class="air-tunnel-region">GL</span>
              <div><span class="eyebrow">海外方案</span><h3 id="air-tunnel-global-title">Tailscale Funnel</h3><p>OAuth 登录后直接获得公网 HTTPS，无需购买域名。</p></div>
              <span class="air-tunnel-recommend">海外推荐</span>
            </header>
            <div class="air-tunnel-facts">
              <div><span>客户端</span><strong id="air-ts-client">检测中…</strong></div>
              <div><span>Funnel</span><strong id="air-ts-funnel-state">读取中…</strong></div>
              <div class="wide"><span>公网地址</span><strong id="air-ts-public-url">等待公网探测…</strong></div>
            </div>
            <ol class="air-tunnel-steps">
              <li>
                <div class="air-tunnel-step-no">1</div>
                <div class="air-tunnel-step-body">
                  <h4>安装并登录 Tailscale</h4>
                  <p>用任意支持的 OAuth 账号登录；如果已经登录，可直接进入下一步。</p>
                  <div class="air-tunnel-actions">
                    <a class="air-tunnel-button" href="https://tailscale.com/download" target="_blank" rel="noopener noreferrer">下载 Tailscale ↗</a>
                    <button id="air-ts-restart" type="button">重连控制面</button>
                  </div>
                </div>
              </li>
              <li>
                <div class="air-tunnel-step-no">2</div>
                <div class="air-tunnel-step-body">
                  <h4>发布 MultiCC 到公网</h4>
                  <label class="air-tunnel-field compact"><span>本地端口</span><input id="air-ts-port" type="number" min="1" max="65535" value="3000"></label>
                  <div class="air-tunnel-switches">
                    <label><input id="air-ts-enabled" type="checkbox"> 启用健康监控</label>
                    <label><input id="air-ts-monitor" type="checkbox"> 仅告警，不自动修复</label>
                  </div>
                  <div class="air-tunnel-actions">
                    <button id="air-ts-toggle" class="primary" type="button">开启 Funnel</button>
                    <button id="air-ts-save" type="button">仅保存监控设置</button>
                  </div>
                </div>
              </li>
              <li>
                <div class="air-tunnel-step-no">3</div>
                <div class="air-tunnel-step-body">
                  <h4>检查直连质量</h4>
                  <p id="air-ts-ipv6">正在检测本机 IPv6 与 Tailscale 直连能力…</p>
                  <button id="air-ts-ipv6-check" type="button">重新检测 IPv6</button>
                  <pre id="air-ts-funnel-detail" class="air-tunnel-detail">正在读取 Funnel 映射…</pre>
                </div>
              </li>
            </ol>
            <p id="air-ts-message" class="air-tunnel-message" role="status"></p>
          </section>
        </div>

        <details class="air-tunnel-advanced">
          <summary><span><b>高级与兼容隧道</b><small>花生壳 / Natapp / cpolar / 探活与修复参数</small></span><span>展开配置</span></summary>
          <div class="air-tunnel-advanced-body">
            <section class="admin-panel">
              <div class="admin-panel-head"><div><span class="eyebrow">MONITOR POLICY</span><h3>探活与自动修复</h3></div></div>
              <div class="air-tunnel-form-grid policy">
                <label><span>探活间隔（秒）</span><input id="air-tunnel-interval" type="number" min="10"></label>
                <label><span>失败阈值（次）</span><input id="air-tunnel-threshold" type="number" min="1"></label>
                <label><span>重启冷却（秒）</span><input id="air-tunnel-cooldown" type="number" min="0"></label>
                <label><span>每小时重试上限</span><input id="air-tunnel-max-restarts" type="number" min="1"></label>
              </div>
              <div class="air-tunnel-actions"><button id="air-tunnel-policy-save" type="button">保存监控参数</button><span id="air-tunnel-policy-message" class="air-tunnel-message" role="status"></span></div>
            </section>
            <div class="air-tunnel-compat-grid">${PROVIDERS.map(compatibilityCard).join('')}</div>
          </div>
        </details>
      </div>`;
  }

  function setText(id, value) {
    const node = byId(id);
    if (node) node.textContent = value == null || value === '' ? '—' : String(value);
  }

  function setMessage(id, value = '', tone = '') {
    const node = byId(id);
    if (!node) return;
    node.textContent = value;
    node.className = `air-tunnel-message${tone ? ` ${tone}` : ''}`;
  }

  function setChip(id, value, tone = 'neutral') {
    const node = byId(id);
    if (!node) return;
    node.textContent = value;
    node.className = `air-tunnel-chip ${tone}`;
  }

  function setValue(id, value) {
    const node = byId(id);
    if (node && document.activeElement !== node) node.value = value == null ? '' : String(value);
  }

  function setChecked(id, value) {
    const node = byId(id);
    if (node) node.checked = !!value;
  }

  function formatBytes(value) {
    let n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let index = 0;
    while (n >= 1024 && index < units.length - 1) { n /= 1024; index += 1; }
    return `${n.toFixed(n >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
  }

  function providerHealth(provider, config, available) {
    if (!config?.enabled && !config?.funnel) return { text: '未启用', tone: 'neutral' };
    if (available === false) return { text: '客户端未安装', tone: 'warning' };
    if (!provider?.lastCheckAt) return { text: '等待首次探活', tone: 'info' };
    if (provider.probeVerdict === 'degraded') return { text: '部分边缘异常', tone: 'warning' };
    if (provider.probeVerdict === 'indeterminate') return { text: '探针不确定', tone: 'warning' };
    return provider.healthy
      ? { text: `健康${provider.lastHttpCode ? ` · HTTP ${provider.lastHttpCode}` : ''}`, tone: 'success' }
      : { text: `异常 · 连续 ${provider.consecutiveFails || 0} 次`, tone: 'danger' };
  }

  function sanitizeSettings(settings) {
    const configs = settings?.config || {};
    for (const provider of ['natapp', 'cpolar', 'sakurafrp']) {
      const config = configs[provider];
      if (!config || typeof config !== 'object') continue;
      config.hasAuthtoken = !!config.authtoken;
      delete config.authtoken;
    }
    return settings;
  }

  async function softRequest(path) {
    try { return await context.api(path); }
    catch (error) {
      return { ok: false, reason: error.reason || error.code || 'unavailable', message: error.message || '请求失败' };
    }
  }

  async function load() {
    if (!context || !host) return;
    const generation = ++loadGeneration;
    setMessage('air-sf-message', '正在读取 SakuraFrp 账户与隧道…');
    setMessage('air-ts-message', '正在读取 Tailscale 状态…');
    const [settings, access, sakura, funnel, ipv6] = await Promise.all([
      softRequest('/api/settings/tunnel'),
      softRequest('/api/settings/access-token'),
      softRequest('/api/tunnel/sakurafrp'),
      softRequest('/api/tunnel/funnel'),
      softRequest('/api/tunnel/ipv6'),
    ]);
    if (generation !== loadGeneration || !host.isConnected) return;
    snapshot = { settings: sanitizeSettings(settings), access, sakura, funnel, ipv6 };
    paint();
  }

  function paintAccess() {
    const access = snapshot.access || {};
    const editor = byId('air-access-editor');
    const input = byId('air-access-token');
    const clear = byId('air-access-clear');
    if (!access.ok && access.reason) {
      setChip('air-access-status', '读取失败', 'danger');
      setText('air-access-copy', access.message || '无法读取访问密码状态。');
      if (editor) editor.hidden = true;
      return;
    }
    setChip('air-access-status', access.hasToken ? '已保护' : '未设置', access.hasToken ? 'success' : 'danger');
    setText('air-access-copy', access.hasToken
      ? `已设置访问密码${access.masked ? `（${access.masked}）` : ''}。公网访问会先经过登录验证。`
      : '尚未设置访问密码。开启任一公网入口前必须先在本机设置。');
    if (editor) editor.hidden = !access.canEdit;
    if (input) input.placeholder = access.hasToken ? '输入新值可更新，留空不修改' : '至少 8 位，建议使用随机密码';
    if (clear) clear.hidden = !access.hasToken;
    if (!access.canEdit && editor) editor.hidden = true;
  }

  function paintSakura() {
    const settings = snapshot.settings || {};
    const config = settings.config?.sakurafrp || {};
    const runtime = settings.providers?.sakurafrp || {};
    const available = settings.availability?.sakurafrp;
    const sakura = snapshot.sakura || {};
    const health = providerHealth(runtime, config, available);
    setText('air-sf-client', available ? '已安装 · 可由 MultiCC 托管' : '未检测到 · 可在第 2 步安装');
    if (sakura.ok) {
      const user = sakura.user || {};
      setText('air-sf-account', `${user.name || user.id || '已绑定'} · ${user.realname ? '已实名' : '未实名'} · ${user.signed ? '已签到' : '未签到'} · ${formatBytes(user.trafficUsed)}/${formatBytes(user.trafficTotal)}`);
      const access = sakura.access;
      if (access) {
        const reach = access.needsBoundDomain ? '等待填写 nyat.app 域名' : (access.publicUrl || config.url || '等待回填公网地址');
        setText('air-sf-tunnel', `${access.name || access.tunnelId || '隧道'} · ${access.online ? '在线' : '离线'} · ${access.nodeName || access.nodeHost || '节点未知'} · ${reach}`);
      } else setText('air-sf-tunnel', sakura.tunnelCount ? `已发现 ${sakura.tunnelCount} 条隧道` : '还没有隧道，请先在官方控制台创建');
    } else {
      setText('air-sf-account', sakura.reason === 'no_token' ? '未绑定访问密钥' : `读取失败 · ${sakura.message || sakura.reason || 'API 不可用'}`);
      setText('air-sf-tunnel', '等待账户绑定');
    }
    setValue('air-sf-url', config.url || sakura.configUrl || '');
    setChecked('air-sf-enabled', config.enabled);
    setChecked('air-sf-monitor', config.monitorOnly);
    const domainWrap = byId('air-sf-domain-wrap');
    if (domainWrap) domainWrap.hidden = !sakura.needsBoundDomain;
    const backfill = byId('air-sf-backfill');
    if (backfill) backfill.disabled = !sakura.ok;
    const restart = byId('air-sf-restart');
    if (restart) restart.disabled = !available || !!config.monitorOnly;
    setMessage('air-sf-message', `${health.text}${runtime.lastAction ? ` · 最近动作：${runtime.lastAction}` : ''}`, health.tone);
  }

  function paintTailscale() {
    const settings = snapshot.settings || {};
    const config = settings.config?.tailscale || {};
    const runtime = settings.providers?.tailscale || {};
    const available = settings.availability?.tailscale;
    const health = providerHealth(runtime, config, available);
    setText('air-ts-client', available ? 'CLI 可用' : '未检测到 Tailscale CLI');
    setText('air-ts-funnel-state', config.funnel ? `已开启 · 端口 ${config.funnelPort || 3000}` : '未开启');
    setText('air-ts-public-url', runtime.publicUrl || '等待 Funnel 分配公网地址');
    setValue('air-ts-port', config.funnelPort || 3000);
    setChecked('air-ts-enabled', config.enabled);
    setChecked('air-ts-monitor', config.monitorOnly);
    const toggle = byId('air-ts-toggle');
    if (toggle) {
      toggle.textContent = config.funnel ? '关闭 Funnel' : '开启 Funnel';
      toggle.classList.toggle('danger', !!config.funnel);
      toggle.classList.toggle('primary', !config.funnel);
      toggle.disabled = !available;
    }
    const restart = byId('air-ts-restart');
    if (restart) restart.disabled = !available || !!config.monitorOnly;
    const ipv6 = snapshot.ipv6 || {};
    let ipv6Text = ipv6.directReady ? 'IPv6 直连已就绪，远程连接可绕开 DERP 中继。'
      : (!ipv6.host?.hasGlobalV6 ? '本机暂无全局 IPv6；仍可通过 Funnel 公网边缘访问。'
        : '本机有全局 IPv6，但 Tailscale 直连尚未确认。');
    if (ipv6.message && !ipv6.host) ipv6Text = `IPv6 检测失败：${ipv6.message}`;
    setText('air-ts-ipv6', ipv6Text);
    setText('air-ts-funnel-detail', snapshot.funnel?.status?.trim() || 'No serve config');
    setMessage('air-ts-message', `${health.text}${runtime.lastAction ? ` · 最近动作：${runtime.lastAction}` : ''}`, health.tone);
  }

  function paintAdvanced() {
    const settings = snapshot.settings || {};
    const config = settings.config || {};
    setValue('air-tunnel-interval', config.intervalSec);
    setValue('air-tunnel-threshold', config.failThreshold);
    setValue('air-tunnel-cooldown', config.restartCooldownSec);
    setValue('air-tunnel-max-restarts', config.maxRestartsPerHour);
    for (const provider of PROVIDERS) {
      const providerConfig = config[provider.id] || {};
      const available = settings.availability?.[provider.id];
      const health = providerHealth(settings.providers?.[provider.id] || {}, providerConfig, available);
      setText(`air-${provider.id}-availability`, available ? '客户端可用' : '未检测到客户端');
      setChip(`air-${provider.id}-health`, health.text, health.tone);
      setValue(`air-${provider.id}-url`, providerConfig.url || '');
      setChecked(`air-${provider.id}-enabled`, providerConfig.enabled);
      setChecked(`air-${provider.id}-monitor`, providerConfig.monitorOnly);
      if (provider.cli) {
        setValue(`air-${provider.id}-port`, providerConfig.port || 3000);
        setValue(`air-${provider.id}-cmd`, providerConfig.startCmd || '');
        const token = byId(`air-${provider.id}-token`);
        if (token) token.placeholder = providerConfig.hasAuthtoken ? '已设置；留空不修改' : '尚未设置';
      }
      const restart = host.querySelector(`[data-restart-provider="${provider.id}"]`);
      if (restart) restart.disabled = !available || !!providerConfig.monitorOnly;
    }
  }

  function paint() {
    paintAccess();
    paintSakura();
    paintTailscale();
    paintAdvanced();
  }

  async function busy(button, label, work) {
    if (!button || button.disabled) return;
    const original = button.textContent;
    button.disabled = true;
    button.textContent = label;
    try { await work(); }
    finally {
      if (button.isConnected) {
        button.disabled = false;
        // A refresh may have repainted a stateful label (for example
        // “开启 Funnel” → “关闭 Funnel”). Do not overwrite that newer truth.
        if (button.textContent === label) button.textContent = original;
      }
    }
  }

  function requireAccessPassword() {
    if (snapshot?.access?.hasToken) return;
    throw new Error('请先在页面顶部设置 MultiCC 访问密码，再开启公网入口。');
  }

  async function bindSakura() {
    const input = byId('air-sf-key');
    const token = input?.value.trim() || '';
    if (!token) throw new Error('请输入 SakuraFrp 访问密钥。');
    await context.api('/api/settings/tunnel', { sakurafrp: { authtoken: token } }, 'POST');
    input.value = '';
    await load();
    setMessage('air-sf-message', '访问密钥已绑定，账户与隧道信息已刷新。', 'success');
  }

  async function installSakura() {
    const result = await context.api('/api/tunnel/sakurafrp/install', {}, 'POST');
    await load();
    setMessage('air-sf-message', `frpc ${result.version || ''} 已安装${result.path ? ` · ${result.path}` : ''}`, 'success');
  }

  async function backfillSakura() {
    const boundDomain = byId('air-sf-domain')?.value.trim() || '';
    const result = await context.api('/api/tunnel/sakurafrp/public-url', { boundDomain }, 'POST');
    setValue('air-sf-url', result.url || '');
    await load();
    setMessage('air-sf-message', `公网地址已回填：${result.url}`, 'success');
  }

  async function saveSakura() {
    const enabled = !!byId('air-sf-enabled')?.checked;
    if (enabled) requireAccessPassword();
    const update = {
      enabled,
      monitorOnly: !!byId('air-sf-monitor')?.checked,
      url: byId('air-sf-url')?.value.trim() || '',
    };
    const token = byId('air-sf-key')?.value.trim();
    if (token) update.authtoken = token;
    await context.api('/api/settings/tunnel', { sakurafrp: update }, 'POST');
    if (byId('air-sf-key')) byId('air-sf-key').value = '';
    await load();
    setMessage('air-sf-message', '国内方案已保存。', 'success');
  }

  async function restartProvider(provider, messageId) {
    const result = await context.api(`/api/tunnel/restart/${provider}`, {}, 'POST');
    await load();
    setMessage(messageId, result.message || '已触发重启。', 'success');
  }

  async function saveTailscale() {
    const enabled = !!byId('air-ts-enabled')?.checked;
    if (enabled) requireAccessPassword();
    await context.api('/api/settings/tunnel', {
      tailscale: { enabled, monitorOnly: !!byId('air-ts-monitor')?.checked, url: '' },
    }, 'POST');
    await load();
    setMessage('air-ts-message', 'Tailscale 监控设置已保存。', 'success');
  }

  async function toggleFunnel() {
    const currentlyOn = !!snapshot?.settings?.config?.tailscale?.funnel;
    const on = !currentlyOn;
    const port = Number.parseInt(byId('air-ts-port')?.value || '3000', 10);
    if (on) {
      requireAccessPassword();
      if (!root.confirm(`将本机 ${port} 端口发布到公网，并要求访问密码登录。确定开启？`)) return;
      await context.api('/api/settings/tunnel', {
        tailscale: { enabled: true, monitorOnly: !!byId('air-ts-monitor')?.checked, url: '' },
      }, 'POST');
    } else if (!root.confirm('确定关闭 Tailscale Funnel 公网入口？')) return;
    const result = await context.api('/api/tunnel/funnel', { on, port }, 'POST');
    await load();
    setMessage('air-ts-message', result.message || (on ? 'Funnel 已开启。' : 'Funnel 已关闭。'), 'success');
  }

  async function saveAccessPassword(clear = false) {
    const input = byId('air-access-token');
    const token = clear ? '' : (input?.value || '').trim();
    if (!clear && !token) throw new Error('请输入新的访问密码。');
    const question = clear
      ? '清除后，未关闭的局域网入口可能失去保护。确定清除访问密码？'
      : '保存后，旧的外网登录会话将失效。确定更新访问密码？';
    if (!root.confirm(question)) return;
    await context.api('/api/settings/access-token', { token }, 'POST');
    if (input) input.value = '';
    setMessage('air-access-message', clear ? '访问密码已清除。' : '访问密码已保存。', 'success');
    await load();
  }

  async function savePolicy() {
    const value = id => Number.parseInt(byId(id)?.value || '', 10);
    await context.api('/api/settings/tunnel', {
      intervalSec: value('air-tunnel-interval'),
      failThreshold: value('air-tunnel-threshold'),
      restartCooldownSec: value('air-tunnel-cooldown'),
      maxRestartsPerHour: value('air-tunnel-max-restarts'),
    }, 'POST');
    setMessage('air-tunnel-policy-message', '监控参数已保存。', 'success');
    await load();
  }

  async function saveCompatibility(providerId) {
    const provider = PROVIDERS.find(item => item.id === providerId);
    if (!provider) return;
    const enabled = !!byId(`air-${providerId}-enabled`)?.checked;
    if (enabled) requireAccessPassword();
    const update = {
      enabled,
      monitorOnly: !!byId(`air-${providerId}-monitor`)?.checked,
      url: byId(`air-${providerId}-url`)?.value.trim() || '',
    };
    if (provider.cli) {
      const token = byId(`air-${providerId}-token`)?.value.trim();
      const port = Number.parseInt(byId(`air-${providerId}-port`)?.value || '3000', 10);
      const startCmd = byId(`air-${providerId}-cmd`)?.value.trim();
      if (token) update.authtoken = token;
      if (Number.isInteger(port)) update.port = port;
      if (startCmd) update.startCmd = startCmd;
    }
    await context.api('/api/settings/tunnel', { [providerId]: update }, 'POST');
    const tokenInput = byId(`air-${providerId}-token`);
    if (tokenInput) tokenInput.value = '';
    setMessage(`air-${providerId}-message`, `${provider.name} 设置已保存。`, 'success');
    await load();
  }

  function runAction(button, busyLabel, messageId, action) {
    busy(button, busyLabel, async () => {
      try { await action(); }
      catch (error) { setMessage(messageId, error.message || '操作失败。', 'danger'); }
    });
  }

  function bind() {
    byId('air-access-save').onclick = event => runAction(event.currentTarget, '保存中…', 'air-access-message', () => saveAccessPassword(false));
    byId('air-access-clear').onclick = event => runAction(event.currentTarget, '清除中…', 'air-access-message', () => saveAccessPassword(true));
    byId('air-sf-bind').onclick = event => runAction(event.currentTarget, '绑定中…', 'air-sf-message', bindSakura);
    byId('air-sf-install').onclick = event => runAction(event.currentTarget, '下载并校验…', 'air-sf-message', installSakura);
    byId('air-sf-backfill').onclick = event => runAction(event.currentTarget, '回填中…', 'air-sf-message', backfillSakura);
    byId('air-sf-save').onclick = event => runAction(event.currentTarget, '保存中…', 'air-sf-message', saveSakura);
    byId('air-sf-restart').onclick = event => runAction(event.currentTarget, '启动中…', 'air-sf-message', () => restartProvider('sakurafrp', 'air-sf-message'));
    byId('air-ts-save').onclick = event => runAction(event.currentTarget, '保存中…', 'air-ts-message', saveTailscale);
    byId('air-ts-toggle').onclick = event => runAction(event.currentTarget, '应用中…', 'air-ts-message', toggleFunnel);
    byId('air-ts-restart').onclick = event => runAction(event.currentTarget, '重连中…', 'air-ts-message', () => restartProvider('tailscale', 'air-ts-message'));
    byId('air-ts-ipv6-check').onclick = event => runAction(event.currentTarget, '检测中…', 'air-ts-message', load);
    byId('air-tunnel-policy-save').onclick = event => runAction(event.currentTarget, '保存中…', 'air-tunnel-policy-message', savePolicy);
    host.querySelectorAll('[data-save-provider]').forEach(button => {
      button.onclick = event => runAction(event.currentTarget, '保存中…', `air-${button.dataset.saveProvider}-message`, () => saveCompatibility(button.dataset.saveProvider));
    });
    host.querySelectorAll('[data-restart-provider]').forEach(button => {
      button.onclick = event => runAction(event.currentTarget, '重启中…', `air-${button.dataset.restartProvider}-message`, () => restartProvider(button.dataset.restartProvider, `air-${button.dataset.restartProvider}-message`));
    });
  }

  function render(target, nextContext) {
    host = target;
    context = nextContext;
    snapshot = null;
    host.innerHTML = markup();
    bind();
    load();
  }

  root.MultiCCAirTunnel = Object.freeze({ render, refresh: load });
})(typeof window !== 'undefined' ? window : null);
