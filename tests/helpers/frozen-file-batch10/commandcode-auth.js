'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 只返回官方 CLI 保存的身份摘要；凭据始终留在官方文件中。
// 本地存在凭据不等于上游已验证有效，因此不返回 authenticated。
function readCommandcodeLogin({ home = os.homedir(), env = process.env } = {}) {
  const suffix = { local: 'auth.local.json', staging: 'auth.staging.json' }[env.COMMANDCODE_API_ENV] || 'auth.json';
  const environmentKey = typeof env.COMMAND_CODE_API_KEY === 'string' && !!env.COMMAND_CODE_API_KEY.trim();
  try {
    const data = JSON.parse(fs.readFileSync(path.join(home, '.commandcode', suffix), 'utf8'));
    const credentialSaved = !!data && typeof data.apiKey === 'string' && !!data.apiKey.trim();
    return { credentialSaved, userName: credentialSaved && typeof data.userName === 'string'
      ? data.userName.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120) : '', environmentKey };
  } catch (_) {
    return { credentialSaved: false, userName: '', environmentKey };
  }
}

function mountCommandcodeAuthRoutes(app, deps) {
  const { directories, createSessionRecord, disposeLoginTerminal = async () => 0,
    getStatus = readCommandcodeLogin } = deps;
  app.get('/api/commandcode/auth/status', (req, res) => {
    res.json({ ok: true, ...getStatus() });
  });
  app.post('/api/commandcode/auth/login', async (req, res) => {
    const sessionId = 'commandcode-login';
    try {
      const dir = [...directories.values()].find(item => item && item.path);
      if (!dir) return res.status(409).json({ ok: false, error: '请先添加一个项目目录，再打开登录终端。' });
      // A login terminal is one-shot: drop the previous run (and its tmux pane)
      // so every click starts a new terminal instead of the saved one.
      await disposeLoginTerminal('commandcode-login');
      const result = await createSessionRecord({
        dir, id: sessionId, cli: 'commandcode', kind: 'terminal', label: 'Command Code 官方账号登录',
        provider: null, loginFlow: 'commandcode-login',
        persistence: 'required', persistenceSource: 'http.commandcode-login',
      });
      if (!result || !result.ok) return res.status(500).json({ ok: false, error: '无法创建 Command Code 登录终端。' });
      res.json({ ok: true, sessionId: result.id, reused: !!result.reused });
    } catch (_) {
      res.status(500).json({ ok: false, error: '无法打开 Command Code 登录终端。' });
    }
  });
}

module.exports = { readCommandcodeLogin, mountCommandcodeAuthRoutes };
