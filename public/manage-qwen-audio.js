(function initManageQwenAudio(global) {
  'use strict';

  let pollTimer = null;
  let notify = () => {};

  // 这一格（Qwen 实时语音）同时活在旧管理台和 Air 的原生语音面板里，文案得跟着界面
  // 语言走 —— 否则英文界面下这一块是中英混排。i18n.js 在两边都先于本文件加载，
  // 取不到就原样退回 key（与其它共享模块同一条兜底）。
  const t = (key, params) => (typeof global.t === 'function' ? global.t(key, params) : key);

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
    // 状态 → i18n key（不是状态 → 文案）：语言在渲染这一刻才定，表里存死文案
    // 就等于把语言钉在脚本加载的那一刻。
    const keys = {
      not_installed: 'qwenAudioStateNotInstalled',
      installing: 'qwenAudioStateInstalling',
      ready: 'qwenAudioStateReady',
      error: 'qwenAudioStateError',
      stopped: 'qwenAudioStateStopped',
      starting: 'qwenAudioStateStarting',
      running: 'qwenAudioStateRunning',
      backoff: 'qwenAudioStateBackoff',
      failed: 'qwenAudioStateFailed',
      qwen_api_key_missing: 'qwenAudioKeyMissing',
      qwen_runtime_not_installed: 'qwenAudioStateRuntimeMissing',
      commander_not_found: 'qwenAudioStateCommanderMissing',
      commander_ambiguous: 'qwenAudioStateCommanderAmbiguous',
      commander_binding_stale: 'qwenAudioStateCommanderStale',
    };
    // 后端将来加了没登记过的状态时，原样显示状态码比显示「未知」更有用。
    return keys[runtime?.state] ? t(keys[runtime.state]) : (runtime?.state || t('qwenAudioStateUnknown'));
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
    title.textContent = t('qwenAudioGlobalTitle');
    const badge = document.createElement('span');
    badge.className = 'status-text';
    badge.textContent = gateway.enabled ? runtimeLabel(runtime) : t('qwenAudioNotEnabled');
    badge.style.color = runtime.state === 'running' ? '#3fb950'
      : ['failed', 'error'].includes(runtime.state) ? '#f85149' : '#d29922';
    row.append(title, badge);
    row.appendChild(button(gateway.enabled ? t('qwenAudioDisable') : t('qwenAudioEnable'), () => setGlobalEnabled(!gateway.enabled)));
    if (gateway.enabled) {
      row.appendChild(button(t('qwenAudioRestart'), restartGlobal));
      // Opening always goes through launch, never through a raw runtime URL, so
      // the window carries a host-issued ticket instead of a bare address.
      row.appendChild(button(t('qwenAudioOpenUi'), openGlobalVoice));
    }
    container.appendChild(row);

    if (Array.isArray(legacy) && legacy.length) {
      const note = document.createElement('div');
      note.className = 'sec-desc';
      note.style.margin = '0';
      note.textContent = t('qwenAudioLegacyNote', { n: legacy.length });
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
        key.placeholder = qwen.hasApiKey ? t('airVoiceKeyConfiguredHint') : t('qwenAudioKeyPlaceholder');
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
          ? t('qwenAudioRuntimeInstalled', { version: runtime.package?.version || '' })
          : runtime.state === 'installing' ? t('qwenAudioInstalling') : t('qwenAudioInstall');
      }
      if (status) {
        const keyState = qwen.hasApiKey ? t('qwenAudioKeyReady') : t('qwenAudioKeyMissing');
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
        status.textContent = t('qwenAudioLoadFailed', { message: error.message });
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
      if (!quiet) notify(t('qwenAudioSaved'));
      return true;
    } catch (error) {
      if (status) {
        status.textContent = t('qwenAudioSaveFailed', { message: error.message });
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
      if (status) status.textContent = t('qwenAudioInstallStarted');
      await loadPanel();
    } catch (error) {
      if (install) install.disabled = false;
      if (status) {
        status.textContent = t('qwenAudioInstallFailed', { message: error.message });
        status.className = 'status-text err';
      }
    }
  }

  // prefix 收的是 i18n key（不是现成文案）：文案里都带 {message} 占位。
  function reportError(prefixKey, error) {
    const status = document.getElementById('qwen-audio-status');
    if (!status) return;
    status.textContent = t(prefixKey, { message: error.message });
    status.className = 'status-text err';
  }

  async function setGlobalEnabled(enabled, autoInstall = false) {
    try {
      await fetchJson(authPath('/api/v1/voice-gateway'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, provider: 'qwen-audio-agent', autoInstall }),
      });
      notify(enabled ? t('qwenAudioEnabled') : t('qwenAudioDisabled'));
      await loadPanel();
    } catch (error) {
      reportError('qwenAudioGatewayFailed', error);
    }
  }

  async function enableGlobal() {
    const keyInput = document.getElementById('qwen-audio-key');
    if (!keyInput?.value && keyInput?.placeholder !== t('airVoiceKeyConfiguredHint')) {
      const status = document.getElementById('qwen-audio-status');
      if (status) {
        status.textContent = t('qwenAudioNeedKey');
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
      notify(t('qwenAudioRestarted'));
      await loadPanel();
    } catch (error) {
      reportError('qwenAudioRestartFailed', error);
    }
  }

  // Same launch path as the Dashboard button: scope is global here, so the Host
  // routes through the voice router instead of binding to a session.
  async function openGlobalVoice(trigger) {
    const button = trigger?.currentTarget || trigger;
    const client = global.MultiCCVoiceLaunch;
    if (!client || typeof client.launch !== 'function') {
      notify(t('qwenAudioModuleMissing'), true);
      return;
    }
    if (button && 'disabled' in button) button.disabled = true;
    try {
      const result = await client.launch({ withToken: path => authPath(path) });
      if (!result.ok) {
        const error = new Error(result.message || result.code);
        reportError('qwenAudioOpenFailed', error);
        notify(t('qwenAudioOpenFailed', { message: error.message }), true);
      }
    } catch (error) {
      reportError('qwenAudioOpenFailed', error);
      notify(t('qwenAudioOpenFailed', { message: error.message }), true);
    } finally {
      if (button && 'disabled' in button) button.disabled = false;
    }
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
  global.MultiCCManageQwenAudio = Object.freeze({ initialize, loadPanel, openGlobalVoice });
})(window);
