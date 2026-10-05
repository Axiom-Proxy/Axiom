'use strict';
// WebSocket relay for Axiom Remote Desktop.
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

/** @type {Map<string, {ws: any, pass: string, info: object, viewers: Set<any>}>} */
const hosts = new Map();
/** @type {Set<any>} */
const viewers = new Set();
const attempts = new Map();

function allowAttempt(address) {
  const now = Date.now();
  const entry = attempts.get(address);
  const current = entry && entry.until > now ? entry : { count: 0, until: now + 60_000 };
  current.count++;
  attempts.set(address, current);
  return current.count <= 10;
}

setInterval(() => {
  const now = Date.now();
  for (const [address, entry] of attempts) {
    if (entry.until <= now) attempts.delete(address);
  }
}, 60_000).unref();

function newDeviceId() {
  let id;
  do {
    // 9 digits, never leading zero, so it always renders as "123 456 789".
    id = String(crypto.randomInt(100000000, 1000000000));
  } while (hosts.has(id));
  return id;
}

function prettyId(id) {
  return `${id.slice(0, 3)} ${id.slice(3, 6)} ${id.slice(6)}`;
}

/** Constant-time string compare that tolerates length mismatch. */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    // Still burn a comparison so timing does not leak the length.
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

function send(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function log(...args) {
  console.log(new Date().toISOString().slice(11, 19), ...args);
}

/* ------------------------------------------------------------------ */
/* WebSocket handling                                                  */
/* ------------------------------------------------------------------ */

const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });

wss.on('connection', (ws, req) => {
  const peerAddr = req.socket.remoteAddress;
  ws.isAlive = true;
  ws.role = null; // 'host' | 'viewer'
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      handleBinary(ws, data);
      return;
    }
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg && typeof msg === 'object' && !Array.isArray(msg)) {
      handleJson(ws, msg, peerAddr);
    }
  });

  ws.on('close', () => teardown(ws));
  ws.on('error', () => teardown(ws));
});

function handleJson(ws, msg, peerAddr) {
  switch (msg.t) {
    /* ---- host side ---- */
    case 'host:register': {
      if (ws.role) return;
      let id = String(msg.id || '');
      if (!/^\d{9}$/.test(id) || hosts.has(id)) id = newDeviceId();
    if (typeof msg.pass !== 'string' || msg.pass.length < 8 || msg.pass.length > 128) {
        send(ws, { t: 'host:error', msg: 'A password is required to register.' });
        return;
      }
      ws.role = 'host';
      ws.deviceId = id;
      hosts.set(id, {
        ws,
        pass: String(msg.pass),
        info: msg.info || {},
        viewers: new Set(),
      });
      send(ws, { t: 'host:registered', id });
      log(`host ${prettyId(id)} online   (${msg.info?.name || 'unknown'} @ ${peerAddr})`);
      return;
    }

    case 'host:info': {
      // Host reporting a resolution change mid-session.
      const h = hosts.get(ws.deviceId);
      if (!h) return;
      h.info = { ...h.info, ...msg.info };
      for (const v of h.viewers) send(v, { t: 'view:info', info: h.info });
      return;
    }

    /* ---- viewer side ---- */
    case 'view:connect': {
      if (ws.role) return;
      if (!allowAttempt(peerAddr)) {
        send(ws, { t: 'view:error', msg: 'Too many attempts. Try again shortly.' });
        ws.close();
        return;
      }
      const id = String(msg.id || '').replace(/\D/g, '');
      const h = hosts.get(id);
      if (!h) {
        send(ws, { t: 'view:error', msg: 'Device is offline or the ID is wrong.' });
        return;
      }
      if (!safeEqual(msg.pass || '', h.pass)) {
        send(ws, { t: 'view:error', msg: 'Wrong password.' });
        log(`viewer ${peerAddr} FAILED auth for ${prettyId(id)}`);
        return;
      }
      ws.role = 'viewer';
      ws.viewerId = crypto.randomUUID().slice(0, 8);
      ws.hostId = id;
      viewers.add(ws);
      h.viewers.add(ws);
      send(ws, { t: 'view:connected', id, info: h.info });
      send(h.ws, { t: 'viewer:join', vid: ws.viewerId, count: h.viewers.size });
      log(`viewer ${ws.viewerId} -> ${prettyId(id)}  (${h.viewers.size} watching)`);
      return;
    }

    /* ---- relayed viewer -> host traffic ---- */
    case 'input':
    case 'ctl': {
      if (ws.role !== 'viewer') return;
      const h = hosts.get(ws.hostId);
      if (!h) return;
      msg.vid = ws.viewerId;
      send(h.ws, msg);
      return;
    }

    /* ---- relayed host -> viewer traffic ---- */
    case 'ctlback': {
      if (ws.role !== 'host') return;
      const h = hosts.get(ws.deviceId);
      if (!h) return;
      for (const v of h.viewers) {
        if (!msg.vid || v.viewerId === msg.vid) send(v, msg);
      }
      return;
    }
  }
}

/** Binary payloads only ever flow host -> viewers (video frames). */
function handleBinary(ws, data) {
  if (ws.role !== 'host') return;
  const h = hosts.get(ws.deviceId);
  if (!h) return;
  for (const v of h.viewers) {
    if (v.readyState !== v.OPEN) continue;
    // Drop frames for viewers that cannot keep up rather than buffering forever.
    if (v.bufferedAmount > 4 * 1024 * 1024) continue;
    v.send(data, { binary: true });
  }
}

function teardown(ws) {
  if (ws.role === 'host') {
    const h = hosts.get(ws.deviceId);
    if (h && h.ws === ws) {
      for (const v of h.viewers) {
        send(v, { t: 'host:gone', msg: 'The remote device went offline.' });
      }
      hosts.delete(ws.deviceId);
      log(`host ${prettyId(ws.deviceId)} offline`);
    }
  } else if (ws.role === 'viewer') {
    viewers.delete(ws);
    const h = hosts.get(ws.hostId);
    if (h) {
      h.viewers.delete(ws);
      send(h.ws, { t: 'viewer:left', vid: ws.viewerId, count: h.viewers.size });
      log(`viewer ${ws.viewerId} left ${prettyId(ws.hostId)}  (${h.viewers.size} watching)`);
    }
  }
  ws.role = null;
}

/* Drop half-open sockets so a crashed host does not linger in the registry. */
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 20000);
wss.on('close', () => clearInterval(heartbeat));

module.exports = wss;
