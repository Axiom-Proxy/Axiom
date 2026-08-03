/*
 * AxiomFS - a synchronous virtual filesystem for the Axiom desktop.
 *
 * The whole tree is held in memory so reads and writes can be synchronous;
 * IndexedDB is the durable mirror behind it, written back in debounced
 * batches. Changes are announced over a BroadcastChannel so the terminal and
 * the Files app stay in step.
 *
 * Storage layout:
 *   store "tree"  - one record: the directory tree, file contents stripped out
 *   store "files" - one record per file path: { d: contents, b: 1 if data URL }
 *
 * Nothing is usable until `AxiomFS.ready` resolves; on first run that is when
 * the defaults in public/default/ finish loading.
 *
 * Nodes:
 *   directory { t: 'd', m: mtime, c: { name: node } }
 *   file      { t: 'f', m: mtime, d: contents, b: 1 if `d` is a data: URL }
 */
(function (global) {
  'use strict';

  var DB_NAME = 'axiom-fs';
  var DB_VERSION = 1;
  var TREE_STORE = 'tree';
  var FILE_STORE = 'files';
  var TREE_KEY = 'root';
  var LEGACY_KEY = 'axiom_fs_v1';
  var CHANNEL_NAME = 'axiom-fs';

  var HOME = '/home/user';
  var DEFAULTS_ROUTE = '/api/default-fs';
  var DEFAULTS_BASE = '/default';

  // The site's own source, mirrored in so it can be read and edited from
  // inside Axiom; scripts/axiom-sw.js serves the edited copies back.
  var SITE_MOUNT = '/system';
  var SITE_ROUTE = '/api/site-fs';
  var SITE_MANIFEST = '/assets/site-manifest.json';
  var SITE_KEY = 'site';
  var SITE_LOCK = 'axiom_site_sync';
  var SITE_LOCK_MS = 20000;

  // Used only if public/default/ cannot be reached at all.
  var FALLBACK_DIRS = ['/home', HOME, HOME + '/Desktop', HOME + '/Documents',
    HOME + '/Downloads', HOME + '/Pictures', '/tmp'];

  function fsError(code, path, msg) {
    var err = new Error(code + ': ' + msg + " '" + path + "'");
    err.code = code;
    err.path = path;
    return err;
  }

  function now() { return Date.now(); }
  function dirNode(children) { return { t: 'd', m: now(), c: children || {} }; }
  function fileNode(data, binary) {
    var node = { t: 'f', m: now(), d: data == null ? '' : String(data) };
    if (binary) node.b = 1;
    return node;
  }

  var root = dirNode();

  /* ---------------------------------------------------------------- paths */

  function normalize(path, cwd) {
    path = path == null ? '' : String(path);
    if (path === '~') path = HOME;
    else if (path.indexOf('~/') === 0) path = HOME + path.slice(1);
    if (path.charAt(0) !== '/') path = (cwd || '/') + '/' + path;

    var parts = path.split('/');
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i];
      if (part === '' || part === '.') continue;
      if (part === '..') { out.pop(); continue; }
      out.push(part);
    }
    return '/' + out.join('/');
  }

  function basename(path) {
    var abs = normalize(path);
    if (abs === '/') return '/';
    return abs.slice(abs.lastIndexOf('/') + 1);
  }

  function dirname(path) {
    var abs = normalize(path);
    if (abs === '/') return '/';
    var cut = abs.lastIndexOf('/');
    return cut === 0 ? '/' : abs.slice(0, cut);
  }

  function join() {
    return normalize(Array.prototype.join.call(arguments, '/'));
  }

  /* ------------------------------------------------------------- lookups */

  function find(abs) {
    if (abs === '/') return root;
    var parts = abs.split('/').slice(1);
    var node = root;
    for (var i = 0; i < parts.length; i++) {
      if (node.t !== 'd') return null;
      node = node.c[parts[i]];
      if (!node) return null;
    }
    return node;
  }

  function resolve(path, cwd) {
    var abs = normalize(path, cwd);
    var node = find(abs);
    if (!node) throw fsError('ENOENT', abs, 'no such file or directory');
    return { abs: abs, node: node };
  }

  function resolveParent(path, cwd) {
    var abs = normalize(path, cwd);
    if (abs === '/') throw fsError('EPERM', '/', 'operation not permitted on');
    var parent = find(dirname(abs));
    if (!parent) throw fsError('ENOENT', dirname(abs), 'no such file or directory');
    if (parent.t !== 'd') throw fsError('ENOTDIR', dirname(abs), 'not a directory');
    return { abs: abs, parent: parent, name: basename(abs) };
  }

  /** Every file path inside a subtree, used when persisting bulk changes. */
  function collectFiles(abs, node) {
    var out = [];
    (function visit(path, current) {
      if (!current) return;
      if (current.t === 'f') { out.push(path); return; }
      var base = path === '/' ? '' : path;
      for (var name in current.c) visit(base + '/' + name, current.c[name]);
    })(abs, node);
    return out;
  }

  function nodeSize(node) {
    if (node.t === 'd') return 0;
    if (node.b) {
      // data: URL - report the decoded byte length, not the base64 length.
      var comma = node.d.indexOf(',');
      var payload = comma === -1 ? node.d : node.d.slice(comma + 1);
      return Math.floor(payload.length * 3 / 4);
    }
    return node.d.length;
  }

  function statOf(abs, node) {
    return {
      path: abs,
      name: abs === '/' ? '/' : basename(abs),
      isDirectory: node.t === 'd',
      isFile: node.t === 'f',
      binary: !!node.b,
      size: nodeSize(node),
      mtime: node.m,
      children: node.t === 'd' ? Object.keys(node.c).length : 0
    };
  }

  /* --------------------------------------------------------- persistence */

  var db = null;
  var listeners = [];
  var channel = null;
  var dirtyFiles = Object.create(null);
  var deletedFiles = Object.create(null);
  var treeDirty = false;
  var flushTimer = null;
  var reloadTimer = null;
  var pendingBroadcast = null;

  try {
    if (global.BroadcastChannel) channel = new BroadcastChannel(CHANNEL_NAME);
  } catch (e) { channel = null; }

  function emit(detail) {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](detail); } catch (e) { /* a bad listener must not break writes */ }
    }
  }

  function markFileDirty(abs) {
    dirtyFiles[abs] = true;
    delete deletedFiles[abs];
  }

  function markSubtreeDirty(abs) {
    collectFiles(abs, find(abs)).forEach(markFileDirty);
  }

  /** Call with paths collected *before* the nodes are removed. */
  function markDeleted(paths) {
    paths.forEach(function (path) {
      deletedFiles[path] = true;
      delete dirtyFiles[path];
    });
  }

  function changed(path) {
    treeDirty = true;
    // Local listeners see the change straight away; other windows are only
    // told once it is committed, so they never re-read a stale tree.
    emit({ path: path, remote: false });
    scheduleFlush(path);
  }

  function broadcastPending() {
    if (!pendingBroadcast) return;
    var path = pendingBroadcast;
    pendingBroadcast = null;
    if (!channel) return;
    try { channel.postMessage({ type: 'change', path: path }); } catch (e) {}
  }

  function openDb() {
    return new Promise(function (resolve, reject) {
      if (!global.indexedDB) { reject(new Error('IndexedDB is unavailable')); return; }
      var request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = function () {
        var database = request.result;
        if (!database.objectStoreNames.contains(TREE_STORE)) database.createObjectStore(TREE_STORE);
        if (!database.objectStoreNames.contains(FILE_STORE)) database.createObjectStore(FILE_STORE);
      };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
      request.onblocked = function () { reject(new Error('IndexedDB is blocked')); };
    });
  }

  function readAll() {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction([TREE_STORE, FILE_STORE], 'readonly');
      var treeRequest = tx.objectStore(TREE_STORE).get(TREE_KEY);
      var cursorRequest = tx.objectStore(FILE_STORE).openCursor();
      var files = Object.create(null);

      cursorRequest.onsuccess = function () {
        var cursor = cursorRequest.result;
        if (!cursor) return;
        files[cursor.key] = cursor.value;
        cursor.continue();
      };
      tx.oncomplete = function () { resolve({ tree: treeRequest.result, files: files }); };
      tx.onerror = function () { reject(tx.error); };
    });
  }

  /** A copy of the tree with file contents removed - they persist separately. */
  function stripTree(node) {
    if (node.t === 'f') {
      var file = { t: 'f', m: node.m };
      if (node.b) file.b = 1;
      return file;
    }
    var children = {};
    for (var name in node.c) children[name] = stripTree(node.c[name]);
    return { t: 'd', m: node.m, c: children };
  }

  /** Rebuild the in-memory tree by pairing the structure with its contents. */
  function hydrate(tree, files) {
    (function visit(path, node) {
      if (node.t === 'f') {
        var record = files[path];
        node.d = record && record.d != null ? record.d : '';
        if (record && record.b) node.b = 1;
        return;
      }
      var base = path === '/' ? '' : path;
      for (var name in node.c) visit(base + '/' + name, node.c[name]);
    })('/', tree);
    return tree;
  }

  function scheduleFlush(path) {
    if (path) pendingBroadcast = path;
    if (flushTimer) return;
    flushTimer = setTimeout(function () {
      flushTimer = null;
      flush().then(broadcastPending, broadcastPending);
    }, 60);
  }

  function flush() {
    var files = Object.keys(dirtyFiles);
    var removed = Object.keys(deletedFiles);
    if (!db || (!treeDirty && !files.length && !removed.length)) return Promise.resolve();

    var snapshot = stripTree(root);
    dirtyFiles = Object.create(null);
    deletedFiles = Object.create(null);
    treeDirty = false;

    return new Promise(function (resolve, reject) {
      var tx = db.transaction([TREE_STORE, FILE_STORE], 'readwrite');
      var fileStore = tx.objectStore(FILE_STORE);

      tx.objectStore(TREE_STORE).put(snapshot, TREE_KEY);
      files.forEach(function (path) {
        var node = find(path);
        if (!node || node.t !== 'f') return;
        fileStore.put({ d: node.d, b: node.b ? 1 : 0 }, path);
      });
      removed.forEach(function (path) { fileStore.delete(path); });

      tx.oncomplete = resolve;
      tx.onerror = function () {
        // Almost always a quota error; put the work back so a later write retries.
        files.forEach(function (path) { dirtyFiles[path] = true; });
        removed.forEach(function (path) { deletedFiles[path] = true; });
        treeDirty = true;
        emit({ path: '/', error: tx.error });
        reject(tx.error);
      };
    });
  }

  /** Side records kept alongside the tree, keyed separately from TREE_KEY. */
  function metaGet(key) {
    if (!db) return Promise.resolve(null);
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(TREE_STORE, 'readonly');
      var request = tx.objectStore(TREE_STORE).get(key);
      request.onsuccess = function () { resolve(request.result || null); };
      tx.onerror = function () { reject(tx.error); };
    });
  }

  function metaPut(key, value) {
    if (!db) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(TREE_STORE, 'readwrite');
      tx.objectStore(TREE_STORE).put(value, key);
      tx.oncomplete = resolve;
      tx.onerror = function () { reject(tx.error); };
    });
  }

  function reloadFromDb() {
    if (!db) return Promise.resolve();
    return readAll().then(function (data) {
      if (!data.tree) return;
      root = hydrate(data.tree, data.files);
      emit({ path: '/', remote: true });
    });
  }

  if (channel) {
    channel.onmessage = function (event) {
      if (!event.data || event.data.type !== 'change') return;
      // Coalesce bursts from the other window into a single re-read.
      if (reloadTimer) return;
      reloadTimer = setTimeout(function () {
        reloadTimer = null;
        // Commit anything of our own first - reloading replaces the whole
        // tree, and unwritten local changes would be lost with it.
        fs.sync().catch(function () {}).then(function () {
          return reloadFromDb();
        }).catch(function () {});
      }, 30);
    };
  }

  global.addEventListener('pagehide', function () {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    flush().catch(function () {});
  });

  /* ------------------------------------------------------------- seeding */

  var TEXT_EXTENSIONS = ['txt', 'md', 'json', 'js', 'mjs', 'ts', 'jsx', 'tsx', 'css', 'scss',
    'html', 'htm', 'xml', 'svg', 'csv', 'log', 'yml', 'yaml', 'toml', 'ini', 'sh', 'py', 'rb',
    'go', 'rs', 'c', 'h', 'cpp', 'java', 'php', 'lua', 'rst', 'gitignore'];

  function isTextName(name) {
    return TEXT_EXTENSIONS.indexOf(extname(name)) !== -1;
  }

  /** Create a directory without announcing it - used while seeding. */
  function mkdirRaw(abs) {
    var parts = abs.split('/').slice(1);
    var node = root;
    for (var i = 0; i < parts.length; i++) {
      var next = node.c[parts[i]];
      if (!next || next.t !== 'd') { next = dirNode(); node.c[parts[i]] = next; }
      node = next;
    }
    return node;
  }

  function writeRaw(abs, data, binary) {
    var parent = mkdirRaw(dirname(abs));
    parent.c[basename(abs)] = fileNode(data, binary);
    markFileDirty(abs);
  }

  function fetchDefaultsManifest() {
    return fetch(DEFAULTS_ROUTE)
      .then(function (res) { return res.ok ? res.json() : Promise.reject(); })
      .catch(function () {
        // Static hosting without the route: fall back to a checked-in manifest.
        return fetch(DEFAULTS_BASE + '/manifest.json').then(function (res) {
          return res.ok ? res.json() : Promise.reject();
        });
      })
      .then(function (data) { return (data && data.entries) || []; })
      .catch(function () { return null; });
  }

  function fetchAsDataUrl(url) {
    return fetch(url).then(function (res) { return res.blob(); }).then(function (blob) {
      return new Promise(function (resolve, reject) {
        var reader = new FileReader();
        reader.onload = function () { resolve(reader.result); };
        reader.onerror = function () { reject(reader.error); };
        reader.readAsDataURL(blob);
      });
    });
  }

  function seedFromDefaults() {
    return fetchDefaultsManifest().then(function (entries) {
      if (!entries) {
        FALLBACK_DIRS.forEach(mkdirRaw);
        return;
      }

      entries.filter(function (entry) { return entry.dir; })
        .forEach(function (entry) { mkdirRaw(entry.path); });

      var files = entries.filter(function (entry) { return !entry.dir; });
      return Promise.all(files.map(function (entry) {
        var url = DEFAULTS_BASE + entry.path.split('/').map(encodeURIComponent).join('/');
        var text = isTextName(entry.path);
        var load = text
          ? fetch(url).then(function (res) { return res.ok ? res.text() : Promise.reject(); })
          : fetchAsDataUrl(url);
        return load.then(function (data) {
          writeRaw(entry.path, data, !text);
        }).catch(function () { /* skip anything that will not load */ });
      })).then(function () {
        FALLBACK_DIRS.forEach(function (path) { if (!find(path)) mkdirRaw(path); });
      });
    });
  }

  function readLegacyTree() {
    try {
      var raw = localStorage.getItem(LEGACY_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      return parsed && parsed.t === 'd' ? parsed : null;
    } catch (e) {
      return null;
    }
  }

  /* --------------------------------------------------------- site mirror */

  /*
   * public/'s source files are mirrored under /system so they can be opened in
   * the Files app and the terminal, and the service worker serves an edited
   * copy back to the browser in place of the shipped one.
   *
   * A record of what each file looked like when it was mirrored is kept beside
   * the tree ({ path: { h: hash, s: size, m: mtime } }). It answers the two
   * questions everything else depends on: has the user edited this file (hash
   * differs), and has the site shipped a new version of it (size/mtime differ).
   * An untouched mirror is refreshed silently; an edited one is never
   * overwritten.
   */

  /** Must stay identical to hashText() in scripts/axiom-sw.js. */
  function hashText(text) {
    var h = 5381;
    for (var i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
    return text.length.toString(36) + ':' + h.toString(36);
  }

  /** Marks a URL as "do not serve this one from the filesystem". */
  function rawUrl(url) {
    return url + (url.indexOf('?') === -1 ? '?' : '&') + '__axiom_raw=1';
  }

  function fetchSiteManifest() {
    return fetch(rawUrl(SITE_ROUTE))
      .then(function (res) { return res.ok ? res.json() : Promise.reject(); })
      .catch(function () {
        // Static hosting without the route: fall back to the checked-in copy.
        return fetch(rawUrl(SITE_MANIFEST)).then(function (res) {
          return res.ok ? res.json() : Promise.reject();
        });
      })
      .then(function (data) { return (data && data.entries) || null; })
      .catch(function () { return null; });
  }

  /** Keeps several open windows from mirroring the same files at once. */
  function claimSiteSync() {
    try {
      var last = parseInt(localStorage.getItem(SITE_LOCK) || '0', 10);
      if (Date.now() - last < SITE_LOCK_MS) return false;
      localStorage.setItem(SITE_LOCK, String(Date.now()));
      return true;
    } catch (e) {
      return true;
    }
  }

  function syncSite(force) {
    if (!force && !claimSiteSync()) return Promise.resolve(false);

    return Promise.all([
      fetchSiteManifest(),
      metaGet(SITE_KEY).catch(function () { return null; })
    ]).then(function (results) {
      var entries = results[0];
      if (!entries) return false;

      var previous = (results[1] && results[1].f) || {};
      var next = Object.create(null);
      var live = Object.create(null);
      var pending = [];

      entries.forEach(function (entry) {
        live[entry.path] = true;
        var abs = SITE_MOUNT + entry.path;
        var node = find(abs);
        var prior = previous[entry.path];

        if (node && node.t === 'f') {
          if (!prior || hashText(node.d) !== prior.h) {
            // Edited. Leave it alone, and keep remembering what shipped.
            if (prior) next[entry.path] = prior;
            return;
          }
          if (prior.s === entry.size && prior.m === entry.mtime) {
            next[entry.path] = prior;
            return;
          }
        }

        var url = rawUrl(entry.path.split('/').map(encodeURIComponent).join('/'));
        pending.push(fetch(url).then(function (res) {
          return res.ok ? res.text() : Promise.reject();
        }).then(function (text) {
          writeRaw(abs, text, false);
          next[entry.path] = { h: hashText(text), s: entry.size, m: entry.mtime };
        }).catch(function () {
          // Unreachable file: keep whatever is already mirrored.
          if (prior) next[entry.path] = prior;
        }));
      });

      // Files that have since left the site: drop the mirror unless it holds
      // an edit, which is the user's to keep.
      Object.keys(previous).forEach(function (path) {
        if (live[path]) return;
        var abs = SITE_MOUNT + path;
        var node = find(abs);
        if (!node || node.t !== 'f') return;
        if (hashText(node.d) !== previous[path].h) { next[path] = previous[path]; return; }
        markDeleted([abs]);
        var parent = find(dirname(abs));
        if (parent && parent.t === 'd') delete parent.c[basename(abs)];
      });

      return Promise.all(pending).then(function () {
        mkdirRaw(SITE_MOUNT);
        treeDirty = true;
        // Written before the files themselves, so the worker never sees a
        // mirrored file it has no shipped hash for and mistakes it for an edit.
        return metaPut(SITE_KEY, { v: Date.now(), f: next }).catch(function () {});
      }).then(function () {
        changed(SITE_MOUNT);
        return true;
      });
    }).catch(function () { return false; });
  }

  /* ------------------------------------------------------------- booting */

  var storage = { usage: 0, quota: 0 };

  function refreshStorageEstimate() {
    if (!navigator.storage || !navigator.storage.estimate) return Promise.resolve(storage);
    return navigator.storage.estimate().then(function (estimate) {
      storage.usage = estimate.usage || 0;
      storage.quota = estimate.quota || 0;
      return storage;
    }).catch(function () { return storage; });
  }

  var ready = openDb()
    .then(function (database) {
      db = database;
      return readAll();
    })
    .then(function (data) {
      if (data.tree) { root = hydrate(data.tree, data.files); return; }

      var legacy = readLegacyTree();
      if (legacy) {
        // Carry over a filesystem created by the previous localStorage build.
        root = legacy;
        treeDirty = true;
        collectFiles('/', root).forEach(markFileDirty);
        return flush().then(function () {
          try { localStorage.removeItem(LEGACY_KEY); } catch (e) {}
        });
      }

      treeDirty = true;
      return seedFromDefaults().then(flush);
    })
    .catch(function (err) {
      // Private browsing, blocked storage, or a failed upgrade: keep the
      // filesystem working in memory so the apps still open.
      console.warn('AxiomFS: persistence unavailable, running in memory only.', err);
      db = null;
      if (Object.keys(root.c).length) return null;
      return seedFromDefaults();
    })
    .then(function () {
      return refreshStorageEstimate();
    })
    .then(function () {
      emit({ path: '/', boot: true });
      // Mirroring the site is a background job - nothing here waits on the
      // network, and /system appears once the change lands.
      setTimeout(function () { syncSite(); }, 0);
      return fs;
    });

  /* ----------------------------------------------------------------- api */

  var fs = {
    HOME: HOME,
    ready: ready,
    storage: storage,
    normalize: normalize,
    basename: basename,
    dirname: dirname,
    join: join,

    exists: function (path, cwd) {
      return !!find(normalize(path, cwd));
    },

    stat: function (path, cwd) {
      var r = resolve(path, cwd);
      return statOf(r.abs, r.node);
    },

    isDirectory: function (path, cwd) {
      var node = find(normalize(path, cwd));
      return !!node && node.t === 'd';
    },

    readdir: function (path, cwd) {
      var r = resolve(path, cwd);
      if (r.node.t !== 'd') throw fsError('ENOTDIR', r.abs, 'not a directory');
      return Object.keys(r.node.c).sort();
    },

    /** Directory entries as stat objects, directories first then A-Z. */
    list: function (path, cwd) {
      var r = resolve(path, cwd);
      if (r.node.t !== 'd') throw fsError('ENOTDIR', r.abs, 'not a directory');
      var base = r.abs === '/' ? '' : r.abs;
      var out = Object.keys(r.node.c).map(function (name) {
        return statOf(base + '/' + name, r.node.c[name]);
      });
      out.sort(function (a, b) {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { numeric: true });
      });
      return out;
    },

    readFile: function (path, cwd) {
      var r = resolve(path, cwd);
      if (r.node.t === 'd') throw fsError('EISDIR', r.abs, 'is a directory');
      return r.node.d;
    },

    writeFile: function (path, data, opts, cwd) {
      opts = opts || {};
      var r = resolveParent(path, cwd);
      var existing = r.parent.c[r.name];
      if (existing && existing.t === 'd') throw fsError('EISDIR', r.abs, 'is a directory');
      r.parent.c[r.name] = fileNode(data, opts.binary);
      markFileDirty(r.abs);
      changed(r.abs);
      return r.abs;
    },

    appendFile: function (path, data, cwd) {
      var abs = normalize(path, cwd);
      var node = find(abs);
      if (node && node.t === 'd') throw fsError('EISDIR', abs, 'is a directory');
      var prev = node && !node.b ? node.d : '';
      return fs.writeFile(abs, prev + String(data == null ? '' : data), null, cwd);
    },

    /** Create `path` as an empty file if it does not exist, else bump mtime. */
    touch: function (path, cwd) {
      var abs = normalize(path, cwd);
      var node = find(abs);
      if (node) { node.m = now(); changed(abs); return abs; }
      return fs.writeFile(abs, '', null, cwd);
    },

    mkdir: function (path, opts, cwd) {
      opts = opts || {};
      var abs = normalize(path, cwd);
      if (abs === '/') {
        if (opts.recursive) return abs;
        throw fsError('EEXIST', abs, 'file exists');
      }

      if (opts.recursive) {
        var parts = abs.split('/').slice(1);
        var node = root;
        var walked = '';
        for (var i = 0; i < parts.length; i++) {
          walked += '/' + parts[i];
          var next = node.c[parts[i]];
          if (!next) { next = dirNode(); node.c[parts[i]] = next; }
          else if (next.t !== 'd') throw fsError('ENOTDIR', walked, 'not a directory');
          node = next;
        }
        changed(abs);
        return abs;
      }

      var r = resolveParent(abs, cwd);
      if (r.parent.c[r.name]) throw fsError('EEXIST', r.abs, 'file exists');
      r.parent.c[r.name] = dirNode();
      changed(r.abs);
      return r.abs;
    },

    rm: function (path, opts, cwd) {
      opts = opts || {};
      var r = resolveParent(path, cwd);
      var node = r.parent.c[r.name];
      if (!node) {
        if (opts.force) return false;
        throw fsError('ENOENT', r.abs, 'no such file or directory');
      }
      if (node.t === 'd' && !opts.recursive) throw fsError('EISDIR', r.abs, 'is a directory');

      markDeleted(collectFiles(r.abs, node));
      delete r.parent.c[r.name];
      changed(r.abs);
      return true;
    },

    rmdir: function (path, cwd) {
      var r = resolveParent(path, cwd);
      var node = r.parent.c[r.name];
      if (!node) throw fsError('ENOENT', r.abs, 'no such file or directory');
      if (node.t !== 'd') throw fsError('ENOTDIR', r.abs, 'not a directory');
      if (Object.keys(node.c).length) throw fsError('ENOTEMPTY', r.abs, 'directory not empty');
      delete r.parent.c[r.name];
      changed(r.abs);
      return true;
    },

    rename: function (from, to, cwd) {
      var src = resolveParent(from, cwd);
      var node = src.parent.c[src.name];
      if (!node) throw fsError('ENOENT', src.abs, 'no such file or directory');

      var destAbs = normalize(to, cwd);
      var destNode = find(destAbs);
      // `mv a b/` where b is a directory means "move a into b".
      if (destNode && destNode.t === 'd' && destAbs !== src.abs) {
        destAbs = destAbs === '/' ? '/' + src.name : destAbs + '/' + src.name;
      }
      if (destAbs === src.abs) return destAbs;
      if (node.t === 'd' && destAbs.indexOf(src.abs + '/') === 0) {
        throw fsError('EINVAL', destAbs, 'cannot move a directory into itself');
      }

      var dst = resolveParent(destAbs, cwd);
      markDeleted(collectFiles(src.abs, node));
      delete src.parent.c[src.name];
      dst.parent.c[dst.name] = node;
      node.m = now();
      markSubtreeDirty(destAbs);
      changed(destAbs);
      return destAbs;
    },

    copy: function (from, to, opts, cwd) {
      opts = opts || {};
      var src = resolve(from, cwd);
      if (src.node.t === 'd' && !opts.recursive) {
        throw fsError('EISDIR', src.abs, 'is a directory');
      }

      var destAbs = normalize(to, cwd);
      var destNode = find(destAbs);
      if (destNode && destNode.t === 'd') {
        destAbs = destAbs === '/' ? '/' + basename(src.abs) : destAbs + '/' + basename(src.abs);
      }
      if (src.node.t === 'd' && destAbs.indexOf(src.abs + '/') === 0) {
        throw fsError('EINVAL', destAbs, 'cannot copy a directory into itself');
      }

      var dst = resolveParent(destAbs, cwd);
      dst.parent.c[dst.name] = JSON.parse(JSON.stringify(src.node));
      dst.parent.c[dst.name].m = now();
      markSubtreeDirty(destAbs);
      changed(destAbs);
      return destAbs;
    },

    /**
     * A name that does not collide inside `dir`: "notes.md" -> "notes copy.md".
     */
    uniqueName: function (dir, name, suffix) {
      var parent = find(normalize(dir));
      if (!parent || parent.t !== 'd' || !parent.c[name]) return name;
      var dot = name.lastIndexOf('.');
      var stem = dot > 0 ? name.slice(0, dot) : name;
      var ext = dot > 0 ? name.slice(dot) : '';
      var label = suffix || 'copy';
      var candidate = stem + ' ' + label + ext;
      var n = 2;
      while (parent.c[candidate]) candidate = stem + ' ' + label + ' ' + (n++) + ext;
      return candidate;
    },

    /** Recursive byte total, for `du` and the Files properties panel. */
    size: function (path, cwd) {
      var r = resolve(path, cwd);
      var total = 0;
      (function walk(node) {
        if (node.t === 'f') { total += nodeSize(node); return; }
        for (var name in node.c) walk(node.c[name]);
      })(r.node);
      return total;
    },

    /** Depth-first walk yielding stat objects for everything under `path`. */
    walk: function (path, cwd) {
      var r = resolve(path, cwd);
      var out = [];
      (function visit(abs, node) {
        if (node.t !== 'd') return;
        var base = abs === '/' ? '' : abs;
        Object.keys(node.c).sort().forEach(function (name) {
          var childAbs = base + '/' + name;
          var child = node.c[name];
          out.push(statOf(childAbs, child));
          visit(childAbs, child);
        });
      })(r.abs, r.node);
      return out;
    },

    /** Expand a shell glob such as `*.txt` or `src/*` into absolute paths. */
    glob: function (pattern, cwd) {
      var abs = normalize(pattern, cwd);
      var dir = dirname(abs);
      var name = basename(abs);
      if (name.indexOf('*') === -1 && name.indexOf('?') === -1) {
        return find(abs) ? [abs] : [];
      }
      var parent = find(dir);
      if (!parent || parent.t !== 'd') return [];
      var re = globToRegExp(name);
      var base = dir === '/' ? '' : dir;
      return Object.keys(parent.c)
        .filter(function (entry) {
          if (entry.charAt(0) === '.' && name.charAt(0) !== '.') return false;
          return re.test(entry);
        })
        .sort()
        .map(function (entry) { return base + '/' + entry; });
    },

    SITE_MOUNT: SITE_MOUNT,

    /** Re-mirror public/ into /system, leaving edited files untouched. */
    syncSite: function () { return syncSite(true); },

    /**
     * Wipe everything: the defaults come back from public/default/ and the
     * site mirror is rebuilt, so any edit that broke the desktop is undone.
     */
    reset: function () {
      root = dirNode();
      dirtyFiles = Object.create(null);
      deletedFiles = Object.create(null);
      try { localStorage.removeItem(SITE_LOCK); } catch (e) {}

      var cleared = db ? new Promise(function (resolve, reject) {
        var tx = db.transaction([TREE_STORE, FILE_STORE], 'readwrite');
        tx.objectStore(TREE_STORE).clear();
        tx.objectStore(FILE_STORE).clear();
        tx.oncomplete = resolve;
        tx.onerror = function () { reject(tx.error); };
      }) : Promise.resolve();

      return cleared
        .then(seedFromDefaults)
        .then(function () {
          treeDirty = true;
          return flush();
        })
        .then(function () { return syncSite(true); })
        .then(function () { changed('/'); });
    },

    /** Force any pending writes out to IndexedDB. */
    sync: function () {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      return flush();
    },

    /** Subscribe to filesystem changes; returns an unsubscribe function. */
    on: function (fn) {
      listeners.push(fn);
      return function () {
        var i = listeners.indexOf(fn);
        if (i !== -1) listeners.splice(i, 1);
      };
    }
  };

  function globToRegExp(pattern) {
    var out = '';
    for (var i = 0; i < pattern.length; i++) {
      var ch = pattern.charAt(i);
      if (ch === '*') out += '[^/]*';
      else if (ch === '?') out += '[^/]';
      else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp('^' + out + '$');
  }

  /* --------------------------------------------------------- presentation */

  var KINDS = [
    { kind: 'image', icon: 'image', ext: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'] },
    { kind: 'video', icon: 'movie', ext: ['mp4', 'webm', 'mkv', 'mov', 'avi'] },
    { kind: 'audio', icon: 'audio_file', ext: ['mp3', 'wav', 'ogg', 'flac', 'm4a'] },
    { kind: 'code', icon: 'code', ext: ['js', 'mjs', 'ts', 'jsx', 'tsx', 'py', 'rb', 'go', 'rs', 'c', 'h', 'cpp', 'java', 'sh', 'php', 'lua'] },
    { kind: 'markup', icon: 'html', ext: ['html', 'htm', 'xml', 'css', 'scss'] },
    { kind: 'data', icon: 'data_object', ext: ['json', 'yaml', 'yml', 'toml', 'csv'] },
    { kind: 'doc', icon: 'description', ext: ['txt', 'md', 'log', 'rst'] },
    { kind: 'pdf', icon: 'picture_as_pdf', ext: ['pdf'] },
    { kind: 'archive', icon: 'folder_zip', ext: ['zip', 'tar', 'gz', 'rar', '7z'] }
  ];

  var TEXT_KINDS = { code: 1, markup: 1, data: 1, doc: 1, plain: 1 };

  function extname(name) {
    var dot = String(name).lastIndexOf('.');
    return dot > 0 ? String(name).slice(dot + 1).toLowerCase() : '';
  }

  fs.extname = extname;

  /** { kind, icon } describing how a name should be presented. */
  fs.kindOf = function (name, isDirectory) {
    if (isDirectory) return { kind: 'dir', icon: 'folder' };
    var ext = extname(name);
    for (var i = 0; i < KINDS.length; i++) {
      if (KINDS[i].ext.indexOf(ext) !== -1) return { kind: KINDS[i].kind, icon: KINDS[i].icon };
    }
    return { kind: 'plain', icon: 'draft' };
  };

  /** Whether a file is safe to show in the text editor. */
  fs.isTextFile = function (path, cwd) {
    var abs = normalize(path, cwd);
    var node = find(abs);
    if (!node || node.t !== 'f') return false;
    if (node.b) return false;
    return !!TEXT_KINDS[fs.kindOf(basename(abs), false).kind];
  };

  fs.formatSize = function (bytes) {
    if (bytes < 1024) return bytes + ' B';
    var units = ['KB', 'MB', 'GB'];
    var value = bytes / 1024;
    var i = 0;
    while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
    return (value < 10 ? value.toFixed(1) : Math.round(value)) + ' ' + units[i];
  };

  fs.formatDate = function (ms) {
    var d = new Date(ms);
    var date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    var time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    return date + ', ' + time;
  };

  global.AxiomFS = fs;
})(window);
