'use strict';

// 桌面壳自己的两页（splash / 启动失败）是 file:// 文档：它们拿不到服务端的
// public/i18n.js 词典，所以自带一份极小的副本 —— 只有桌面壳自己那几行字。
//
// 规则必须和 web 端一致（public/i18n.js 的 getLang）：显式选择 ＞ 系统语言 ＞ 英文。
// 之所以不能两边各写一套：AppImageHub 那类目录站就是在非中文环境（容器里 LANG 未设）
// 启动这个 AppImage 并给窗口截图，截图里只要还有中文就判「不是英文界面」——启动失败页
// 恰恰是最需要英文的那一页。
(function () {
  const STORE_KEY = 'multicc_lang';
  const FALLBACK = 'en';
  const COPY = {
    zh: {
      docTitleFailed: 'MultiCC — 启动失败',
      failedTitle: 'MultiCC 启动失败',
      failedSub: '本地后台服务未能启动。',
      starting: '正在启动本地服务，首次启动可能需要一点时间…',
      reasonUnknown: '发生未知错误。',
      reasonPortInUse: '本地端口被占用（EADDRINUSE）。可能是另一个 MultiCC 服务或其他程序占用了端口。关闭占用程序后点「重试启动」，桌面版会自动换一个空闲端口。',
      reasonCrashLoop: '本地服务在短时间内多次异常退出，已停止自动重启。请查看日志定位原因；常见原因是数据目录损坏或依赖缺失。',
      reasonNotReady: '本地服务启动后长时间未就绪（等待 /readyz 超时）。请查看日志了解卡在哪一步。',
      reasonSpawnError: '无法启动本地服务进程。可能是安装不完整（缺少 server 文件），请重新安装桌面版。',
      reasonMissingRuntime: '随包自带的服务运行环境缺失，安装包可能没解压完整，请重新安装桌面版。',
      detail: '后台日志末尾',
      retry: '重试启动',
      openLogs: '打开日志',
      openData: '打开数据目录',
      quit: '退出',
      logsLabel: '日志 Logs',
      dataLabel: '数据 Data',
      labelSep: '：',
      language: 'EN/中',
      languageTitle: 'Switch language: 中文 / English',
    },
    en: {
      docTitleFailed: 'MultiCC — startup failed',
      failedTitle: 'MultiCC failed to start',
      failedSub: 'The local MultiCC backend could not start.',
      starting: 'Starting the local service — the first launch can take a moment…',
      reasonUnknown: 'An unexpected error occurred.',
      reasonPortInUse: 'The local port is already in use (EADDRINUSE). Another MultiCC server or program is holding it. Close it and choose Retry — the desktop app will pick a free port.',
      reasonCrashLoop: 'The local server exited abnormally several times in a row, so automatic restarts have stopped. Check the log to find the cause; the usual reasons are a damaged data directory or a missing dependency.',
      reasonNotReady: 'The local server started but never became ready (the /readyz probe timed out). Check the log to see how far it got.',
      reasonSpawnError: 'The local server process could not be started. The installation may be incomplete (server files missing); please reinstall the desktop app.',
      reasonMissingRuntime: 'The bundled runtime that starts the local service is missing — the installation looks incomplete. Please reinstall the desktop app.',
      detail: 'End of the backend log',
      retry: 'Retry',
      openLogs: 'Open logs',
      openData: 'Open data folder',
      quit: 'Quit',
      logsLabel: 'Logs',
      dataLabel: 'Data',
      labelSep: ': ',
      language: 'EN/中',
      languageTitle: 'Switch language: 中文 / English',
    },
  };

  function search() {
    try { return new URLSearchParams(location.search); } catch (_) { return new URLSearchParams(''); }
  }

  // 系统语言：Electron 把 LANG/LC_* 解析成 BCP-47 交给主进程（app.getLocale），
  // 由它经 ?lang= 传进来；没有参数时退回 navigator.language。只做「中文 / 其它」二分。
  function systemLang() {
    const tag = String(search().get('lang')
      || (typeof navigator !== 'undefined' ? (navigator.language || '') : '')).toLowerCase();
    return /^zh\b|^zh[-_]/.test(tag) ? 'zh' : FALLBACK;
  }

  function stored() {
    try {
      const value = localStorage.getItem(STORE_KEY);
      return value === 'zh' || value === 'en' ? value : null;
    } catch (_) { return null; }
  }

  const lang = () => stored() || systemLang();
  const t = key => (COPY[lang()] && COPY[lang()][key]) || COPY.zh[key] || key;

  function setLang(next) {
    try { localStorage.setItem(STORE_KEY, next === 'zh' ? 'zh' : 'en'); } catch (_) {}
    location.reload();
  }
  const toggleLang = () => setLang(lang() === 'zh' ? 'en' : 'zh');

  // 把页面里所有带 data-shell-i18n 的节点按当前语言刷一遍；document.title 单独给 key。
  function apply(root) {
    const doc = document;
    doc.documentElement.lang = lang();
    for (const node of (root || doc).querySelectorAll('[data-shell-i18n]')) {
      node.textContent = t(node.dataset.shellI18n);
    }
    for (const node of (root || doc).querySelectorAll('[data-shell-i18n-title]')) {
      node.title = t(node.dataset.shellI18nTitle);
    }
    const titleKey = doc.body && doc.body.dataset.titleKey;
    if (titleKey) doc.title = t(titleKey);
  }

  window.MultiCCShellI18n = { lang, systemLang, t, setLang, toggleLang, apply, COPY };
})();
