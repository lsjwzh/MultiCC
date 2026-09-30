(function attach(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MultiCCVoiceLaunch = api;
})(typeof window !== 'undefined' ? window : globalThis, function createApi() {
  'use strict';

  // Single client entry point for the global realtime voice gateway.
  //
  // Every button — Dashboard, Web Chat phone, Flutter Chat phone — asks for a
  // launch and opens whatever URL the Host hands back. The client states scope
  // and nothing else: directory, cwd, Commander and prompt are host-owned, so
  // they are never submitted from here and never trusted from here.
  //
  // Plain microphone dictation does not go through this module at all.

  const ENDPOINT = '/api/v1/voice-gateway/launch';

  // 这一份是模块自带的（chat / dashboard / manage 三页共用，也可能在没挂 i18n.js 的
  // 测试页里跑），所以中英并列、就地判定，别指望页面的 t()。语言规则和 public/i18n.js
  // 的 getLang() 一致：显式选择 ＞ 系统语言 ＞ 英文 —— 国际发行渠道要求非中文环境
  // 默认英文，这里兜底成中文就会在英文页面的气泡里冒出汉字。
  const ERROR_TEXT = {
    voice_gateway_not_found: {
      zh: '实时语音网关尚未启用，请先在管理页开启。',
      en: 'The realtime voice gateway is not enabled — turn it on in the Manage console first.',
    },
    voice_gateway_not_running: {
      zh: '实时语音服务未启动，请在管理页启动或重启。',
      en: 'The realtime voice service is not running — start or restart it in the Manage console.',
    },
    voice_launch_source_not_found: {
      zh: '当前会话已不存在，无法启动语音。',
      en: 'This session no longer exists, so voice cannot be started.',
    },
    voice_launch_source_not_addressable: {
      zh: '该会话不支持语音投递。',
      en: 'This session cannot receive voice.',
    },
    voice_launch_source_not_chat: {
      zh: '只有 chat 会话可以启动语音。',
      en: 'Only chat sessions can start voice.',
    },
    voice_launch_directory_not_found: {
      zh: '会话所属项目已不存在，无法启动语音。',
      en: 'The project this session belongs to no longer exists, so voice cannot be started.',
    },
    voice_router_not_provisioned: {
      zh: '全局语音路由尚未初始化，请先在管理页保存一次配置。',
      en: 'The global voice router is not provisioned yet — save the configuration in the Manage console first.',
    },
    voice_router_id_conflict: {
      zh: '全局语音路由 id 被其他会话占用，请联系管理员处理。',
      en: 'The global voice router id is taken by another session — ask an administrator to resolve it.',
    },
    voice_launch_expired: {
      zh: '语音入口已过期，请重新点击。',
      en: 'The voice entry has expired — click again.',
    },
    voice_launch_unknown: {
      zh: '语音入口无效，请重新点击。',
      en: 'That voice entry is not valid — click again.',
    },
    launch_failed: { zh: '启动语音失败。', en: 'Could not start voice.' },
    launch_failed_with: { zh: '启动语音失败：{code}', en: 'Could not start voice: {code}' },
    popup_blocked: {
      zh: '浏览器拦截了语音窗口，请允许弹出窗口后重试。',
      en: 'The browser blocked the voice window — allow pop-ups and try again.',
    },
  };

  function uiLang() {
    try {
      const win = typeof window !== 'undefined' ? window : null;
      if (!win) return 'en';
      if (typeof win.getLang === 'function') return win.getLang();
      const stored = win.localStorage && win.localStorage.getItem('multicc_lang');
      if (stored === 'zh' || stored === 'en') return stored;
      return /^zh/i.test(win.navigator && win.navigator.language || '') ? 'zh' : 'en';
    } catch (_) { return 'en'; }
  }

  function text(key, vars) {
    const entry = ERROR_TEXT[key] || {};
    let out = entry[uiLang()] || entry.zh || key;
    if (vars) for (const name of Object.keys(vars)) out = out.split(`{${name}}`).join(String(vars[name]));
    return out;
  }

  function describeError(code) {
    if (!code) return text('launch_failed');
    return ERROR_TEXT[code] ? text(code) : text('launch_failed_with', { code });
  }

  function errorCodeFrom(data, res) {
    if (data && typeof data.code === 'string') return data.code;
    if (data && typeof data.error === 'string') return data.error;
    return 'HTTP ' + ((res && res.status) || 0);
  }

  // sourceSessionId present → this chat; absent → global. There is no third
  // option, and the caller cannot influence routing beyond that choice.
  async function requestLaunch(options) {
    const opts = options || {};
    const sourceSessionId = typeof opts.sourceSessionId === 'string' ? opts.sourceSessionId.trim() : '';
    const doFetch = opts.fetchImpl || (typeof fetch === 'function' ? fetch.bind(null) : null);
    if (!doFetch) return { ok: false, code: 'fetch_unavailable', message: describeError('fetch_unavailable') };
    const url = typeof opts.withToken === 'function' ? opts.withToken(ENDPOINT) : ENDPOINT;
    let res = null;
    let data = null;
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sourceSessionId ? { sourceSessionId } : {}),
      });
      data = await res.json();
    } catch (error) {
      const code = (error && error.message) || 'network_error';
      return { ok: false, code, message: text('launch_failed_with', { code }) };
    }
    const launch = data && data.launch;
    if (!res.ok || !data || data.ok === false || !launch || !launch.url) {
      const code = errorCodeFrom(data, res);
      return { ok: false, code, message: describeError(code) };
    }
    return { ok: true, launch };
  }

  function openLaunch(launch, opener) {
    if (!launch || !launch.url) return false;
    const open = opener || (typeof window !== 'undefined' ? window.open.bind(window) : null);
    if (!open) return false;
    // A dedicated named window per scope so a second click re-focuses the same
    // call instead of stacking duplicate microphone sessions.
    open(launch.url, 'multicc-voice-' + (launch.scope || 'global'), 'noopener');
    return true;
  }

  async function launch(options) {
    const result = await requestLaunch(options);
    if (!result.ok) return result;
    const opened = openLaunch(result.launch, options && options.opener);
    return opened ? result : { ok: false, code: 'popup_blocked', message: text('popup_blocked') };
  }

  return {
    ENDPOINT,
    describeError,
    launch,
    openLaunch,
    requestLaunch,
  };
});
