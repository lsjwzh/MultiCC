(function initManageQwenAudio(global) {
  'use strict';

  let pollTimer = null;
  let notify = () => {};

  function authPath(path, prefix = '?') {
    const suffix = typeof global.tokenQS === 'function' ? global.tokenQS(prefix) : '';
    return path + suffix;
  }

  async function fetchJson(path, options) {
    const response = await fetch(path, options);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || body.code || `HTTP ${response.status}`);
    return body;
  }

  function runtimeLabel(runtime) {
    const labels = {
      not_installed: '未安装',
      installing: '安装中',
      ready: '已安装',
      error: '安装失败',
      stopped: '已停止',
      starting: '启动中',
      running: '运行中',
      backoff: '等待重试',
      failed: '异常暂停',
      qwen_api_key_missing: '缺少 DashScope Key',
      qwen_runtime_not_installed: '等待安装',
      commander_not_found: '缺少 Commander',
      commander_ambiguous: 'Commander 不唯一',
      commander_binding_stale: 'Commander 绑定过期',
    };
    return labels[runtime?.state] || runtime?.state || '未知';
  }

  function button(text, onClick, className = 'btn btn-sm') {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = className;
    element.textContent = text;
    element.addEventListener('click', onClick);
    return element;
  }

  // One machine, one gateway: this panel shows a single row, not a Fleet list.
  // Legacy per-Fleet records may still exist on disk; they are surfaced as a
  // migration note rather than as separate, separately-startable gateways.
  function renderGlobal(gateway, runtime, legacy) {
    const container = document.getElementById('qwen-audio-global');
    if (!container) return;
    container.replaceChildren();

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--line);border-radius:8px;flex-wrap:wrap;';
    const title = document.createElement('span');
    title.style.cssText = 'font-size:13px;color:var(--text);font-weight:600;flex:1;min-width:180px;';
    title.textContent = '全局实时语音 Gateway';
    const badge = document.createElement('span');
    badge.className = 'status-text';
    badge.textContent = gateway.enabled ? runtimeLabel(runtime) : '未启用';
    badge.style.color = runtime.state === 'running' ? '#3fb950'
      : ['failed', 'error'].includes(runtime.state) ? '#f85149' : '#d29922';
    row.append(title, badge);
    row.appendChild(button(gateway.enabled ? '停用' : '启用', () => setGlobalEnabled(!gateway.enabled)));
    if (gateway.enabled) {
      row.appendChild(button('重启进程', restartGlobal));
      // Opening always goes through launch, never through a raw runtime URL, so
      // the window carries a host-issued ticket instead of a bare address.
      row.appendChild(button('打开语音界面', openGlobalVoice));
    }
    container.appendChild(row);

    if (Array.isArray(legacy) && legacy.length) {
      const note = document.createElement('div');
      note.className = 'sec-desc';
      note.style.margin = '0';
      note.textContent = `已迁移：${legacy.length} 条旧的按 Fleet 配置只作兼容保留，不会再各自拉起进程。`;
      container.appendChild(note);
    }
  }

  async function loadPanel() {
    const status = document.getElementById('qwen-audio-status');
    try {
      const [settings, runtimeBody, gatewayBody, childBody] = await Promise.all([
        fetchJson(authPath('/api/settings/voice')),
        fetchJson(authPath('/api/v1/voice-runtime')),
        fetchJson(authPath('/api/v1/voice-gateway')),
        fetchJson(authPath('/api/v1/voice-gateway/runtime')).catch(() => ({ runtime: {} })),
      ]);
      const qwen = settings.qwenAudio || {};
      const runtime = runtimeBody.runtime || {};
      const key = document.getElementById('qwen-audio-key');
      if (key) {
        key.value = '';
        key.placeholder = qwen.hasApiKey ? '已配置（留空不修改）' : 'DashScope API Key';
      }
      const url = document.getElementById('qwen-audio-url');
      const model = document.getElementById('qwen-audio-model');
      const voice = document.getElementById('qwen-audio-voice');
      if (url) url.value = qwen.baseUrl || '';
      if (model) model.value = qwen.model || '';
      if (voice) voice.value = qwen.voice || '';

      const install = document.getElementById('qwen-audio-install');
      if (install) {
        install.disabled = runtime.state === 'installing';
        install.textContent = runtime.installed
          ? `运行时 ${runtime.package?.version || ''} 已安装`
          : runtime.state === 'installing' ? '安装中…' : '安装运行时';
      }
      if (status) {
        const keyState = qwen.hasApiKey ? 'Key 已配置' : '缺少 DashScope Key';
        const progress = runtime.progress?.stage ? ` · ${runtime.progress.stage}` : '';
        status.textContent = `${runtimeLabel(runtime)} · ${keyState}${progress}`;
        status.className = `status-text ${runtime.state === 'error' ? 'err' : runtime.installed && qwen.hasApiKey ? 'ok' : ''}`;
      }

      const gateway = gatewayBody.gateway || {};
      const child = childBody.runtime || {};
      renderGlobal(gateway, child, gatewayBody.legacy);

      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = null;
      if (runtime.state === 'installing' || ['installing', 'starting', 'backoff'].includes(child.state)) {
        pollTimer = setTimeout(loadPanel, 2000);
      }
    } catch (error) {
      if (status) {
        status.textContent = `加载失败：${error.message}`;
        status.className = 'status-text err';
      }
    }
  }

  async function persistSettings({ quiet = false } = {}) {
    const status = document.getElementById('qwen-audio-status');
    const value = id => (document.getElementById(id)?.value || '').trim();
    const qwenAudio = {
      model: value('qwen-audio-model'),
      voice: value('qwen-audio-voice'),
      baseUrl: value('qwen-audio-url'),
    };
    const apiKey = value('qwen-audio-key');
    if (apiKey) qwenAudio.apiKey = apiKey;
    try {
      await fetchJson(authPath('/api/settings/voice'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ qwenAudio }),
      });
      if (!quiet) notify('Qwen Audio 配置已保存');
      return true;
    } catch (error) {
      if (status) {
        status.textContent = `保存失败：${error.message}`;
        status.className = 'status-text err';
      }
      return false;
    }
  }

  async function saveSettings() {
    if (await persistSettings()) await loadPanel();
  }

  async function installRuntime() {
    const status = document.getElementById('qwen-audio-status');
    const install = document.getElementById('qwen-audio-install');
    if (install) install.disabled = true;
    try {
      await fetchJson(authPath('/api/v1/voice-runtime/install'), { method: 'POST' });
      if (status) status.textContent = '已开始安装固定版本运行时…';
      await loadPanel();
    } catch (error) {
      if (install) install.disabled = false;
      if (status) {
        status.textContent = `安装失败：${error.message}`;
        status.className = 'status-text err';
      }
    }
  }

  function reportError(prefix, error) {
    const status = document.getElementById('qwen-audio-status');
    if (!status) return;
    status.textContent = `${prefix}：${error.message}`;
    status.className = 'status-text err';
  }

  async function setGlobalEnabled(enabled, autoInstall = false) {
    try {
      await fetchJson(authPath('/api/v1/voice-gateway'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, provider: 'qwen-audio-agent', autoInstall }),
      });
      notify(enabled ? '全局实时语音已启用' : '全局实时语音已停用');
      await loadPanel();
    } catch (error) {
      reportError('语音网关操作失败', error);
    }
  }

  async function enableGlobal() {
    const keyInput = document.getElementById('qwen-audio-key');
    if (!keyInput?.value && keyInput?.placeholder !== '已配置（留空不修改）') {
      const status = document.getElementById('qwen-audio-status');
      if (status) {
        status.textContent = '首次启用前需要填写 DashScope API Key';
        status.className = 'status-text err';
      }
      keyInput?.focus();
      return;
    }
    if (!await persistSettings({ quiet: true })) return;
    await setGlobalEnabled(true, true);
  }

  async function restartGlobal() {
    try {
      await fetchJson(authPath('/api/v1/voice-gateway/restart'), { method: 'POST' });
      notify('实时语音进程已重启');
      await loadPanel();
    } catch (error) {
      reportError('重启失败', error);
    }
  }

  // Same launch path as the Dashboard button: scope is global here, so the Host
  // routes through the voice router instead of binding to a session.
  async function openGlobalVoice() {
    const client = global.MultiCCVoiceLaunch;
    if (!client || typeof client.launch !== 'function') {
      notify('语音模块未加载，请刷新页面后重试', true);
      return;
    }
    const result = await client.launch({ withToken: path => authPath(path) });
    if (!result.ok) reportError('打开语音界面失败', new Error(result.message || result.code));
  }

  function initialize(options = {}) {
    if (typeof options.notify === 'function') notify = options.notify;
    return loadPanel();
  }

  global.saveQwenAudioSettings = saveSettings;
  global.installQwenAudioRuntime = installRuntime;
  global.enableQwenAudioGlobal = enableGlobal;
  global.setQwenAudioGlobalEnabled = setGlobalEnabled;
  global.restartQwenAudioGlobal = restartGlobal;
  global.MultiCCManageQwenAudio = Object.freeze({ initialize, loadPanel });
})(window);
