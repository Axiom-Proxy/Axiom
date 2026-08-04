/*
 * Real SSH sessions for the terminal, run entirely in the browser.
 *
 * The SSH protocol itself executes here, in a Go/WASM client. Bytes reach the
 * remote host over a Wisp TCP stream (the same /edu/ endpoint the proxy uses),
 * so the server moves ciphertext and never sees a password, a key or a
 * keystroke. Output is rendered by xterm.js, which — unlike the line renderer
 * in terminal.js — is a real VT emulator, so curses apps and colour work.
 *
 *   var program = AxiomSSH.createProgram({ argv: ['user@host'] });
 *   program.start(host);   // see terminal.js for the host contract
 */
(function (global) {
    'use strict';

    var WASM_EXEC = '/ssh/vendor/wasm_exec.js';
    var WASM_BINARY = '/ssh/vendor/sshclient.wasm';
    var XTERM_JS = '/ssh/xterm/xterm.js';
    var XTERM_CSS = '/ssh/xterm-css/xterm.css';
    var WISP_URL = (location.protocol === 'https:' ? 'wss:' : 'ws:') +
        '//' + location.host + '/edu/';

    var wasmReady = null;
    var xtermReady = null;
    var wispConn = null;

    /* ------------------------------------------------------------ loading */

    function loadScript(src) {
        return new Promise(function (resolve, reject) {
            var existing = document.querySelector('script[data-src="' + src + '"]');
            if (existing) { resolve(); return; }
            var el = document.createElement('script');
            el.src = src;
            el.dataset.src = src;
            el.onload = function () { resolve(); };
            el.onerror = function () { reject(new Error('failed to load ' + src)); };
            document.head.appendChild(el);
        });
    }

    /** Boot the Go runtime once per page; it registers window.SSHClient. */
    function loadWasm() {
        if (wasmReady) return wasmReady;
        wasmReady = loadScript(WASM_EXEC).then(function () {
            var go = new global.Go();
            var source = fetch(WASM_BINARY);
            var instantiate = WebAssembly.instantiateStreaming
                ? WebAssembly.instantiateStreaming(source, go.importObject)
                : source.then(function (r) { return r.arrayBuffer(); })
                    .then(function (b) { return WebAssembly.instantiate(b, go.importObject); });

            return instantiate.then(function (result) {
                go.run(result.instance);
                // go.run() returns before the Go side finishes registering.
                return new Promise(function (resolve, reject) {
                    var waited = 0;
                    (function poll() {
                        if (global.SSHClient) return resolve(global.SSHClient);
                        if ((waited += 50) > 10000) return reject(new Error('WASM client did not start'));
                        setTimeout(poll, 50);
                    })();
                });
            });
        });
        return wasmReady;
    }

    function loadXterm() {
        if (xtermReady) return xtermReady;
        if (!document.querySelector('link[data-src="' + XTERM_CSS + '"]')) {
            var link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = XTERM_CSS;
            link.dataset.src = XTERM_CSS;
            document.head.appendChild(link);
        }
        xtermReady = loadScript(XTERM_JS).then(function () { return global.Terminal; });
        return xtermReady;
    }

    /* -------------------------------------------------------------- wisp */

    /** One multiplexed Wisp connection is shared by every SSH tab. */
    function wispConnection() {
        if (wispConn && wispConn.connected) return Promise.resolve(wispConn.conn);
        return import('/wisp/wisp-client.mjs').then(function (mod) {
            var conn = new mod.client.ClientConnection(WISP_URL);
            wispConn = { conn: conn, connected: true };
            conn.onclose = function () { wispConn = null; };
            return new Promise(function (resolve, reject) {
                conn.onopen = function () { resolve(conn); };
                conn.onerror = function () {
                    wispConn = null;
                    reject(new Error('could not reach the Wisp relay'));
                };
            });
        });
    }

    /* ------------------------------------------------------------- argv */

    /** `ssh user@host -p 2222` -> { username, host, port }. */
    function parseTarget(argv) {
        var target = null, port = null, identity = null, loginName = null;

        for (var i = 0; i < argv.length; i++) {
            var arg = argv[i];
            if (arg === '-p') { port = argv[++i]; continue; }
            if (arg === '-i') { identity = argv[++i]; continue; }
            if (arg === '-l') { loginName = argv[++i]; continue; }
            if (arg.charAt(0) === '-') continue;
            if (target == null) target = arg;
        }

        if (!target) return null;

        var at = target.lastIndexOf('@');
        var username = at === -1 ? '' : target.slice(0, at);
        var hostPart = at === -1 ? target : target.slice(at + 1);

        if (loginName) username = loginName; // -l wins, as in OpenSSH

        var colon = hostPart.lastIndexOf(':');
        if (colon !== -1 && hostPart.indexOf(']') === -1 && /^\d+$/.test(hostPart.slice(colon + 1))) {
            if (port == null) port = hostPart.slice(colon + 1);
            hostPart = hostPart.slice(0, colon);
        }

        if (!hostPart) return null;
        return {
            username: username,
            host: hostPart,
            port: Number(port) || 22,
            identity: identity
        };
    }

    /* ---------------------------------------------------------- program */

    function createProgram(options) {
        var argv = options.argv || [];
        var cwd = options.cwd || '/';
        var host = null;          // terminal host
        var term = null;          // xterm instance
        var session = null;       // wasm SSH session
        var stream = null;        // wisp TCP stream
        var spinner = null;
        var resizeObserver = null;
        var transportId = 'ssh-' + Math.random().toString(36).slice(2);
        var bytesUp = 0, bytesDown = 0;
        var finished = false;

        function teardown() {
            if (finished) return;
            finished = true;
            if (spinner) { spinner.stop(); spinner = null; }
            if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null; }
            if (session) { try { session.disconnect(); } catch (e) {} session = null; }
            if (stream) { try { stream.close(); } catch (e) {} stream = null; }
            if (term) { try { term.dispose(); } catch (e) {} term = null; }
        }

        function finish(message, cls) {
            var announce = !finished && message;
            teardown();
            if (!host) return;
            host.unmount();
            if (announce) host.write(message, cls || 'term-hint');
            host.setBusy(false);
            host.exit();
        }

        function readIdentity(path) {
            try {
                var stat = global.AxiomFS.stat(path, cwd);
                if (stat.binary) throw new Error('binary');
                return global.AxiomFS.readFile(stat.path);
            } catch (e) {
                throw new Error('cannot read identity file ' + path);
            }
        }

        /*
         * Prompt inside xterm, masking the input.
         *
         * An empty submission is ignored rather than accepted. The Enter that
         * ran `ssh host` in the line editor can still be in flight when xterm
         * takes focus, and xterm delivers it here as a stray carriage return -
         * accepting it would send an empty password and fail authentication
         * before the user has typed anything.
         */
        function askSecret(prompt) {
            return new Promise(function (resolve) {
                term.write('\r\n' + prompt);
                var buffer = '';
                var sub = term.onData(function (data) {
                    // A paste arrives as one chunk, wrapped in bracketed-paste
                    // markers when the mode is on; without stripping them the
                    // literal "[200~" would land in the secret.
                    data = data.replace(/\x1b\[20[01]~/g, '');
                    for (var i = 0; i < data.length; i++) {
                        var ch = data[i];
                        if (ch === '\r' || ch === '\n') {
                            if (!buffer) continue;
                            sub.dispose();
                            term.write('\r\n');
                            resolve(buffer);
                            return;
                        }
                        if (ch === '\x03') { sub.dispose(); term.write('\r\n'); resolve(null); return; }
                        if (ch === '\x7f' || ch === '\b') {
                            if (buffer) { buffer = buffer.slice(0, -1); term.write('\b \b'); }
                            continue;
                        }
                        if (ch >= ' ') { buffer += ch; term.write('*'); }
                    }
                });
            });
        }

        function mountTerminal(Terminal, target) {
            var mount = host.mount();
            mount.innerHTML =
                '<div class="term-mount-bar">' +
                '<span class="term-mount-label"></span>' +
                '<button class="term-mount-close" type="button">Disconnect</button>' +
                '</div>' +
                '<div class="term-mount-surface"></div>';

            mount.querySelector('.term-mount-label').textContent =
                'ssh ' + (target.username ? target.username + '@' : '') +
                target.host + (target.port !== 22 ? ':' + target.port : '');
            mount.querySelector('.term-mount-close')
                .addEventListener('click', function () { finish('Connection closed.'); });

            var surface = mount.querySelector('.term-mount-surface');
            term = new Terminal({
                fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
                fontSize: 13,
                cursorBlink: true,
                convertEol: false,
                // The panel is translucent over the desktop, so the terminal
                // draws on nothing of its own and the ANSI palette is taken
                // from the colours the local shell already prints with.
                allowTransparency: true,
                theme: {
                    background: 'rgba(0, 0, 0, 0)',
                    foreground: 'rgba(255, 255, 255, 0.88)',
                    cursor: 'rgba(255, 255, 255, 0.85)',
                    cursorAccent: 'rgba(0, 0, 0, 0.6)',
                    selectionBackground: 'rgba(255, 255, 255, 0.18)',

                    black: '#2b2b2b',
                    red: '#ff8a8a',
                    green: '#9ee6a8',
                    yellow: '#ffd479',
                    blue: '#8ed4f4',
                    magenta: '#f8b8d0',
                    cyan: '#99e3e8',
                    white: 'rgba(255, 255, 255, 0.88)',

                    brightBlack: 'rgba(255, 255, 255, 0.45)',
                    brightRed: '#ffa8a8',
                    brightGreen: '#b6efbe',
                    brightYellow: '#f2deb4',
                    brightBlue: '#b8c9ff',
                    brightMagenta: '#f8c9b6',
                    brightCyan: '#bde7d5',
                    brightWhite: '#ffffff'
                }
            });
            term.open(surface);
            term.focus();
            fitTerminal(surface);

            // xterm has no built-in fit without the addon; size from the box.
            resizeObserver = new ResizeObserver(function () { fitTerminal(surface); });
            resizeObserver.observe(surface);
            return term;
        }

        function fitTerminal(surface) {
            if (!term) return;
            var core = term._core;
            if (!core || !core._renderService || !core._renderService.dimensions) return;
            var dims = core._renderService.dimensions.css.cell;
            if (!dims || !dims.width || !dims.height) return;
            // clientWidth spans the padding box, so the gutter has to come off
            // or the terminal is sized wider than the space it can draw in.
            var pad = getComputedStyle(surface);
            var width = surface.clientWidth -
                parseFloat(pad.paddingLeft) - parseFloat(pad.paddingRight);
            var height = surface.clientHeight -
                parseFloat(pad.paddingTop) - parseFloat(pad.paddingBottom);
            var cols = Math.max(20, Math.floor(width / dims.width));
            var rows = Math.max(5, Math.floor(height / dims.height));
            if (cols === term.cols && rows === term.rows) return;
            term.resize(cols, rows);
            if (session && session.resizeTerminal) {
                session.resizeTerminal(cols, rows).catch(function () {});
            }
        }

        function connect(SSHClient, target) {
            return wispConnection().then(function (conn) {
                stream = conn.create_stream(target.host, target.port, 0x01);

                // wasm -> wire, and wire -> wasm. The counters make a stalled
                // handshake diagnosable: which direction stopped moving says
                // whether the relay, the remote or the client is at fault.
                SSHClient.createTransport(transportId, {
                    onWrite: function (data) {
                        bytesUp += data.length;
                        if (stream) stream.send(data);
                    },
                    onClose: function () {
                        if (stream) { try { stream.close(); } catch (e) {} stream = null; }
                    }
                });

                stream.onmessage = function (data) {
                    bytesDown += data.length;
                    SSHClient.injectTransportData(transportId, new Uint8Array(data));
                };
                stream.onclose = function () {
                    console.log('[ssh] wisp stream closed; up=' + bytesUp + ' down=' + bytesDown);
                    finish('Connection closed by remote host.');
                };

                return gatherCredentials(target);
            }).then(function (credentials) {
                if (credentials == null) { finish('Cancelled.'); return null; }

                if (spinner) { spinner.stop(); spinner = null; }
                term.write('\r\n');

                var pending = SSHClient.connect({
                    host: target.host,
                    port: target.port,
                    user: credentials.user,
                    password: credentials.password,
                    privateKey: credentials.privateKey
                }, transportId, {
                    /*
                     * Only a live session's disconnect is reported from here.
                     * A failure during connect surfaces as a rejection carrying
                     * the actual reason (bad password, unsupported algorithm),
                     * and reporting "error" here would tear the program down
                     * first and throw that reason away.
                     */
                    onStateChange: function (state) {
                        console.log('[ssh] state:', state);
                        if (state === 'disconnected' && session) finish('Connection closed.');
                    },
                    // Decrypted channel bytes carry type "data"; raw transport
                    // packets arrive on the same callback without it.
                    onPacketReceive: function (data, meta) {
                        if (meta && meta.type === 'data' && term) term.write(new Uint8Array(data));
                    }
                });

                /*
                 * The race has to be built here rather than in a later .then:
                 * returning `pending` into the chain would make the chain await
                 * it first, and a handshake that never settles would hang with
                 * no timeout ever applied.
                 */
                return Promise.race([
                    pending,
                    new Promise(function (_, reject) {
                        setTimeout(function () {
                            reject(new Error('timed out during authentication after 45s (bytes sent=' +
                                bytesUp + ', received=' + bytesDown + ')'));
                        }, 45000);
                    })
                ]);
            }).then(function (active) {
                if (!active) return;
                session = active;
                host.setBusy(true);

                term.onData(function (data) {
                    if (session) session.send(new TextEncoder().encode(data));
                });

                if (session.resizeTerminal) {
                    session.resizeTerminal(term.cols, term.rows).catch(function () {});
                }
                term.focus();
            });
        }

        /* Ask for whatever was not supplied on the command line. */
        function gatherCredentials(target) {
            var user = target.username;
            var chain = Promise.resolve();

            if (!user) {
                chain = chain.then(function () {
                    term.write('\r\n');
                    return askSecretVisible('login as: ');
                }).then(function (value) {
                    if (value == null || !value) return Promise.reject(new Error('cancelled'));
                    user = value;
                });
            }

            if (target.identity) {
                return chain.then(function () {
                    return { user: user, privateKey: readIdentity(target.identity) };
                });
            }

            return chain.then(function () {
                return askSecret(user + '@' + target.host + "'s password: ");
            }).then(function (password) {
                if (password == null) return null;
                return { user: user, password: password };
            }).catch(function (err) {
                if (String(err.message) === 'cancelled') return null;
                throw err;
            });
        }

        /** Same as askSecret but echoes, for the username prompt. */
        function askSecretVisible(prompt) {
            return new Promise(function (resolve) {
                term.write(prompt);
                var buffer = '';
                var sub = term.onData(function (data) {
                    // A paste arrives as one chunk, wrapped in bracketed-paste
                    // markers when the mode is on; without stripping them the
                    // literal "[200~" would land in the secret.
                    data = data.replace(/\x1b\[20[01]~/g, '');
                    for (var i = 0; i < data.length; i++) {
                        var ch = data[i];
                        if (ch === '\r' || ch === '\n') {
                            if (!buffer) continue; // stray Enter from the launching command
                            sub.dispose(); term.write('\r\n'); resolve(buffer); return;
                        }
                        if (ch === '\x03') { sub.dispose(); term.write('\r\n'); resolve(null); return; }
                        if (ch === '\x7f' || ch === '\b') {
                            if (buffer) { buffer = buffer.slice(0, -1); term.write('\b \b'); }
                            continue;
                        }
                        if (ch >= ' ') { buffer += ch; term.write(ch); }
                    }
                });
            });
        }

        return {
            name: 'ssh',

            start: function (terminalHost) {
                host = terminalHost;

                var target = parseTarget(argv);
                if (!target) {
                    host.write('ssh: usage: ssh [-p port] [-i identity] [user@]host', 'term-error');
                    host.exit();
                    return;
                }

                host.setBusy(true);
                spinner = host.spinner('Starting SSH client…');

                Promise.all([loadWasm(), loadXterm()]).then(function (parts) {
                    var SSHClient = parts[0];
                    var Terminal = parts[1];
                    if (finished) return;
                    if (spinner) spinner.set('Connecting to ' + target.host + '…');
                    mountTerminal(Terminal, target);
                    return connect(SSHClient, target);
                }).catch(function (err) {
                    var reason = String(err && err.message ? err.message : err);
                    // Show it in the session too: by the time the program exits
                    // the mounted terminal is gone, and the reason is the whole
                    // point of the failure.
                    if (term) {
                        term.write('\r\n\x1b[31mssh: ' + reason + '\x1b[0m\r\n');
                        console.error('[ssh]', err);
                    }
                    finish('ssh: ' + reason, 'term-error');
                });
            },

            onLine: function () {},

            onInterrupt: function () { finish('Connection closed.'); return true; },

            onClose: function () { teardown(); }
        };
    }

    global.AxiomSSH = { createProgram: createProgram };
})(window);
