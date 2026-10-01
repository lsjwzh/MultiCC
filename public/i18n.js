(function () {
  'use strict';

  const SHARED = window.MULTICC_I18N_CATALOG || {};
  const I18N = {
    zh: {
      ...(SHARED.zh || {}),
      cancel: '取消',
      confirm: '确认',
      create: '创建',
      save: '保存',
      delete: '删除',
      rename: '改名',
      restart: '重启',
      merge: '合并',
      open: '打开',
      openInNewTab: '新标签页打开',
      more: '更多',
      close: '关闭',
      refresh: '刷新',
      search: '搜索工作区 / 会话…',
      default: '默认',
      defaultClaudeSetting: '默认（跟随 Claude 设置）',
      custom: '自定义…',
      defaultBase: '基分支',
      active: '活跃',
      activeSessions: '活跃会话',
      waiting: '等待',
      waitingInput: '等待输入',
      scheduledTasks: '定时任务',
      completed: '完成',
      thinking: '思考中',
      editing: '编辑中',
      running: '运行中',
      error: '出现异常',
      idle: '空闲',
      directories: '工作区',
      sessions: '会话',
      sessionCount: '{n} 个会话',
      noSessions: '暂无会话',
      replyNeeded: '需要你回复 ›',
      registered: '已登记 ›',
      newDirectory: '＋ 新建工作区',
      createSession: '+ 新建 ▾',
      sessionNamePrompt: '输入会话名称（可选，留空自动生成）',
      next: '下一步',
      providerTitle: '切换该会话使用的 Provider（下一轮对话生效）',
      providerDefault: '默认登录 / 订阅（不覆盖）',
      providerEmpty: '还没有可用 provider。请到管理台「Provider」页配置。',
      limitUpdatedAgo: '更新于 {ago}',
      limitStale: '过期',
      limitFetchFailed: '查询失败',
      deleteDirectory: '删除工作区',
      deleteSession: '删除会话',
      note: '留言',
      rolePrompt: '角色提示词',
      rolePromptSet: '角色提示词（已设置）',
      changeModel: '切换模型（{model}）',
      mergeTo: '合并到 {base}',
      mergeToAhead: '✓ 合并到 {base}（领先 {n} 个提交）',
      dirtyChanges: '有未提交改动',
      aheadCommits: '领先 {n} 个提交',
      mergeReadyTitle: '可合并：{detail}',
      mergeWorktreeTitle: '把此会话 worktree 合并回基分支',
      moreSessionActions: '更多操作（改名/留言/Diff/合并/删除）',
      moreSessionActionsReady: '{detail}（点击查看更多）',
      terminal: '终端',
      manage: '管理',
      clear: '清理',
      clearHistory: '清空全部',
      clearKeepLast: '保留最近 {n} 条',
      changeDir: '切换目录',
      sync: '同步',
      syncing: '同步中…',
      syncWorktree: '同步 worktree',
      behindLabel: '⎇ {branch} · 落后 {base} {n} 个提交',
      behindBanner: '⚠ 当前 worktree（{branch}）落后 {base} {n} 个提交，请使用上方同步按钮合入基分支。',
      worktreeClean: '当前 worktree 没有可合并的改动。',
      worktreeMergeable: '当前 worktree {detail}，可合并回 {base}。',
      mergeWorktreeConfirmReady: '此 worktree 有可合并改动。\n未提交改动会先自动提交，是否继续？',
      mergeWorktreeConfirm: '把此会话 worktree 合并回基分支？\n未提交改动会先自动提交。',
      modelTitle: '切换该会话使用的模型（下一轮对话生效）',
      // 这几个按钮的图标现在由 chat.html 的 data-hdr-icon 画出来（页头展开时只
      // 留图标、名字进 title；浮层里图标和名字各占一列），文案里再带一遍 emoji
      // 就会在浮层里出现两个图标。
      role: '角色',
      roleSet: '角色✓',
      memory: '记忆',
      memorySet: '记忆✓',
      autoCommit: '自动提交',
      autoCommitOn: '自动提交✓',
      autoCommitOff: '自动提交✕',
      autoCommitTitle: '每轮执行成功后自动 commit 并合并回基分支',
      share: '分享',
      voiceCall: '语音',
      language: '中/EN',
      languageToggle: '切换语言：中文 / English',
      clearChatViewHint: '只清理这个页面的消息显示，不动原生 CLI 的上下文',
      autoEditorAutoModelNeedsRouting: '「自动选模型」只在「按难度」线路池里可用。',
      // ── 运行配置（run-config.js 的统一对话框）──────────────────────────
      runConfigTitle: "运行配置",
      runConfigClose: "关闭",
      runConfigIntroDraft: "新任务用哪条线路跑：先挑 CLI，再挑线路和模型。",
      runConfigIntroTask: "这个任务用哪条线路跑：改完保存，下一轮生效。",
      runConfigModeLabel: "运行方式",
      runConfigModeFixed: "固定一条",
      runConfigModeAuto: "自动挑选",
      runConfigCliNoteDraft: "创建后生效",
      runConfigCliNote: "下一轮生效",
      runConfigLineLabel: "线路",
      runConfigModelLabel: "模型",
      runConfigModelDefault: "线路默认",
      runConfigModelCustom: "自定义…",
      runConfigModelPlaceholder: "自定义模型…",
      runConfigEffortLabel: "推理强度",
      runConfigAdvanced: "高级：子任务线路 / 模型",
      runConfigSubProvider: "子任务线路",
      runConfigSubModel: "子任务模型",
      runConfigSubHint: "子任务留空就是跟随主线路。",
      runConfigSubFollow: "随主（默认）",
      runConfigNotSet: "不设置",
      runConfigPickHead: "怎么挑",
      runConfigPickNote: "线路之间可以跨 CLI",
      runConfigPickOrder: "按顺序",
      runConfigPickOrderDetail: "一直用第 1 条；额度用完或报错才往下换",
      runConfigPickDifficulty: "按难度",
      runConfigPickDifficultyDetail: "每条消息先让 Jev 判断难易，再挑线路和模型",
      runConfigTierLabel: "档位",
      runConfigTierPrice: "交给 Jev",
      runConfigTierPriceHint: "由 Jev 按难度挑，不用逐行标",
      runConfigTierManual: "我自己标",
      runConfigTierManualHint: "每行标一个简单 / 中等 / 复杂",
      runConfigTierSimple: "简单",
      runConfigTierMedium: "中等",
      runConfigTierComplex: "复杂",
      runConfigPoolHead: "线路池",
      runConfigPoolNote: "拖动排序",
      runConfigPoolNoteJev: "交给 Jev：不用标档位",
      runConfigAddLine: "添加线路",
      runConfigMore: "更多：最多试几条 / 粘住上次成功 / 预设",
      runConfigMaxAttempts: "最多试几条",
      runConfigSticky: "粘住上次成功的线路",
      runConfigPreset: "预设",
      runConfigPresetNone: "（不用预设）",
      runConfigPresetRecent: "最近用过",
      runConfigCrossTrust: "这份池子混用了「官方账号」和别人配的线路，我确认要这样跑。",
      runConfigCancel: "取消",
      runConfigUse: "用这套配置",
      runConfigSave: "保存",
      runConfigCliNoTerminal: "终端模式不提供这条 CLI",
      runConfigCliNoChat: "对话模式不提供这条 CLI",
      runConfigCliMissing: "未安装",
      runConfigCliOwnAccount: "使用 {name} 自己的账号",
      runConfigCliLineCount: "{n} 条",
      runConfigCliNoLines: "没有可用线路",
      runConfigLoadFailedShort: "加载失败",
      runConfigLoadFailed: "线路列表加载失败",
      runConfigNoLines: "没有可用线路",
      runConfigRetry: "重试",
      runConfigNativeOwnAccount: "{name} 自己的账号",
      runConfigNativeDefault: "默认登录 / 官方账号",
      runConfigStatusOwn: "使用 {name} 自己的账号",
      runConfigSummaryAuto: "{n} 条线路 · 跨 {m} 个 CLI",
      runConfigSearchLine: "搜索线路或模型…",
      runConfigLoading: "正在读取线路…",
      runConfigNativeNote: "上面的线路也都能跑",
      runConfigInPool: "已在池里",
      runConfigRowCli: "用哪个 CLI 跑这条线路",
      runConfigRowModel: "模型",
      runConfigRowTier: "档位",
      runConfigRowDrag: "拖动排序",
      runConfigRowRemove: "移除这条线路",
      runConfigAutoModel: "自动（Jev 挑）",
      runConfigComponentsMissing: "运行配置组件没有加载。",
      runConfigJevGateway: "网关",
      runConfigJevEndpoint: "接口地址",
      runConfigJevModel: "模型名",
      runConfigJevKey: "Jev key",
      runConfigJevTest: "测试",
      runConfigJevChange: "更换",
      runConfigJevSaveTest: "保存并测试",
      runConfigJevUnavailable: "Jev 判断难度",
      runConfigJevVaultOnly: "key 从本机保险箱条目「{name}」读取。",
      runConfigJevChecking: "正在检查 Jev key…",
      runConfigJevReady: "Jev 已就绪",
      runConfigJevMissing: "先配置 Jev",
      runConfigJevCheckFailed: " · 查不到 key 状态，可直接重新粘贴保存",
      runConfigJevKeyMissingDetail: " · 它负责判断每条消息是简单还是复杂",
      runConfigJevKeyHelp: "key 只存进本机保险箱（条目 {name}），不写进配置、不发给模型。",
      runConfigJevErrKeyMissing: "保险箱里没有这个 key，请先粘贴保存。",
      runConfigJevErrKeyInvalid: "key 无效或没有权限，请检查后更换。",
      runConfigJevErrTimeout: "Jev 超时没有回应，稍后再试。",
      runConfigJevErrNetwork: "连不上网关，检查网络或代理。",
      runConfigJevErrUnavailable: "服务端还没有测试接口：重启 multicc 后再试。",
      runConfigJevErrOther: "测试失败：{code}",
      runConfigJevSample: "把 README 里的一个错别字改掉",
      runConfigJevTesting: "正在请 Jev 判断…",
      runConfigJevTestOk: "✓ 连通了（{ms} ms）",
      runConfigJevKeyEmpty: "先把 key 粘贴到输入框里。",
      runConfigJevKeySaving: "正在保存…",
      runConfigJevKeySaveFailed: "保存失败：{reason}",
    },
    en: {
      ...(SHARED.en || {}),
      cancel: 'Cancel',
      confirm: 'Confirm',
      create: 'Create',
      save: 'Save',
      delete: 'Delete',
      rename: 'Rename',
      restart: 'Restart',
      merge: 'Merge',
      open: 'Open',
      openInNewTab: 'Open in new tab',
      more: 'More',
      close: 'Close',
      refresh: 'Refresh',
      search: 'Search workspaces / sessions...',
      default: 'Default',
      defaultClaudeSetting: 'Default (Claude setting)',
      custom: 'Custom...',
      defaultBase: 'base branch',
      active: 'active',
      activeSessions: 'Active sessions',
      waiting: 'Waiting',
      waitingInput: 'Waiting for input',
      scheduledTasks: 'Scheduled tasks',
      completed: 'Completed',
      thinking: 'Thinking',
      editing: 'Editing',
      running: 'Running',
      error: 'Error',
      idle: 'Idle',
      directories: 'Workspaces',
      sessions: 'sessions',
      sessionCount: '{n} sessions',
      noSessions: 'No sessions yet',
      replyNeeded: 'Needs your reply ›',
      registered: 'Registered ›',
      newDirectory: '+ New workspace',
      createSession: '+ New ▾',
      sessionNamePrompt: 'Enter session name (optional, auto-generated if blank)',
      next: 'Next',
      providerTitle: 'Change this session Provider (applies next turn)',
      providerDefault: 'Default login / subscription (no override)',
      deleteDirectory: 'Delete workspace',
      deleteSession: 'Delete session',
      note: 'Note',
      rolePrompt: 'Role prompt',
      rolePromptSet: 'Role prompt (set)',
      changeModel: 'Change model ({model})',
      mergeTo: 'Merge to {base}',
      mergeToAhead: '✓ Merge to {base} ({n} commits)',
      dirtyChanges: 'uncommitted changes',
      aheadCommits: '{n} commits ahead',
      mergeReadyTitle: 'Ready to merge: {detail}',
      mergeWorktreeTitle: 'Merge this session’s worktree back to the base branch',
      moreSessionActions: 'More actions (rename/note/Diff/merge/delete)',
      moreSessionActionsReady: '{detail} (click for more)',
      terminal: 'Terminal',
      manage: 'Manage',
      clear: 'Clear',
      clearHistory: 'Clear all',
      clearKeepLast: 'Keep last {n}',
      changeDir: 'Change directory',
      sync: 'Sync',
      syncing: 'Syncing...',
      syncWorktree: 'Sync worktree',
      behindLabel: '⎇ {branch} · behind {base} by {n} commits',
      behindBanner: '⚠ Current worktree ({branch}) is behind {base} by {n} commits. Use the Sync button above to merge base in.',
      worktreeClean: 'Current worktree has nothing to merge.',
      worktreeMergeable: 'Current worktree has {detail}; it can be merged back to {base}.',
      mergeWorktreeConfirmReady: 'This worktree has mergeable changes.\nUncommitted changes will be committed first. Continue?',
      mergeWorktreeConfirm: 'Merge this session worktree back to the base branch?\nUncommitted changes will be committed first.',
      modelTitle: 'Change this session model (applies next turn)',
      providerTitle: 'Change this session Provider (applies next turn)',
      providerDefault: 'Default login / subscription (no override)',
      providerEmpty: 'No providers configured. Add one in the Provider page.',
      limitUpdatedAgo: 'updated {ago}',
      limitStale: 'stale',
      limitFetchFailed: 'fetch failed',
      role: 'Role',
      roleSet: 'Role✓',
      memory: 'Memory',
      memorySet: 'Memory✓',
      autoCommit: 'Auto-commit',
      autoCommitOn: 'Auto-commit✓',
      autoCommitOff: 'Auto-commit✕',
      autoCommitTitle: 'Auto commit & merge back to the base branch after each successful turn',
      share: 'Share',
      voiceCall: 'Voice',
      language: 'EN/中',
      languageToggle: 'Switch language: 中文 / English',
      clearChatViewHint: 'Clears this page\'s message view; the native CLI context is untouched',
      autoEditorAutoModelNeedsRouting: 'Auto model is only available inside a difficulty-routed pool.',
      // ── 运行配置（run-config.js 的统一对话框）──────────────────────────
      runConfigTitle: "Run config",
      runConfigClose: "Close",
      runConfigIntroDraft: "Which line the new task runs on: pick a CLI, then a line and a model.",
      runConfigIntroTask: "Which line this task runs on: save now, in effect next turn.",
      runConfigModeLabel: "Run mode",
      runConfigModeFixed: "One line",
      runConfigModeAuto: "Auto pick",
      runConfigCliNoteDraft: "in effect once created",
      runConfigCliNote: "in effect next turn",
      runConfigLineLabel: "Line",
      runConfigModelLabel: "Model",
      runConfigModelDefault: "Line default",
      runConfigModelCustom: "Custom…",
      runConfigModelPlaceholder: "Custom model…",
      runConfigEffortLabel: "Reasoning effort",
      runConfigAdvanced: "Advanced: sub-task line / model",
      runConfigSubProvider: "Sub-task line",
      runConfigSubModel: "Sub-task model",
      runConfigSubHint: "Leave the sub-task empty to follow the main line.",
      runConfigSubFollow: "Follow main (default)",
      runConfigNotSet: "Not set",
      runConfigPickHead: "How to pick",
      runConfigPickNote: "lines may span CLIs",
      runConfigPickOrder: "In order",
      runConfigPickOrderDetail: "Always line 1; fall through when its quota runs out or it errors",
      runConfigPickDifficulty: "By difficulty",
      runConfigPickDifficultyDetail: "Jev rates each message first, then picks the line and model",
      runConfigTierLabel: "Tier",
      runConfigTierPrice: "Let Jev decide",
      runConfigTierPriceHint: "Jev picks by difficulty; no per-row labels",
      runConfigTierManual: "I label them",
      runConfigTierManualHint: "label each row simple / medium / complex",
      runConfigTierSimple: "Simple",
      runConfigTierMedium: "Medium",
      runConfigTierComplex: "Complex",
      runConfigPoolHead: "Line pool",
      runConfigPoolNote: "drag to reorder",
      runConfigPoolNoteJev: "Jev decides; no tiers to set",
      runConfigAddLine: "Add line",
      runConfigMore: "More: max tries / stick to last success / presets",
      runConfigMaxAttempts: "Max tries",
      runConfigSticky: "Stick to the last successful line",
      runConfigPreset: "Preset",
      runConfigPresetNone: "(no preset)",
      runConfigPresetRecent: "Recently used",
      runConfigCrossTrust: "This pool mixes the official account with other users' lines; I confirm this is intended.",
      runConfigCancel: "Cancel",
      runConfigUse: "Use this config",
      runConfigSave: "Save",
      runConfigCliNoTerminal: "Terminal mode does not offer this CLI",
      runConfigCliNoChat: "Chat mode does not offer this CLI",
      runConfigCliMissing: "Not installed",
      runConfigCliOwnAccount: "Uses {name}'s own account",
      runConfigCliLineCount: "{n} lines",
      runConfigCliNoLines: "No usable line",
      runConfigLoadFailedShort: "load failed",
      runConfigLoadFailed: "Failed to load the line list",
      runConfigNoLines: "No usable line",
      runConfigRetry: "Retry",
      runConfigNativeOwnAccount: "{name}'s own account",
      runConfigNativeDefault: "default login / official account",
      runConfigStatusOwn: "Uses {name}'s own account",
      runConfigSummaryAuto: "{n} lines · across {m} CLIs",
      runConfigSearchLine: "Search line or model…",
      runConfigLoading: "Loading lines…",
      runConfigNativeNote: "the lines above can run too",
      runConfigInPool: "in pool",
      runConfigRowCli: "Which CLI runs this line",
      runConfigRowModel: "Model",
      runConfigRowTier: "Tier",
      runConfigRowDrag: "Drag to reorder",
      runConfigRowRemove: "Remove this line",
      runConfigAutoModel: "Auto (Jev picks)",
      runConfigComponentsMissing: "The run-config components did not load.",
      runConfigJevGateway: "Gateway",
      runConfigJevEndpoint: "Endpoint",
      runConfigJevModel: "Model",
      runConfigJevKey: "Jev key",
      runConfigJevTest: "Test",
      runConfigJevChange: "Change",
      runConfigJevSaveTest: "Save & test",
      runConfigJevUnavailable: "Jev difficulty",
      runConfigJevVaultOnly: "The key is read from the local vault entry \"{name}\".",
      runConfigJevChecking: "Checking the Jev key…",
      runConfigJevReady: "Jev ready",
      runConfigJevMissing: "Set up Jev first",
      runConfigJevCheckFailed: " · cannot read the key status; you can paste and save again",
      runConfigJevKeyMissingDetail: " · it decides whether each message is simple or complex",
      runConfigJevKeyHelp: "The key is stored only in the local vault (entry {name}); it is not written into the config and never sent to the model.",
      runConfigJevErrKeyMissing: "No such key in the vault; paste and save it first.",
      runConfigJevErrKeyInvalid: "The key is invalid or lacks permission; check it and change it.",
      runConfigJevErrTimeout: "Jev timed out; try again later.",
      runConfigJevErrNetwork: "Cannot reach the gateway; check your network or proxy.",
      runConfigJevErrUnavailable: "The server has no test endpoint yet; restart multicc and retry.",
      runConfigJevErrOther: "Test failed: {code}",
      runConfigJevSample: "Fix a typo in the README",
      runConfigJevTesting: "Asking Jev…",
      runConfigJevTestOk: "✓ connected ({ms} ms)",
      runConfigJevKeyEmpty: "Paste the key into the box first.",
      runConfigJevKeySaving: "Saving…",
      runConfigJevKeySaveFailed: "Save failed: {reason}",
    },
  };
  // 语言来源按优先级三段：用户显式选过的（localStorage）＞ 系统语言 ＞ 英文兜底。
  // 系统语言只做「中文 / 其它」二分：zh* 归中文，其余（含 de/fr、含取不到系统语言的
  // C locale 容器）一律英文。国际发行渠道（AppImageHub 目录站那类）明确要求「非中文
  // 环境默认英文界面」，而中文环境里的默认仍然是中文，所以这里不需要一张语言表，
  // 只需要这一个判断 —— 也别写成「非英文即中文」，那正是原来反过来的那版错误。
  const LANG_STORE_KEY = 'multicc_lang';
  const FALLBACK_LANG = 'en';
  function systemLang() {
    const tags = [];
    try {
      const nav = typeof navigator === 'undefined' ? null : navigator;
      if (nav) {
        if (Array.isArray(nav.languages)) tags.push(...nav.languages);
        if (nav.language) tags.push(nav.language);
        if (nav.userLanguage) tags.push(nav.userLanguage);
      }
    } catch (_) {}
    for (const tag of tags) {
      const value = String(tag || '').trim().toLowerCase();
      if (!value) continue;
      if (value === 'zh' || value.indexOf('zh-') === 0 || value.indexOf('zh_') === 0) return 'zh';
      // 第一个成形（看起来像语言标签）的取值说了算：de-DE / fr / en-US 都归英文界面，
      // 因为产品只有中英两套文案。垃圾值（空串、下划线开头）跳过，继续往后看。
      if (/^[a-z]{2,3}(?:[-_]|$)/.test(value)) return FALLBACK_LANG;
    }
    return FALLBACK_LANG;
  }
  // localStorage 在 file://（桌面版的错误页）和隐私模式下可能直接抛，读不到就当没选过。
  const getLang = () => {
    try {
      const stored = localStorage.getItem(LANG_STORE_KEY);
      if (stored && I18N[stored]) return stored;
    } catch (_) {}
    return systemLang();
  };
  // 日期/时间也要跟着语言走：zh-CN 的短日期是「9月21日 14:30」，英文界面里那两个
  // 汉字就是残留。所有 Intl / toLocaleString 都传 getLocale()，不要写字面量，也
  // 不要留空让浏览器自己挑（浏览器是中文时英文界面照样冒汉字）。
  const getLocale = () => (getLang() === 'zh' ? 'zh-CN' : 'en-US');

  function t(key, params) {
    const lang = getLang();
    const dict = I18N[lang] || I18N.zh;
    let text = dict[key] || I18N.zh[key] || key;
    if (params) {
      text = text.replace(/\{(\w+)\}/g, (_, name) =>
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : `{${name}}`);
    }
    return text;
  }

function setLang(lang) {
  // 认不出来的取值回落到的不是「中文」而是当前系统语言：否则在一个英文环境里
  // 传个拼错的 lang 参数，会把用户从英文界面翻回中文。
  try { localStorage.setItem(LANG_STORE_KEY, I18N[lang] ? lang : systemLang()); } catch (_) {}
  location.reload();
}

function toggleLang() {
  setLang(getLang() === 'zh' ? 'en' : 'zh');
}

function applyI18n(root) {
  const scope = root || document;
  document.documentElement.lang = getLang();
  // <title> 不是普通元素，querySelector 挑不到；页面在 <html> 上挂 data-i18n-doc-title
  // 就能让标签页也跟着切语言（否则英文界面里浏览器标签上仍是一行中文）。
  const docTitleKey = document.documentElement.dataset && document.documentElement.dataset.i18nDocTitle;
  if (docTitleKey) document.title = t(docTitleKey);
  scope.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  scope.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); });
  scope.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
  // contenteditable 的占位是 CSS ::before 读 attr(data-placeholder) 画的，不是 placeholder 属性。
  scope.querySelectorAll('[data-i18n-data-placeholder]').forEach((el) => { el.setAttribute('data-placeholder', t(el.dataset.i18nDataPlaceholder)); });
  scope.querySelectorAll('[data-i18n-aria-label]').forEach((el) => { el.setAttribute('aria-label', t(el.dataset.i18nAriaLabel)); });
  scope.querySelectorAll('[data-i18n-value]').forEach((el) => { el.value = t(el.dataset.i18nValue); });
  scope.querySelectorAll('.lang-toggle').forEach((el) => { el.textContent = t('language'); });
}

window.I18N = I18N;
window.t = t;
window.getLang = getLang;
window.systemLang = systemLang;
window.getLocale = getLocale;
window.setLang = setLang;
window.toggleLang = toggleLang;
window.applyI18n = applyI18n;
document.addEventListener('DOMContentLoaded', () => applyI18n(document));
})();
