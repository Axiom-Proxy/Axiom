'use strict';
/**
 * Axiom Remote Desktop client engine.
 *
 * Capture, connection, and viewer input live here so the Electron window stays
 * a small front end over one host-side object.
 *
 * Events:
 *   log(line)                 human-readable progress
 *   status(status)            any change to the snapshot returned by getStatus()
 *   ready({id, pass, screen}) registered with a relay and the helper is up
 *   error(message)            something the user should see
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { spawn, spawnSync } = require('child_process');
const WebSocket = require('ws');

const DEFAULT_SRC = path.join(__dirname, 'LightDeskHelper.cs');

const MSG_INFO = 1, MSG_MEDIA = 2, MSG_ERROR = 3;

/* ------------------------------------------------------------------ */
/* Server URL handling                                                 */
/* ------------------------------------------------------------------ */

/**
 * Turn whatever the user typed into a relay WebSocket URL.
 * Accepts "example.com", "example.com:8080", "https://example.com",
 * "ws://example.com/ws" — all of which people reasonably expect to work.
 */
function normalizeServerUrl(input) {
  let s = String(input || '').trim();
  if (!s) throw new Error('Enter an Axiom address.');

  if (!/^[a-z]+:\/\//i.test(s)) s = 'ws://' + s;
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new Error(`"${input}" is not a valid Axiom address.`);
  }

  // https:// pages serve wss:// sockets; keep the security level the user asked
  // for rather than silently downgrading.
  if (u.protocol === 'https:') u.protocol = 'wss:';
  else if (u.protocol === 'http:') u.protocol = 'ws:';
  if (u.protocol !== 'ws:' && u.protocol !== 'wss:') {
    throw new Error('That address type is not supported.');
  }

  if (!u.hostname) throw new Error('That Axiom address is incomplete.');
  // The URL parser is lenient about what it accepts as a host, which would turn
  // a typo into an endless reconnect loop instead of an error the user can see.
  // Underscores are allowed because Windows machine names may contain them.
  if (!/^(\[[0-9a-f:.]+\]|[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?)*)$/i
    .test(u.hostname)) {
    throw new Error('That Axiom address is not valid.');
  }
  if (u.pathname === '' || u.pathname === '/') u.pathname = '/ws';
  u.search = '';
  u.hash = '';
  return u.toString();
}

/** The page a human should open, derived from the relay socket URL. */
function webUrlFor(serverUrl) {
  try {
    const u = new URL(serverUrl);
    u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
    u.pathname = '/remote-desktop.html';
    return u.toString().replace(/\/$/, '');
  } catch {
    return serverUrl;
  }
}

/* ------------------------------------------------------------------ */

class LightDeskClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} [opts.dataDir]   where device.json / config.json live
   * @param {string} [opts.serverUrl] overrides the saved server for this run
   * @param {string} [opts.password]  forces a specific password
   * @param {string} [opts.binDir]    where the compiled helper is written; must
   *                                  be writable, which an installed app's own
   *                                  directory generally is not
   */
  constructor(opts = {}) {
    super();
    this.dataDir = opts.dataDir || __dirname;
    this.deviceFile = path.join(this.dataDir, 'device.json');
    this.configFile = path.join(this.dataDir, 'config.json');
    this.srcFile = opts.srcFile || DEFAULT_SRC;
    this.binDir = opts.binDir || path.join(this.dataDir, 'bin');
    this.exeFile = path.join(this.binDir, 'LightDeskHelper.exe');
    this.bundledHelper = !!opts.bundledHelper;

    this.config = this._loadConfig();
    if (opts.serverUrl) this.config.server = normalizeServerUrl(opts.serverUrl);

    this.settings = {
      fps: Number(opts.fps || 20),
      quality: Number(opts.quality || 55),
      scale: Number(opts.scale || 1),
    };

    this.device = this._loadDevice(opts.password);

    this.ws = null;
    this.helper = null;
    this.helperReady = false;
    this.registered = false;
    this.connection = 'idle';     // idle | connecting | online | retrying | error
    this.lastError = null;
    this.screen = { w: 0, h: 0 };
    this.viewerCount = 0;
    this.audioViewers = new Set();
    this.audioOn = false;
    this.framesSent = 0;
    this.bytesSent = 0;
    this.rateFps = 0;
    this.rateKbps = 0;
    this.retry = 0;
    this.stopping = false;
    this._readyEmitted = false;
    this._retryTimer = null;
    this._rateTimer = null;
  }

  /* ---------------------------------------------------------- config -- */

  _loadConfig() {
    let cfg = {};
    try {
      cfg = JSON.parse(fs.readFileSync(this.configFile, 'utf8'));
    } catch {
      /* first run */
    }
    const defaultServer = require('./default-server.json').server;
    try {
      cfg.server = cfg.server ? normalizeServerUrl(cfg.server) : (defaultServer ? normalizeServerUrl(defaultServer) : '');
    } catch {
      cfg.server = '';
    }
    // A generic build has no relay until its owner supplies one. Do not start a
    // failing connection loop before they have had a chance to do that.
    if (typeof cfg.autoStart !== 'boolean') cfg.autoStart = Boolean(cfg.server);
    return cfg;
  }

  _saveConfig() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(this.configFile, JSON.stringify(this.config, null, 2));
    } catch (e) {
      this.emit('log', `! could not save config: ${e.message}`);
    }
  }

  /** Device identity persists across restarts so the ID stays stable. */
  _loadDevice(forcedPass) {
    let dev = {};
    try {
      dev = JSON.parse(fs.readFileSync(this.deviceFile, 'utf8'));
    } catch {
      /* first run */
    }
    if (!/^\d{9}$/.test(dev.id || '')) {
      dev.id = String(crypto.randomInt(100000000, 1000000000));
    }
    if (forcedPass) dev.pass = forcedPass;
    if (!dev.pass) dev.pass = LightDeskClient.newPassword();
    this._writeDevice(dev);
    return dev;
  }

  _writeDevice(dev) {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(this.deviceFile, JSON.stringify(dev, null, 2));
    } catch (e) {
      this.emit('log', `! could not persist device.json: ${e.message}`);
    }
  }

  /** Ambiguous characters removed so the password is easy to read aloud. */
  static newPassword() {
    const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
    return Array.from(crypto.randomFillSync(new Uint8Array(8)))
      .map((b) => alphabet[b % alphabet.length])
      .join('');
  }

  /* ---------------------------------------------------- public API -- */

  getStatus() {
    return {
      connection: this.connection,
      lastError: this.lastError,
      server: this.config.server,
      webUrl: webUrlFor(this.config.server),
      id: this.device.id,
      prettyId: LightDeskClient.prettyId(this.device.id),
      pass: this.device.pass,
      screen: { ...this.screen },
      viewers: this.viewerCount,
      audio: this.audioOn,
      helperReady: this.helperReady,
      fps: this.rateFps,
      kbps: this.rateKbps,
      settings: { ...this.settings },
    };
  }

  static prettyId(id) {
    return `${id.slice(0, 3)} ${id.slice(3, 6)} ${id.slice(6)}`;
  }

  /** Change relays without restarting: drop the socket and reconnect. */
  setServerUrl(url) {
    const normalized = normalizeServerUrl(url);
    if (normalized === this.config.server) return normalized;
    this.config.server = normalized;
    this._saveConfig();
    this.emit('log', `  switching relay -> ${normalized}`);
    if (this.connection !== 'idle') this._reconnect();
    this._emitStatus();
    return normalized;
  }

  /** Drop the current relay socket and dial again from scratch. */
  _reconnect() {
    this.registered = false;
    this.viewerCount = 0;
    this.audioViewers.clear();
    this._applySettings();
    if (this.ws) {
      const old = this.ws;
      this.ws = null;
      old.removeAllListeners();
      old.on('error', () => {});
      try { old.close(); } catch { /* already gone */ }
    }
    clearTimeout(this._retryTimer);
    this.retry = 0;
    if (!this.stopping) this._connect();
  }

  regeneratePassword() {
    this.device.pass = LightDeskClient.newPassword();
    this._writeDevice(this.device);
    // The relay only reads the password at registration time, so the socket has
    // to be recycled for the old one to stop working.
    this._reconnect();
    this._emitStatus();
    return this.device.pass;
  }

  start() {
    if (!this.config.server) {
      const msg = 'Enter your Axiom address before sharing.';
      this.lastError = msg;
      this.connection = 'error';
      this.emit('error', msg);
      this._emitStatus();
      return false;
    }
    if (process.platform !== 'win32') {
      const msg = 'Axiom Remote Desktop is available on Windows.';
      this.lastError = msg;
      this.connection = 'error';
      this.emit('error', msg);
      this._emitStatus();
      return false;
    }
    const built = this.buildHelper();
    if (built !== true) {
      this.lastError = built;
      this.connection = 'error';
      this.emit('error', built);
      this._emitStatus();
      return false;
    }
    this.stopping = false;
    this._readyEmitted = false;
    this.helper = this._spawnHelper();
    this._connect();
    this._startRateTimer();
    return true;
  }

  stop() {
    if (this.stopping) return;
    this.stopping = true;
    clearTimeout(this._retryTimer);
    clearInterval(this._rateTimer);
    this._helperSend('q');
    if (this.ws) {
      try { this.ws.close(); } catch { /* already gone */ }
    }
    const child = this.helper;
    this.helper = null;
    this.helperReady = false;
    this.viewerCount = 0;
    this.registered = false;
    this.audioViewers.clear();
    this.audioOn = false;
    setTimeout(() => { if (child) child.kill(); }, 300);
    this.connection = 'idle';
    this._emitStatus();
  }

  /* ------------------------------------------------------- helper -- */

  static findCsc() {
    const root = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET');
    for (const arch of ['Framework64', 'Framework']) {
      const dir = path.join(root, arch);
      let versions = [];
      try {
        versions = fs.readdirSync(dir).filter((v) => v.startsWith('v4.')).sort().reverse();
      } catch {
        continue;
      }
      for (const v of versions) {
        const csc = path.join(dir, v, 'csc.exe');
        if (fs.existsSync(csc)) return csc;
      }
    }
    return null;
  }

  /** Compile the helper if it is missing or the source is newer. @returns true|string */
  buildHelper() {
    if (this.bundledHelper) {
      return fs.existsSync(this.exeFile) ? true : 'The screen capture component is missing.';
    }
    let needs = true;
    try {
      needs = fs.statSync(this.srcFile).mtimeMs > fs.statSync(this.exeFile).mtimeMs;
    } catch {
      needs = true;
    }
    if (!needs) return true;

    const csc = LightDeskClient.findCsc();
    if (!csc) return 'A required Windows component is unavailable.';

    fs.mkdirSync(this.binDir, { recursive: true });
    this.emit('log', '  building capture helper (first run only)...');

    const r = spawnSync(
      csc,
      [
        '/nologo', '/target:exe', '/platform:anycpu', '/optimize+', '/unsafe+',
        '/r:System.Drawing.dll', '/r:System.Windows.Forms.dll',
        `/out:${this.exeFile}`, this.srcFile,
      ],
      { encoding: 'utf8' }
    );

    if (r.status !== 0 || !fs.existsSync(this.exeFile)) {
      return 'A required Windows component could not be prepared.';
    }
    this.emit('log', '  helper built -> ' + this.exeFile);
    return true;
  }

  _spawnHelper() {
    const child = spawn(this.exeFile, [], { stdio: ['pipe', 'pipe', 'pipe'] });

    let buf = Buffer.alloc(0);
    child.stdout.on('data', (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      // Messages are [int32 len][byte type][payload]; a chunk may hold part of
      // one message or several, so drain everything that is complete.
      for (;;) {
        if (buf.length < 5) break;
        const len = buf.readInt32LE(0);
        if (len < 0 || len > 64 * 1024 * 1024) { buf = Buffer.alloc(0); break; }
        if (buf.length < 5 + len) break;
        const type = buf[4];
        const payload = buf.subarray(5, 5 + len);
        this._onHelperMessage(type, payload);
        buf = buf.subarray(5 + len);
      }
    });

    child.stderr.on('data', (d) => {
      const s = d.toString().trim();
      if (s) this.emit('log', '[helper] ' + s.split('\n')[0]);
    });

    child.on('exit', (code) => {
      // A helper we already replaced (stop/start cycle) must not resurrect itself.
      if (this.helper !== child) return;
      this.helperReady = false;
      this._emitStatus();
      if (this.stopping) return;
      this.emit('log', `! helper exited (code ${code}); restarting in 2s`);
      setTimeout(() => {
        if (!this.stopping) this.helper = this._spawnHelper();
      }, 2000);
    });

    child.on('error', () => this.emit('error', 'Screen sharing could not start.'));

    return child;
  }

  _onHelperMessage(type, payload) {
    if (type === MSG_MEDIA) {
      this._sendMedia(payload);
      this.framesSent += payload[0] === 1 ? 1 : 0;
      this.bytesSent += payload.length;
      return;
    }
    if (type === MSG_INFO) {
      this.screen = { w: payload.readInt32LE(0), h: payload.readInt32LE(4) };
      this.helperReady = true;
      this._applySettings();
      this._wsSend({ t: 'host:info', info: { ...this.screen } });
      this._maybeReady();
      this._emitStatus();
      return;
    }
    if (type === MSG_ERROR) {
      const msg = payload.toString('utf8');
      this.emit('log', '[helper] ' + msg);
      // Audio is optional; a machine with no playback device should not look broken.
      if (msg.startsWith('audio:')) {
        this.audioViewers.clear();
        this.audioOn = false;
        this._emitStatus();
      }
    }
  }

  _helperSend(cmd) {
    if (this.helper && this.helper.stdin.writable) this.helper.stdin.write(cmd + '\n');
  }

  /* -------------------------------------------------------- relay -- */

  _wsSend(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  _sendMedia(buf) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    // Never queue more than a couple of frames - stale frames are worse than
    // dropped ones on a slow link.
    if (this.ws.bufferedAmount > 2 * 1024 * 1024) return;
    this.ws.send(buf, { binary: true });
  }

  _connect() {
    if (this.stopping) return;
    this.connection = this.retry > 0 ? 'retrying' : 'connecting';
    this._emitStatus();

    let ws;
    try {
      ws = new WebSocket(this.config.server);
    } catch (e) {
      this.lastError = e.message;
      this.connection = 'error';
      this._emitStatus();
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      if (this.ws !== ws) return;
      this.retry = 0;
      this.lastError = null;
      this._reregister();
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary || this.ws !== ws) return;
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      this._handleServerMessage(msg);
    });

    ws.on('close', () => {
      if (this.ws !== ws || this.stopping) return;
      this.registered = false;
      this.viewerCount = 0;
      this.audioViewers.clear();
      this._applySettings();
      const delay = Math.min(15000, 1000 * 2 ** this.retry++);
      this.connection = 'retrying';
      this.emit('log', `  disconnected from relay - retrying in ${Math.round(delay / 1000)}s`);
      this._emitStatus();
      this._retryTimer = setTimeout(() => this._connect(), delay);
    });

    ws.on('error', (e) => {
      if (this.ws !== ws) return;
      this.lastError = e.message;
      if (this.retry === 0) this.emit('log', `! relay error: ${e.message}`);
      this._emitStatus();
    });
  }

  _reregister() {
    this._wsSend({
      t: 'host:register',
      id: this.device.id,
      pass: this.device.pass,
      info: {
        name: os.hostname(),
        os: `${os.type()} ${os.release()}`,
        w: this.screen.w,
        h: this.screen.h,
        audio: true,
      },
    });
  }

  _handleServerMessage(msg) {
    switch (msg.t) {
      case 'host:registered':
        if (msg.id !== this.device.id) {
          this.device.id = msg.id;
          this._writeDevice(this.device);
        }
        this.registered = true;
        this.connection = 'online';
        this._maybeReady();
        this._emitStatus();
        break;

      case 'host:error':
        this.lastError = msg.msg;
        this.emit('error', 'Axiom could not start sharing: ' + msg.msg);
        this._emitStatus();
        break;

      case 'viewer:join':
        this.viewerCount = msg.count;
        this.emit('log', `  + viewer connected (${this.viewerCount} watching)`);
        this._applySettings();
        this._helperSend('key');
        this._emitStatus();
        break;

      case 'viewer:left':
        this.viewerCount = msg.count;
        if (msg.vid) this.audioViewers.delete(msg.vid);
        this.emit('log', `  - viewer left (${this.viewerCount} watching)`);
        this._applySettings();
        this._emitStatus();
        break;

      case 'input':
        this._applyInput(msg.d);
        break;

      case 'ctl':
        this._handleControl(msg);
        break;
    }
  }

  /** Translate the viewer's JSON events into the helper's line protocol. */
  _applyInput(d) {
    if (!d || typeof d !== 'object') return;
    const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

    switch (d.t) {
      case 'm':  this._helperSend(`m ${n(d.x).toFixed(5)} ${n(d.y).toFixed(5)}`); break;
      case 'md': this._helperSend(`md ${n(d.b) | 0}`); break;
      case 'mu': this._helperSend(`mu ${n(d.b) | 0}`); break;
      case 'w':  this._helperSend(`w ${n(d.d) | 0} ${d.h === 1 ? 1 : 0}`); break;
      case 'kd': this._helperSend(`kd ${n(d.c) | 0}`); break;
      case 'ku': this._helperSend(`ku ${n(d.c) | 0}`); break;
    }
  }

  _handleControl(msg) {
    switch (msg.a) {
      case 'ping':
        // Round-trips all the way to the host so the UI measures real latency.
        this._wsSend({ t: 'ctlback', a: 'pong', ts: msg.ts, vid: msg.vid });
        break;

      case 'quality':
        if (Number.isFinite(msg.quality)) this.settings.quality = clamp(msg.quality, 10, 95);
        if (Number.isFinite(msg.fps)) this.settings.fps = clamp(msg.fps, 1, 60);
        if (Number.isFinite(msg.scale)) this.settings.scale = clamp(msg.scale, 0.25, 1);
        this._applySettings();
        this._emitStatus();
        break;

      case 'keyframe':
        this._helperSend('key');
        break;

      case 'audio': {
        // Capture runs while at least one viewer wants sound.
        const vid = msg.vid || 'anon';
        if (msg.on) this.audioViewers.add(vid);
        else this.audioViewers.delete(vid);
        this._applySettings();
        this._wsSend({ t: 'ctlback', a: 'audio', on: this.audioOn, vid: msg.vid });
        this._emitStatus();
        break;
      }

      case 'text':
        if (typeof msg.s === 'string' && msg.s.length) {
          this._helperSend('txt ' + Buffer.from(msg.s.slice(0, 4096), 'utf8').toString('base64'));
        }
        break;
    }
  }

  /** Capture only runs while somebody is actually watching. */
  _applySettings() {
    if (!this.helperReady) return;
    const fps = this.viewerCount > 0 ? this.settings.fps : 0;
    this._helperSend(`cfg ${fps} ${this.settings.quality} ${this.settings.scale}`);

    const wantAudio = this.viewerCount > 0 && this.audioViewers.size > 0;
    if (wantAudio !== this.audioOn) {
      this.audioOn = wantAudio;
      this._helperSend(`aud ${wantAudio ? 1 : 0}`);
      this.emit('log', `  audio ${wantAudio ? 'on' : 'off'}`);
    }
  }

  /* --------------------------------------------------------- misc -- */

  /** "Ready" needs both the relay-assigned ID and the helper's screen size. */
  _maybeReady() {
    if (this._readyEmitted || !this.registered || !this.helperReady) return;
    this._readyEmitted = true;
    this.emit('ready', this.getStatus());
  }

  _emitStatus() {
    this.emit('status', this.getStatus());
  }

  _startRateTimer() {
    clearInterval(this._rateTimer);
    this._rateTimer = setInterval(() => {
      this.rateFps = Number((this.framesSent / 2).toFixed(1));
      this.rateKbps = Math.round((this.bytesSent * 8) / 1000 / 2);
      this.framesSent = 0;
      this.bytesSent = 0;
      if (this.viewerCount > 0) this._emitStatus();
    }, 2000);
    this._rateTimer.unref?.();
  }
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, Number(n)));
}

module.exports = { LightDeskClient, normalizeServerUrl, webUrlFor };
