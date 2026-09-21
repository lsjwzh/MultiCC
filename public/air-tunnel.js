'use strict';

(function initAirTunnel(root) {
  if (!root || !root.document) return;
  const document = root.document;
  const PROVIDERS = Object.freeze([
    { id: 'phddns', name: t('airTunnelBrandPhddns'), cli: false, placeholder: 'https://xxxx.vicp.fun/manage' },
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
      <label><span>${t('airTunnelAccessToken')}</span><input id="air-${provider.id}-token" type="password" autocomplete="new-password" placeholder="${t('airTunnelTokenPlaceholder')}"></label>
      <label><span>${t('airTunnelLocalPort')}</span><input id="air-${provider.id}-port" type="number" min="1" max="65535" value="3000"></label>
      <label class="wide"><span>${t('airTunnelStartCmdAdvanced')}</span><input id="air-${provider.id}-cmd" type="text" placeholder="${t('airTunnelStartCmdPlaceholder')}"></label>` : '';
    return `
      <article class="air-tunnel-compat" data-provider="${provider.id}">
        <div class="air-tunnel-compat-head">
          <div><strong>${esc(provider.name)}</strong><small id="air-${provider.id}-availability">${t('airTunnelReadingClient')}</small></div>
          <span id="air-${provider.id}-health" class="air-tunnel-chip neutral">${t('airTunnelReading')}</span>
        </div>
        <div class="air-tunnel-form-grid">
          <label><span>${t('airTunnelProbeUrl')}</span><input id="air-${provider.id}-url" type="url" placeholder="${esc(provider.placeholder)}"></label>
          ${secret}
        </div>
        <div class="air-tunnel-switches">
          <label><input id="air-${provider.id}-enabled" type="checkbox"> ${t('airTunnelEnableHealthMonitor')}</label>
          <label><input id="air-${provider.id}-monitor" type="checkbox"> ${t('airTunnelAlertOnly')}</label>
        </div>
        <div class="air-tunnel-actions">
          <button type="button" data-save-provider="${provider.id}">${t('airTunnelSave')}</button>
          <button type="button" data-restart-provider="${provider.id}">${t('airTunnelRestartNow')}</button>
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
            <h2>${t('airTunnelHeroTitle')}</h2>
            <p>${t('airTunnelHeroCopy')}</p>
          </div>
          <div class="air-tunnel-route-map" aria-label="${t('airTunnelRouteMapAria')}">
            <a href="#air-tunnel-cn"><b>${t('airTunnelMainlandCn')}</b><span>SakuraFrp · ${t('airTunnelRouteCnNode')}</span><em>${t('airTunnelRecommended')}</em></a>
            <span aria-hidden="true">${t('airTunnelOr')}</span>
            <a href="#air-tunnel-global"><b>${t('airTunnelOverseas')}</b><span>Tailscale · ${t('airTunnelRouteGlobalNode')}</span><em>${t('airTunnelRecommended')}</em></a>
          </div>
        </section>

        <section class="air-tunnel-security admin-panel" aria-labelledby="air-tunnel-security-title">
          <div class="air-tunnel-security-mark">⌁</div>
          <div class="air-tunnel-security-copy">
            <span class="eyebrow">PUBLIC ACCESS GUARD</span>
            <h3 id="air-tunnel-security-title">${t('airTunnelGuardTitle')}</h3>
            <p id="air-access-copy">${t('airTunnelCheckingAccessPassword')}</p>
          </div>
          <span id="air-access-status" class="air-tunnel-chip neutral">${t('airTunnelReading')}</span>
          <div id="air-access-editor" class="air-tunnel-security-editor" hidden>
            <input id="air-access-token" type="password" autocomplete="new-password" placeholder="${t('airTunnelNewPasswordPlaceholder')}">
            <button id="air-access-save" type="button">${t('airTunnelSaveUpdate')}</button>
            <button id="air-access-clear" class="subtle" type="button" hidden>${t('airTunnelClear')}</button>
          </div>
          <span id="air-access-message" class="air-tunnel-message" role="status"></span>
        </section>

        <div class="air-tunnel-route-grid">
          <section id="air-tunnel-cn" class="air-tunnel-route cn" aria-labelledby="air-tunnel-cn-title">
            <header>
              <span class="air-tunnel-region">CN</span>
              <div><span class="eyebrow">${t('airTunnelCnPlanEyebrow')}</span><h3 id="air-tunnel-cn-title">SakuraFrp · ${t('airTunnelCnTitle')}</h3><p>${t('airTunnelCnDesc')}</p></div>
              <span class="air-tunnel-recommend">${t('airTunnelCnRecommended')}</span>
            </header>
            <div class="air-tunnel-facts">
              <div><span>${t('airTunnelAccount')}</span><strong id="air-sf-account">${t('airTunnelReadingEllipsis')}</strong></div>
              <div><span>${t('airTunnelCliClient')}</span><strong id="air-sf-client">${t('airTunnelDetecting')}</strong></div>
              <div class="wide"><span>${t('airTunnelTunnel')}</span><strong id="air-sf-tunnel">${t('airTunnelReadingEllipsis')}</strong></div>
            </div>
            <ol class="air-tunnel-steps">
              <li>
                <div class="air-tunnel-step-no">1</div>
                <div class="air-tunnel-step-body">
                  <h4>${t('airTunnelBindKeyTitle')}</h4>
                  <p>${t('airTunnelBindKeyDesc')}</p>
                  <div class="air-tunnel-inline-form">
                    <input id="air-sf-key" type="password" autocomplete="new-password" placeholder="${t('airTunnelKeyPlaceholder')}">
                    <button id="air-sf-bind" type="button">${t('airTunnelBindKey')}</button>
                    <a href="https://www.natfrp.com/user/" target="_blank" rel="noopener noreferrer">${t('airTunnelOpenConsole')}</a>
                  </div>
                  <small>${t('airTunnelKeyPrivacyNote')}</small>
                </div>
              </li>
              <li>
                <div class="air-tunnel-step-no">2</div>
                <div class="air-tunnel-step-body">
                  <h4>${t('airTunnelInstallFrpcTitle')}</h4>
                  <p>${t('airTunnelInstallFrpcDesc')}</p>
                  <button id="air-sf-install" type="button">${t('airTunnelInstallFrpc')}</button>
                </div>
              </li>
              <li>
                <div class="air-tunnel-step-no">3</div>
                <div class="air-tunnel-step-body">
                  <h4>${t('airTunnelConfirmUrlTitle')}</h4>
                  <label class="air-tunnel-field"><span>${t('airTunnelPublicUrlLabel')}</span><input id="air-sf-url" type="url" placeholder="${t('airTunnelUrlPlaceholder')}"></label>
                  <div id="air-sf-domain-wrap" class="air-tunnel-domain" hidden>
                    <label class="air-tunnel-field"><span>${t('airTunnelBoundDomainLabel')}</span><input id="air-sf-domain" type="text" placeholder="${t('airTunnelDomainPlaceholder')}"></label>
                    <button id="air-sf-backfill" type="button">${t('airTunnelBackfill')}</button>
                  </div>
                  <div class="air-tunnel-switches">
                    <label><input id="air-sf-enabled" type="checkbox"> ${t('airTunnelEnableHealthMonitor')}</label>
                    <label><input id="air-sf-monitor" type="checkbox"> ${t('airTunnelAlertOnly')}</label>
                  </div>
                  <div class="air-tunnel-actions">
                    <button id="air-sf-save" class="primary" type="button">${t('airTunnelSaveCnPlan')}</button>
                    <button id="air-sf-restart" type="button">${t('airTunnelStartRestartTunnel')}</button>
                  </div>
                </div>
              </li>
            </ol>
            <p id="air-sf-message" class="air-tunnel-message" role="status"></p>
          </section>

          <section id="air-tunnel-global" class="air-tunnel-route global" aria-labelledby="air-tunnel-global-title">
            <header>
              <span class="air-tunnel-region">GL</span>
              <div><span class="eyebrow">${t('airTunnelGlobalPlanEyebrow')}</span><h3 id="air-tunnel-global-title">Tailscale Funnel</h3><p>${t('airTunnelGlobalDesc')}</p></div>
              <span class="air-tunnel-recommend">${t('airTunnelGlobalRecommended')}</span>
            </header>
            <div class="air-tunnel-facts">
              <div><span>${t('airTunnelClient')}</span><strong id="air-ts-client">${t('airTunnelDetecting')}</strong></div>
              <div><span>Funnel</span><strong id="air-ts-funnel-state">${t('airTunnelReadingEllipsis')}</strong></div>
              <div class="wide"><span>${t('airTunnelPublicAddress')}</span><strong id="air-ts-public-url">${t('airTunnelWaitingProbe')}</strong></div>
            </div>
            <ol class="air-tunnel-steps">
              <li>
                <div class="air-tunnel-step-no">1</div>
                <div class="air-tunnel-step-body">
                  <h4>${t('airTunnelInstallTailscale')}</h4>
                  <p>${t('airTunnelInstallTailscaleDesc')}</p>
                  <div class="air-tunnel-actions">
                    <a class="air-tunnel-button" href="https://tailscale.com/download" target="_blank" rel="noopener noreferrer">${t('airTunnelDownloadTailscale')}</a>
                    <button id="air-ts-restart" type="button">${t('airTunnelReconnectControlPlane')}</button>
                  </div>
                </div>
              </li>
              <li>
                <div class="air-tunnel-step-no">2</div>
                <div class="air-tunnel-step-body">
                  <h4>${t('airTunnelPublishTitle')}</h4>
                  <label class="air-tunnel-field compact"><span>${t('airTunnelLocalPort')}</span><input id="air-ts-port" type="number" min="1" max="65535" value="3000"></label>
                  <div class="air-tunnel-switches">
                    <label><input id="air-ts-enabled" type="checkbox"> ${t('airTunnelEnableHealthMonitor')}</label>
                    <label><input id="air-ts-monitor" type="checkbox"> ${t('airTunnelAlertOnlyNoRepair')}</label>
                  </div>
                  <div class="air-tunnel-actions">
                    <button id="air-ts-toggle" class="primary" type="button">${t('airTunnelEnableFunnel')}</button>
                    <button id="air-ts-save" type="button">${t('airTunnelSaveMonitorOnly')}</button>
                  </div>
                </div>
              </li>
              <li>
                <div class="air-tunnel-step-no">3</div>
                <div class="air-tunnel-step-body">
                  <h4>${t('airTunnelCheckDirectTitle')}</h4>
                  <p id="air-ts-ipv6">${t('airTunnelCheckingIpv6')}</p>
                  <button id="air-ts-ipv6-check" type="button">${t('airTunnelRecheckIpv6')}</button>
                  <pre id="air-ts-funnel-detail" class="air-tunnel-detail">${t('airTunnelReadingFunnel')}</pre>
                </div>
              </li>
            </ol>
            <p id="air-ts-message" class="air-tunnel-message" role="status"></p>
          </section>
        </div>

        <details class="air-tunnel-advanced">
          <summary><span><b>${t('airTunnelAdvancedTitle')}</b><small>${t('airTunnelBrandPhddns')} / Natapp / cpolar / ${t('airTunnelAdvancedCompatHint')}</small></span><span>${t('airTunnelExpandConfig')}</span></summary>
          <div class="air-tunnel-advanced-body">
            <section class="admin-panel">
              <div class="admin-panel-head"><div><span class="eyebrow">MONITOR POLICY</span><h3>${t('airTunnelMonitorPolicyTitle')}</h3></div></div>
              <div class="air-tunnel-form-grid policy">
                <label><span>${t('airTunnelIntervalLabel')}</span><input id="air-tunnel-interval" type="number" min="10"></label>
                <label><span>${t('airTunnelThresholdLabel')}</span><input id="air-tunnel-threshold" type="number" min="1"></label>
                <label><span>${t('airTunnelCooldownLabel')}</span><input id="air-tunnel-cooldown" type="number" min="0"></label>
                <label><span>${t('airTunnelMaxRestartsLabel')}</span><input id="air-tunnel-max-restarts" type="number" min="1"></label>
              </div>
              <div class="air-tunnel-actions"><button id="air-tunnel-policy-save" type="button">${t('airTunnelSavePolicy')}</button><span id="air-tunnel-policy-message" class="air-tunnel-message" role="status"></span></div>
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
    if (!config?.enabled && !config?.funnel) return { text: t('airTunnelNotEnabled'), tone: 'neutral' };
    if (available === false) return { text: t('airTunnelClientNotInstalled'), tone: 'warning' };
    if (!provider?.lastCheckAt) return { text: t('airTunnelWaitingFirstProbe'), tone: 'info' };
    if (provider.probeVerdict === 'degraded') return { text: t('airTunnelPartialEdgeDegraded'), tone: 'warning' };
    if (provider.probeVerdict === 'indeterminate') return { text: t('airTunnelProbeIndeterminate'), tone: 'warning' };
    return provider.healthy
      ? { text: provider.lastHttpCode ? t('airTunnelHealthyWithCode', { code: provider.lastHttpCode }) : t('airTunnelHealthy'), tone: 'success' }
      : { text: t('airTunnelUnhealthy', { n: provider.consecutiveFails || 0 }), tone: 'danger' };
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
      return { ok: false, reason: error.reason || error.code || 'unavailable', message: error.message || t('airTunnelRequestFailed') };
    }
  }

  async function load() {
    if (!context || !host) return;
    const generation = ++loadGeneration;
    setMessage('air-sf-message', t('airTunnelReadingSakura'));
    setMessage('air-ts-message', t('airTunnelReadingTailscale'));
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
      setChip('air-access-status', t('airTunnelReadFailed'), 'danger');
      setText('air-access-copy', access.message || t('airTunnelAccessReadFailed'));
      if (editor) editor.hidden = true;
      return;
    }
    setChip('air-access-status', access.hasToken ? t('airTunnelProtected') : t('airTunnelNotSet'), access.hasToken ? 'success' : 'danger');
    setText('air-access-copy', access.hasToken
      ? (access.masked ? t('airTunnelAccessSetMasked', { masked: access.masked }) : t('airTunnelAccessSet'))
      : t('airTunnelAccessUnset'));
    if (editor) editor.hidden = !access.canEdit;
    if (input) input.placeholder = access.hasToken ? t('airTunnelNewPasswordHint') : t('airTunnelStrongPasswordHint');
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
    setText('air-sf-client', available ? t('airTunnelInstalledManaged') : t('airTunnelNotDetectedStep2'));
    if (sakura.ok) {
      const user = sakura.user || {};
      setText('air-sf-account', `${user.name || user.id || t('airTunnelBound')} · ${user.realname ? t('airTunnelRealNameVerified') : t('airTunnelRealNameUnverified')} · ${user.signed ? t('airTunnelCheckedIn') : t('airTunnelNotCheckedIn')} · ${formatBytes(user.trafficUsed)}/${formatBytes(user.trafficTotal)}`);
      const access = sakura.access;
      if (access) {
        const reach = access.needsBoundDomain ? t('airTunnelWaitingBoundDomain') : (access.publicUrl || config.url || t('airTunnelWaitingPublicUrl'));
        setText('air-sf-tunnel', `${access.name || access.tunnelId || t('airTunnelTunnel')} · ${access.online ? t('airTunnelOnline') : t('airTunnelOffline')} · ${access.nodeName || access.nodeHost || t('airTunnelNodeUnknown')} · ${reach}`);
      } else setText('air-sf-tunnel', sakura.tunnelCount ? t('airTunnelTunnelsFound', { n: sakura.tunnelCount }) : t('airTunnelNoTunnels'));
    } else {
      setText('air-sf-account', sakura.reason === 'no_token' ? t('airTunnelNoToken') : `${t('airTunnelReadFailed')} · ${sakura.message || sakura.reason || t('airTunnelApiUnavailable')}`);
      setText('air-sf-tunnel', t('airTunnelWaitingAccountBind'));
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
    setMessage('air-sf-message', `${health.text}${runtime.lastAction ? ` · ${t('airTunnelLastAction', { action: runtime.lastAction })}` : ''}`, health.tone);
  }

  function paintTailscale() {
    const settings = snapshot.settings || {};
    const config = settings.config?.tailscale || {};
    const runtime = settings.providers?.tailscale || {};
    const available = settings.availability?.tailscale;
    const health = providerHealth(runtime, config, available);
    setText('air-ts-client', available ? t('airTunnelCliAvailable') : t('airTunnelNoTailscaleCli'));
    setText('air-ts-funnel-state', config.funnel ? t('airTunnelFunnelOn', { port: config.funnelPort || 3000 }) : t('airTunnelFunnelOff'));
    setText('air-ts-public-url', runtime.publicUrl || t('airTunnelWaitingFunnelUrl'));
    setValue('air-ts-port', config.funnelPort || 3000);
    setChecked('air-ts-enabled', config.enabled);
    setChecked('air-ts-monitor', config.monitorOnly);
    const toggle = byId('air-ts-toggle');
    if (toggle) {
      toggle.textContent = config.funnel ? t('airTunnelDisableFunnel') : t('airTunnelEnableFunnel');
      toggle.classList.toggle('danger', !!config.funnel);
      toggle.classList.toggle('primary', !config.funnel);
      toggle.disabled = !available;
    }
    const restart = byId('air-ts-restart');
    if (restart) restart.disabled = !available || !!config.monitorOnly;
    const ipv6 = snapshot.ipv6 || {};
    let ipv6Text = ipv6.directReady ? t('airTunnelIpv6Ready')
      : (!ipv6.host?.hasGlobalV6 ? t('airTunnelIpv6NoGlobal')
        : t('airTunnelIpv6Unconfirmed'));
    if (ipv6.message && !ipv6.host) ipv6Text = t('airTunnelIpv6CheckFailed', { message: ipv6.message });
    setText('air-ts-ipv6', ipv6Text);
    setText('air-ts-funnel-detail', snapshot.funnel?.status?.trim() || 'No serve config');
    setMessage('air-ts-message', `${health.text}${runtime.lastAction ? ` · ${t('airTunnelLastAction', { action: runtime.lastAction })}` : ''}`, health.tone);
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
      setText(`air-${provider.id}-availability`, available ? t('airTunnelClientAvailable') : t('airTunnelNoClientDetected'));
      setChip(`air-${provider.id}-health`, health.text, health.tone);
      setValue(`air-${provider.id}-url`, providerConfig.url || '');
      setChecked(`air-${provider.id}-enabled`, providerConfig.enabled);
      setChecked(`air-${provider.id}-monitor`, providerConfig.monitorOnly);
      if (provider.cli) {
        setValue(`air-${provider.id}-port`, providerConfig.port || 3000);
        setValue(`air-${provider.id}-cmd`, providerConfig.startCmd || '');
        const token = byId(`air-${provider.id}-token`);
        if (token) token.placeholder = providerConfig.hasAuthtoken ? t('airTunnelTokenSetPlaceholder') : t('airTunnelTokenUnsetPlaceholder');
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
    throw new Error(t('airTunnelNeedAccessPassword'));
  }

  async function bindSakura() {
    const input = byId('air-sf-key');
    const token = input?.value.trim() || '';
    if (!token) throw new Error(t('airTunnelEnterSakuraKey'));
    await context.api('/api/settings/tunnel', { sakurafrp: { authtoken: token } }, 'POST');
    input.value = '';
    await load();
    setMessage('air-sf-message', t('airTunnelKeyBound'), 'success');
  }

  async function installSakura() {
    const result = await context.api('/api/tunnel/sakurafrp/install', {}, 'POST');
    await load();
    setMessage('air-sf-message', `${t('airTunnelFrpcInstalled', { version: result.version || '' })}${result.path ? ` · ${result.path}` : ''}`, 'success');
  }

  async function backfillSakura() {
    const boundDomain = byId('air-sf-domain')?.value.trim() || '';
    const result = await context.api('/api/tunnel/sakurafrp/public-url', { boundDomain }, 'POST');
    setValue('air-sf-url', result.url || '');
    await load();
    setMessage('air-sf-message', t('airTunnelUrlBackfilled', { url: result.url }), 'success');
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
    setMessage('air-sf-message', t('airTunnelCnPlanSaved'), 'success');
  }

  async function restartProvider(provider, messageId) {
    const result = await context.api(`/api/tunnel/restart/${provider}`, {}, 'POST');
    await load();
    setMessage(messageId, result.message || t('airTunnelRestartTriggered'), 'success');
  }

  async function saveTailscale() {
    const enabled = !!byId('air-ts-enabled')?.checked;
    if (enabled) requireAccessPassword();
    await context.api('/api/settings/tunnel', {
      tailscale: { enabled, monitorOnly: !!byId('air-ts-monitor')?.checked, url: '' },
    }, 'POST');
    await load();
    setMessage('air-ts-message', t('airTunnelTailscaleSaved'), 'success');
  }

  async function toggleFunnel() {
    const currentlyOn = !!snapshot?.settings?.config?.tailscale?.funnel;
    const on = !currentlyOn;
    const port = Number.parseInt(byId('air-ts-port')?.value || '3000', 10);
    if (on) {
      requireAccessPassword();
      if (!root.confirm(t('airTunnelConfirmEnableFunnel', { port }))) return;
      await context.api('/api/settings/tunnel', {
        tailscale: { enabled: true, monitorOnly: !!byId('air-ts-monitor')?.checked, url: '' },
      }, 'POST');
    } else if (!root.confirm(t('airTunnelConfirmDisableFunnel'))) return;
    const result = await context.api('/api/tunnel/funnel', { on, port }, 'POST');
    await load();
    setMessage('air-ts-message', result.message || (on ? t('airTunnelFunnelEnabled') : t('airTunnelFunnelDisabled')), 'success');
  }

  async function saveAccessPassword(clear = false) {
    const input = byId('air-access-token');
    const token = clear ? '' : (input?.value || '').trim();
    if (!clear && !token) throw new Error(t('airTunnelEnterNewAccessPassword'));
    const question = clear
      ? t('airTunnelConfirmClearPassword')
      : t('airTunnelConfirmUpdatePassword');
    if (!root.confirm(question)) return;
    await context.api('/api/settings/access-token', { token }, 'POST');
    if (input) input.value = '';
    setMessage('air-access-message', clear ? t('airTunnelPasswordCleared') : t('airTunnelPasswordSaved'), 'success');
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
    setMessage('air-tunnel-policy-message', t('airTunnelPolicySaved'), 'success');
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
    setMessage(`air-${providerId}-message`, t('airTunnelProviderSaved', { name: provider.name }), 'success');
    await load();
  }

  function runAction(button, busyLabel, messageId, action) {
    busy(button, busyLabel, async () => {
      try { await action(); }
      catch (error) { setMessage(messageId, error.message || t('airTunnelActionFailed'), 'danger'); }
    });
  }

  function bind() {
    byId('air-access-save').onclick = event => runAction(event.currentTarget, t('airTunnelSaving'), 'air-access-message', () => saveAccessPassword(false));
    byId('air-access-clear').onclick = event => runAction(event.currentTarget, t('airTunnelClearing'), 'air-access-message', () => saveAccessPassword(true));
    byId('air-sf-bind').onclick = event => runAction(event.currentTarget, t('airTunnelBinding'), 'air-sf-message', bindSakura);
    byId('air-sf-install').onclick = event => runAction(event.currentTarget, t('airTunnelDownloading'), 'air-sf-message', installSakura);
    byId('air-sf-backfill').onclick = event => runAction(event.currentTarget, t('airTunnelBackfilling'), 'air-sf-message', backfillSakura);
    byId('air-sf-save').onclick = event => runAction(event.currentTarget, t('airTunnelSaving'), 'air-sf-message', saveSakura);
    byId('air-sf-restart').onclick = event => runAction(event.currentTarget, t('airTunnelStarting'), 'air-sf-message', () => restartProvider('sakurafrp', 'air-sf-message'));
    byId('air-ts-save').onclick = event => runAction(event.currentTarget, t('airTunnelSaving'), 'air-ts-message', saveTailscale);
    byId('air-ts-toggle').onclick = event => runAction(event.currentTarget, t('airTunnelApplying'), 'air-ts-message', toggleFunnel);
    byId('air-ts-restart').onclick = event => runAction(event.currentTarget, t('airTunnelReconnecting'), 'air-ts-message', () => restartProvider('tailscale', 'air-ts-message'));
    byId('air-ts-ipv6-check').onclick = event => runAction(event.currentTarget, t('airTunnelDetecting'), 'air-ts-message', load);
    byId('air-tunnel-policy-save').onclick = event => runAction(event.currentTarget, t('airTunnelSaving'), 'air-tunnel-policy-message', savePolicy);
    host.querySelectorAll('[data-save-provider]').forEach(button => {
      button.onclick = event => runAction(event.currentTarget, t('airTunnelSaving'), `air-${button.dataset.saveProvider}-message`, () => saveCompatibility(button.dataset.saveProvider));
    });
    host.querySelectorAll('[data-restart-provider]').forEach(button => {
      button.onclick = event => runAction(event.currentTarget, t('airTunnelRestarting'), `air-${button.dataset.restartProvider}-message`, () => restartProvider(button.dataset.restartProvider, `air-${button.dataset.restartProvider}-message`));
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
