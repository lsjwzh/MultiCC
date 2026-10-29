'use strict';

// MultiCC desktop shell — Electron main process.
//
// This is a shell around the standalone release, not a second build of the
// product: Contents/Resources carries the same tree a `multicc-standalone-*`
// package does (app-server + the pinned Node runtime + launcher, staged by
// scripts/desktop-stage-standalone.js), and the supervised backend child runs
// on that bundled runtime — the identical code and Node that install.sh puts on
// a server. Everything OS-specific lives in lib/ modules that never import
// electron; the entire UI is the existing MultiCC web app. The window only ever
// loads two local origins: our backend (http://127.0.0.1:<port>) and our own
// splash / error pages (file://). No remote content is executed.

const { app, BrowserWindow, Menu, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const { DEFAULT_PORT, selectPort } = require('./lib/port-chooser');
const {
  resolveDesktopEnv, buildChildEnv, readEnvValues, ensureWritableDirs,
} = require('./lib/desktop-env');
const { createBackendSupervisor } = require('./lib/backend-supervisor');
const { reclaimOrphan } = require('./lib/orphan-reclaim');
const { createDesktopUpdater, resolveInstallTarget } = require('./lib/desktop-updater');

// ── Single instance ─────────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// ── Globals ─────────────────────────────────────────────────────────────────
let mainWindow = null;
let supervisor = null;
let desktopEnv = null;
let supervisorLog = null;
let isQuitting = false;
let startingNewRun = false;
let currentOrigin = null;
let desktopUpdater = null;

function logLine(...args) {
  const text = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  console.log(`[desktop] ${text}`);
  if (supervisorLog) { try { supervisorLog.write(`${new Date().toISOString()} ${text}\n`); } catch (_) {} }
}

function sanitizedBaseEnv() {
  const env = { ...process.env };
  // Electron sets ELECTRON_RUN_AS_NODE=1 for itself when it is relaunched as
  // Node; the backend child decides that for itself in desktop-env, so it must
  // never be inherited. (Launching our GUI from a terminal that had it set
  // would otherwise turn the whole app into a headless process.)
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

// ── Desktop self-update ─────────────────────────────────────────────────────
// The program the user installed and this process runs from: the .app on
// macOS, the install directory on Windows, the AppImage file on Linux. Only
// the shell knows it, which is why the swap happens here rather than on the
// server (which keeps refusing /api/update with DESKTOP_UPDATE_UNSUPPORTED).
function resolveAppBundlePath() {
  if (process.platform === 'darwin') return path.resolve(process.resourcesPath, '..', '..');
  if (process.platform === 'win32') return path.resolve(process.resourcesPath, '..');
  return process.env.APPIMAGE || path.resolve(process.resourcesPath, '..');
}

// Whether this build can install a new release over itself. A dev checkout
// (`electron .`) is not the shipped program, and a Linux .deb install has no
// in-place path, so both answer false and the web UI keeps its download-page
// fallback instead of walking the user into an update that cannot happen.
function desktopUpdateSupported() {
  if (!app.isPackaged) return false;
  const target = resolveInstallTarget({ platform: process.platform, bundlePath: resolveAppBundlePath(), env: process.env });
  return target.kind !== 'unsupported';
}

function createDesktopUpdaterInstance() {
  const workDir = path.join(app.getPath('userData'), 'update');
  fs.mkdirSync(workDir, { recursive: true });
  desktopUpdater = createDesktopUpdater({
    spawn: childProcess.spawn,
    platform: process.platform,
    arch: process.arch,
    currentVersion: app.getVersion(),
    bundlePath: resolveAppBundlePath(),
    workDir,
    appPid: process.pid,
    supported: desktopUpdateSupported(),
    logger: { log: logLine, error: logLine, warn: logLine },
    // Progress is what the web UI paints: a snapshot in the same shape
    // src/update-runner.js readUpdateStatus returns, so public/air-ops.js's
    // progress panel renders a desktop run unchanged.
    onProgress: (state) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('desktop:update:progress', state);
    },
    // The installer script waits for this pid to disappear, then swaps the
    // bundle and reopens it; quitting here is what lets it proceed.
    onQuit: () => app.quit(),
  });
  return desktopUpdater;
}

// ── System language ─────────────────────────────────────────────────────────
// The web UI picks its language from `navigator.language` (public/i18n.js), and
// Chromium derives that from this process's locale. Electron resolves LANG/LC_*
// for us through app.getLocale(), so pinning the Chromium switch to it is what
// makes the packaged app follow the system language: Chinese systems stay
// Chinese, and a C/en locale gets the English interface the AppImage catalog
// requires. Without this the packaged app can sit on Chromium's en-US default
// whatever the system says (which would silently flip Chinese users to English).
// Must run before app is ready; every locale the shell shows (?lang= on the
// splash/error pages) reads from the same value.
const systemLocale = (() => {
  try { return app.getLocale() || 'en-US'; } catch (_) { return 'en-US'; }
})();
try { app.commandLine.appendSwitch('lang', systemLocale); } catch (_) {}

// ── Window ──────────────────────────────────────────────────────────────────
const SPLASH_URL = `file://${path.join(__dirname, 'assets', 'splash.html')}?lang=${encodeURIComponent(systemLocale)}`;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 620,
    backgroundColor: '#101218',
    title: 'MultiCC',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  wireSecurity(mainWindow);
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.loadURL(SPLASH_URL);
  return mainWindow;
}

function isAllowedPage(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'file:') {
      // Only our own asset pages, never arbitrary disk files.
      return path.resolve(decodeURIComponent(parsed.pathname)).startsWith(path.join(__dirname, 'assets'));
    }
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return currentOrigin && parsed.origin === currentOrigin;
    }
    return false;
  } catch (_) { return false; }
}

function wireSecurity(win) {
  // Target=_blank and window.open: never open in-app; hand http(s) links to
  // the OS browser, deny everything else.
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') shell.openExternal(url);
      else if (parsed.protocol === 'mailto:') shell.openExternal(url);
    } catch (_) {}
    return { action: 'deny' };
  });
  // Block navigation away from the two allowed local origins.
  win.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedPage(url)) event.preventDefault();
  });
  // No geolocation/camera/notifications prompts from a local tool UI.
  win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
}

// ── Error page ──────────────────────────────────────────────────────────────
function showError(failure, origin) {
  if (!mainWindow) createWindow();
  const params = new URLSearchParams({
    reason: (failure && failure.reason) || 'unknown',
    message: ((failure && failure.message) || '').slice(0, 500),
    // The backend's own last lines: the page is what a user (or a bug report,
    // or a catalog reviewer's screenshot) actually sees, so the reason a server
    // died belongs on it — a one-line "failed to start" leaves the only clue in
    // a log file on the user's disk.
    tail: ((failure && failure.tail) || '').slice(-2000),
    lang: systemLocale,
    logDir: desktopEnv ? desktopEnv.logsDir : '',
    dataDir: desktopEnv ? desktopEnv.dataRoot : '',
    origin: origin || '',
  });
  mainWindow.loadURL(`file://${path.join(__dirname, 'assets', 'error.html')}?${params}`);
}

// ── Supervisor phases ───────────────────────────────────────────────────────
function handlePhase(phase, info) {
  if (phase === 'ready') {
    currentOrigin = info.origin;
    logLine(`backend ready at ${info.origin}`);
    if (mainWindow) mainWindow.loadURL(`${info.origin}/`);
  } else if (phase === 'failed') {
    logLine(`backend failed: ${info.reason}`);
    showError(info.failure, supervisor ? supervisor.getState().origin : null);
  } else if (phase === 'respawning') {
    logLine(`backend exited (code=${info.code} signal=${info.signal}); restarting…`);
    if (mainWindow && currentOrigin) mainWindow.loadURL(`${currentOrigin}/`);
  }
}

// ── Boot / retry ────────────────────────────────────────────────────────────
async function startBackend() {
  if (startingNewRun) return;
  startingNewRun = true;
  try {
    const reclaim = await reclaimOrphan({
      infoFile: desktopEnv.runtimeInfoFile,
      spawn: childProcess.spawn,
      logger: { log: logLine, error: logLine, warn: logLine },
    });
    if (reclaim.reclaimed) logLine(`reclaimed previous backend (${reclaim.method})`);

    // The server must run on the runtime staged inside this app, not on
    // Electron's own Node: that is what makes the dmg and the tarball the same
    // product, and it is the Node the release smoke-tested end to end. A
    // packaged app with no runtime is a broken build, not something to paper
    // over by falling back to Electron's Node.
    if (app.isPackaged && !fs.existsSync(desktopEnv.runtimeNode)) {
      logLine(`bundled runtime missing at ${desktopEnv.runtimeNode}`);
      showError({ reason: 'missing-runtime', message: desktopEnv.runtimeNode }, null);
      return;
    }

    // The same rule as the standalone launcher: an explicit port is used
    // verbatim and a taken one stops the start with a message; only an
    // unspecified port is allowed to walk forward from 3000. Without this the
    // desktop shell ignored PORT in its config and always started on the first
    // free port from 3000.
    const dotenv = readEnvValues(desktopEnv.envFile);
    const configuredPort = Number.parseInt(dotenv.PORT, 10);
    const configuredValid = Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65535;
    const envPortRaw = process.env.MULTICC_DESKTOP_PORT;
    const pinnedPort = envPortRaw !== undefined && envPortRaw !== ''
      ? Number.parseInt(envPortRaw, 10)
      : configuredValid && /^(1|true|yes|on)$/i.test(String(dotenv.PORT_PINNED || '').trim())
        ? configuredPort
        : null;
    const port = await selectPort({
      pinnedPort,
      startPort: configuredValid ? configuredPort : DEFAULT_PORT,
    });
    logLine(`starting backend on 127.0.0.1:${port}${pinnedPort !== null ? ' (pinned)' : ''} (server: ${desktopEnv.serverEntry}, runtime: ${desktopEnv.runtimeNode})`);
    supervisor = createBackendSupervisor({
      spawn: childProcess.spawn,
      execPath: desktopEnv.runtimeNode,
      serverEntry: desktopEnv.serverEntry,
      buildEnv: ({ port: childPort }) => buildChildEnv({
        port: childPort,
        desktopEnv,
        baseEnv: sanitizedBaseEnv(),
        dotenv,
        runtimeNode: desktopEnv.runtimeNode,
        // Tells the server it is hosted by this shell (not a standalone
        // install), so the web UI's update entry refuses instead of running
        // install.sh against the folder that holds MultiCC.app.
        desktopShell: true,
      }),
      logsDir: desktopEnv.logsDir,
      runtimeInfoFile: desktopEnv.runtimeInfoFile,
      logger: { log: logLine, error: logLine, warn: logLine },
      onPhase: handlePhase,
    });
    await supervisor.start({ port });
  } catch (error) {
    logLine(`startup failed: ${error.message}`);
    showError({ reason: 'spawn-error', message: error.message }, null);
  } finally {
    startingNewRun = false;
  }
}

async function stopEverything() {
  if (supervisor) {
    try { await supervisor.stop(); } catch (error) { logLine(`stop failed: ${error.message}`); }
    supervisor = null;
  }
  if (supervisorLog) { try { supervisorLog.end(); } catch (_) {} supervisorLog = null; }
}

// ── IPC from splash/error pages ─────────────────────────────────────────────
function wireIpc() {
  const { ipcMain, dialog } = require('electron');
  ipcMain.handle('desktop:version', () => app.getVersion());
  // Answer the preload's synchronous capability probe before any page loads:
  // the web UI uses it to decide between the in-app update flow and the
  // download-page fallback.
  ipcMain.on('desktop:update:supported', (event) => { event.returnValue = desktopUpdateSupported(); });
  ipcMain.handle('desktop:update:status', () => (desktopUpdater ? desktopUpdater.getState() : null));
  ipcMain.handle('desktop:update:start', async (_event, options) => {
    try {
      if (!desktopUpdater) createDesktopUpdaterInstance();
      const state = await desktopUpdater.start(options || {});
      return { ok: true, state };
    } catch (error) {
      logLine(`desktop update failed: ${error.message}`);
      return { ok: false, code: error.code || 'DESKTOP_UPDATE_FAILED', error: error.message, state: desktopUpdater ? desktopUpdater.getState() : null };
    }
  });
  ipcMain.on('desktop:retry', () => {
    logLine('retry requested from error page');
    if (mainWindow) mainWindow.loadURL(SPLASH_URL);
    if (supervisor && supervisor.getState().state === 'failed') supervisor = null;
    startBackend();
  });
  ipcMain.on('desktop:open-logs', async () => {
    const dir = desktopEnv ? desktopEnv.logsDir : null;
    if (!dir) return;
    fs.mkdirSync(dir, { recursive: true });
    const first = fs.readdirSync(dir).filter(f => f.endsWith('.log')).sort().pop();
    if (first) await shell.openPath(path.join(dir, first));
    else await shell.openPath(dir);
  });
  ipcMain.on('desktop:open-data', async () => {
    if (desktopEnv) { fs.mkdirSync(desktopEnv.dataRoot, { recursive: true }); await shell.openPath(desktopEnv.dataRoot); }
  });
  ipcMain.on('desktop:quit', () => app.quit());
  // Dialog bridge for the error page (kept out of the sandboxed renderer).
  ipcMain.handle('desktop:reveal', async (_event, targetPath) => {
    const allowed = [desktopEnv.logsDir, desktopEnv.dataRoot, desktopEnv.envFile, path.dirname(desktopEnv.envFile)];
    if (!allowed.some(root => targetPath && path.resolve(targetPath).startsWith(path.resolve(root)))) return false;
    await shell.showItemInFolder(path.resolve(targetPath));
    return true;
  });
}

// ── Lifecycle ───────────────────────────────────────────────────────────────
if (gotLock) {
  app.on('before-quit', (event) => {
    if (isQuitting) return;
    isQuitting = true;
    event.preventDefault();
    stopEverything().finally(() => app.exit(0));
  });

  app.whenReady().then(async () => {
    desktopEnv = resolveDesktopEnv({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      userData: app.getPath('userData'),
    });
    ensureWritableDirs(desktopEnv);
    supervisorLog = fs.createWriteStream(path.join(desktopEnv.logsDir, 'supervisor.log'), { flags: 'a' });
    logLine(`desktop shell starting (mode=${desktopEnv.mode}, app=${app.getVersion()}, electron=${process.versions.electron})`);

    // macOS keeps its application/edit menus (Cmd+C/V/Q depend on them);
    // elsewhere the bar stays hidden and Chromium handles in-page shortcuts.
    if (process.platform === 'darwin') {
      Menu.setApplicationMenu(Menu.buildFromTemplate([
        { role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' },
      ]));
    } else {
      Menu.setApplicationMenu(null);
    }

    wireIpc();
    createDesktopUpdaterInstance();
    createWindow();
    app.on('activate', () => { if (!mainWindow) createWindow(); });
    await startBackend();
  });

  app.on('window-all-closed', () => app.quit());
}
