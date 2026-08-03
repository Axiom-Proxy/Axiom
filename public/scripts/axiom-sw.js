/*
 * Serves the user's own edits of the site back to the browser.
 *
 * public/'s source files are mirrored into the AxiomFS filesystem at /system
 * (see the site sync in scripts/fs.js). This runs inside the service worker,
 * reads that filesystem straight out of IndexedDB, and answers a request from
 * it whenever the mirrored copy differs from the one that was shipped - so
 * editing /system/styles/windows.css in the Files app restyles the desktop.
 *
 * Untouched files fall through to the network, which keeps deploys flowing
 * through to users who have not customised anything.
 *
 * Loaded by educational_sl/sw.js via importScripts; it deliberately shares that
 * registration because a second worker at scope "/" would evict the proxy's.
 *
 * Escape hatches, for when someone edits the desktop into a brick:
 *   - any page loaded with ?__axiom_raw=1 is served from the network, and so
 *     is everything that page requests
 *   - /recovery.html is never overridden
 */
(function (global) {
  'use strict';

  var DB_NAME = 'axiom-fs';
  var DB_VERSION = 1;
  var TREE_STORE = 'tree';
  var FILE_STORE = 'files';
  var SITE_KEY = 'site';
  var MOUNT = '/system';
  var CHANNEL_NAME = 'axiom-fs';
  var RAW_PARAM = '__axiom_raw';

  // Proxy plumbing, API routes and anything else that must never be answered
  // out of a user-editable file.
  var SKIP_PREFIXES = ['/educational_', '/baremux/', '/epoxy/', '/libcurl/',
    '/remote-desktop/vendor/', '/api/', '/edu/', '/search_complete/', '/chat'];
  var SKIP_PATHS = ['/recovery.html', '/scripts/axiom-sw.js'];

  // Ceilings on the two things that can stall: the filesystem lookup behind a
  // request, and opening the database it lives in.
  var LOOKUP_TIMEOUT = 2000;
  var OPEN_TIMEOUT = 1500;

  var TYPES = {
    html: 'text/html; charset=utf-8',
    htm: 'text/html; charset=utf-8',
    css: 'text/css; charset=utf-8',
    js: 'text/javascript; charset=utf-8',
    mjs: 'text/javascript; charset=utf-8',
    json: 'application/json; charset=utf-8',
    md: 'text/markdown; charset=utf-8',
    txt: 'text/plain; charset=utf-8',
    svg: 'image/svg+xml',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    ico: 'image/x-icon'
  };

  function extname(path) {
    var dot = path.lastIndexOf('.');
    var slash = path.lastIndexOf('/');
    return dot > slash + 1 ? path.slice(dot + 1).toLowerCase() : '';
  }

  /** Must stay identical to hashText() in scripts/fs.js. */
  function hashText(text) {
    var h = 5381;
    for (var i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
    return text.length.toString(36) + ':' + h.toString(36);
  }

  /* ------------------------------------------------------------ indexeddb */

  var dbPromise = null;

  function forget() {
    dbPromise = null;
  }

  function openDb() {
    if (dbPromise) return dbPromise;

    var attempt = new Promise(function (resolve, reject) {
      var request = indexedDB.open(DB_NAME, DB_VERSION);
      // The page owns the schema; if the worker gets here first it creates the
      // same stores so neither side has to wait on the other.
      request.onupgradeneeded = function () {
        var database = request.result;
        if (!database.objectStoreNames.contains(TREE_STORE)) database.createObjectStore(TREE_STORE);
        if (!database.objectStoreNames.contains(FILE_STORE)) database.createObjectStore(FILE_STORE);
      };
      request.onsuccess = function () {
        var database = request.result;
        // Holding this connection open would block the page from upgrading the
        // database or deleting it - which is exactly what wiping the disk does.
        database.onversionchange = function () { database.close(); forget(); };
        database.onclose = forget;
        resolve(database);
      };
      request.onerror = function () { reject(request.error); };
      request.onblocked = function () { reject(new Error('IndexedDB is blocked')); };
    });

    // An open that never lands must not be cached, or every later request
    // queues up behind the same dead promise.
    dbPromise = withTimeout(attempt.catch(function () { return null; }), null, OPEN_TIMEOUT)
      .then(function (database) {
        if (!database) { forget(); throw new Error('IndexedDB is unavailable'); }
        return database;
      });

    return dbPromise;
  }

  function get(store, key) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(store, 'readonly');
        var request = tx.objectStore(store).get(key);
        request.onsuccess = function () { resolve(request.result); };
        tx.onerror = function () { reject(tx.error); };
      });
    }).catch(function (err) {
      // Most likely the connection went away underneath us; reopen next time.
      forget();
      throw err;
    });
  }

  /* ---------------------------------------------------------------- cache */

  // The pristine record only changes when the site syncs, so it is cached and
  // dropped whenever the filesystem announces a write.
  var siteRecord = null;
  var siteRecordAt = 0;
  var RECORD_TTL = 5000;

  try {
    if (global.BroadcastChannel) {
      var channel = new BroadcastChannel(CHANNEL_NAME);
      channel.onmessage = function (event) {
        if (event.data && event.data.type === 'change') siteRecordAt = 0;
      };
    }
  } catch (e) { /* no channel: the TTL still bounds staleness */ }

  function loadSiteRecord() {
    var now = Date.now();
    if (siteRecord && now - siteRecordAt < RECORD_TTL) return Promise.resolve(siteRecord);
    return get(TREE_STORE, SITE_KEY).then(function (record) {
      siteRecord = record && record.f ? record : { f: {} };
      siteRecordAt = Date.now();
      return siteRecord;
    });
  }

  /* --------------------------------------------------------------- routing */

  /**
   * Nothing in here may outlive the request it is answering: a promise handed
   * to respondWith() that never settles leaves the page pending forever.
   */
  function withTimeout(promise, fallback, ms) {
    return new Promise(function (resolve) {
      var timer = setTimeout(function () { resolve(fallback); }, ms);
      promise.then(function (value) {
        clearTimeout(timer);
        resolve(value);
      }, function () {
        clearTimeout(timer);
        resolve(fallback);
      });
    });
  }

  var rawClients = new Map();

  function isRawUrl(url) {
    return !!url && url.indexOf(RAW_PARAM) !== -1;
  }

  function remember(id, raw) {
    if (rawClients.size > 128) rawClients.clear();
    rawClients.set(id, raw);
    return raw;
  }

  /*
   * A page loaded raw serves everything it asks for raw too, which means
   * matching a request to the page that made it.
   *
   * Subresources name their page in event.clientId and can be looked up. A
   * navigation cannot: its client does not exist yet, and clients.get() on the
   * reserved id it carries never settles in Chrome - an iframe pointed at an
   * intercepted page would hang on it indefinitely. So navigations are read
   * straight off the request, and the answer is filed under the id the client
   * is about to get, for the subresources that follow.
   */
  function noteNavigation(event) {
    var request = event.request;
    if (request.mode !== 'navigate' || !event.resultingClientId) return;
    remember(event.resultingClientId, isRawUrl(request.url) || isRawUrl(request.referrer));
  }

  function clientIsRaw(event) {
    var id = event.clientId || event.resultingClientId;
    if (!id) return Promise.resolve(false);
    if (rawClients.has(id)) return Promise.resolve(rawClients.get(id));
    if (event.request.mode === 'navigate') return Promise.resolve(false);
    if (!global.clients || !global.clients.get) return Promise.resolve(false);

    return withTimeout(global.clients.get(id).then(function (client) {
      return remember(id, !!client && isRawUrl(client.url));
    }), false, LOOKUP_TIMEOUT);
  }

  /** The /system path a request maps to, or null if it is not ours to answer. */
  function sitePath(request) {
    if (request.method !== 'GET') return null;

    var url;
    try { url = new URL(request.url); } catch (e) { return null; }
    if (url.origin !== global.location.origin) return null;
    if (url.searchParams.has(RAW_PARAM)) return null;

    var path = url.pathname;
    if (path.charAt(path.length - 1) === '/') path += 'index.html';
    if (SKIP_PATHS.indexOf(path) !== -1) return null;
    for (var i = 0; i < SKIP_PREFIXES.length; i++) {
      if (path.indexOf(SKIP_PREFIXES[i]) === 0) return null;
    }

    // Extensionless requests are only interesting when they are page loads.
    if (!extname(path) && request.mode !== 'navigate') return null;

    return MOUNT + path;
  }

  function bodyOf(record) {
    if (!record.b) return record.d;
    // Binary files are stored as data: URLs.
    var comma = record.d.indexOf(',');
    var binary = atob(record.d.slice(comma + 1));
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function respond(path, record) {
    return new Response(bodyOf(record), {
      status: 200,
      headers: {
        'Content-Type': TYPES[extname(path)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
        'X-Axiom-Source': 'axiomfs'
      }
    });
  }

  /** The filesystem's answer to a request, or null to let the network have it. */
  function lookup(event, path) {
    return clientIsRaw(event).then(function (raw) {
      if (raw) return null;

      return Promise.all([get(FILE_STORE, path), loadSiteRecord()]).then(function (results) {
        var record = results[0];
        if (!record || record.d == null) return null;

        // A file that matches what was shipped is not an edit - let the network
        // answer so server-side updates are not frozen at the mirrored copy.
        var pristine = results[1].f[path.slice(MOUNT.length)];
        if (pristine && !record.b && hashText(record.d) === pristine.h) return null;

        return respond(path, record);
      });
    });
  }

  function serve(event, path) {
    // A slow or wedged filesystem costs the shipped version of a file, never
    // the request itself.
    return withTimeout(lookup(event, path), null, LOOKUP_TIMEOUT)
      .then(function (response) { return response || fetch(event.request); });
  }

  global.AxiomOverride = {
    /** A Response promise when the filesystem owns this request, else null. */
    match: function (event) {
      var path;
      try {
        noteNavigation(event);
        path = sitePath(event.request);
      } catch (e) {
        return null;
      }
      if (!path) return null;
      return serve(event, path);
    }
  };

  global.addEventListener('install', function () { global.skipWaiting(); });
  global.addEventListener('activate', function (event) {
    rawClients.clear();
    if (global.clients && global.clients.claim) event.waitUntil(global.clients.claim());
  });
})(self);
