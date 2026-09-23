'use strict';

// HTTP surface for the optional privileged helper (see src/privileged-helper.js
// for what it is and why it is a sudoers drop-in rather than a root daemon).
//
// Installing it is the one moment where the user is asked for a password; from
// then on the whitelisted actions run silently. Everything here is optional by
// construction: if the user never presses the button, or uninstalls later, the
// features keep working through the per-action password prompt.
const { execFile } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');

const INSTALL_TIMEOUT_MS = 120000;
const SCRIPT_PATH = path.join(__dirname, '..', '..', 'scripts', 'install-privileged-helper.sh');

// AppleScript takes the whole command as a double-quoted string, so both
// characters that can terminate or extend that string are escaped. The values
// interpolated here are a repo-internal path and a username the script itself
// re-validates, but escaping is done at the boundary regardless.
const forAppleScript = (text) => String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

function createPrivilegedHelperRoutes(options = {}) {
  const {
    platform = process.platform,
    run = execFile,
    log = console,
    helper = require('../privileged-helper').createPrivilegedHelper({ platform, run }),
    user = os.userInfo().username,
    scriptPath = SCRIPT_PATH,
  } = options;

  const elevate = (args) => new Promise((resolve) => {
    const command = [scriptPath, ...args].map((part) => `'${part}'`).join(' ');
    const script = `do shell script "${forAppleScript(command)}" with administrator privileges`;
    run('/usr/bin/osascript', ['-e', script], { timeout: INSTALL_TIMEOUT_MS, encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ failed: Boolean(error), text: `${error ? error.message : ''} ${stdout || ''} ${stderr || ''}`.trim() });
    });
  });

  async function statusHandler(req, res) {
    const status = await helper.status();
    return res.json({ ok: true, ...status, user });
  }

  async function changeHandler(mode, req, res) {
    if (platform !== 'darwin') {
      return res.status(400).json({ ok: false, code: 'NOT_APPLICABLE', error: '免密助手只在 macOS 上有意义。' });
    }
    const result = await elevate(mode === 'install' ? ['install', user] : ['uninstall']);
    if (result.failed) {
      // Cancelling the password dialog is the expected way to decline, not a
      // fault: report it as such so the UI does not show a red error for a
      // deliberate choice.
      if (/User canceled|-128/i.test(result.text)) {
        return res.status(200).json({ ok: false, status: 'canceled', error: '已取消授权，功能仍可用，只是每次会要求输入密码。' });
      }
      log.warn(`[multicc/privileged-helper] ${mode} failed: ${result.text}`);
      return res.status(500).json({ ok: false, error: result.text, script: scriptPath });
    }
    // Trust the probe, not the exit code: a drop-in sudo refuses to honour
    // (wrong mode or owner) would otherwise be reported as a success.
    const status = await helper.status();
    if (mode === 'install' && !status.installed) {
      return res.status(500).json({ ok: false, error: '助手已写入，但 sudo 仍要求密码，请检查 /etc/sudoers.d/multicc。' });
    }
    return res.json({ ok: true, status: mode === 'install' ? 'installed' : 'removed', ...status });
  }

  function mountRoutes(app) {
    if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
      throw new TypeError('Express app.get and app.post are required');
    }
    app.get('/api/system/privileged-helper', statusHandler);
    app.post('/api/system/privileged-helper/install', (req, res) => changeHandler('install', req, res));
    app.post('/api/system/privileged-helper/uninstall', (req, res) => changeHandler('uninstall', req, res));
  }

  return { statusHandler, installHandler: (req, res) => changeHandler('install', req, res), uninstallHandler: (req, res) => changeHandler('uninstall', req, res), mountRoutes };
}

module.exports = { createPrivilegedHelperRoutes };
