'use strict';

// ── Open the Full Disk Access pane, and name what to add to it ───────────────
// macOS TCC denies git access to Desktop/Documents/Downloads/iCloud for any
// process that has not been granted 完全磁盘访问权限. This is not a Unix
// permission problem — root gets EPERM too — and it is not fixable in code:
// only the user, in System Settings, can grant it.
//
// What this route removes is the two steps a user most often gets wrong:
// finding the pane at all, and knowing WHICH binary to add. Authorization is
// recorded against the responsible process, which differs depending on how
// MultiCC was started (terminal, .app bundle, launchd), so the path is computed
// rather than guessed at by the user.
const { execFile } = require('node:child_process');
const path = require('node:path');
const { homedir } = require('node:os');

const OPEN_TIMEOUT_MS = 10000;
const FULL_DISK_ACCESS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles';
const AGENT_PERMISSION_URLS = Object.freeze({
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  screenRecording: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
});

function isLocal(req) {
  const address = req?.socket?.remoteAddress || '';
  return address === '::1' || address === '127.0.0.1' || address === '::ffff:127.0.0.1';
}

function createMacosPrivacyRoutes({
  platform = process.platform,
  run = execFile,
  log = console,
  permissionTargets = require('../directories').macPermissionTargets,
  agentBin = process.env.MULTICC_AGENT_BIN || path.join(homedir(), '.multicc', 'bin', 'multicc-agent'),
} = {}) {
  async function agentPermissionsHandler(req, res) {
    if (platform !== 'darwin') return res.json({ ok: true, applicable: false });
    const result = await new Promise(resolve => {
      run(agentBin, ['status'], { timeout: 3000, encoding: 'utf8' }, (error, stdout) => {
        if (error) return resolve(null);
        try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
      });
    });
    if (!result || result.ok !== true) return res.json({ ok: false, applicable: true,
      local: isLocal(req), error: 'agent-unavailable' });
    // Only these two booleans cross the API; Agent status contains more detail
    // that the permission setup page has no reason to expose.
    return res.json({ ok: true, applicable: true, local: isLocal(req),
      accessibility: result.accessibility === true, screenRecording: result.screenRecording === true });
  }

  async function openAgentPermissionHandler(req, res) {
    if (platform !== 'darwin') return res.status(400).json({ ok: false, error: 'macOS only' });
    if (!isLocal(req)) return res.status(403).json({ ok: false, error: '请在这台 Mac 上打开权限设置。' });
    const permission = req.body?.permission;
    const url = Object.prototype.hasOwnProperty.call(AGENT_PERMISSION_URLS, permission)
      ? AGENT_PERMISSION_URLS[permission] : null;
    if (!url) return res.status(400).json({ ok: false, error: 'unknown permission' });
    const result = await new Promise(resolve => {
      run('/usr/bin/open', [url], { timeout: OPEN_TIMEOUT_MS, encoding: 'utf8' }, error => resolve(error));
    });
    if (result) return res.status(500).json({ ok: false, error: result.message });
    return res.json({ ok: true, status: 'opened' });
  }

  // GET — what the user must add, so the UI can show a copyable path next to
  // the button instead of prose the user has to parse.
  async function targetHandler(req, res) {
    if (platform !== 'darwin') {
      return res.json({ ok: true, platform, applicable: false, target: null });
    }
    const targets = permissionTargets();
    // launchd has no GUI session to attribute the grant to, so the binary
    // itself is the only thing that can be added; a bundle grants to the .app.
    const target = targets.service ? targets.execPath : (targets.appBundle || targets.execPath);
    return res.json({
      ok: true,
      platform,
      applicable: true,
      target,
      // A translocated copy is a dead end: any grant is recorded against a
      // randomised read-only path that will not exist next launch.
      translocated: Boolean(targets.translocated),
      url: FULL_DISK_ACCESS_URL,
    });
  }

  // POST — open the pane. Deliberately not idempotency-checked: reopening a
  // settings pane is harmless, and the user may well click it twice.
  async function openHandler(req, res) {
    if (platform !== 'darwin') {
      return res.status(400).json({ ok: false, code: 'NOT_APPLICABLE', error: '完全磁盘访问权限是 macOS 专有设置。' });
    }
    const result = await new Promise((resolve) => {
      run('/usr/bin/open', [FULL_DISK_ACCESS_URL], { timeout: OPEN_TIMEOUT_MS, encoding: 'utf8' }, (error, stdout, stderr) => {
        resolve({ failed: Boolean(error), text: `${error ? error.message : ''} ${stderr || ''}`.trim() });
      });
    });
    if (result.failed) {
      log.warn(`[multicc] macos-privacy: opening the Full Disk Access pane failed: ${result.text}`);
      return res.status(500).json({ ok: false, error: result.text, url: FULL_DISK_ACCESS_URL });
    }
    return res.json({ ok: true, status: 'opened', url: FULL_DISK_ACCESS_URL });
  }

  function mountRoutes(app) {
    app.get('/api/system/disk-access', targetHandler);
    app.post('/api/system/disk-access/open', openHandler);
    app.get('/api/system/agent-permissions', agentPermissionsHandler);
    app.post('/api/system/agent-permissions/open', openAgentPermissionHandler);
  }

  return { mountRoutes, targetHandler, openHandler, agentPermissionsHandler, openAgentPermissionHandler };
}

module.exports = { createMacosPrivacyRoutes, FULL_DISK_ACCESS_URL, AGENT_PERMISSION_URLS };
