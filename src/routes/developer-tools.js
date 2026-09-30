'use strict';

// ── Install macOS Command Line Tools from the UI ──────────────────────────────
// MultiCC gives every session its own git worktree, so a working git is not
// optional. On macOS /usr/bin/git is only a Command Line Tools *shim*: it exists
// even when the tools do not, and every call then exits non-zero with a note the
// user cannot act on ("xcode-select: note: No developer tools were found").
//
// `xcode-select --install` is the one command that repairs it, and it works by
// asking the system's install daemon to show its own dialog — the very "click
// Install" prompt the user expects. That makes it safe to expose as a button:
// the request does not download or install anything itself, it only raises the
// system prompt, and the user still has to accept it.
//
// Probing uses `xcode-select -p`, never `git --version`: the latter would pop
// that dialog as a side effect of merely asking a question.
const { execFile } = require('node:child_process');

const PROBE_TIMEOUT_MS = 5000;
const INSTALL_TIMEOUT_MS = 20000;

// The shim itself. A git resolved anywhere else (Homebrew, MacPorts, the
// git-scm.com installer, a git bundled with Xcode.app) is a real binary, and
// asking it for its version is safe — it cannot raise the install dialog. Only
// this one path can, which is why it is named rather than probed.
const CLT_SHIM_PATH = '/usr/bin/git';

// `xcode-select --install` returns non-zero when the tools are already present
// or when a request is already queued. Neither is a failure worth showing as
// one, and both are only distinguishable by the text it prints.
const ALREADY_INSTALLED_RE = /already installed|已安装/i;
const ALREADY_REQUESTED_RE = /install requested|已请求|software update/i;

function createDeveloperToolsRoutes({
  platform = process.platform,
  run = execFile,
  log = console,
} = {}) {
  const exec = (file, args, timeout) => new Promise((resolve) => {
    run(file, args, { timeout }, (error, stdout, stderr) => {
      resolve({
        failed: Boolean(error),
        code: error && typeof error.code === 'number' ? error.code : (error ? -1 : 0),
        stdout: `${stdout || ''}`.trim(),
        text: `${stdout || ''}${stderr || ''}`.trim(),
        spawnError: error && error.code === 'ENOENT' ? 'ENOENT' : null,
      });
    });
  });

  const xcodeSelect = (args, timeout) => exec('xcode-select', args, timeout);

  async function toolsInstalled() {
    const probe = await xcodeSelect(['-p'], PROBE_TIMEOUT_MS);
    return !probe.failed;
  }

  // What MultiCC actually requires is a working git, not the Command Line Tools:
  // the tools are merely the most common way to get one. Someone who installed
  // git from Homebrew, MacPorts or git-scm.com has a perfectly good git and must
  // not be told to install anything. So the tools are only the answer when the
  // *only* git on PATH is the shim.
  async function gitWorks() {
    if (platform === 'darwin' && await toolsInstalled()) return true;
    const resolved = await exec('/bin/sh', ['-c', 'command -v git'], PROBE_TIMEOUT_MS);
    const gitPath = resolved.failed ? '' : resolved.stdout.split('\n')[0].trim();
    if (!gitPath) return false;
    // Running the shim here would raise the dialog this endpoint exists to
    // raise deliberately — on a button press, not on a status poll.
    if (platform === 'darwin' && gitPath === CLT_SHIM_PATH) return false;
    const version = await exec(gitPath, ['--version'], PROBE_TIMEOUT_MS);
    return !version.failed;
  }

  // GET — answer "are the tools there?" without side effects, so the client can
  // hide the button on a machine that never had the problem.
  async function statusHandler(req, res) {
    const git = await gitWorks();
    // `applicable` answers "would the button help here", which is narrower than
    // "is this macOS": a Homebrew git makes the tools irrelevant.
    return res.json({
      ok: true,
      platform,
      applicable: platform === 'darwin' && !git,
      gitWorks: git,
      installed: platform === 'darwin' ? await toolsInstalled() : true,
    });
  }

  // POST — raise the system installer dialog. Idempotent from the caller's point
  // of view: already-installed and already-requested both answer 200 with the
  // state, because re-clicking a button must not produce a scary error.
  async function installHandler(req, res) {
    if (platform !== 'darwin') {
      return res.status(400).json({
        ok: false,
        code: 'NOT_APPLICABLE',
        error: 'Command Line Tools are a macOS concept; install git with your package manager.',
      });
    }
    if (await toolsInstalled()) {
      return res.json({ ok: true, status: 'already-installed' });
    }
    const result = await xcodeSelect(['--install'], INSTALL_TIMEOUT_MS);
    if (!result.failed) {
      log.log('[multicc] developer-tools: system install dialog requested');
      return res.json({ ok: true, status: 'requested', detail: result.text || null });
    }
    if (ALREADY_INSTALLED_RE.test(result.text)) {
      return res.json({ ok: true, status: 'already-installed', detail: result.text });
    }
    if (ALREADY_REQUESTED_RE.test(result.text)) {
      return res.json({ ok: true, status: 'already-requested', detail: result.text });
    }
    // Headless launchd contexts have no GUI session to draw the dialog into, so
    // the honest answer is the manual command rather than a silent success.
    log.warn(`[multicc] developer-tools: xcode-select --install failed (${result.code}): ${result.text}`);
    return res.status(500).json({
      ok: false,
      code: result.spawnError === 'ENOENT' ? 'XCODE_SELECT_MISSING' : 'INSTALL_REQUEST_FAILED',
      error: result.text || 'xcode-select --install failed',
      command: 'xcode-select --install',
    });
  }

  function mountRoutes(app) {
    app.get('/api/system/developer-tools', statusHandler);
    app.post('/api/system/developer-tools/install', installHandler);
  }

  return { mountRoutes, statusHandler, installHandler };
}

module.exports = { createDeveloperToolsRoutes };
