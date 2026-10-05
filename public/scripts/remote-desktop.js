'use strict';
/* Axiom remote desktop viewer. */

const $ = (id) => document.getElementById(id);

const el = {
  connectScreen: $('connect-screen'),
  sessionScreen: $('session-screen'),
  form: $('connect-form'),
  idInput: $('id-input'),
  passInput: $('pass-input'),
  pwToggle: $('pw-toggle'),
  connectBtn: $('connect-btn'),
  error: $('connect-error'),
  serverStatus: $('server-status'),
  recentWrap: $('recent-wrap'),
  recentList: $('recent-list'),

  toolbar: $('toolbar'),
  tbTitle: $('tb-title'),
  stats: $('stats'),
  stage: $('stage'),
  canvas: $('screen-canvas'),
  overlay: $('stage-overlay'),
  overlayText: $('overlay-text'),
  toast: $('toast'),

  btnDisconnect: $('btn-disconnect'),
  btnAudio: $('btn-audio'),
  btnKeyboard: $('btn-keyboard'),
  btnTaskmgr: $('btn-taskmgr'),
  btnSettings: $('btn-settings'),
  btnFullscreen: $('btn-fullscreen'),

  settingsPanel: $('settings-panel'),
  textPanel: $('text-panel'),
  textInput: $('text-input'),
  textSend: $('text-send'),
  fpsRange: $('fps-range'),
  qRange: $('q-range'),
  sRange: $('s-range'),
  fpsVal: $('fps-val'),
  qVal: $('q-val'),
  sVal: $('s-val'),
};

const ctx = el.canvas.getContext('2d', { alpha: false, desynchronized: true });

const state = {
  ws: null,
  connected: false,       // authenticated against a host
  probing: true,          // pre-session socket used to show relay status
  hostInfo: null,
  cursor: { x: 0, y: 0 },
  lastFrameAt: 0,
  fpsSamples: [],
  latency: null,
  pressedKeys: new Set(),
  pendingBitmap: false,
  bytesWindow: 0,
  audioWanted: false,
  session: 0,
};

const CH_VIDEO = 1, CH_AUDIO = 2;

/* ── Small helpers ──────────────────────────────────────────────────────── */

function toast(msg, ms = 1800) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.toast.hidden = true; }, ms);
}

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/remote-desktop/ws`;
}

function send(obj) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(obj));
}

/** All input events share one envelope so the relay can forward them blindly. */
function sendInput(d) {
  if (state.connected) send({ t: 'input', d });
}

function prettyId(id) {
  return `${id.slice(0, 3)} ${id.slice(3, 6)} ${id.slice(6)}`;
}

/* ── Relay status probe (before a session starts) ───────────────────────── */

function probeRelay() {
  const probe = new WebSocket(wsUrl());
  probe.onopen = () => {
    el.serverStatus.className = 'dot-status online';
    el.serverStatus.innerHTML = '<i class="dot"></i> online';
    probe.close();
  };
  probe.onerror = () => {
    el.serverStatus.className = 'dot-status offline';
    el.serverStatus.innerHTML = '<i class="dot"></i> unavailable';
  };
}

/* ── Recent devices (localStorage) ──────────────────────────────────────── */

const RECENT_KEY = 'axiom.remote.recent';

function getRecent() {
  try {
    return (JSON.parse(localStorage.getItem(RECENT_KEY)) || [])
      .filter((r) => /^\d{9}$/.test(r.id) && Number.isFinite(r.at));
  } catch { return []; }
}

function rememberDevice(id) {
  const list = getRecent().filter((r) => r.id !== id);
  list.unshift({ id, at: Date.now() });
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 5))); } catch {}
}

function renderRecent() {
  const list = getRecent();
  el.recentWrap.hidden = list.length === 0;
  el.recentList.innerHTML = '';
  for (const r of list) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.innerHTML =
      `<span class="rid">${prettyId(r.id)}</span><span class="rwhen">${timeAgo(r.at)}</span>`;
    btn.onclick = () => {
      el.idInput.value = prettyId(r.id);
      el.passInput.focus();
    };
    li.appendChild(btn);
    el.recentList.appendChild(li);
  }
}

function timeAgo(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/* ── Connect flow ───────────────────────────────────────────────────────── */

// Auto-format the ID field as "123 456 789" while preserving caret sanity.
el.idInput.addEventListener('input', () => {
  const digits = el.idInput.value.replace(/\D/g, '').slice(0, 9);
  const atEnd = el.idInput.selectionStart === el.idInput.value.length;
  el.idInput.value = digits.replace(/(\d{3})(?=\d)/g, '$1 ').trim();
  if (atEnd) el.idInput.setSelectionRange(el.idInput.value.length, el.idInput.value.length);
});

el.pwToggle.addEventListener('click', () => {
  const showing = el.passInput.type === 'password';
  el.passInput.type = showing ? 'text' : 'password';
  el.pwToggle.title = showing ? 'Hide password' : 'Show password';
  el.pwToggle.setAttribute('aria-label', el.pwToggle.title);
  el.pwToggle.querySelector('.material-symbols-outlined').textContent = showing ? 'visibility_off' : 'visibility';
});

el.form.addEventListener('submit', (e) => {
  e.preventDefault();
  const id = el.idInput.value.replace(/\D/g, '');
  const pass = el.passInput.value;
  if (id.length !== 9) return showError('A device ID is 9 digits.');
  showError(null);
  el.connectBtn.disabled = true;
  el.connectBtn.querySelector('.btn-label').textContent = 'Connecting…';
  openSession(id, pass);
});

function showError(msg) {
  el.error.hidden = !msg;
  el.error.textContent = msg || '';
  if (msg) {
    el.connectBtn.disabled = false;
    el.connectBtn.querySelector('.btn-label').textContent = 'Connect';
  }
}

function openSession(id, pass) {
  state.session += 1;
  const ws = new WebSocket(wsUrl());
  ws.binaryType = 'arraybuffer';
  state.ws = ws;

  ws.onopen = () => send({ t: 'view:connect', id, pass });

  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') {
      onMedia(ev.data);
      return;
    }
    const msg = JSON.parse(ev.data);
    switch (msg.t) {
      case 'view:connected':
        state.connected = true;
        state.hostInfo = msg.info || {};
        rememberDevice(id);
        enterSession(id);
        break;
      case 'view:info':
        state.hostInfo = { ...state.hostInfo, ...msg.info };
        break;
      case 'view:error':
        showError(msg.msg);
        ws.close();
        break;
      case 'host:gone':
        endSession(msg.msg || 'The remote device went offline.');
        break;
      case 'ctlback':
        if (msg.a === 'pong') state.latency = Math.round(performance.now() - msg.ts);
        if (msg.a === 'audio' && !msg.on && state.audioWanted) {
          // The host could not open a playback device to listen in on.
          setAudio(false);
          toast('The remote PC has no audio to share');
        }
        break;
    }
  };

  ws.onclose = () => {
    if (state.connected) endSession('Connection closed.');
    else showError((el.error.textContent) || 'Could not connect.');
  };

  ws.onerror = () => {
    if (!state.connected) showError('Could not connect.');
  };
}

function enterSession(id) {
  el.connectScreen.hidden = true;
  el.sessionScreen.hidden = false;
  el.connectBtn.disabled = false;
  el.connectBtn.querySelector('.btn-label').textContent = 'Connect';

  const info = state.hostInfo || {};
  el.tbTitle.textContent = `${info.name || prettyId(id)} · ${info.w || '?'}×${info.h || '?'}`;
  el.overlay.hidden = false;
  el.overlayText.textContent = 'Waiting for the first frame…';

  el.stage.focus();
  pushQuality();
  startPing();
}

function endSession(reason) {
  if (state.audioWanted) setAudio(false);
  state.connected = false;
  haveFrame = false;
  state.pendingBitmap = false;
  if (lastBmp) { lastBmp.close(); lastBmp = null; }
  stopPing();
  releaseAllKeys();
  if (state.ws) { state.ws.onclose = null; state.ws.close(); state.ws = null; }
  el.sessionScreen.hidden = true;
  el.connectScreen.hidden = false;
  el.settingsPanel.hidden = true;
  el.textPanel.hidden = true;
  renderRecent();
  if (reason) showError(reason);
}

el.btnDisconnect.addEventListener('click', () => endSession(null));

/* ── Frame rendering ────────────────────────────────────────────────────── */

// Last decoded frame, kept as an ImageBitmap so a cursor-only update can be
// recomposed without waiting for the host to send fresh pixels. Keeping the
// bitmap (instead of blitting through an intermediate canvas) means a full
// frame is a single canvas draw rather than two.
let lastBmp = null;
let haveFrame = false;

/** Every binary message starts with a channel byte: 1 = video, 2 = audio. */
function onMedia(buf) {
  state.bytesWindow += buf.byteLength;
  const ch = new Uint8Array(buf, 0, 1)[0];
  if (ch === CH_VIDEO) onFrame(buf);
  else if (ch === CH_AUDIO) onAudio(buf);
}

function onFrame(buf) {
  const view = new DataView(buf);
  state.cursor.x = view.getUint16(1, true) / 65535;
  state.cursor.y = view.getUint16(3, true) / 65535;

  // A header-only message is a cursor move with no pixel changes behind it.
  if (buf.byteLength === 9) {
    if (haveFrame) compose();
    return;
  }

  // Track render fps over a 1s sliding window.
  const now = performance.now();
  state.fpsSamples.push(now);
  while (state.fpsSamples.length && now - state.fpsSamples[0] > 1000) state.fpsSamples.shift();

  // If decoding is still behind, skip this frame rather than growing a backlog.
  if (state.pendingBitmap) return;
  state.pendingBitmap = true;

  const sid = state.session;
  const blob = new Blob([new Uint8Array(buf, 9)], { type: 'image/jpeg' });
  createImageBitmap(blob)
    .then((bmp) => {
      state.pendingBitmap = false;
      if (!state.connected || state.session !== sid) { bmp.close(); return; }
      draw(bmp);
    })
    .catch(() => { state.pendingBitmap = false; });
}

function draw(bmp) {
  if (el.canvas.width !== bmp.width || el.canvas.height !== bmp.height) {
    el.canvas.width = bmp.width;
    el.canvas.height = bmp.height;
  }
  if (lastBmp) lastBmp.close();
  lastBmp = bmp;
  haveFrame = true;
  compose();
  if (!el.overlay.hidden) el.overlay.hidden = true;
}

function compose() {
  if (!haveFrame || !lastBmp) return;
  ctx.drawImage(lastBmp, 0, 0);
  drawCursor();
}

/** The host's real pointer, painted client-side so it stays crisp at any scale. */
function drawCursor() {
  const x = state.cursor.x * el.canvas.width;
  const y = state.cursor.y * el.canvas.height;
  const s = Math.max(14, el.canvas.width / 90);

  ctx.save();
  ctx.translate(x, y);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, s);
  ctx.lineTo(s * 0.28, s * 0.76);
  ctx.lineTo(s * 0.46, s * 1.12);
  ctx.lineTo(s * 0.62, s * 1.04);
  ctx.lineTo(s * 0.44, s * 0.68);
  ctx.lineTo(s * 0.72, s * 0.64);
  ctx.closePath();
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#000';
  ctx.lineWidth = Math.max(1, s / 14);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

/* ── Audio playback ─────────────────────────────────────────────────────── */

/**
 * The host sends mono 16-bit PCM in ~10ms packets and stays completely silent
 * when nothing is playing. Packets are queued onto a playhead that runs a small
 * distance ahead of the clock; any gap (silence, a stall) resets it rather than
 * letting the stream drift further and further behind.
 */
const audio = {
  ctx: null,
  playhead: 0,
  LEAD: 0.12,      // seconds of buffer we aim to stay ahead by
  MAX_LAG: 0.6,    // beyond this we resync instead of queueing more
};

function onAudio(buf) {
  if (!state.audioWanted || !audio.ctx || audio.ctx.state !== 'running') return;

  const view = new DataView(buf);
  const rate = view.getUint32(1, true);
  const channels = view.getUint8(5) || 1;
  const samples = (buf.byteLength - 7) / 2;
  if (!rate || samples < 1) return;

  const pcm = new Int16Array(buf.slice(7));
  const frames = Math.floor(samples / channels);
  const ab = audio.ctx.createBuffer(channels, frames, rate);
  for (let c = 0; c < channels; c++) {
    const out = ab.getChannelData(c);
    for (let i = 0; i < frames; i++) out[i] = pcm[i * channels + c] / 32768;
  }

  const now = audio.ctx.currentTime;
  // A fresh start, a gap in the sound, or a backlog all mean "start over here".
  if (audio.playhead < now + 0.01 || audio.playhead > now + audio.MAX_LAG) {
    audio.playhead = now + audio.LEAD;
  }

  const src = audio.ctx.createBufferSource();
  src.buffer = ab;
  src.connect(audio.ctx.destination);
  src.start(audio.playhead);
  audio.playhead += ab.duration;
}

/** Toggling requires a user gesture the first time, which the click provides. */
function setAudio(on) {
  state.audioWanted = on;
  el.btnAudio.classList.toggle('active', on);
  el.btnAudio.setAttribute('aria-pressed', String(on));
  el.btnAudio.querySelector('.ico-audio-on').hidden = !on;
  el.btnAudio.querySelector('.ico-audio-off').hidden = on;

  if (on) {
    if (!audio.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      audio.ctx = new AC();
    }
    audio.ctx.resume().catch(() => toast('The browser blocked audio playback'));
    audio.playhead = 0;
  }
  send({ t: 'ctl', a: 'audio', on });
}

el.btnAudio.addEventListener('click', () => {
  const on = !state.audioWanted;
  setAudio(on);
  toast(on ? 'Listening to the remote PC' : 'Sound off');
});

/* ── Stats + latency ────────────────────────────────────────────────────── */

let pingTimer = null;
function startPing() {
  stopPing();
  pingTimer = setInterval(() => {
    if (state.connected) send({ t: 'ctl', a: 'ping', ts: performance.now() });
  }, 2000);
}
function stopPing() {
  clearInterval(pingTimer);
  pingTimer = null;
}

setInterval(() => {
  if (!state.connected) return;
  const fps = state.fpsSamples.length;
  const kbps = Math.round((state.bytesWindow * 8) / 1000);
  state.bytesWindow = 0;
  const lat = state.latency == null ? '—' : state.latency;
  el.stats.textContent = `${fps} fps · ${lat} ms · ${kbps} kbps`;
}, 1000);

/* ── Mouse input ────────────────────────────────────────────────────────── */

/** Canvas is letterboxed by max-width/max-height, so its rect is the picture. */
function normFromEvent(e) {
  const r = el.canvas.getBoundingClientRect();
  return {
    x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
    y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
  };
}

let lastMoveSent = 0;
el.canvas.addEventListener('mousemove', (e) => {
  const now = performance.now();
  if (now - lastMoveSent < 16) return;   // cap at ~60 moves/s
  lastMoveSent = now;
  const p = normFromEvent(e);
  sendInput({ t: 'm', x: p.x, y: p.y });
});

el.canvas.addEventListener('mousedown', (e) => {
  e.preventDefault();
  el.stage.focus();
  const p = normFromEvent(e);
  sendInput({ t: 'm', x: p.x, y: p.y });
  sendInput({ t: 'md', b: btnIndex(e.button) });
});

// Listen on window for mouseup so a drag released outside the canvas still lifts.
window.addEventListener('mouseup', (e) => {
  if (!state.connected) return;
  sendInput({ t: 'mu', b: btnIndex(e.button) });
});

function btnIndex(b) {
  return b === 1 ? 2 : b === 2 ? 1 : 0;   // DOM middle=1/right=2 -> helper right=1/middle=2
}

el.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

el.canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const dir = e.deltaY > 0 ? -120 : 120;   // Windows WHEEL_DELTA, inverted sign
  sendInput({ t: 'w', d: dir, h: 0 });
  if (Math.abs(e.deltaX) > 2) {
    sendInput({ t: 'w', d: e.deltaX > 0 ? 120 : -120, h: 1 });
  }
}, { passive: false });

/* ── Keyboard input ─────────────────────────────────────────────────────── */

const CODE_VK = {
  Escape: 0x1B, Backspace: 0x08, Tab: 0x09, Enter: 0x0D, Space: 0x20,
  CapsLock: 0x14, NumLock: 0x90, ScrollLock: 0x91, Pause: 0x13, PrintScreen: 0x2C,
  ShiftLeft: 0xA0, ShiftRight: 0xA1, ControlLeft: 0xA2, ControlRight: 0xA3,
  AltLeft: 0xA4, AltRight: 0xA5, MetaLeft: 0x5B, MetaRight: 0x5C, ContextMenu: 0x5D,
  ArrowUp: 0x26, ArrowDown: 0x28, ArrowLeft: 0x25, ArrowRight: 0x27,
  Insert: 0x2D, Delete: 0x2E, Home: 0x24, End: 0x23, PageUp: 0x21, PageDown: 0x22,
  Minus: 0xBD, Equal: 0xBB, BracketLeft: 0xDB, BracketRight: 0xDD, Backslash: 0xDC,
  Semicolon: 0xBA, Quote: 0xDE, Backquote: 0xC0, Comma: 0xBC, Period: 0xBE, Slash: 0xBF,
  NumpadDivide: 0x6F, NumpadMultiply: 0x6A, NumpadSubtract: 0x6D,
  NumpadAdd: 0x6B, NumpadDecimal: 0x6E, NumpadEnter: 0x0D,
};
for (let i = 0; i <= 9; i++) {
  CODE_VK[`Digit${i}`] = 0x30 + i;
  CODE_VK[`Numpad${i}`] = 0x60 + i;
}
for (let i = 0; i < 26; i++) CODE_VK[`Key${String.fromCharCode(65 + i)}`] = 0x41 + i;
for (let i = 1; i <= 12; i++) CODE_VK[`F${i}`] = 0x6F + i;

function vkFor(e) {
  if (CODE_VK[e.code] !== undefined) return CODE_VK[e.code];
  // Fallback for layouts where `code` is unknown but the key is a plain letter/digit.
  if (/^[a-zA-Z0-9]$/.test(e.key)) return e.key.toUpperCase().charCodeAt(0);
  return null;
}

el.stage.addEventListener('keydown', (e) => {
  if (!state.connected) return;
  const vk = vkFor(e);
  if (vk === null) return;
  e.preventDefault();
  state.pressedKeys.add(vk);
  sendInput({ t: 'kd', c: vk });
});

el.stage.addEventListener('keyup', (e) => {
  if (!state.connected) return;
  const vk = vkFor(e);
  if (vk === null) return;
  e.preventDefault();
  state.pressedKeys.delete(vk);
  sendInput({ t: 'ku', c: vk });
});

/** Losing focus mid-chord would otherwise leave Ctrl/Alt stuck down remotely. */
function releaseAllKeys() {
  for (const vk of state.pressedKeys) sendInput({ t: 'ku', c: vk });
  state.pressedKeys.clear();
}
el.stage.addEventListener('blur', releaseAllKeys);
window.addEventListener('blur', releaseAllKeys);

/* ── Toolbar actions ────────────────────────────────────────────────────── */

function togglePanel(panel) {
  const opening = panel.hidden;
  el.settingsPanel.hidden = true;
  el.textPanel.hidden = true;
  panel.hidden = !opening;
  el.btnSettings.classList.toggle('active', !el.settingsPanel.hidden);
  el.btnKeyboard.classList.toggle('active', !el.textPanel.hidden);
  if (opening && panel === el.textPanel) el.textInput.focus();
}

el.btnSettings.addEventListener('click', () => togglePanel(el.settingsPanel));
el.btnKeyboard.addEventListener('click', () => togglePanel(el.textPanel));

el.btnTaskmgr.addEventListener('click', () => {
  // Ctrl+Alt+Del is a secure-attention sequence and cannot be injected; this is
  // the closest usable equivalent.
  sendInput({ t: 'kd', c: 0xA2 });
  sendInput({ t: 'kd', c: 0xA0 });
  sendInput({ t: 'kd', c: 0x1B });
  sendInput({ t: 'ku', c: 0x1B });
  sendInput({ t: 'ku', c: 0xA0 });
  sendInput({ t: 'ku', c: 0xA2 });
  toast('Sent Ctrl + Shift + Esc');
});

el.btnFullscreen.addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else el.sessionScreen.requestFullscreen().catch(() => toast('Fullscreen was blocked'));
});

el.textSend.addEventListener('click', () => {
  const s = el.textInput.value;
  if (!s) return;
  send({ t: 'ctl', a: 'text', s });
  el.textInput.value = '';
  el.textPanel.hidden = true;
  el.btnKeyboard.classList.remove('active');
  el.stage.focus();
  toast('Text sent');
});

/* ── Quality controls ───────────────────────────────────────────────────── */

const PRESETS = {
  smooth:   { fps: 30, quality: 35, scale: 65 },
  balanced: { fps: 20, quality: 55, scale: 100 },
  sharp:    { fps: 8,  quality: 85, scale: 100 },
};

function pushQuality() {
  el.fpsVal.textContent = el.fpsRange.value;
  el.qVal.textContent = el.qRange.value;
  el.sVal.textContent = el.sRange.value;
  send({
    t: 'ctl',
    a: 'quality',
    fps: Number(el.fpsRange.value),
    quality: Number(el.qRange.value),
    scale: Number(el.sRange.value) / 100,
  });
}

for (const r of [el.fpsRange, el.qRange, el.sRange]) {
  r.addEventListener('input', () => {
    el.fpsVal.textContent = el.fpsRange.value;
    el.qVal.textContent = el.qRange.value;
    el.sVal.textContent = el.sRange.value;
    document.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
  });
  r.addEventListener('change', pushQuality);
}

document.querySelectorAll('.chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    const p = PRESETS[chip.dataset.preset];
    el.fpsRange.value = p.fps;
    el.qRange.value = p.quality;
    el.sRange.value = p.scale;
    document.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
    chip.classList.add('active');
    pushQuality();
  });
});

/* Close popovers when clicking the video area. */
el.stage.addEventListener('mousedown', () => {
  el.settingsPanel.hidden = true;
  el.textPanel.hidden = true;
  el.btnSettings.classList.remove('active');
  el.btnKeyboard.classList.remove('active');
});

/* ── Init ───────────────────────────────────────────────────────────────── */

renderRecent();
probeRelay();
el.idInput.focus();
fetch('/remote-desktop/download', { method: 'HEAD' }).then((response) => {
  if (!response.ok) {
    $('download-app').hidden = true;
    $('download-unavailable').hidden = false;
  }
}).catch(() => {
  $('download-app').hidden = true;
  $('download-unavailable').hidden = false;
});
