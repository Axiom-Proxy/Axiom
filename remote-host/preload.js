'use strict';
/**
 * The only bridge between the renderer and Node. The window gets a small, fixed
 * set of verbs; it never sees ipcRenderer, fs or the client object itself.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lightdesk', {
  getStatus: () => ipcRenderer.invoke('status'),
  start: () => ipcRenderer.invoke('start'),
  stop: () => ipcRenderer.invoke('stop'),
  newPassword: () => ipcRenderer.invoke('newPassword'),
  setServer: (address) => ipcRenderer.invoke('setServer', address),
  copy: (text) => ipcRenderer.invoke('copy', text),

  onStatus: (cb) => ipcRenderer.on('status', (_e, s) => cb(s)),
  onLog: (cb) => ipcRenderer.on('log', (_e, line) => cb(line)),
  onError: (cb) => ipcRenderer.on('error', (_e, msg) => cb(msg)),
});
