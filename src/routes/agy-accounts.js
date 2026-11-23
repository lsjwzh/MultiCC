'use strict';

// agy 的登录终端执行体。公开路由 `POST /api/agy/accounts/:id/login-terminal`
// 由 Rust 前门独占（native/gateway/src/app/agy_accounts.rs 的 LoginTerminal）：
// 那里校验 id、确认账号存在并解析出账号目录，再把它交给这里。
//
// 这里只做 Rust 做不到的部分：节点 PTY 会话。登录是厂商自带的交互 TUI，没有
// `agy login` 子命令，所以终端必须由 Node 起。账号目录随请求体传入，本文件
// 不再自己读盘或校验收 id，存储规则只有 native/core/src/agy_accounts.rs 一份。
//
// 终端拿到 `HOME=<id>.home`，OAuth 只会写那个账号的 `~/.gemini`。该环境变量由
// sanitizeLoginEnv（src/official-accounts.js）放行，并在会话创建时应用。

const fs = require('node:fs');

const AGY_LOGIN_FLOW = 'agy-login';
const AGY_LOGIN_SESSION_ID = 'agy-login';
const LOGIN_LABEL = '反重力登录';

function mountAgyAccountRoutes(app, rawDeps) {
  if (!app || typeof app.post !== 'function') {
    throw new TypeError('[agy-accounts] Express-compatible app is required');
  }
  const deps = rawDeps || {};
  const { directories, createSessionRecord } = deps;
  if (typeof createSessionRecord !== 'function') {
    throw new TypeError('[agy-accounts] createSessionRecord is required');
  }
  const asyncHandler = typeof deps.asyncHandler === 'function' ? deps.asyncHandler : fn => fn;
  const disposeLoginTerminal = typeof deps.disposeLoginTerminal === 'function'
    ? deps.disposeLoginTerminal : async () => 0;

  // One login terminal at a time: it is a human-driven OAuth flow, and a second
  // click must show a fresh prompt rather than replay a finished one.
  app.post('/api/agy/accounts/:id/login-terminal', asyncHandler(async (req, res) => {
    const accountDir = String((req.body && req.body.home) || '');
    if (!accountDir) return res.status(400).json({ error: 'account home required' });
    fs.mkdirSync(accountDir, { recursive: true, mode: 0o700 });

    const dirList = typeof directories.values === 'function' ? [...directories.values()] : [];
    const dir = dirList.find(item => item && item.path) || dirList[0];
    if (!dir) return res.status(500).json({ error: 'no directory available' });

    const proxyUrl = typeof (req.body && req.body.proxyUrl) === 'string' ? req.body.proxyUrl.trim() : '';
    const loginEnv = {
      HOME: accountDir,
      ...(proxyUrl ? {
        HTTP_PROXY: proxyUrl,
        HTTPS_PROXY: proxyUrl,
        ALL_PROXY: proxyUrl,
        http_proxy: proxyUrl,
        https_proxy: proxyUrl,
        all_proxy: proxyUrl,
        NO_PROXY: '127.0.0.1,localhost,::1',
        no_proxy: '127.0.0.1,localhost,::1',
      } : {}),
    };

    await disposeLoginTerminal(AGY_LOGIN_FLOW);
    const result = await createSessionRecord({
      dir,
      cli: 'agy',
      kind: 'terminal',
      id: AGY_LOGIN_SESSION_ID,
      label: LOGIN_LABEL,
      loginFlow: AGY_LOGIN_FLOW,
      loginEnv,
      persistence: 'required',
      persistenceSource: 'http.agy-login-terminal',
    });
    if (!result || !result.ok) {
      return res.status(400).json({ error: (result && result.error) || 'session create failed' });
    }
    const sessionId = result.id || (result.session && result.session.id);
    return res.json({ ...result.session, id: sessionId, url: `/?id=${encodeURIComponent(sessionId)}` });
  }));
}

module.exports = { mountAgyAccountRoutes, AGY_LOGIN_FLOW, AGY_LOGIN_SESSION_ID };
