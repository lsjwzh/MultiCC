'use strict';

// Preload for the desktop shell. Runs sandboxed + contextIsolated over every
// page this window loads, but only the splash/error pages and the MultiCC web
// UI's host-ops row actually use it — the rest of the web UI is untouched. The
// surface is a handful of verbs and two getters; no fs/net/require is exposed
// to the renderer.
//
// `update` is the desktop self-updater: the web UI detects it and runs the
// in-app download/install flow instead of sending the user to the releases
// page. It is null when this build cannot replace itself (a dev checkout, or
// a Linux .deb install), which is exactly the signal the UI falls back on.

const { contextBridge, ipcRenderer } = require('electron');

// A synchronous probe, answered by main before any page loads, so the web UI
// can pick its update path without a round trip.
const updateSupported = (() => {
  try { return ipcRenderer.sendSync('desktop:update:supported') === true; } catch (_) { return false; }
})();

contextBridge.exposeInMainWorld('multiccDesktop', {
  version: () => ipcRenderer.invoke('desktop:version'),
  retry: () => ipcRenderer.send('desktop:retry'),
  openLogs: () => ipcRenderer.send('desktop:open-logs'),
  openDataFolder: () => ipcRenderer.send('desktop:open-data'),
  quit: () => ipcRenderer.send('desktop:quit'),
  update: updateSupported ? {
    supported: true,
    status: () => ipcRenderer.invoke('desktop:update:status'),
    start: options => ipcRenderer.invoke('desktop:update:start', options || {}),
    // Subscribe to run snapshots; returns an unsubscribe function.
    onProgress: handler => {
      const listener = (_event, state) => handler(state);
      ipcRenderer.on('desktop:update:progress', listener);
      return () => ipcRenderer.removeListener('desktop:update:progress', listener);
    },
  } : null,
});
