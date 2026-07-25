// multicc shared model/alias helpers.
//
// Loaded by BOTH chat.html and manage.html, right after i18n.js (it uses tt()).
// Owns the PURE pieces of the provider/model UI logic that were previously
// byte-duplicated across chat.js and manage.js. Exposed as plain globals
// (window.*) so the classic chat.js / manage.js scripts can reference them
// bare, exactly as they referenced their own local copies before.
//
// Page-state-coupled helpers (providerAliasMap / providerAliasTiers /
// modelDisplayName, which read each page's own provider-list cache) stay in
// their respective pages — only provably-pure, byte-identical logic lives here.
(function () {
  // Claude model choices for new sessions. value '' = follow the user's /model
  // default. __custom__ = free-text model id.
  const CLAUDE_MODEL_OPTIONS = [
    { value: '', labelKey: 'defaultClaudeSetting' },
    { value: 'claude-opus-5', label: 'Opus 5' },
    { value: 'claude-opus-5[1m]', label: 'Opus 5 (1M context)' },
    { value: 'claude-opus-4-8', label: 'Opus 4.8' },
    { value: 'claude-sonnet-5', label: 'Sonnet 5' },
    { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
    { value: 'claude-fable-5', label: 'Fable 5' },
    { value: 'claude-fable-5[1m]', label: 'Fable 5 (1M context)' },
    { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
    { value: '__custom__', labelKey: 'custom' },
  ];

  // Claude alias tiers in display/precedence order. Single source of truth for
  // the vocabulary previously hardcoded as ['opus','sonnet','haiku','fable'] at
  // 6+ sites across chat.js and manage.js.
  const ALIAS_TIERS = ['opus', 'sonnet', 'haiku', 'fable'];

  // Short display name for a wire model id, falling back to the id itself.
  function modelShortName(model) {
    const opt = CLAUDE_MODEL_OPTIONS.find(o => o.value === model);
    return opt ? (opt.labelKey ? tt(opt.labelKey) : opt.label) : model;
  }

  // Ordered [tier, entry] pairs for an alias-mapped relay, or []. Pure over the
  // resolved aliasMap — single source of truth for the tier-filter+order logic
  // that providerAliasTiers (chat.js & manage.js) and rebuildModelOptions
  // (manage.js) previously reimplemented.
  function aliasTiersFromMap(aliasMap) {
    if (!aliasMap) return [];
    return ALIAS_TIERS.filter(t => aliasMap[t] && aliasMap[t].model).map(t => [t, aliasMap[t]]);
  }

  // Format an alias-tier option label as "tier · displayName · wireModelId"
  // (别名 - 展示名 - 真实id). displayName is omitted when the entry has none,
  // yielding "tier · wireModelId".
  function formatAliasTierLabel(tier, entry) {
    const e = entry || {};
    return `${tier}${e.name ? ` · ${e.name}` : ''} · ${e.model}`;
  }

  window.CLAUDE_MODEL_OPTIONS = CLAUDE_MODEL_OPTIONS;
  window.ALIAS_TIERS = ALIAS_TIERS;
  window.modelShortName = modelShortName;
  window.aliasTiersFromMap = aliasTiersFromMap;
  window.formatAliasTierLabel = formatAliasTierLabel;
})();
