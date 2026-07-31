(function initManageQwenAudio(global) {
  'use strict';

  let pollTimer = null;
  let getDirectories = () => [];
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

  function renderFleets(gateways, runtimes) {
    const directories = getDirectories() || [];
    const select = document.getElementById('qwen-audio-fleet');
    if (select) {
      const previous = select.value;
      select.replaceChildren();
      for (const directory of directories) {
        const option = document.createElement('option');
        option.value = directory.id;
        option.textContent = directory.name || directory.path || directory.id;
        select.appendChild(option);
      }
      if (directories.some(directory => directory.id === previous)) select.value = previous;
    }

    const container = document.getElementById('qwen-audio-fleets');
    if (!container) return;
    container.replaceChildren();
    if (!gateways.length) {
      const empty = document.createElement('div');
      empty.className = 'sec-desc';
      empty.textContent = '尚未给任何 Fleet 启用 Qwen Audio Gateway。';
      container.appendChild(empty);
      return;
    }

    for (const gateway of gateways) {
      const directory = directories.find(item => item.id === gateway.directoryId);
      const runtime = runtimes.get(gateway.directoryId) || {};
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--line);border-radius:8px;flex-wrap:wrap;';
      const title = document.createElement('span');
      title.style.cssText = 'font-size:13px;color:var(--text);font-weight:600;flex:1;min-width:180px;';
      title.textContent = directory?.name || gateway.directoryId;
      const badge = document.createElement('span');
      badge.className = 'status-text';
      badge.textContent = runtimeLabel(runtime);
      badge.style.color = runtime.state === 'running' ? '#3fb950'
        : ['failed', 'error'].includes(runtime.state) ? '#f85149' : '#d29922';
      row.append(title, badge);
      row.appendChild(button(gateway.enabled ? '停用' : '启用', () => (
        setFleetEnabled(gateway.directoryId, !gateway.enabled)
      )));
      if (gateway.enabled) row.appendChild(button('重启进程', () => restartFleet(gateway.directoryId)));
      if (runtime.state === 'running' && runtime.url) {
        row.appendChild(button('打开语音界面', () => global.open(runtime.url, '_blank', 'noopener')));
      }
      container.appendChild(row);
    }
  }

  async function loadPanel() {
    const status = document.getElementById('qwen-audio-status');
    try {
      const [settings, runtimeBody, gatewaysBody] = await Promise.all([
        fetchJson(authPath('/api/settings/voice')),
        fetchJson(authPath('/api/v1/voice-runtime')),
        fetchJson(authPath('/api/v1/voice-gateways')),
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

      const gateways = gatewaysBody.gateways || [];
      const runtimeEntries = await Promise.all(gateways.map(async gateway => {
        try {
          const body = await fetchJson(authPath(`/api/v1/directories/${encodeURIComponent(gateway.directoryId)}/voice-gateway/runtime`));
          return [gateway.directoryId, body.runtime || {}];
        } catch (_) {
          return [gateway.directoryId, {}];
        }
      }));
      renderFleets(gateways, new Map(runtimeEntries));

      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = null;
      if (runtime.state === 'installing'
          || runtimeEntries.some(([, item]) => ['installing', 'starting', 'backoff'].includes(item.state))) {
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

  async function setFleetEnabled(directoryId, enabled, autoInstall = false) {
    const status = document.getElementById('qwen-audio-status');
    try {
      await fetchJson(authPath(`/api/v1/directories/${encodeURIComponent(directoryId)}/voice-gateway`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, provider: 'qwen-audio-agent', autoInstall }),
      });
      notify(enabled ? 'Qwen Audio Fleet Gateway 已启用' : 'Qwen Audio Fleet Gateway 已停用');
      await loadPanel();
    } catch (error) {
      if (status) {
        status.textContent = `Fleet 操作失败：${error.message}`;
        status.className = 'status-text err';
      }
    }
  }

  async function enableFleet() {
    const select = document.getElementById('qwen-audio-fleet');
    const directoryId = select?.value;
    if (!directoryId) {
      notify('请先创建并选择 Fleet', true);
      return;
    }
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
    await setFleetEnabled(directoryId, true, true);
  }

  async function restartFleet(directoryId) {
    const status = document.getElementById('qwen-audio-status');
    try {
      await fetchJson(authPath(`/api/v1/directories/${encodeURIComponent(directoryId)}/voice-gateway/restart`), { method: 'POST' });
      notify('Qwen Audio 进程已重启');
      await loadPanel();
    } catch (error) {
      if (status) {
        status.textContent = `重启失败：${error.message}`;
        status.className = 'status-text err';
      }
    }
  }

  function initialize(options = {}) {
    if (typeof options.getDirectories === 'function') getDirectories = options.getDirectories;
    if (typeof options.notify === 'function') notify = options.notify;
    return loadPanel();
  }

  global.saveQwenAudioSettings = saveSettings;
  global.installQwenAudioRuntime = installRuntime;
  global.enableQwenAudioFleet = enableFleet;
  global.setQwenAudioFleetEnabled = setFleetEnabled;
  global.restartQwenAudioFleet = restartFleet;
  global.MultiCCManageQwenAudio = Object.freeze({ initialize, loadPanel });
})(window);
