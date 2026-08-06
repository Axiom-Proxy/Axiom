const openWindows = {};

        const wallpaperThemes = new Set(['default', 'midnight', 'ocean', 'forest', 'ember', 'aurora', "pippa"]);

        function applyWallpaper() {
            const themeId = window.axiomTheme ? window.axiomTheme.getSavedId() : 'default';
            const wallpaper = wallpaperThemes.has(themeId) ? themeId : 'default';
            document.documentElement.style.setProperty('--wallpaper', `url("/assets/wallpapers/${wallpaper}.webp")`);
        }

        applyWallpaper();
        window.addEventListener('storage', function (event) {
            if (event.key === 'axiom_theme_id') applyWallpaper();
        });

        function openWindow(title, key, page, opts = {}) {
            const btn = document.getElementById('btn-' + key);

            if (openWindows[key] && !openWindows[key].closed) {
                openWindows[key].focus();
                return;
            }

            const classes = ['no-full'];
            if (opts.chromeless) classes.push('no-header');

            const wb = new WinBox({
                title: title,
                width: '760px',
                height: '540px',
                x: 'center',
                y: 'center',
                bottom: 44,
                class: classes,
                html: `<iframe src="./${page}" class="window-frame"></iframe>`,
                onclose() {
                    delete openWindows[key];
                    if (btn) btn.classList.remove('open');
                    if (key === 'lmstudio') lmProviderGone();
                    return false;
                }
            });

            if (opts.chromeless) addCustomControls(wb);

            openWindows[key] = wb;
            if (btn) btn.classList.add('open');
        }

        function addCustomControls(wb) {
            const root = wb.body.parentElement;
            const controls = document.createElement('div');
            controls.className = 'wb-custom-controls';
            controls.innerHTML = `
                <button class="wb-cc-btn" data-action="min" title="Minimize"><span class="material-symbols-outlined">remove</span></button>
                <button class="wb-cc-btn" data-action="max" title="Maximize"><span class="material-symbols-outlined">crop_square</span></button>
                <button class="wb-cc-btn wb-cc-close" data-action="close" title="Close"><span class="material-symbols-outlined">close</span></button>
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
                    'LM Studio did not come up. Open it from the taskbar and try again.'));
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

        function updateTray() {
            const clockEl = document.getElementById('tray-clock');
            const dateEl = document.getElementById('tray-date');
            const now = new Date();

            if (clockEl) {
                let hours = now.getHours();
                const minutes = now.getMinutes().toString().padStart(2, '0');
                const ampm = hours >= 12 ? 'PM' : 'AM';
                hours = hours % 12 || 12;
                clockEl.textContent = hours + ':' + minutes + ' ' + ampm;
            }
            if (dateEl) {
                dateEl.textContent = now.toLocaleDateString(undefined, {
                    month: 'numeric', day: 'numeric', year: 'numeric'
                });
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
