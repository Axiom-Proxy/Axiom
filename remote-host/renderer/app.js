'use strict';
/* Axiom remote desktop host. */

const $ = (id) => document.getElementById(id);

const el = {
  statusLine: $('status-line'),
  statusDot: $('status-dot'),
  idValue: $('id-value'),
  passValue: $('pass-value'),
  copyId: $('copy-id'),
  copyPass: $('copy-pass'),
  togglePass: $('toggle-pass'),
  newPass: $('new-pass'),
  statViewers: $('stat-viewers'),
  statScreen: $('stat-screen'),
  statRate: $('stat-rate'),
  statAudio: $('stat-audio'),
  shareBtn: $('share-btn'),
  toast: $('toast'),
  serverInput: $('server-input'),
  saveServer: $('save-server'),
  serverMsg: $('server-msg'),
};

let passShown = false;
let sharing = true;

/* ── Helpers ────────────────────────────────────────────────────────── */

function toast(msg, ms = 1600) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.toast.hidden = true; }, ms);
}

const STATUS_TEXT = {
  idle: ['Not sharing', ''],
  connecting: ['Connecting…', 'working'],
  retrying: ['Connection unavailable. Retrying…', 'working'],
  online: ['Ready to share', 'online'],
  error: ['Something went wrong', 'bad'],
};

/* ── Rendering ──────────────────────────────────────────────────────── */

function render(s) {
  const [text, cls] = STATUS_TEXT[s.connection] || ['—', ''];
  el.statusLine.textContent =
    s.connection === 'online' && s.viewers > 0
      ? `Sharing with ${s.viewers} viewer${s.viewers > 1 ? 's' : ''}`
      : text;
  el.statusDot.className = 'dot ' + cls;

  el.idValue.textContent = s.prettyId;
  el.passValue.textContent = passShown ? s.pass : '•'.repeat(s.pass.length);

  el.statViewers.textContent = s.viewers;
  el.statScreen.textContent = s.screen.w ? `${s.screen.w}×${s.screen.h}` : '—';
  el.statRate.textContent = s.viewers > 0 && s.fps ? `${s.fps} fps` : 'Idle';
  el.statAudio.textContent = s.audio ? 'On' : 'Off';

  sharing = s.connection !== 'idle';
  el.shareBtn.textContent = sharing ? 'Stop sharing' : 'Start sharing';
  el.shareBtn.classList.toggle('stopped', !sharing);
}

function showServerMessage(message, type) {
  el.serverMsg.textContent = message;
  el.serverMsg.className = 'msg ' + type;
  el.serverMsg.hidden = !message;
}

/* ── Wiring ─────────────────────────────────────────────────────────── */

el.copyId.addEventListener('click', async () => {
  await window.lightdesk.copy(el.idValue.textContent.replace(/\s/g, ''));
  toast('ID copied');
});

el.copyPass.addEventListener('click', async () => {
  const s = await window.lightdesk.getStatus();
  await window.lightdesk.copy(s.pass);
  toast('Password copied');
});

el.togglePass.addEventListener('click', async () => {
  passShown = !passShown;
  el.togglePass.textContent = passShown ? 'Hide' : 'Show';
  el.togglePass.title = passShown ? 'Hide password' : 'Show password';
  render(await window.lightdesk.getStatus());
});

el.newPass.addEventListener('click', async () => {
  await window.lightdesk.newPassword();
  passShown = true;
  el.togglePass.textContent = 'Hide';
  el.togglePass.title = 'Hide password';
  render(await window.lightdesk.getStatus());
  toast('New password generated');
});

async function saveServer() {
  try {
    const server = await window.lightdesk.setServer(el.serverInput.value);
    el.serverInput.value = server.replace(/^wss?:\/\//, (scheme) => scheme === 'wss://' ? 'https://' : 'http://');
    showServerMessage('Address saved.', 'ok');
    render(await window.lightdesk.getStatus());
  } catch (error) {
    showServerMessage(error.message || 'Could not save that address.', 'err');
  }
}

el.saveServer.addEventListener('click', saveServer);
el.serverInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') saveServer();
});

el.shareBtn.addEventListener('click', async () => {
  const s = sharing ? await window.lightdesk.stop() : await window.lightdesk.start();
  render(s);
  toast(sharing ? 'Sharing started' : 'Sharing stopped');
});

window.lightdesk.onStatus(render);
window.lightdesk.onError((msg) => toast(msg, 4000));

/* ── Init ───────────────────────────────────────────────────────────── */

window.lightdesk.getStatus().then((s) => {
  el.serverInput.value = s.server.replace(/^wss?:\/\//, (scheme) => scheme === 'wss://' ? 'https://' : 'http://');
  render(s);
});
