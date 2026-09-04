'use strict';

// MultiCC desktop shell — Electron main process.
//
// The shell is deliberately thin: everything OS-specific lives in lib/ modules
// that never import electron, and the entire UI is the existing MultiCC web
// app served by a locally-supervised backend child (this very binary running
// as plain Node via ELECTRON_RUN_AS_NODE). The window only ever loads two
// local origins: our backend (http://127.0.0.1:<port>) and our own splash /
// error pages (file://). No remote content is executed.

const { app, BrowserWindow, Menu, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const { findFreePort } = require('./lib/port-chooser');
const {
  resolveDesktopEnv, buildChildEnv, readEnvValues, ensureWritableDirs,
} = require('./lib/desktop-env');
const { createBackendSupervisor } = require('./lib/backend-supervisor');
const { reclaimOrphan } = require('./lib/orphan-reclaim');

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

function logLine(...args) {
  const text = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  console.log(`[desktop] ${text}`);
  if (supervisorLog) { try { supervisorLog.write(`${new Date().toISOString()} ${text}\n`); } catch (_) {} }
}

function sanitizedBaseEnv() {
  const env = { ...process.env };
  // The child must not inherit anything that changes how the Electron binary
  // boots — we set ELECTRON_RUN_AS_NODE deliberately in desktop-env instead.
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

// ── Window ──────────────────────────────────────────────────────────────────
const SPLASH_URL = `file://${path.join(__dirname, 'assets', 'splash.html')}`;

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

    const port = await findFreePort();
    logLine(`starting backend on 127.0.0.1:${port} (server: ${desktopEnv.serverEntry})`);
    supervisor = createBackendSupervisor({
      spawn: childProcess.spawn,
      execPath: process.execPath,
      serverEntry: desktopEnv.serverEntry,
      buildEnv: ({ port: childPort }) => buildChildEnv({
        port: childPort,
        desktopEnv,
        baseEnv: sanitizedBaseEnv(),
        dotenv: readEnvValues(desktopEnv.envFile),
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
    createWindow();
    app.on('activate', () => { if (!mainWindow) createWindow(); });
    await startBackend();
  });

  app.on('window-all-closed', () => app.quit());
}
