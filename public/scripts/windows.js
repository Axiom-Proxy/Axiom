const openWindows = {};

        /*
         * Fold the dock away while a window is maximized, and let the window
         * take the strip of height the dock normally reserves.
         *
         * WinBox sizes a maximized window as viewport minus its top/bottom
         * margins, and we open windows with bottom: 86 to clear the floating
         * dock. On maximize we drop that margin to the screen inset so the
         * window runs to the bottom edge, and flag <body> so the dock folds
         * down (revealable on hover, same as auto-hide). Every path back —
         * restore, minimize, close — puts the margin and the dock back.
         */
        (function patchWinBoxMaximize() {
            const proto = window.WinBox && window.WinBox.prototype;
            if (!proto) return;

            const MAX_BOTTOM = 8; // matches #taskbar's own bottom inset
            const origMaximize = proto.maximize;
            const origRestore = proto.restore;
            const origMinimize = proto.minimize;
            const origClose = proto.close;

            function restoreBottom(wb) {
                if (wb._axSavedBottom != null) {
                    wb.bottom = wb._axSavedBottom;
                    wb._axSavedBottom = null;
                }
            }

            function anyMaximized() {
                for (const key in openWindows) {
                    const wb = openWindows[key];
                    if (wb && !wb.closed && wb.max && !wb.min) return true;
                }
                return false;
            }

            function syncDock() {
                document.body.classList.toggle('windows-maximized', anyMaximized());
            }

            proto.maximize = function (state) {
                // Maximizing a window that sits in the dock has to bring it
                // out properly first, or it stays stowed and invisible.
                if (state !== false && this.min && this.window) {
                    this.restore();
                    if (this.max) return this;
                }
                // maximize(false) is WinBox's own restore path.
                if (state === false) {
                    restoreBottom(this);
                } else if (!this.max) {
                    this._axSavedBottom = this.bottom;
                    this.bottom = MAX_BOTTOM;
                }
                const r = origMaximize.call(this, state);
                syncDock();
                return r;
            };

            /*
             * WinBox lines every minimized window up as a title-bar stub along
             * the foot of the screen, and re-lays that whole row out whenever
             * any window joins or leaves it. Our minimized windows live in the
             * dock instead, so put each one back at the geometry it had when
             * it went - otherwise a window still pouring into the dock gets
             * snapped into a stub the moment a second window minimizes.
             */
            function pinMinimized() {
                for (const key in openWindows) {
                    const wb = openWindows[key];
                    if (wb && wb.min && wb.window && wb._axMinGeom) {
                        Object.assign(wb.window.style, wb._axMinGeom);
                    }
                }
            }

            // A genie still running has the window scaled, which would make
            // any measurement of it wrong; stop it where it is first.
            function stopGenie(wb) {
                if (wb._genie) { wb._genie.cancel(); wb._genie = null; }
                if (wb.window) wb.window.style.transformOrigin = '';
            }

            proto.minimize = function (state) {
                if (state === false || this.min || !this.window) {
                    const r = origMinimize.call(this, state);
                    syncDock();
                    return r;
                }
                stopGenie(this);

                // WinBox drops the maximized state on the way down; remember
                // it so the window comes back the way it left.
                this._axWasMax = !!this.max;
                if (this.max) restoreBottom(this);

                // Keep the window where and how big it was, so the genie can
                // start from the window the user was looking at.
                const st = this.window.style;
                const was = { left: st.left, top: st.top, width: st.width, height: st.height };
                const from = this.window.getBoundingClientRect();
                this.addClass('no-animation');
                const r = origMinimize.call(this, state);
                this._axMinGeom = was;
                pinMinimized();
                void this.window.offsetWidth;
                this.removeClass('no-animation');
                syncDock();
                genie(this, from, false);
                return r;
            };

            proto.restore = function () {
                if (!this.min || !this.window) {
                    restoreBottom(this);
                    const r = origRestore.call(this);
                    syncDock();
                    return r;
                }
                stopGenie(this);
                const wasMax = this._axWasMax;
                this._axWasMax = false;
                this._axMinGeom = null;

                // Jump straight back to the saved geometry (or to maximized)
                // and let the genie, not a left/top transition, do the moving.
                this.addClass('no-animation');
                restoreBottom(this);
                const r = origRestore.call(this);
                pinMinimized();
                if (wasMax) this.maximize();
                void this.window.offsetWidth;
                this.removeClass('no-animation');
                syncDock();
                genie(this, this.window.getBoundingClientRect(), true);
                return r;
            };

            // Bringing a minimized window forward - from its dock icon, the
            // Window menu, or another app - means taking it out of the dock.
            const origFocus = proto.focus;
            proto.focus = function (state) {
                if (state !== false && this.min && this.window) this.restore();
                return origFocus.call(this, state);
            };

            // A short fade on the way out, as macOS gives a closing window.
            proto.close = function (force) {
                // Already on its way out: a second close (Close All, say)
                // would otherwise tear the window down twice.
                if (this.closing) return;
                // A minimized window has nothing on screen to fade out.
                if (this.min && this.window) stopGenie(this);
                if (!this.window || this.min || reduceMotion()) {
                    const r = origClose.apply(this, arguments);
                    pinMinimized();
                    if (!r) this.closed = true;
                    syncDock();
                    return r;
                }
                this.closing = true;
                const fade = this.window.animate(
                    [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(0.97)' }],
                    { duration: 150, easing: 'ease-in', fill: 'forwards' }
                );
                fade.onfinish = () => {
                    if (!this.window) return;
                    const r = origClose.call(this, force);
                    pinMinimized();
                    if (r) {
                        // Something vetoed the close: bring the window back.
                        this.closing = false;
                        fade.cancel();
                    } else {
                        this.closed = true;
                    }
                    syncDock();
                };
            };
        })();

        function reduceMotion() {
            return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
        }

        /*
         * The genie, approximately: the window is scaled about the centre of
         * its dock icon, so it pours down into the icon rather than fading
         * where it stood. It narrows faster than it shortens on the way, which
         * is most of what makes the real effect read as a funnel.
         */
        function genie(wb, rect, reverse) {
            const dom = wb.window;
            if (!dom) return;
            if (wb._genie) { wb._genie.cancel(); wb._genie = null; }

            const tile = wb._axKey && document.getElementById('btn-' + wb._axKey);
            const target = tile && tile.getBoundingClientRect();
            const hasTile = !!(target && target.width);
            const tx = hasTile ? target.left + target.width / 2 : innerWidth / 2;
            const ty = hasTile ? target.top + target.height / 2 : innerHeight;

            const done = () => {
                wb._genie = null;
                dom.style.transformOrigin = '';
                if (!reverse && wb.min) wb.addClass('stowed');
            };

            if (reverse) wb.removeClass('stowed');
            if (reduceMotion() || !rect.width) { done(); return; }

            dom.style.transformOrigin = (tx - rect.left) + 'px ' + (ty - rect.top) + 'px';
            const end = Math.max(0.02, (hasTile ? target.width : 48) / rect.width);
            const frames = [
                { transform: 'scale(1, 1)', opacity: 1, offset: 0 },
                { transform: 'scale(0.42, 0.72)', opacity: 0.92, offset: 0.45 },
                { transform: 'scale(' + end + ', ' + end + ')', opacity: 0, offset: 1 }
            ];
            if (reverse) frames.reverse().forEach(f => { f.offset = 1 - f.offset; });

            wb._genie = dom.animate(frames, {
                duration: reverse ? 360 : 420,
                easing: reverse ? 'cubic-bezier(0.2, 0.8, 0.3, 1)' : 'cubic-bezier(0.5, 0, 0.75, 0.4)'
            });
            wb._genie.onfinish = done;
        }

        const WP_KEY = 'axiom_wallpaper';
        const WP_CUSTOM_KEY = 'axiom_custom_wallpaper';

        function getSavedWallpaper() {
            return localStorage.getItem(WP_KEY) || window.AxiomDesk?.DEFAULT_WALLPAPER || 'forest';
        }

        function getCustomWallpaper() {
            return localStorage.getItem(WP_CUSTOM_KEY);
        }

        function applyWallpaper() {
            const customWp = getCustomWallpaper();
            const savedWp = getSavedWallpaper();

            if (customWp && savedWp === '_custom') {
                document.documentElement.style.setProperty('--wallpaper', `url("${customWp}")`);
            } else {
                document.documentElement.style.setProperty('--wallpaper', `url("/assets/wallpapers/${savedWp}.webp")`);
            }
        }

        applyWallpaper();
        window.addEventListener('storage', function (event) {
            if (event.key === 'axiom_theme_id' || event.key === WP_KEY || event.key === WP_CUSTOM_KEY || event.key === 'axiom_wallpaper_broadcast') {
                applyWallpaper();
            }
        });

        /* ------------------------------------------------- running apps */

        // Glyphs for the apps that have no pinned dock icon of their own.
        const APP_GLYPHS = {
            chat: 'chat',
            lmstudio: 'neurology',
            defender: 'security',
            'games-web': 'stadia_controller'
        };

        /*
         * An app that is running but not pinned gets a dock icon for as long
         * as it is open, to the right of a separator - which is also where
         * its window minimizes to.
         */
        function addTransientTile(title, key, opts) {
            const items = document.querySelector('#taskbar .dock-items');
            if (!items) return null;

            if (!items.querySelector('.dock-sep')) {
                const sep = document.createElement('div');
                sep.className = 'dock-sep';
                items.appendChild(sep);
            }

            const tile = document.createElement('div');
            tile.className = 'taskbar-btn transient';
            tile.id = 'btn-' + key;
            tile.dataset.label = title;
            tile.dataset.app = key;

            const art = document.createElement('span');
            art.className = 'app-squircle';
            if (opts.img) {
                const img = document.createElement('img');
                img.src = opts.img;
                img.alt = '';
                img.draggable = false;
                art.appendChild(img);
            } else {
                const glyph = document.createElement('span');
                glyph.className = 'material-symbols-outlined';
                glyph.textContent = opts.icon || APP_GLYPHS[key] ||
                    (key.indexOf('game:') === 0 ? 'sports_esports' : 'web_asset');
                art.appendChild(glyph);
            }
            tile.appendChild(art);

            const dot = document.createElement('span');
            dot.className = 'indicator';
            tile.appendChild(dot);

            tile.addEventListener('click', () => {
                const wb = openWindows[key];
                if (wb && !wb.closed) activateWindow(wb);
            });
            items.appendChild(tile);
            return tile;
        }

        function removeTransientTile(tile) {
            tile.classList.add('leaving');
            tile.removeAttribute('id');
            setTimeout(() => {
                tile.remove();
                const items = document.querySelector('#taskbar .dock-items');
                const sep = items && items.querySelector('.dock-sep');
                if (sep && !items.querySelector('.taskbar-btn.transient:not(.leaving)')) sep.remove();
            }, 240);
        }

        function bounce(tile) {
            if (!tile || reduceMotion()) return;
            tile.classList.remove('bounce');
            void tile.offsetWidth;
            tile.classList.add('bounce');
            tile.addEventListener('animationend', function done(e) {
                if (e.animationName !== 'dock-bounce') return;
                tile.classList.remove('bounce');
                tile.removeEventListener('animationend', done);
            });
        }

        /*
         * Clicking the dock icon of the window already in front minimizes it,
         * as a taskbar does. The press itself blurs that window (WinBox drops
         * focus on any mousedown outside a window), so note which window was
         * in front before that happens.
         */
        let dockPressWindow = null;
        document.addEventListener('pointerdown', e => {
            const tile = e.target.closest && e.target.closest('#taskbar .taskbar-btn');
            const wb = tile && openWindows[tile.dataset.app];
            dockPressWindow = (wb && !wb.closed && !wb.closing && !wb.min && wb.focused) ? wb : null;
        }, true);
        // Clear it once the click has been handled, so a later open from a
        // menu or the keyboard never mistakes itself for a dock press.
        document.addEventListener('click', () => { dockPressWindow = null; });

        function activateWindow(wb) {
            if (wb === dockPressWindow) {
                dockPressWindow = null;
                wb.minimize();
            } else {
                wb.focus();
            }
        }

        function openWindow(title, key, page, opts = {}) {
            const existing = openWindows[key];
            if (existing && !existing.closed && !existing.closing) {
                activateWindow(existing);
                return;
            }

            let btn = document.getElementById('btn-' + key);
            if (!btn) btn = addTransientTile(title, key, opts);
            const transient = !!(btn && btn.classList.contains('transient'));

            const classes = ['no-full'];
            if (opts.chromeless) classes.push('no-header');

            const wb = new WinBox({
                title: title,
                width: Math.min(760, window.innerWidth - 24),
                height: Math.min(540, window.innerHeight - 130),
                x: 'center',
                y: 'center',
                // Keep windows clear of the menu bar and the floating dock.
                top: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--menubar-h')) || 34,
                bottom: 86,
                class: classes,
                html: `<iframe src="./${page}" class="window-frame"></iframe>`,
                onclose() {
                    // The same app may already have been reopened while this
                    // window was fading out; only clear what is still ours.
                    if (openWindows[key] !== this) return false;
                    delete openWindows[key];
                    if (btn) {
                        if (transient) removeTransientTile(btn);
                        else btn.classList.remove('open');
                    }
                    if (key === 'lmstudio') lmProviderGone();
                    return false;
                }
            });

            wb._axKey = key;
            if (opts.chromeless) addCustomControls(wb);

            openWindows[key] = wb;
            if (btn) {
                btn.classList.add('open');
                bounce(btn);
            }
        }

        function addCustomControls(wb) {
            const root = wb.body.parentElement;
            const controls = document.createElement('div');
            controls.className = 'wb-custom-controls';
            // Minimize, maximize, close - the Windows order, at the right of
            // the tab strip. Their glyphs are drawn by the stylesheet,
            // matching the framed windows' cluster.
            controls.innerHTML = `
                <button class="wb-cc-btn wb-cc-min" data-action="min" title="Minimize"></button>
                <button class="wb-cc-btn wb-cc-max" data-action="max" title="Maximize"></button>
                <button class="wb-cc-btn wb-cc-close" data-action="close" title="Close"></button>
            `;
            controls.addEventListener('mousedown', e => e.stopPropagation());
            controls.addEventListener('click', e => {
                const actionBtn = e.target.closest('.wb-cc-btn');
                if (!actionBtn) return;
                switch (actionBtn.dataset.action) {
                    case 'min': wb.minimize(); break;
                    case 'max': wb.max ? wb.restore() : wb.maximize(); break;
                    case 'close': wb.close(); break;
                }
            });
            root.appendChild(controls);
        }

        function findWindowBySource(source) {
            for (const key in openWindows) {
                const wb = openWindows[key];
                const iframe = wb.body && wb.body.querySelector('iframe');
                if (iframe && iframe.contentWindow === source) return wb;
            }
            return null;
        }

        /* ----------------------------------------------- local model broker */

        /*
         * The LM Studio window owns the only copy of the model, so every other
         * window has to reach it through here. This end keeps the registration,
         * renumbers request ids so two windows cannot collide, and fans the
         * reply events back to whoever asked.
         *
         * A request that arrives with no LM Studio window open starts one and
         * waits: the point of the endpoint is that `claude` can pick a local
         * model without the user having to set the engine up first.
         */
        const lm = {
            provider: null,     // the LM Studio window
            state: null,        // its last published state
            calls: new Map(),   // rid -> { source, id }
            queued: [],         // requests waiting on the window to come up
            seq: 0,
            opening: false
        };

        const LM_READY_TIMEOUT = 45000;

        function lmProviderAlive() {
            const wb = openWindows['lmstudio'];
            if (!wb || wb.closed) return false;
            const iframe = wb.body && wb.body.querySelector('iframe');
            return !!(iframe && lm.provider && iframe.contentWindow === lm.provider);
        }

        function lmFail(source, id, message) {
            source.postMessage({
                type: 'axiom:lm-event', id,
                event: { kind: 'error', message }
            }, '*');
        }

        function lmDispatch(entry) {
            const rid = ++lm.seq;
            lm.calls.set(rid, { source: entry.source, id: entry.id });
            lm.provider.postMessage({
                type: 'axiom:lm-invoke', rid, kind: entry.kind, payload: entry.payload
            }, '*');
            entry.rid = rid;
        }

        function lmEnqueue(entry) {
            lm.queued.push(entry);
            if (lm.opening) return;

            lm.opening = true;
            openWindow('LM Studio', 'lmstudio', 'lmstudio.html');

            setTimeout(() => {
                if (!lm.opening) return;
                lm.opening = false;
                const waiting = lm.queued.splice(0);
                waiting.forEach(item => lmFail(item.source, item.id,
                    'LM Studio did not come up. Open it from the dock and try again.'));
            }, LM_READY_TIMEOUT);
        }

        function lmFlush() {
            lm.opening = false;
            lm.queued.splice(0).forEach(lmDispatch);
        }

        function lmCancel(source, id) {
            // Not dispatched yet: drop it before it ever reaches the engine.
            const pending = lm.queued.findIndex(e => e.source === source && e.id === id);
            if (pending !== -1) {
                const [entry] = lm.queued.splice(pending, 1);
                lmFail(entry.source, entry.id, 'Cancelled.');
                return;
            }
            for (const [rid, call] of lm.calls) {
                if (call.source !== source || call.id !== id) continue;
                if (lm.provider) lm.provider.postMessage({ type: 'axiom:lm-cancel', rid }, '*');
                return;
            }
        }

        /** The window went away mid-call; nothing is going to answer those. */
        function lmProviderGone() {
            lm.provider = null;
            lm.state = null;
            for (const [, call] of lm.calls) {
                lmFail(call.source, call.id, 'LM Studio was closed while the request was running.');
            }
            lm.calls.clear();
        }

        function handleLmMessage(data, source) {
            if (data.type === 'axiom:lm-ready') {
                lm.provider = source;
                lm.state = data.state || null;
                lmFlush();
                return true;
            }

            if (data.type === 'axiom:lm-state') {
                if (source !== lm.provider) return true;
                lm.state = data.state || null;
                return true;
            }

            if (data.type === 'axiom:lm-event') {
                if (source !== lm.provider) return true;
                const call = lm.calls.get(data.rid);
                if (!call) return true;
                const event = data.event || {};
                if (event.kind === 'done' || event.kind === 'error') lm.calls.delete(data.rid);
                call.source.postMessage({ type: 'axiom:lm-event', id: call.id, event }, '*');
                return true;
            }

            if (data.type === 'axiom:lm-request') {
                const entry = { source, id: data.id, kind: data.kind, payload: data.payload };
                if (lmProviderAlive()) lmDispatch(entry);
                else { lm.provider = null; lmEnqueue(entry); }
                return true;
            }

            if (data.type === 'axiom:lm-cancel') {
                lmCancel(source, data.id);
                return true;
            }

            return false;
        }

        let activeDrag = null;

        function endDrag() {
            if (!activeDrag) return;
            activeDrag.wb.removeClass('no-animation');
            activeDrag = null;
        }

        function osBridgeReply(source, id, result, error) {
            source.postMessage({ type: 'axiom:reply', id, result, error: error || null }, '*');
        }

        window.addEventListener('message', event => {
            const data = event.data;
            if (!data || typeof data !== 'object') return;

            if (typeof data.type === 'string' && data.type.indexOf('axiom:lm-') === 0) {
                if (handleLmMessage(data, event.source)) return;
            }

            if (data.type === 'axiom:open-window') {
                // A window asking for another app - the terminal's `open`/`edit`
                // commands use this to bring up Files.
                openWindow(data.title, data.key, data.page, data.opts || {});
            } else if (data.type === 'axiom:eval') {
                let result, error;
                try { result = String(eval(data.code) ?? ''); } catch (e) { error = e.message; }
                osBridgeReply(event.source, data.id, result, error);
            } else if (data.type === 'axiom:list-windows') {
                const list = Object.entries(openWindows).map(([key, wb]) => ({
                    key,
                    title: wb.title || key,
                    closed: !!wb.closed
                }));
                osBridgeReply(event.source, data.id, list);
            } else if (data.type === 'axiom:window-control') {
                const wb = openWindows[data.key];
                if (wb && !wb.closed) {
                    if (data.action === 'focus') wb.focus();
                    else if (data.action === 'close') wb.close();
                    else if (data.action === 'minimize') wb.minimize();
                    else if (data.action === 'maximize') wb.max ? wb.restore() : wb.maximize();
                }
            } else if (data.type === 'axiom:drag-start') {
                const wb = findWindowBySource(event.source);
                if (!wb) return;
                wb.focus();
                wb.addClass('no-animation');
                activeDrag = { wb, anchorX: data.x, anchorY: data.y, origX: wb.x, origY: wb.y };
            } else if (data.type === 'axiom:drag-move') {
                if (!activeDrag || findWindowBySource(event.source) !== activeDrag.wb) return;
                const dx = data.x - activeDrag.anchorX;
                const dy = data.y - activeDrag.anchorY;
                activeDrag.wb.move(activeDrag.origX + dx, activeDrag.origY + dy);
            } else if (data.type === 'axiom:drag-end') {
                endDrag();
            } else if (data.type === 'axiom:drag-maximize-toggle') {
                const wb = findWindowBySource(event.source);
                if (!wb) return;
                wb.max ? wb.restore() : wb.maximize();
            }
        });

        window.addEventListener('mouseup', endDrag);
        window.addEventListener('blur', endDrag);

        // How the menu-bar clock is written is up to the user: 12- or 24-hour,
        // with or without seconds, with or without the date beside it.
        function trayPrefs() {
            const desk = window.AxiomDesk;
            return desk ? desk.all() : { bar24h: false, barSeconds: false, barDate: true, barBattPct: false };
        }

        function updateTray() {
            const clockEl = document.getElementById('tray-clock');
            const dateEl = document.getElementById('tray-date');
            const now = new Date();
            const p = trayPrefs();

            if (clockEl) {
                const opts = { hour: p.bar24h ? '2-digit' : 'numeric', minute: '2-digit', hour12: !p.bar24h };
                if (p.barSeconds) opts.second = '2-digit';
                clockEl.textContent = now.toLocaleTimeString(undefined, opts);
            }
            if (dateEl) {
                // The macOS menu bar writes the date as 'Thu Sep 4', with no
                // comma - which toLocaleDateString puts in for most locales.
                dateEl.textContent = now.toLocaleDateString(undefined, {
                    weekday: 'short', month: 'short', day: 'numeric'
                }).replace(/,/g, '');
                dateEl.hidden = !p.barDate;
            }
            updateBatteryIcon();
        }

        function updateBatteryIcon(level) {
            const icon = document.getElementById('battery-icon');
            if (!icon) return;
            if (navigator.getBattery) {
                navigator.getBattery().then(function (battery) {
                    const pct = Math.round(battery.level * 100);
                    const charging = battery.charging;
                    icon.textContent = charging ? 'battery_charging_full' : batteryIconFor(pct);
                    const btn = document.getElementById('btn-battery');
                    if (btn) btn.title = 'Battery: ' + pct + '%' + (charging ? ' (charging)' : '');

                    // The percentage is opt-in, and rides next to the glyph.
                    let label = document.getElementById('battery-pct');
                    if (trayPrefs().barBattPct) {
                        if (!label && btn) {
                            label = document.createElement('span');
                            label.id = 'battery-pct';
                            label.className = 'mb-batt-pct';
                            btn.appendChild(label);
                        }
                        if (label) label.textContent = pct + '%';
                    } else if (label) {
                        label.remove();
                    }
                });
            }
        }

        function batteryIconFor(pct) {
            if (pct >= 97) return 'battery_full';
            if (pct >= 85) return 'battery_6_bar';
            if (pct >= 70) return 'battery_5_bar';
            if (pct >= 55) return 'battery_4_bar';
            if (pct >= 40) return 'battery_3_bar';
            if (pct >= 25) return 'battery_2_bar';
            if (pct >= 10) return 'battery_1_bar';
            if (pct >= 5) return 'battery_low';
            return 'battery_0_bar';
        }

        if (document.getElementById('tray-time')) {
            updateTray();
            setInterval(updateTray, 1000);
            // A change to the clock format should land now, not on the next tick.
            if (window.AxiomDesk) window.AxiomDesk.on(updateTray);
        }

        /* -------------------------------------------------------- autorun */

        const autoRanPaths = new Set();

        function runAutoScript(path, code) {
            try {
                // eslint-disable-next-line no-new-func
                new Function(code)();
                console.info('[autorun]', path);
            } catch (e) {
                console.error('[autorun] error in', path, e);
            }
        }

        function scanAndRunAutoScripts() {
            let entries;
            try { entries = AxiomFS.walk('/'); } catch (e) { return; }
            for (const entry of entries) {
                if (!entry.isFile || !entry.path.endsWith('.auto.js')) continue;
                if (autoRanPaths.has(entry.path)) continue;
                autoRanPaths.add(entry.path);
                try {
                    const code = AxiomFS.readFile(entry.path);
                    window.runAutoScript(entry.path, code);
                } catch (e) {
                    console.error('[autorun] could not read', entry.path, e);
                }
            }
        }

        AxiomFS.ready.then(() => {
            scanAndRunAutoScripts();
            AxiomFS.on(({ path }) => {
                if (!path || !path.endsWith('.auto.js')) return;
                if (autoRanPaths.has(path)) return;
                // Small delay so the write is fully committed before we read.
                setTimeout(() => {
                    try {
                        const code = AxiomFS.readFile(path);
                        autoRanPaths.add(path);
                        window.runAutoScript(path, code);
                    } catch (e) {
                        console.error('[autorun] could not read', path, e);
                    }
                }, 50);
            });
        });
