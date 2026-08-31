'use strict';

// Shared browser/CommonJS boundary for the Auto Provider candidate policy and
// editor. Chat embeds it inside the AI-config modal; other surfaces can mount
// the same editor without importing Chat's model/effort/session concerns.
(function initAutoProviderEditor(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MultiCCAutoProviderEditor = api;
})(typeof window !== 'undefined' ? window : null, function createAutoProviderEditorApi() {
  const PROTOCOLS = Object.freeze(['anthropic', 'openai_responses', 'openai_chat']);
  const PROTOCOL_SET = new Set(PROTOCOLS);
  const MAX_CANDIDATES = 12;
  const MAX_ATTEMPTS = 4;
  const AUTO_PREFIX = '__auto__:';
  const STYLE_ID = 'multicc-auto-provider-editor-style';

  function protocolOf(provider) {
    const value = provider && (provider.protocol || provider.apiFormat);
    return PROTOCOL_SET.has(value) ? value : null;
  }

  function protocolLabel(protocol) {
    return ({
      anthropic: 'Anthropic Messages',
      openai_responses: 'OpenAI Responses',
      openai_chat: 'OpenAI Chat Completions',
    })[protocol] || String(protocol || '');
  }

  function optionValue(protocol) {
    return PROTOCOL_SET.has(protocol) ? `${AUTO_PREFIX}${protocol}` : '';
  }

  function protocolFromValue(value) {
    const text = String(value || '');
    if (!text.startsWith(AUTO_PREFIX)) return null;
    const protocol = text.slice(AUTO_PREFIX.length);
    return PROTOCOL_SET.has(protocol) ? protocol : null;
  }

  function providersForProtocol(providers, protocol) {
    if (!PROTOCOL_SET.has(protocol)) return [];
    return (Array.isArray(providers) ? providers : [])
      .filter(provider => provider && provider.id && protocolOf(provider) === protocol);
  }

  function availableProtocols(providers) {
    return PROTOCOLS.map(protocol => {
      const pool = providersForProtocol(providers, protocol);
      return Object.freeze({
        protocol,
        label: protocolLabel(protocol),
        count: pool.length,
        managedCount: pool.filter(provider => provider.isOfficial !== true).length,
      });
    }).filter(entry => entry.count >= 2);
  }

  function selectionCrossesTrust(candidates, providers) {
    const byId = new Map((Array.isArray(providers) ? providers : [])
      .filter(provider => provider && provider.id)
      .map(provider => [String(provider.id), provider]));
    const trustDomains = new Set((Array.isArray(candidates) ? candidates : [])
      .filter(candidate => candidate && candidate.enabled !== false)
      .map(candidate => byId.get(String(candidate.providerId || '')))
      .filter(Boolean)
      .map(provider => provider.isOfficial === true ? 'official' : 'user-managed'));
    return trustDomains.size > 1;
  }

  function candidateModel(provider, configured) {
    if (configured && Object.prototype.hasOwnProperty.call(configured, 'model')) {
      return configured.model ? String(configured.model) : null;
    }
    if (provider && provider.isOfficial === true) return null;
    return provider && provider.model ? String(provider.model) : null;
  }

  function candidateForProvider(provider, priority, configured) {
    return {
      providerId: String(provider.id),
      model: candidateModel(provider, configured),
      priority,
      enabled: true,
    };
  }

  function defaultCandidates(providers, protocol) {
    return providersForProtocol(providers, protocol)
      .filter(provider => provider.isOfficial !== true)
      .slice(0, 2)
      .map((provider, index) => candidateForProvider(provider, index + 1, null));
  }

  // A new Auto pool is deliberately conservative: only the first two
  // user-managed providers are enabled. Official subscription routes are shown
  // by the editor, but entering a mixed trust-domain pool is always an explicit
  // user action followed by confirmation.
  function defaultSelection(providers, protocol) {
    const candidates = defaultCandidates(providers, protocol);
    if (candidates.length < 2) return null;
    return {
      version: 1,
      mode: 'auto',
      protocol,
      candidates,
      maxAttempts: 2,
      sticky: true,
      allowCrossTrust: false,
    };
  }

  function fail(error, code) {
    return Object.freeze({ ok: false, value: null, error, code });
  }

  function serializeDraft(draft = {}) {
    const protocol = String(draft.protocol || '');
    if (!PROTOCOL_SET.has(protocol)) {
      if (!protocol) return Object.freeze({ ok: true, value: null, error: null, code: null });
      return fail('无效的 Auto Provider 协议。', 'invalid_protocol');
    }
    const source = Array.isArray(draft.candidates) ? draft.candidates : [];
    const candidates = [];
    const ids = new Set();
    for (let index = 0; index < source.length; index += 1) {
      const raw = source[index];
      if (!raw || raw.enabled === false) continue;
      const providerId = String(raw.providerId || '').trim();
      if (!providerId || ids.has(providerId)) {
        return fail(providerId ? `Provider ${providerId} 重复。` : '候选 Provider 无效。',
          providerId ? 'duplicate_provider' : 'invalid_provider');
      }
      const priority = Number(raw.priority == null ? index + 1 : raw.priority);
      if (!Number.isSafeInteger(priority) || priority < 1 || priority > 100) {
        return fail('优先级必须是 1–100 的整数。', 'invalid_priority');
      }
      ids.add(providerId);
      candidates.push({
        providerId,
        model: raw.model == null || String(raw.model).trim() === '' ? null : String(raw.model).trim(),
        priority,
        enabled: true,
        _index: index,
      });
    }
    if (candidates.length < 2) {
      return fail('至少启用两个同协议 Provider。', 'insufficient_candidates');
    }
    if (candidates.length > MAX_CANDIDATES) {
      return fail(`最多启用 ${MAX_CANDIDATES} 个候选 Provider。`, 'too_many_candidates');
    }
    candidates.sort((left, right) => left.priority - right.priority || left._index - right._index);
    const cleanCandidates = candidates.map(({ _index, ...candidate }) => candidate);
    const providers = Array.isArray(draft.providers) ? draft.providers : [];
    const crossesTrust = selectionCrossesTrust(cleanCandidates, providers);
    if (crossesTrust && draft.crossTrustConfirmed !== true) {
      return fail('混合 Official 与自管 Provider 前，请先确认跨上游发送风险。',
        'cross_trust_confirmation_required');
    }
    const requestedAttempts = Number(draft.maxAttempts) || 2;
    const maxAttempts = Math.max(2, Math.min(MAX_ATTEMPTS, cleanCandidates.length, requestedAttempts));
    return Object.freeze({
      ok: true,
      value: {
        version: 1,
        mode: 'auto',
        protocol,
        candidates: cleanCandidates,
        maxAttempts,
        sticky: draft.sticky !== false,
        allowCrossTrust: crossesTrust && draft.crossTrustConfirmed === true,
      },
      error: null,
      code: null,
    });
  }

  function ensureStyles(document) {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .multicc-auto-editor{border:1px solid var(--line-strong,#30363d);border-radius:8px;padding:10px;margin:0 0 12px;color:var(--text,#c9d1d9)}
      .multicc-auto-editor-title{font-size:12px;font-weight:600;margin-bottom:3px}
      .multicc-auto-editor-help{font-size:11px;color:var(--muted,#8b949e);line-height:1.45;margin-bottom:8px}
      .multicc-auto-editor-list{min-width:0}
      .multicc-auto-editor-row{display:grid;grid-template-columns:22px minmax(150px,1fr) 70px minmax(130px,1fr);gap:7px;align-items:center;padding:6px 0;border-bottom:1px solid var(--line,#21262d)}
      .multicc-auto-editor-name{font-size:11px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .multicc-auto-editor input[type=number],.multicc-auto-editor select{box-sizing:border-box;width:100%;min-width:0;background:var(--well,#0d1117);color:var(--text,#c9d1d9);border:1px solid var(--line-strong,#30363d);border-radius:5px;padding:5px}
      .multicc-auto-editor-error{color:var(--danger,#f85149);font-size:11px;margin:6px 0}
      .multicc-auto-editor-warning{color:var(--warning,#d29922);font-size:11px;line-height:1.45;margin:7px 0;padding:7px;border:1px solid color-mix(in srgb,var(--warning,#d29922) 45%,transparent);border-radius:6px}
      .multicc-auto-editor-warning label{display:flex;align-items:flex-start;gap:6px;margin-top:6px;color:var(--text,#c9d1d9)}
      .multicc-auto-editor-controls{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:8px;font-size:11px;color:var(--muted,#8b949e)}
      .multicc-auto-editor-controls select{width:auto;padding:3px 6px}
      @media (max-width:640px){
        .multicc-auto-editor-row{grid-template-columns:22px minmax(0,1fr);gap:6px 8px;padding:9px 0}
        .multicc-auto-editor-name{white-space:normal;overflow:visible}
        .multicc-auto-editor-priority,.multicc-auto-editor-model{grid-column:2}
      }
    `;
    (document.head || document.body).appendChild(style);
  }

  function element(document, tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function mount(options = {}) {
    const document = options.document
      || (typeof window !== 'undefined' && window.document) || null;
    const container = options.container;
    if (!document || !container || typeof container.appendChild !== 'function') {
      throw new TypeError('Auto Provider editor requires document and container');
    }
    ensureStyles(document);
    let providers = Array.isArray(options.providers) ? options.providers : [];
    let protocol = PROTOCOL_SET.has(options.protocol) ? options.protocol : null;
    let initialSelection = options.initialSelection || null;
    let destroyed = false;
    const formatProvider = typeof options.formatProvider === 'function'
      ? options.formatProvider : provider => provider.name || provider.id;
    const onChange = typeof options.onChange === 'function' ? options.onChange : null;

    container.classList.add('multicc-auto-editor');
    const title = element(document, 'div', 'multicc-auto-editor-title', 'Auto Provider 候选池');
    const help = element(document, 'div', 'multicc-auto-editor-help',
      '按优先级尝试；仅在首字节前且没有工具副作用时切换。新鲜额度已耗尽的候选会预先跳过。');
    const list = element(document, 'div', 'multicc-auto-editor-list');
    const error = element(document, 'div', 'multicc-auto-editor-error');
    error.setAttribute('role', 'alert');
    error.style.display = 'none';
    const warning = element(document, 'div', 'multicc-auto-editor-warning');
    warning.style.display = 'none';
    const warningText = element(document, 'div', '',
      '已选择 Official 与自管 Provider：同一对话上下文可能在自动切换时发送给多个上游。');
    const confirmLabel = element(document, 'label');
    const confirm = document.createElement('input');
    confirm.type = 'checkbox';
    confirm.className = 'multicc-auto-editor-cross-trust-confirm';
    confirmLabel.append(confirm, document.createTextNode('我确认允许本候选池跨这些上游发送对话上下文'));
    warning.append(warningText, confirmLabel);
    const controls = element(document, 'div', 'multicc-auto-editor-controls');
    const maxLabel = element(document, 'label', '', '最多尝试 ');
    const maxAttempts = document.createElement('select');
    maxAttempts.className = 'multicc-auto-editor-max-attempts';
    for (let value = 2; value <= MAX_ATTEMPTS; value += 1) {
      const option = document.createElement('option');
      option.value = String(value);
      option.textContent = String(value);
      maxAttempts.appendChild(option);
    }
    maxLabel.appendChild(maxAttempts);
    const stickyLabel = element(document, 'label');
    const sticky = document.createElement('input');
    sticky.type = 'checkbox';
    sticky.className = 'multicc-auto-editor-sticky';
    stickyLabel.append(sticky, document.createTextNode(' 成功后优先沿用'));
    controls.append(maxLabel, stickyLabel);
    container.replaceChildren(title, help, list, error, warning, controls);

    function rows() {
      return [...list.querySelectorAll('.multicc-auto-editor-row')];
    }

    function rawCandidates() {
      return rows().map(row => ({
        providerId: row.dataset.providerId,
        model: row.querySelector('.multicc-auto-editor-model').value || null,
        priority: Number(row.querySelector('.multicc-auto-editor-priority').value),
        enabled: row.querySelector('.multicc-auto-editor-enabled').checked,
      }));
    }

    function enabledCandidates() {
      return rawCandidates().filter(candidate => candidate.enabled);
    }

    function showError(message) {
      error.textContent = message || '';
      error.style.display = message ? '' : 'none';
    }

    function syncAttemptLimit() {
      const enabledCount = enabledCandidates().length;
      const ceiling = Math.max(2, Math.min(MAX_ATTEMPTS, enabledCount));
      for (const option of maxAttempts.options) option.disabled = Number(option.value) > ceiling;
      if (Number(maxAttempts.value) > ceiling) maxAttempts.value = String(ceiling);
    }

    function syncCandidateLimit() {
      const enabledCount = enabledCandidates().length;
      for (const row of rows()) {
        const checkbox = row.querySelector('.multicc-auto-editor-enabled');
        checkbox.disabled = !checkbox.checked && enabledCount >= MAX_CANDIDATES;
      }
    }

    function syncTrustWarning({ preserveConfirmation = true } = {}) {
      const mixed = selectionCrossesTrust(enabledCandidates(), providers);
      warning.style.display = mixed ? '' : 'none';
      if (!mixed || !preserveConfirmation) confirm.checked = false;
      return mixed;
    }

    function notify() {
      showError('');
      syncAttemptLimit();
      syncCandidateLimit();
      const crossesTrust = syncTrustWarning();
      if (onChange) {
        onChange(Object.freeze({
          protocol,
          enabledCount: enabledCandidates().length,
          crossesTrust,
          crossTrustConfirmed: confirm.checked,
        }));
      }
    }

    function render() {
      if (destroyed) return;
      container.style.display = protocol ? '' : 'none';
      list.replaceChildren();
      showError('');
      if (!protocol) return;
      const configuredSelection = initialSelection && initialSelection.mode === 'auto'
        && initialSelection.protocol === protocol ? initialSelection : null;
      const configuredById = new Map((configuredSelection?.candidates || [])
        .map(candidate => [String(candidate.providerId || ''), candidate]));
      const defaultsById = new Map(defaultCandidates(providers, protocol)
        .map(candidate => [candidate.providerId, candidate]));
      let nextUnconfiguredPriority = Math.max(0,
        ...[...configuredById.values(), ...defaultsById.values()]
          .map(candidate => Number(candidate.priority) || 0));
      const pool = providersForProtocol(providers, protocol);
      pool.forEach((provider) => {
        const providerId = String(provider.id);
        const configured = configuredById.get(providerId);
        const row = element(document, 'div', 'multicc-auto-editor-row');
        row.dataset.providerId = providerId;
        const enabled = document.createElement('input');
        enabled.type = 'checkbox';
        enabled.className = 'multicc-auto-editor-enabled';
        enabled.checked = configuredSelection ? !!configured && configured.enabled !== false : defaultsById.has(providerId);
        enabled.setAttribute('aria-label', `启用 ${provider.name || providerId}`);
        const name = element(document, 'span', 'multicc-auto-editor-name', String(formatProvider(provider) || providerId));
        name.title = name.textContent;
        const priority = document.createElement('input');
        priority.type = 'number';
        priority.min = '1';
        priority.max = '100';
        priority.className = 'multicc-auto-editor-priority';
        priority.value = String(configured?.priority || defaultsById.get(providerId)?.priority
          || ++nextUnconfiguredPriority);
        priority.title = '优先级（数字越小越优先）';
        priority.setAttribute('aria-label', `${provider.name || providerId} 优先级`);
        const model = document.createElement('select');
        model.className = 'multicc-auto-editor-model';
        model.setAttribute('aria-label', `${provider.name || providerId} 模型`);
        const preferredModel = candidateModel(provider, configured);
        const models = [...new Set([
          '', provider.model, ...(Array.isArray(provider.modelOptions) ? provider.modelOptions : []), preferredModel,
        ].filter(value => value != null).map(value => String(value)))];
        for (const modelId of models) {
          const option = document.createElement('option');
          option.value = modelId;
          option.textContent = modelId || 'Provider 默认';
          model.appendChild(option);
        }
        model.value = preferredModel || '';
        row.append(enabled, name, priority, model);
        list.appendChild(row);
        enabled.addEventListener('change', () => {
          if (!selectionCrossesTrust(enabledCandidates(), providers)) confirm.checked = false;
          notify();
        });
        priority.addEventListener('input', notify);
        model.addEventListener('change', notify);
      });
      maxAttempts.value = String(configuredSelection?.maxAttempts
        || Math.max(2, Math.min(3, enabledCandidates().length)));
      sticky.checked = configuredSelection ? configuredSelection.sticky !== false : true;
      confirm.checked = configuredSelection?.allowCrossTrust === true;
      syncAttemptLimit();
      syncCandidateLimit();
      syncTrustWarning();
    }

    maxAttempts.addEventListener('change', notify);
    sticky.addEventListener('change', notify);
    confirm.addEventListener('change', notify);

    const controller = Object.freeze({
      setContext(next = {}) {
        if (destroyed) return;
        if (Object.prototype.hasOwnProperty.call(next, 'providers')) {
          providers = Array.isArray(next.providers) ? next.providers : [];
        }
        if (Object.prototype.hasOwnProperty.call(next, 'protocol')) {
          protocol = PROTOCOL_SET.has(next.protocol) ? next.protocol : null;
        }
        if (Object.prototype.hasOwnProperty.call(next, 'initialSelection')) {
          initialSelection = next.initialSelection || null;
        }
        render();
      },
      read() {
        if (destroyed) return fail('Auto Provider 编辑器已关闭。', 'editor_destroyed');
        const result = serializeDraft({
          protocol,
          providers,
          candidates: rawCandidates(),
          maxAttempts: Number(maxAttempts.value),
          sticky: sticky.checked,
          crossTrustConfirmed: confirm.checked,
        });
        showError(result.ok ? '' : result.error);
        if (!result.ok && result.code === 'cross_trust_confirmation_required') confirm.focus();
        return result;
      },
      destroy() {
        if (destroyed) return;
        destroyed = true;
        container.replaceChildren();
        container.classList.remove('multicc-auto-editor');
        container.style.display = 'none';
      },
    });
    render();
    return controller;
  }

  return Object.freeze({
    AUTO_PREFIX,
    MAX_ATTEMPTS,
    MAX_CANDIDATES,
    PROTOCOLS,
    availableProtocols,
    candidateModel,
    defaultSelection,
    mount,
    optionValue,
    protocolFromValue,
    protocolLabel,
    protocolOf,
    providersForProtocol,
    selectionCrossesTrust,
    serializeDraft,
  });
});
