(function () {
  'use strict';

  const I18N = {
    zh: {
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
      search: '搜索目录 / 会话…',
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
      noActiveTask: '暂无进行中任务',
      directories: '目录',
      sessions: '会话',
      sessionCount: '{n} 个会话',
      noSessions: '暂无会话',
      replyNeeded: '需要你回复 ›',
      registered: '已登记 ›',
      newDirectory: '＋ 新建目录',
      createSession: '+ 新建 ▾',
      sessionNamePrompt: '输入会话名称（可选，留空自动生成）',
      next: '下一步',
      providerTitle: '切换该会话使用的 Provider（下一轮对话生效）',
      providerDefault: '默认登录 / 订阅（不覆盖）',
      providerEmpty: '还没有可用 provider。请到管理台「Provider」页配置。',
      role: '🎭 角色',
      roleSet: '🎭 角色✓',
      memory: '🧠 记忆',
      memorySet: '🧠 记忆✓',
      stream: '⚡ 流式',
      streamAuto: '⚡ 流式+接力',
      streamOff: '⚡ 流式✕',
      share: '🔗 分享',
      language: '中/EN',
    },
    en: {
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
      search: 'Search directories / sessions...',
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
      noActiveTask: 'No active tasks',
      directories: 'Directories',
      sessions: 'sessions',
      sessionCount: '{n} sessions',
      noSessions: 'No sessions yet',
      replyNeeded: 'Needs your reply ›',
      registered: 'Registered ›',
      newDirectory: '+ New directory',
      createSession: '+ New ▾',
      sessionNamePrompt: 'Enter session name (optional, auto-generated if blank)',
      next: 'Next',
      providerTitle: 'Change this session Provider (applies next turn)',
      providerDefault: 'Default login / subscription (no override)',
      deleteDirectory: 'Delete directory',
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
      mergeWorktreeTitle: 'Merge worktree back to base branch',
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
      role: '🎭 Role',
      roleSet: '🎭 Role✓',
      memory: '🧠 Memory',
      memorySet: '🧠 Memory✓',
      stream: '⚡ Stream',
      streamAuto: '⚡ Stream+auto',
      streamOff: '⚡ Stream off',
      share: '🔗 Share',
      language: 'EN/中',
    },
  };
  const getLang = () => localStorage.getItem('multicc_lang') || 'zh';

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
  localStorage.setItem('multicc_lang', I18N[lang] ? lang : 'zh');
  location.reload();
}

function toggleLang() {
  setLang(getLang() === 'zh' ? 'en' : 'zh');
}

function applyI18n(root) {
  const scope = root || document;
  document.documentElement.lang = getLang();
  scope.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  scope.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); });
  scope.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
  scope.querySelectorAll('.lang-toggle').forEach((el) => { el.textContent = t('language'); });
}

window.I18N = I18N;
window.t = t;
window.setLang = setLang;
window.toggleLang = toggleLang;
window.applyI18n = applyI18n;
document.addEventListener('DOMContentLoaded', () => applyI18n(document));
})();
