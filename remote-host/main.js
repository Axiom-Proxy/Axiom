'use strict';
// Axiom Remote Desktop Windows host.

const { app, BrowserWindow, Tray, Menu, ipcMain, clipboard, nativeImage, dialog } =
  require('electron');
const path = require('path');

const CLIENT_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'app.asar.unpacked', 'client')
  : path.join(__dirname, 'client');
const { LightDeskClient, normalizeServerUrl } = require(path.join(CLIENT_DIR, 'core.js'));

// Keep the device ID and password in the user's app data when packaged.
const packaged = app.isPackaged;
const dataDir = packaged ? app.getPath('userData') : CLIENT_DIR;

let win = null;
let tray = null;
let client = null;
let quitting = false;
const logLines = [];

/* ------------------------------------------------------------------ */
/* Tray icon                                                           */
/* ------------------------------------------------------------------ */

/** A 32x32 BGRA disc, drawn in code so the app ships without image assets. */
function trayIcon() {
  const S = 32;
  const buf = Buffer.alloc(S * S * 4);
  const c = (S - 1) / 2;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const d = Math.hypot(x - c, y - c);
      const a = Math.max(0, Math.min(1, (S / 2 - 1.5 - d) * 1.4));
      const i = (y * S + x) * 4;
      buf[i] = 0xf0;                 // B
      buf[i + 1] = 0x8a;             // G
      buf[i + 2] = 0x5b;             // R  -> the UI's accent blue
      buf[i + 3] = Math.round(a * 255);
    }
  }
  return nativeImage.createFromBuffer(buf, { width: S, height: S });
}

function buildTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('Axiom Remote Desktop');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show Axiom', click: showWindow },
      { type: 'separator' },
      { label: 'Quit', click: () => { quitting = true; app.quit(); } },
    ])
  );
  tray.on('click', showWindow);
}

function showWindow() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/* ------------------------------------------------------------------ */
/* Window                                                              */
/* ------------------------------------------------------------------ */

function createWindow() {
  win = new BrowserWindow({
    width: 780,
    height: 720,
    minWidth: 460,
    minHeight: 560,
    show: false,
    backgroundColor: '#030303',
    autoHideMenuBar: true,
    title: 'Axiom Remote Desktop',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());

  // Closing the window leaves sharing running in the tray, which is what a host
  // app should do; Quit from the tray menu is the real exit.
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
    if (client && client.connection === 'online') {
      tray.displayBalloon?.({
        title: 'Axiom is still sharing',
        content: 'Quit from the tray icon to stop sharing this PC.',
      });
    }
  });

  win.on('closed', () => { win = null; });
}

function push(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/* ------------------------------------------------------------------ */
/* Client engine                                                       */
/* ------------------------------------------------------------------ */

function createClient() {
  client = new LightDeskClient({
    dataDir,
    srcFile: path.join(CLIENT_DIR, 'LightDeskHelper.cs'),
    binDir: path.join(CLIENT_DIR, 'bin'),
    bundledHelper: packaged,
  });

  client.on('status', (s) => push('status', s));
  client.on('error', (msg) => {
    addLog('! ' + msg);
    push('error', msg);
  });
  client.on('log', addLog);
}

function addLog(line) {
  const stamped = `${new Date().toTimeString().slice(0, 8)}  ${String(line).trim()}`;
  logLines.push(stamped);
  if (logLines.length > 200) logLines.shift();
  push('log', stamped);
}

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */

ipcMain.handle('status', () => ({ ...client.getStatus(), log: logLines }));

ipcMain.handle('start', () => {
  client.start();
  return client.getStatus();
});

ipcMain.handle('stop', () => {
  client.stop();
  return client.getStatus();
});

ipcMain.handle('newPassword', () => {
  addLog('  password regenerated - existing viewers will need the new one');
  return client.regeneratePassword();
});

ipcMain.handle('setServer', (_e, address) => {
  const value = String(address || '').trim();
  if (!value) throw new Error('Enter an Axiom link.');
  const url = new URL(normalizeServerUrl(value));
  // A domain is all a BYOD user needs to enter; the host knows this app's relay
  // endpoint. Keep an explicitly supplied socket path intact for advanced setups.
  if (url.pathname === '/' || url.pathname === '/ws') url.pathname = '/remote-desktop/ws';
  url.search = '';
  url.hash = '';
  if (url.protocol !== 'wss:' && !['localhost', '127.0.0.1'].includes(url.hostname)) {
    throw new Error('Use an HTTPS Axiom address.');
  }
  return client.setServerUrl(url.toString());
});

ipcMain.handle('copy', (_e, text) => {
  clipboard.writeText(String(text));
  return true;
});

/* ------------------------------------------------------------------ */

// A second launch should surface the running instance, not start a rival host.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(() => {
    if (process.platform !== 'win32') {
      dialog.showErrorBox(
        'Unsupported platform',
        'Axiom Remote Desktop is available on Windows.'
      );
      app.quit();
      return;
    }
    createClient();
    createWindow();
    buildTray();
    if (client.config.autoStart) client.start();
  });

  app.on('window-all-closed', () => { /* stay alive in the tray */ });
  app.on('before-quit', () => {
    quitting = true;
    if (client) client.stop();
  });
}
