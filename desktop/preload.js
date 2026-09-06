'use strict';

// Preload for the desktop shell. Runs sandboxed + contextIsolated over every
// page this window loads, but only the splash/error pages actually use it —
// the MultiCC web UI is untouched. The surface is four verbs and one getter;
// no fs/net/require is exposed to the renderer.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('multiccDesktop', {
  version: () => ipcRenderer.invoke('desktop:version'),
  retry: () => ipcRenderer.send('desktop:retry'),
  openLogs: () => ipcRenderer.send('desktop:open-logs'),
  openDataFolder: () => ipcRenderer.send('desktop:open-data'),
  quit: () => ipcRenderer.send('desktop:quit'),
});
