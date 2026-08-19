'use strict';

(function initManageSessionLifecycle(root) {
  if (!root || !root.MultiCCApi || !root.MultiCCProviderCatalog) {
    throw new Error('Manage session lifecycle dependencies are unavailable');
  }

  const api = root.MultiCCApi;
  const catalog = root.MultiCCProviderCatalog;
  const mutationEpoch = new Map();
  let nextMutationEpoch = 0;
  const QODER_MODEL_OPTIONS = Object.freeze([
    { value: '', label: '默认（跟随 Qoder CN 设置）' },
    { value: 'auto', label: 'Auto（智能路由）' },
    { value: 'ultimate', label: 'Ultimate（极致）' },
    { value: 'performance', label: 'Performance（性能）' },
    { value: 'efficient', label: 'Efficient（经济）' },
    { value: 'lite', label: 'Lite（轻量）' },
  ]);
  const ZCODE_MODEL_OPTIONS = Object.freeze([
    { value: '', label: '默认（跟随 ZCode 设置）' },
  ]);

  function supportsManagedProvider(cli) {
    return cli === 'claude' || cli === 'codex' || cli === 'opencode' || cli === 'zcode';
  }

  // Qoder CN's real catalog comes from `qoderclicn --list-models` via
  // /api/qoder/models (1-day cache, shared with chat.html through
  // shared/models.js). Fall back to the built-in routing tiers on a cache miss
  // — the dialog builds its <select> synchronously and cannot await.
  function qoderModelOptions() {
    const live = typeof root.readQoderModelsSync === 'function' ? root.readQoderModelsSync() : [];
    if (!live.length) return QODER_MODEL_OPTIONS;
    return [
      QODER_MODEL_OPTIONS[0],
      ...live.map(entry => ({ value: entry.model, label: entry.label || entry.model })),
    ];
  }

  // Claude's servable ids come from the installed CLI's bundle via
  // /api/claude/models (1-day cache, shared with chat.html through
  // shared/models.js). Fall back to the static table on a cache miss — the
  // dialog builds its <select> synchronously and cannot await.
  function claudeModelOptions() {
    const live = typeof root.readClaudeModelsSync === 'function' ? root.readClaudeModelsSync() : [];
    const source = live.length
      ? live.map(entry => ({ value: entry.model, label: entry.label || entry.model }))
      : CLAUDE_MODEL_OPTIONS.filter(o => o.value && o.value !== '__custom__');
    return [CLAUDE_MODEL_OPTIONS[0], ...source];
  }

  function vendorModelOptions(cli) {
    if (cli === 'qoder') return qoderModelOptions();
    if (cli === 'claude') return claudeModelOptions();
    return null;
  }

  function effortLabelForCli(cli, isClaude) {
    if (cli === 'qoder') return 'Reasoning Effort';
    if (cli === 'opencode') return 'Variant';
    return isClaude ? 'Effort' : 'Reasoning Level';
  }

  function effortOptionsForCli(cli, isClaude) {
    if (cli === 'zcode') return [];
    if (cli === 'qoder') return ['', 'low', 'medium', 'high', 'xhigh', 'max'];
    if (cli === 'opencode') return ['', 'minimal', 'low', 'medium', 'high', 'max'];
    return isClaude
      ? ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode']
      : ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  }

  function defaultEffortForCli(cli, isClaude) {
    if (cli === 'qoder' || cli === 'opencode' || cli === 'zcode') return '';
    return isClaude ? 'medium' : 'xhigh';
  }

  function beginMutation(ownerKey) {
    const epoch = ++nextMutationEpoch;
    mutationEpoch.set(ownerKey, epoch);
    return { ownerKey, epoch };
  }

  function ownsMutation(owner) {
    return mutationEpoch.get(owner.ownerKey) === owner.epoch;
  }

  async function ownedJson(ownerKey, url, options) {
    const owner = beginMutation(ownerKey);
    try {
      const data = await api.json(url, options);
      if (!ownsMutation(owner)) return { owned: false };
      mutationEpoch.delete(ownerKey);
      return { owned: true, data };
    } catch (error) {
      if (!ownsMutation(owner)) return { owned: false };
      mutationEpoch.delete(ownerKey);
      return { owned: true, error };
    }
  }

  function showApiError(error) {
    const detail = api.errorDisplay(error);
    const status = detail.status ? ` · HTTP ${detail.status}` : '';
    const request = detail.requestId ? ` · request ${detail.requestId}` : '';
    showToast(`Error: ${detail.message}${status}${request}`, true);
  }

  function buildSessionCreatePayload(cli, kind, result) {
    const body = { cli, kind };
    const label = String(result && result.label || '').trim();
    const rolePrompt = String(result && result.rolePrompt || '').trim();
    if (label) body.label = label;
    if (result && result.model) body.model = result.model;
    if (result && result.provider !== null && result.provider !== undefined && result.provider !== '') {
      body.provider = result.provider;
    }
    if (result && result.effort) body.effort = result.effort;
    if (rolePrompt) body.rolePrompt = rolePrompt;
    return body;
  }

  // CLAUDE_MODEL_OPTIONS + modelShortName live in shared/models.js (loaded before manage.js).

  // aliasMap (tier→{model,name}) for a provider id from the cached provider list,
  // or null. Alias-mapped relays declare one wire model per Claude tier.
  function providerAliasMap(providerId) {
    if (!providerId) return null;
    const p = catalog.findProvider(_providerData, '', providerId);
    return p && p.aliasMap && Object.keys(p.aliasMap).length ? p.aliasMap : null;
  }

  // Ordered alias tiers [tier,{model,name}] for an alias-mapped relay, or [].
  function providerAliasTiers(providerId) {
    return aliasTiersFromMap(providerAliasMap(providerId));
  }

  // Map a stored wire model id (e.g. claude-opus-4-8) back to its alias tier so
  // the tier dropdown pre-selects instead of dropping into the custom-id field.
  function normalizeModelForProvider(providerId, model) {
    if (!model) return model;
    for (const [t, m] of providerAliasTiers(providerId)) {
      if (t === model) return model;
      if (m.model === model) return t;
    }
    return model;
  }

  // Display name preferring an alias-mapped relay's real model name (e.g. GLM5.2),
  // given either a tier key or a wire model id it maps to.
  function modelDisplayName(model, providerId) {
    if (!model) return model;
    const map = providerAliasMap(providerId);
    if (map) {
      if (map[model]) {
        const e = map[model];
        if (e.name) return e.name;     // 显示名优先（如 GLM5.2）
        if (e.model) return e.model;   // 否则用映射的真模型 id（如 glm-5.2），不回退到 tier 别名 opus
      }
      for (const v of Object.values(map)) {
        if (v && v.model === model) return v.name || model;
      }
    }
    return modelShortName(model);
  }

  // WebView-safe model picker (same pattern as _dialog). Resolves to '' (default),
  // a model string, or null (cancelled).
  function showModelPicker({ title = tt('modelTitle'), okText = tt('create'), current = '', providerId = '', cli = 'claude' } = {}) {
    return new Promise((resolve) => {
      let closed = false;
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px;';
      const box = document.createElement('div');
      box.style.cssText = 'background:#161b22;border:1px solid #30363d;border-radius:12px;padding:18px;width:380px;max-width:94vw;';
      const msg = document.createElement('div');
      msg.style.cssText = 'font-size:14px;color:#c9d1d9;line-height:1.6;margin-bottom:12px;';
      msg.textContent = title;
      box.appendChild(msg);

      // Alias-mapped relays: list the tiers directly, each reading
      // "opus · GLM5.2 · glm-5.2" (别名 - 展示名 - 真实id); map a stored wire id back to its tier.
      const tiers = cli === 'zcode' ? [] : providerAliasTiers(providerId);
      const vendorOptions = vendorModelOptions(cli);
      const provider = catalog.findProvider(_providerData, '', providerId);
      const providerModels = provider ? catalog.modelsFor(provider) : [];
      const optionList = providerModels.length
        ? [...providerModels.map(value => ({ value, label: value })), { value: '__custom__', labelKey: 'custom' }]
        : vendorOptions
        ? [...vendorOptions, { value: '__custom__', labelKey: 'custom' }]
        : tiers.length
        ? [
            ...tiers.map(([t, m]) => ({
              value: t,
              label: formatAliasTierLabel(t, m),
            })),
            { value: '__custom__', labelKey: 'custom' },
          ]
        : CLAUDE_MODEL_OPTIONS;
      const cur = tiers.length ? normalizeModelForProvider(providerId, current) : current;
      const isKnown = optionList.some(o => o.value === cur);
      const select = document.createElement('select');
      select.style.cssText = 'width:100%;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:8px 10px;outline:none;margin-bottom:12px;';
      for (const o of optionList) {
        const opt = document.createElement('option');
        opt.value = o.value; opt.textContent = o.labelKey ? tt(o.labelKey) : o.label;
        select.appendChild(opt);
      }
      select.value = isKnown ? cur : '__custom__';
      box.appendChild(select);

      const custom = document.createElement('input');
      custom.type = 'text';
      custom.placeholder = '模型 ID，如 claude-opus-4-8';
      custom.value = isKnown ? '' : cur;
      custom.style.cssText = 'width:100%;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:8px 10px;outline:none;margin-bottom:12px;display:none;';
      box.appendChild(custom);
      const syncCustom = () => {
        custom.style.display = select.value === '__custom__' ? '' : 'none';
      };
      syncCustom();
      select.onchange = () => { syncCustom(); if (select.value === '__custom__') custom.focus(); };

      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
      const cancel = document.createElement('button');
      cancel.className = 'btn'; cancel.textContent = tt('cancel');
      const ok = document.createElement('button');
      ok.className = 'btn btn-green'; ok.textContent = okText;
      row.appendChild(cancel); row.appendChild(ok);
      box.appendChild(row);
      overlay.appendChild(box);
      document.body.appendChild(overlay);

      const close = (result) => {
        if (closed) return;
        closed = true;
        document.removeEventListener('keydown', onKey, true);
        overlay.remove();
        resolve(result);
      };
      const accept = () => close(select.value === '__custom__' ? custom.value.trim() : select.value);
      const reject = () => close(null);
      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); reject(); }
        else if (e.key === 'Enter') { e.preventDefault(); accept(); }
      }
      ok.onclick = accept;
      cancel.onclick = reject;
      overlay.onclick = (e) => { if (e.target === overlay) reject(); };
      document.addEventListener('keydown', onKey, true);
      setTimeout(() => { if (!closed) select.focus(); }, 0);
    });
  }

  async function newSessionInDir(dirId, cli, kind) {
    // Single dialog: name + role + provider + model
    let providers = [];
    let defaultProviderId = '';
    if (supportsManagedProvider(cli)) {
      try {
        const appType = cli === 'codex' ? 'codex' : 'claude';
        const data = catalog.normalizeCatalog(
          await api.json(`/api/providers?cli=${encodeURIComponent(cli)}`),
        );
        providers = catalog.providersForCli(data, cli);
        defaultProviderId = cli === 'opencode' || cli === 'zcode'
          ? ''
          : (data.defaults[appType] || '');
      } catch (_) {}
    }

    const result = await showCreateSessionDialog({
      cli, kind, providers, defaultProviderId,
      isClaude: cli === 'claude',
    });
    if (result === null) return; // cancelled

    const { label, rolePrompt, provider, model, effort } = result;

    try {
      const body = buildSessionCreatePayload(cli, kind, { label, rolePrompt, provider, model, effort });

      const sess = await api.json(`/api/directories/${encodeURIComponent(dirId)}/sessions`, {
        method: 'POST',
        json: body,
      });
      showToast(`Created ${cli} ${kind}: ${sess.id}`);
      _expandedDirs.add(dirId);
      await loadDashboard();
      // Open it immediately
      openSessionInline(sess.id, sess.kind);
    } catch (err) {
      showApiError(err);
    }
  }

  // ── Agent-preset (role library) helpers for the new-session dialog ──
  let _agentPresetIndexCache = null;
  let _agentPresetIndexPromise = null;
  async function fetchAgentPresetIndex() {
    if (_agentPresetIndexCache) return _agentPresetIndexCache;
    if (_agentPresetIndexPromise) return _agentPresetIndexPromise;
    _agentPresetIndexPromise = api.json('/api/agent-presets')
      .then(data => (_agentPresetIndexCache = data))
      .catch(() => null)
      .finally(() => { _agentPresetIndexPromise = null; });
    return _agentPresetIndexPromise;
  }
  async function fetchAgentPreset(id) {
    try {
      return await api.json(`/api/agent-presets/${encodeURIComponent(id)}`);
    } catch (_) { return null; }
  }
  async function fetchAgentPresetPrompt(id) {
    const d = await fetchAgentPreset(id);
    return d && d.prompt ? d.prompt : null;
  }

  function providerIdForPresetDefault(preset, providers) {
    if (!preset) return '';
    const declared = preset.defaultProviderId || '';
    if (declared && providers.some(p => p.id === declared)) return declared;
    const model = preset.defaultModel || '';
    const key = (preset.defaultProviderKey || '').toLowerCase();
    if (key === 'xf-maas-coding') {
      const byModel = providers.find(p => model && (p.modelOptions || []).includes(model));
      if (byModel) return byModel.id;
      const byName = providers.find(p => /讯飞|xf|maas/i.test(p.name || ''));
      return byName ? byName.id : '';
    }
    if (key === 'openai-codex') {
      const byName = providers.find(p => /openai|codex\s*官方|官方/i.test(p.name || ''));
      if (byName) return byName.id;
      const byModel = providers.find(p => (p.modelOptions || []).some(m => /^gpt-/i.test(m)));
      return byModel ? byModel.id : '';
    }
    return '';
  }

  function applyPresetDefaultsToDialog(preset, { providers, provSelect, modelSelect, modelCustom, effortSelect, isClaude, defaultProviderId, cli }) {
    if (!preset) return;
    if (!supportsManagedProvider(cli)) return;
    if (cli !== 'claude' && cli !== 'codex') return;
    const presetCli = preset.defaultCli === 'claude' ? 'claude' : 'codex';
    const dialogCli = isClaude ? 'claude' : 'codex';
    if (presetCli && presetCli !== dialogCli) return;

    const providerId = providerIdForPresetDefault(preset, providers);
    if (providerId && [...provSelect.options].some(o => o.value === providerId)) {
      provSelect.value = providerId;
    }
    rebuildModelOptions(modelSelect, modelCustom, providers, provSelect.value, isClaude, defaultProviderId, cli);

    const model = preset.defaultModel || '';
    if (model) {
      if ([...modelSelect.options].some(o => o.value === model)) {
        modelSelect.value = model;
        modelCustom.value = '';
      } else {
        modelSelect.value = '__custom__';
        modelCustom.value = model;
      }
      modelSelect.dispatchEvent(new Event('change'));
    }

    const effort = preset.defaultEffort || '';
    if (effort && [...effortSelect.options].some(o => o.value === effort)) {
      effortSelect.value = effort;
    }
  }

  // Build the <select> options for a model dropdown based on the selected
  // provider's modelOptions. Falls back to CLAUDE_MODEL_OPTIONS when no
  // provider or a provider without modelOptions is chosen.
  function rebuildModelOptions(modelSelect, modelCustom, providers, selectedProviderId, isClaude, defaultProviderId = '', cli = 'claude') {
    const prev = modelSelect.value;
    modelSelect.innerHTML = '';
    const effectiveProviderId = selectedProviderId || defaultProviderId || '';
    const prov = catalog.findProvider(providers, '', effectiveProviderId);
    // Alias-mapped relays: offer the tiers directly, each option reading
    // "opus · GLM5.2 · glm-5.2". The tier key is the value — the server honors
    // session.model === opus/sonnet/haiku/fable as a wire model. Tier order +
    // filtering come from the shared aliasTiersFromMap helper.
    const tiers = cli === 'zcode'
      ? []
      : aliasTiersFromMap(prov && prov.aliasMap ? prov.aliasMap : null);
    let opts;
    let asyncFill = null;
    const vendorOptions = vendorModelOptions(cli);
    if (vendorOptions) {
      opts = vendorOptions;
    } else if (tiers.length) {
      opts = tiers.map(([t, m]) => ({ value: t, label: formatAliasTierLabel(t, m) }));
  } else if (prov && catalog.modelsFor(prov).length) {
    opts = catalog.modelsFor(prov).map(m => ({ value: m, label: m }));
    } else if (isClaude) {
      opts = CLAUDE_MODEL_OPTIONS;
    } else if (cli === 'zcode') {
      opts = ZCODE_MODEL_OPTIONS;
    } else if (cli === 'opencode' && typeof loadOpenCodeModels === 'function') {
      // opencode with no multicc-managed provider model list: show a loading
      // placeholder, then asynchronously append the local opencode CLI's model
      // list (cached 1 day server- and client-side). The full <provider>/<model>
      // value pairs directly with opencode's -m provider/model arg.
      opts = [{ value: '', label: '加载 OpenCode 模型中…' }];
      asyncFill = loadOpenCodeModels().then(models => {
        if (!Array.isArray(models) || !models.length) return [];
        return models.map(m => ({ value: `${m.provider}/${m.model}`, label: m.label || `${m.provider}/${m.model}` }));
      }).catch(() => []);
    } else {
      opts = [];
    }
    for (const o of opts) {
      const opt = document.createElement('option');
      opt.value = o.value; opt.textContent = o.labelKey ? tt(o.labelKey) : o.label;
      modelSelect.appendChild(opt);
    }
    // Always allow custom model entry
    const customOpt = document.createElement('option');
    customOpt.value = '__custom__'; customOpt.textContent = tt('custom') || '自定义…';
    modelSelect.appendChild(customOpt);
    // Try to preserve previous selection, otherwise default to '' (follow provider/default)
    const hasVal = [...modelSelect.options].some(o => o.value === prev);
    modelSelect.value = hasVal ? prev : (opts.length ? opts[0].value : '__custom__');
    const syncCustom = () => { modelCustom.style.display = modelSelect.value === '__custom__' ? '' : 'none'; };
    syncCustom();
    if (asyncFill) {
      asyncFill.then(loaded => {
        if (!loaded || !loaded.length) {
          // No models returned — drop the "loading…" placeholder so only
          // __custom__ remains, mirroring the previous empty behavior.
          const ph = [...modelSelect.options].find(o => o.value === '' && /加载|loading|OpenCode/i.test(o.textContent || ''));
          if (ph) modelSelect.removeChild(ph);
          if (modelSelect.value === '') modelSelect.value = '__custom__';
          syncCustom();
          return;
        }
        // Remove the placeholder, append the loaded entries (dedup vs existing).
        const existing = new Set([...modelSelect.options].map(o => o.value));
        const ph = [...modelSelect.options].find(o => o.value === '' && /加载|loading|OpenCode/i.test(o.textContent || ''));
        const preservePrev = prev && modelSelect.value === prev;
        if (ph) modelSelect.removeChild(ph);
        // Insert loaded entries before the __custom__ sentinel.
        const customIndex = [...modelSelect.options].findIndex(o => o.value === '__custom__');
        for (const item of loaded) {
          if (existing.has(item.value)) continue;
          existing.add(item.value);
          const opt = document.createElement('option');
          opt.value = item.value; opt.textContent = item.label;
          if (customIndex >= 0) modelSelect.insertBefore(opt, modelSelect.options[customIndex]);
          else modelSelect.appendChild(opt);
        }
        // Preserve the user's current selection unless it was the placeholder.
        if (preservePrev && [...modelSelect.options].some(o => o.value === prev)) {
          modelSelect.value = prev;
        } else if (!modelSelect.value || [...modelSelect.options].findIndex(o => o.value === modelSelect.value) === -1) {
          modelSelect.value = loaded[0].value;
        }
        syncCustom();
      });
    }
    modelSelect.onchange = () => { syncCustom(); if (modelSelect.value === '__custom__') modelCustom.focus(); };
  }

  // Single unified creation dialog (name + role + provider + model)
  function showCreateSessionDialog({ cli, kind, providers = [], defaultProviderId = '', isClaude = true }) {
    return new Promise((resolve) => {
      let closed = false;
      let presetRequestEpoch = 0;
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px;';
      const box = document.createElement('div');
      box.style.cssText = 'background:#161b22;border:1px solid #30363d;border-radius:12px;padding:18px;width:440px;max-width:94vw;max-height:90vh;overflow-y:auto;';

      const title = document.createElement('div');
      title.style.cssText = 'font-size:15px;color:#f2f4f7;font-weight:600;margin-bottom:14px;';
      const CLI_LABELS = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode', zcode: 'ZCode', qoder: 'Qoder CN' };
      title.textContent = `新建 ${CLI_LABELS[cli] || cli} ${kind === 'chat' ? 'Chat' : 'Terminal'}`;
      box.appendChild(title);

      // ── Name input ──
      const nameLabel = document.createElement('div');
      nameLabel.style.cssText = 'font-size:11px;color:#8b949e;margin-bottom:4px;';
      nameLabel.textContent = '会话名称（可选）';
      box.appendChild(nameLabel);
      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.placeholder = '留空自动生成';
      nameInput.style.cssText = 'width:100%;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:8px 10px;outline:none;margin-bottom:12px;box-sizing:border-box;';
      box.appendChild(nameInput);

      // ── Role prompt with preset picker ──
      const roleLabel = document.createElement('div');
      roleLabel.style.cssText = 'font-size:11px;color:#8b949e;margin-bottom:4px;';
      roleLabel.textContent = '角色提示词（可选）';
      box.appendChild(roleLabel);

      // Preset-role picker row
      const presetRow = document.createElement('div');
      presetRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:6px;';
      const presetSel = document.createElement('select');
      presetSel.style.cssText = 'flex:1;min-width:0;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:7px 10px;outline:none;';
      const ph = document.createElement('option');
      ph.value = ''; ph.textContent = '⭐ 从预设角色填入…（加载中）';
      presetSel.appendChild(ph);
      presetRow.appendChild(presetSel);
      box.appendChild(presetRow);
      fetchAgentPresetIndex().then((idx) => {
        if (closed) return;
        if (!idx) { ph.textContent = '预设角色加载失败'; return; }
        ph.textContent = '⭐ 从预设角色填入…';
        const presets = idx.presets || [];
        const byId = {};
        for (const p of presets) byId[p.id] = p;
        const feat = (idx.featured || []).map((id) => byId[id]).filter(Boolean);
        if (feat.length) {
          const og = document.createElement('optgroup'); og.label = '⭐ 推荐';
          for (const p of feat) {
            const o = document.createElement('option');
            o.value = p.id; o.textContent = `${p.emoji || ''} ${p.name}`.trim();
            og.appendChild(o);
          }
          presetSel.appendChild(og);
        }
        for (const c of (idx.categories || [])) {
          const items = presets.filter((x) => x.category === c.key);
          if (!items.length) continue;
          const og = document.createElement('optgroup'); og.label = c.label || c.key;
          for (const p of items) {
            const o = document.createElement('option');
            o.value = p.id; o.textContent = `${p.emoji || ''} ${p.name}`.trim();
            og.appendChild(o);
          }
          presetSel.appendChild(og);
        }
      });
      presetSel.addEventListener('change', async () => {
        const id = presetSel.value;
        presetSel.value = '';
        if (!id) return;
        const requestEpoch = ++presetRequestEpoch;
        presetSel.disabled = true;
        const preset = await fetchAgentPreset(id);
        if (closed || requestEpoch !== presetRequestEpoch) return;
        presetSel.disabled = false;
        if (preset && preset.prompt) {
          roleInput.value = preset.prompt;
          applyPresetDefaultsToDialog(preset, { providers, provSelect, modelSelect, modelCustom, effortSelect, isClaude, defaultProviderId, cli });
          roleInput.focus();
        }
        else showToast('预设角色加载失败', true);
      });

      const roleInput = document.createElement('textarea');
      roleInput.placeholder = '留空则继承Fleet默认角色';
      roleInput.rows = 3;
      roleInput.style.cssText = 'width:100%;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:8px 10px;outline:none;margin-bottom:12px;resize:vertical;font-family:inherit;box-sizing:border-box;';
      box.appendChild(roleInput);

      // ── Provider select ──
      const provLabel = document.createElement('div');
      provLabel.style.cssText = 'font-size:11px;color:#8b949e;margin-bottom:4px;';
      provLabel.textContent = 'Provider';
      if (!supportsManagedProvider(cli)) provLabel.style.display = 'none';
      box.appendChild(provLabel);
      const provSelect = document.createElement('select');
      provSelect.style.cssText = 'width:100%;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:8px 10px;outline:none;margin-bottom:12px;box-sizing:border-box;';
      const defaultProvider = providers.find(p => p.id === defaultProviderId);
      if (!defaultProvider) {
        const defOpt = document.createElement('option');
        defOpt.value = '';
        defOpt.textContent = cli === 'zcode'
          ? 'ZCode 原生 / Coding Plan（不覆盖）'
          : '默认登录 / 订阅（不覆盖）';
        provSelect.appendChild(defOpt);
      }
      providers.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.id;
        const isDefault = p.id === defaultProviderId;
        const protocol = p.apiFormat === 'openai_chat' ? ' [Chat→Responses]' : (p.apiFormat === 'openai_responses' ? ' [Responses]' : ' [Anthropic]');
        opt.textContent = (isDefault ? '默认 · ' : '') + p.name + protocol + (p.isOfficial ? ' · 订阅' : '') + (p.model ? ' · ' + p.model : '');
        provSelect.appendChild(opt);
      });
      if (defaultProvider) provSelect.value = defaultProviderId;
      if (!supportsManagedProvider(cli)) provSelect.style.display = 'none';
      box.appendChild(provSelect);

      // ── Model select (both Claude & Codex, linked to provider) ──
      let modelSelect = null, modelCustom = null;
      // Always show model selector — for Claude it has the standard list as
      // fallback; for Codex it starts empty (custom only) unless a provider
      // with modelOptions is picked.
      const modelLabel = document.createElement('div');
      modelLabel.style.cssText = 'font-size:11px;color:#8b949e;margin-bottom:4px;';
      modelLabel.textContent = '模型';
      box.appendChild(modelLabel);
      modelSelect = document.createElement('select');
      modelSelect.style.cssText = 'width:100%;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:8px 10px;outline:none;margin-bottom:6px;box-sizing:border-box;';
      box.appendChild(modelSelect);

      modelCustom = document.createElement('input');
      modelCustom.type = 'text';
      modelCustom.placeholder = isClaude ? '模型 ID，如 claude-opus-4-8' : '模型 ID，如 gpt-5.5 / xopglm52';
      modelCustom.style.cssText = 'width:100%;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:8px 10px;outline:none;margin-bottom:6px;display:none;box-sizing:border-box;';
      box.appendChild(modelCustom);

      // Empty provider follows the configured default provider for this CLI, so
      // Codex still shows GPT / XF model choices instead of Claude-only fallback.
      rebuildModelOptions(modelSelect, modelCustom, providers, provSelect.value, isClaude, defaultProviderId, cli);

      // Provider → Model linkage: when provider changes, rebuild model list
      provSelect.addEventListener('change', () => {
        rebuildModelOptions(modelSelect, modelCustom, providers, provSelect.value, isClaude, defaultProviderId, cli);
      });

      // ── Effort / Reasoning level ──
      const effortLabel = document.createElement('div');
      effortLabel.style.cssText = 'font-size:11px;color:#8b949e;margin-bottom:4px;';
      effortLabel.textContent = effortLabelForCli(cli, isClaude);
      box.appendChild(effortLabel);
      const effortSelect = document.createElement('select');
      effortSelect.style.cssText = 'width:100%;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:8px 10px;outline:none;margin-bottom:12px;box-sizing:border-box;';
      const effortOptions = effortOptionsForCli(cli, isClaude);
      for (const v of effortOptions) {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = v;
        effortSelect.appendChild(opt);
      }
      effortSelect.value = defaultEffortForCli(cli, isClaude);
      if (!effortOptions.length) {
        effortLabel.style.display = 'none';
        effortSelect.style.display = 'none';
      }
      box.appendChild(effortSelect);

      // ── Buttons ──
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:4px;';
      const cancel = document.createElement('button');
      cancel.className = 'btn'; cancel.textContent = tt('cancel');
      const ok = document.createElement('button');
      ok.className = 'btn btn-green'; ok.textContent = tt('create');
      row.appendChild(cancel); row.appendChild(ok);
      box.appendChild(row);
      overlay.appendChild(box);
      document.body.appendChild(overlay);

      nameInput.focus();

      const close = (result) => {
        if (closed) return;
        closed = true;
        presetRequestEpoch++;
        document.removeEventListener('keydown', onKey, true);
        overlay.remove();
        resolve(result);
      };
      const accept = () => {
        let model = null;
        if (modelSelect) {
          model = modelSelect.value === '__custom__' ? modelCustom.value.trim() : modelSelect.value;
        }
        close({
          label: nameInput.value,
          rolePrompt: roleInput.value,
          provider: provSelect.value,
          model: model || null,
          effort: effortSelect.value,
        });
      };
      const reject = () => close(null);
      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); reject(); }
        else if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); accept(); }
      }
      ok.onclick = accept;
      cancel.onclick = reject;
      overlay.onclick = (e) => { if (e.target === overlay) reject(); };
      document.addEventListener('keydown', onKey, true);
    });
  }

  async function changeSessionModel(id) {
    const sess = _cachedSessions.find(s => s.id === id);
    if (!sess) return;
    const picked = await showModelPicker({
      title: tt('modelTitle'),
      okText: tt('save'),
      current: sess.model || '',
      providerId: sess.provider || '',
      cli: sess.cli || 'claude',
    });
    if (picked === null) return; // cancelled
    const result = await ownedJson(`session:${id}:model`, `/api/sessions/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      json: { model: picked },
    });
    if (!result.owned) return;
    if (result.error) { showApiError(result.error); return; }
    const hint = sess.kind === 'terminal' ? '（重启会话后生效）' : '（下一轮对话生效）';
    showToast(`模型已切换为 ${modelDisplayName(picked, sess.provider)} ${hint}`);
    loadDashboard();
  }

  // WebView-safe multi-line role-prompt editor. Resolves to the entered text
  // (empty string = clear), or null when cancelled.
  function showRoleEditor({ title, current = '', placeholder = '' } = {}) {
    return new Promise((resolve) => {
      let closed = false;
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px;';
      const box = document.createElement('div');
      box.style.cssText = 'background:#161b22;border:1px solid #30363d;border-radius:12px;padding:18px;width:560px;max-width:94vw;';
      const msg = document.createElement('div');
      msg.style.cssText = 'font-size:14px;color:#c9d1d9;line-height:1.6;margin-bottom:10px;';
      msg.textContent = title;
      box.appendChild(msg);

      const ta = document.createElement('textarea');
      ta.value = current || '';
      ta.placeholder = placeholder;
      ta.rows = 8;
      ta.style.cssText = 'width:100%;box-sizing:border-box;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;line-height:1.5;padding:10px;outline:none;resize:vertical;margin-bottom:6px;font-family:inherit;';
      box.appendChild(ta);

      const hint = document.createElement('div');
      hint.style.cssText = 'font-size:12px;color:#8b949e;margin-bottom:12px;';
      hint.textContent = '留空＝清除（会话将继承Fleet默认角色）。Ctrl/⌘+Enter 保存。';
      box.appendChild(hint);

      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
      const cancel = document.createElement('button');
      cancel.className = 'btn'; cancel.textContent = '取消';
      const ok = document.createElement('button');
      ok.className = 'btn btn-green'; ok.textContent = '保存';
      row.appendChild(cancel); row.appendChild(ok);
      box.appendChild(row);
      overlay.appendChild(box);
      document.body.appendChild(overlay);

      const close = (result) => {
        if (closed) return;
        closed = true;
        document.removeEventListener('keydown', onKey, true);
        overlay.remove();
        resolve(result);
      };
      const accept = () => {
        if (ta.value.length > 8000) { showToast('角色提示词过长（上限 8000 字）', true); return; }
        close(ta.value);
      };
      const reject = () => close(null);
      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); reject(); }
        else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); accept(); }
      }
      ok.onclick = accept;
      cancel.onclick = reject;
      overlay.onclick = (e) => { if (e.target === overlay) reject(); };
      document.addEventListener('keydown', onKey, true);
      setTimeout(() => { if (!closed) ta.focus(); }, 0);
    });
  }

  async function changeSessionRole(id) {
    const sess = _cachedSessions.find(s => s.id === id);
    if (!sess) return;
    const next = await showRoleEditor({
      title: `会话角色提示词 — ${sess.label || sess.id}`,
      current: sess.rolePrompt || '',
      placeholder: '例如：你是开发保姆，被触发时用 multicc-trigger skill 检查 git 改动并提醒提交和测试，不要擅自改代码。',
    });
    if (next === null) return; // cancelled
    const result = await ownedJson(`session:${id}:role`, `/api/sessions/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      json: { rolePrompt: next },
    });
    if (!result.owned) return;
    if (result.error) { showApiError(result.error); return; }
    const hint = (sess.cli || 'claude') === 'codex' ? '（Codex 仅新会话首轮生效）' : '（下一轮对话生效）';
    showToast(`${next.trim() ? '角色已更新' : '已清除会话角色（继承Fleet默认）'} ${hint}`);
    loadDashboard();
  }

  async function changeDirectoryRole(id) {
    const dir = (_cachedDirectories || []).find(d => d.id === id);
    if (!dir) return;
    const next = await showRoleEditor({
      title: `Fleet默认角色 — ${dir.name}`,
      current: dir.rolePrompt || '',
      placeholder: '该Fleet下所有会话的默认角色。单个会话可在「角色提示词」里单独覆盖。',
    });
    if (next === null) return;
    const result = await ownedJson(`directory:${id}:role`, `/api/directories/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      json: { rolePrompt: next },
    });
    if (!result.owned) return;
    if (result.error) { showApiError(result.error); return; }
    showToast(`${next.trim() ? 'Fleet默认角色已更新' : '已清除Fleet默认角色'}（对未单独设角色的会话下一轮生效）`);
    loadDashboard();
  }

  async function renameSession(id) {
    const sess = _cachedSessions.find(s => s.id === id);
    if (!sess) return;
    const next = await showPrompt('Rename session', sess.label || sess.id);
    if (next === null) return;
    const label = next.trim();
    if (label.length > 80) {
      showToast('Name is too long (max 80 chars)', true);
      return;
    }
    const result = await ownedJson(`session:${id}:label`, `/api/sessions/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      json: { label },
    });
    if (!result.owned) return;
    if (result.error) { showApiError(result.error); return; }
    showToast(label ? `Renamed to ${label}` : 'Session name reset');
    await loadDashboard();
  }

  root.MultiCCManageSessionLifecycle = Object.freeze({
    ownedJson,
    buildSessionCreatePayload,
    effortLabelForCli,
    effortOptionsForCli,
    defaultEffortForCli,
  });

  // Warm the Qoder catalog so the create/edit dialogs render the live list on
  // first open. One request per day — a warm localStorage cache never goes out.
  if (typeof root.loadQoderModels === 'function') {
    try { root.loadQoderModels(); } catch (_) { /* picker keeps the tiers */ }
  }

  // Same warm-up for the Claude CLI-bundle model list (picker keeps the static
  // table until the fetch lands).
  if (typeof root.loadClaudeModels === 'function') {
    try { root.loadClaudeModels(); } catch (_) { /* picker keeps the static table */ }
  }

  Object.assign(root, {
    providerAliasMap,
    providerAliasTiers,
    normalizeModelForProvider,
    modelDisplayName,
    showModelPicker,
    newSessionInDir,
    fetchAgentPresetIndex,
    fetchAgentPreset,
    fetchAgentPresetPrompt,
    providerIdForPresetDefault,
    applyPresetDefaultsToDialog,
    rebuildModelOptions,
    showCreateSessionDialog,
    changeSessionModel,
    showRoleEditor,
    changeSessionRole,
    changeDirectoryRole,
    renameSession,
    buildSessionCreatePayload,
    effortLabelForCli,
    effortOptionsForCli,
    defaultEffortForCli,
  });
})(typeof window !== 'undefined' ? window : null);
