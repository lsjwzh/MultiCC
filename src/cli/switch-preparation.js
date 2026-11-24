'use strict';

// Native adapter only. History lookup, missing/ambiguous decisions and checked
// copies run on the Rust worker; there is no Node implementation or fallback.
const os = require('node:os');
const { getNative, nativeCode } = require('../native/runtime');

const PROFILE_ROUTE_ERRORS = Object.freeze({
  CODEX_SESSION_ROLLOUT_AMBIGUOUS: 'Codex 原生会话历史存在多份副本，无法安全切换线路；请先清理重复的 rollout 文件。',
  CODEX_SESSION_ROUTE_SOURCE_CHANGED: 'Codex 会话历史在切换期间发生变化，请重试。',
  CODEX_SESSION_ROLLOUT_RACE: 'Codex 会话历史在迁移期间发生并发变更，请重试。',
});

function profileRouteFailure(rawError) {
  const error = nativeCode(rawError);
  const code = error && typeof error.code === 'string' ? error.code : '';
  if (code.startsWith('CODEX_SESSION_')) {
    const wrapped = new Error(PROFILE_ROUTE_ERRORS[code] || 'Codex 会话历史校验失败，无法切换线路。');
    wrapped.code = code;
    wrapped.status = 409;
    wrapped.safe = true;
    wrapped.cause = error;
    return wrapped;
  }
  return error;
}

async function prepareCliSwitchRoute(input) {
  return JSON.parse(await getNative().prepareCliSwitchRoute(JSON.stringify({
    homeDir: os.homedir(), ...input,
  })));
}

async function synchronizeCodexProfileRoute(route) {
  try {
    return await prepareCliSwitchRoute({ ...route, cli: 'codex' });
  } catch (error) {
    throw profileRouteFailure(error);
  }
}

module.exports = { prepareCliSwitchRoute, synchronizeCodexProfileRoute };
