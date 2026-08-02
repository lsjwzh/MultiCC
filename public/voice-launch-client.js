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

  const ERROR_TEXT = {
    voice_gateway_not_found: '实时语音网关尚未启用，请先在管理页开启。',
    voice_gateway_not_running: '实时语音服务未启动，请在管理页启动或重启。',
    voice_launch_source_not_found: '当前会话已不存在，无法启动语音。',
    voice_launch_source_not_addressable: '该会话不支持语音投递。',
    voice_launch_source_not_chat: '只有 chat 会话可以启动语音。',
    voice_launch_directory_not_found: '会话所属项目已不存在，无法启动语音。',
    voice_router_not_provisioned: '全局语音路由尚未初始化，请先在管理页保存一次配置。',
    voice_router_id_conflict: '全局语音路由 id 被其他会话占用，请联系管理员处理。',
    voice_launch_expired: '语音入口已过期，请重新点击。',
    voice_launch_unknown: '语音入口无效，请重新点击。',
  };

  function describeError(code) {
    if (!code) return '启动语音失败。';
    return ERROR_TEXT[code] || ('启动语音失败：' + code);
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
      return { ok: false, code, message: '启动语音失败：' + code };
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
    return opened ? result : { ok: false, code: 'popup_blocked', message: '浏览器拦截了语音窗口，请允许弹出窗口后重试。' };
  }

  return {
    ENDPOINT,
    describeError,
    launch,
    openLaunch,
    requestLaunch,
  };
});
