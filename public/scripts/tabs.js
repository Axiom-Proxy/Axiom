const tabs = [];
        let activeTabId = null;
        let idCounter = 0;
        let renderPending = false;

        function genId() { return ++idCounter; }

        function escHtml(str) {
            return String(str)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;');
        }

        const BASE_PATH = window.location.pathname.replace(/[^/]+$/, '');

        function toDisplay(url) {
            let full;
            try { full = new URL(url, window.location.href).href; } catch(e) { return url; }
            try {
                const p = new URL(full);
                if (p.origin === window.location.origin) {
                    let path = p.pathname;
                    if (path.startsWith(BASE_PATH)) path = path.slice(BASE_PATH.length);
                    path = path.replace(/\.[^.]+$/, '');   // strip extension
                    return 'axiom://' + path;
                }
            } catch(e) {}
            return url;
        }

        function fromDisplay(input) {
            input = input.trim();
            if (input.startsWith('axiom://')) {
                const name = input.slice('axiom://'.length);
                return window.location.origin + BASE_PATH + name + '.html';
            }
            if (!input.startsWith('./') && !input.startsWith('/') && !/^[a-z][a-z\d+\-.]*:\/\//i.test(input)) {
                return 'https://' + input;
            }
            return input;
        }

        function isProxyUrl(url) {
            return url && url.includes('render.html');
        }

        // Same rules start.html uses: bare domains become https://, anything else is a search.
        function toSearchUrl(query) {
            const isUrl = /^(https?:\/\/|[a-zA-Z0-9-]+\.[a-zA-Z]{2,})/.test(query);
            if (!isUrl) return `https://search.brave.com/search?q=${encodeURIComponent(query)}`;
            return query.startsWith('http') ? query : 'https://' + query;
        }

        function proxyUrl(target) {
            let encoded;
            try { encoded = btoa(target); }
            catch(e) { encoded = btoa(unescape(encodeURIComponent(target))); }
            return BASE_PATH + 'render.html?url=' + encoded;
        }

        const SESSION_KEY = 'axiom-tabs-session';
        let restoringSession = false;

        function saveSession() {
            if (restoringSession) return;
            try {
                const data = {
                    activeIndex: tabs.findIndex(t => t.id === activeTabId),
                    tabs: tabs.map(t => ({ url: t.url, displayUrl: t.displayUrl, title: t.title }))
                };
                localStorage.setItem(SESSION_KEY, JSON.stringify(data));
            } catch(e) {}
        }

        function restoreSession() {
            try {
                const raw = localStorage.getItem(SESSION_KEY);
                if (!raw) return false;
                const data = JSON.parse(raw);
                if (!data || !Array.isArray(data.tabs) || data.tabs.length === 0) return false;
                restoringSession = true;
                let activeId = null;
                data.tabs.forEach((t, i) => {
                    if (!t || !t.url) return;
                    const tab = createTab(t.url, { title: t.title, displayUrl: t.displayUrl });
                    if (i === data.activeIndex) activeId = tab.id;
                });
                restoringSession = false;
                if (tabs.length === 0) return false;
                activateTab(activeId != null ? activeId : tabs[tabs.length - 1].id);
                return true;
            } catch(e) {
                restoringSession = false;
                return false;
            }
        }

        function faviconUrl(tab) {
            let raw = null;
            if (tab.displayUrl && /^https?:\/\//i.test(tab.displayUrl)) {
                raw = tab.displayUrl;
            } else if (/^https?:\/\//i.test(tab.url)) {
                try {
                    if (new URL(tab.url).origin !== window.location.origin) raw = tab.url;
                } catch(e) {}
            }
            if (!raw) return null;
            try {
                const host = new URL(raw).hostname;
                return `https://www.google.com/s2/favicons?sz=32&domain=${encodeURIComponent(host)}`;
            } catch(e) { return null; }
        }

        function defaultFaviconEl() {
            const span = document.createElement('span');
            span.className = 'material-symbols-outlined';
            span.textContent = 'language';
            return span;
        }

        function createTab(url = './start.html', opts = {}) {
            const id = genId();

            let displayUrl = opts.displayUrl !== undefined ? opts.displayUrl : null;
            if (displayUrl == null) {
                const renderMatch = url.match(/render\.html\?url=([^&]+)/);
                if (renderMatch) {
                    try { displayUrl = atob(renderMatch[1]); } catch(e) {}
                }
            }

            const iframe = document.createElement('iframe');
            iframe.src = url;
            iframe.addEventListener('load', () => {
                const tab = tabs.find(t => t.id === id);
                if (!tab) return;
                try {
                    const loc = iframe.contentWindow.location.href;
                    if (loc && loc !== 'about:blank') tab.url = loc;
                    const title = iframe.contentDocument?.title;
                    if (title) tab.title = title;
                } catch(e) {  }
                renderTabs();
            });

            document.getElementById('content-area').appendChild(iframe);

            const tab = { id, url, title: opts.title || 'New Tab', iframe, displayUrl };
            tabs.push(tab);
            activateTab(id);
            return tab;
        }

        function closeTab(id) {
            const idx = tabs.findIndex(t => t.id === id);
            if (idx === -1) return;
            tabs[idx].iframe.remove();
            tabs.splice(idx, 1);
            if (tabs.length === 0) { createTab(); return; }
            if (activeTabId === id) {
                activateTab(tabs[Math.min(idx, tabs.length - 1)].id);
            } else {
                renderTabs();
            }
        }

        function activateTab(id) {
            const next = tabs.find(t => t.id === id);
            if (!next) return;
            tabs.forEach(t => t.iframe.classList.remove('active'));
            next.iframe.classList.add('active');
            activeTabId = id;
            const addr = document.getElementById('address-bar');
            if (document.activeElement !== addr) {
                addr.value = next.displayUrl != null ? next.displayUrl : toDisplay(next.url);
            }
            renderTabs();
        }

        function navigateActive(raw) {
            const tab = tabs.find(t => t.id === activeTabId);
            if (!tab || !raw) return;
            const input = raw.trim();

            if (input.startsWith('axiom://')) {
                const url = fromDisplay(input);
                tab.url = url;
                tab.displayUrl = null;
                tab.title = 'Loading\u2026';
                tab.iframe.src = url;
                renderTabs();
                return;
            }

            const target = toSearchUrl(input);

            if (isProxyUrl(tab.url)) {
                tab.iframe.contentWindow.postMessage({ type: 'navigate', url: target }, '*');
                return;
            }

            tab.url = proxyUrl(target);
            tab.displayUrl = target;
            tab.title = 'Loading\u2026';
            tab.iframe.src = tab.url;
            renderTabs();
        }

        function moveTab(from, to) {
            if (from !== to && tabs[from]) {
                const [moved] = tabs.splice(from, 1);
                tabs.splice(to, 0, moved);
            } else if (!renderPending) {
                return;   // nothing moved and nothing was deferred
            }
            renderTabs();
        }

        function renderTabs() {
            // Rebuilding the strip mid-drag would tear out the tab being dragged.
            if (window.AxiomTabDrag && AxiomTabDrag.isActive()) { renderPending = true; return; }
            renderPending = false;

            const list = document.getElementById('tab-list');
            const prevScroll = list.scrollLeft;
            list.innerHTML = '';

            tabs.forEach(tab => {
                const el = document.createElement('div');
                el.className = 'tab' + (tab.id === activeTabId ? ' active' : '');
                el.dataset.id = String(tab.id);
                el.innerHTML =
                    `<div class="tab-favicon"></div>` +
                    `<span class="tab-title">${escHtml(tab.title)}</span>` +
                    `<button class="tab-close" title="Close tab"><span class="material-symbols-outlined">close</span></button>`;

                const faviconBox = el.querySelector('.tab-favicon');
                const favUrl = faviconUrl(tab);
                if (favUrl) {
                    const img = document.createElement('img');
                    img.className = 'tab-favicon-img';
                    img.src = favUrl;
                    img.alt = '';
                    img.addEventListener('error', () => img.replaceWith(defaultFaviconEl()), { once: true });
                    faviconBox.appendChild(img);
                } else {
                    faviconBox.appendChild(defaultFaviconEl());
                }

                el.querySelector('.tab-close').addEventListener('click', e => {
                    e.stopPropagation();
                    closeTab(tab.id);
                });

                // Browsers select a tab the instant you press it, then let the
                // same press turn into a drag once the cursor actually moves.
                el.addEventListener('pointerdown', e => {
                    if (e.button !== 0 || e.target.closest('.tab-close')) return;
                    e.preventDefault();
                    if (activeTabId !== tab.id) activateTab(tab.id);
                    AxiomTabDrag.start(e, document.getElementById('tab-list'), tab.id, moveTab);
                });

                list.appendChild(el);
            });

            list.scrollLeft = prevScroll;

            const active = tabs.find(t => t.id === activeTabId);
            const addr = document.getElementById('address-bar');
            if (active && document.activeElement !== addr) {
                addr.value = active.displayUrl != null ? active.displayUrl : toDisplay(active.url);
            }

            saveSession();
            paintStar();
            paintChip();
        }

        document.getElementById('btn-back').addEventListener('click', () => {
            const tab = tabs.find(t => t.id === activeTabId);
            if (!tab) return;
            if (isProxyUrl(tab.url)) {
                tab.iframe.contentWindow.postMessage({ type: 'back' }, '*');
            } else {
                try { tab.iframe.contentWindow.history.back(); } catch(e) {}
            }
        });
        document.getElementById('btn-forward').addEventListener('click', () => {
            const tab = tabs.find(t => t.id === activeTabId);
            if (!tab) return;
            if (isProxyUrl(tab.url)) {
                tab.iframe.contentWindow.postMessage({ type: 'forward' }, '*');
            } else {
                try { tab.iframe.contentWindow.history.forward(); } catch(e) {}
            }
        });
        document.getElementById('btn-refresh').addEventListener('click', () => {
            const tab = tabs.find(t => t.id === activeTabId);
            if (!tab) return;
            if (isProxyUrl(tab.url)) {
                tab.iframe.contentWindow.postMessage({ type: 'refresh' }, '*');
            } else {
                try { tab.iframe.contentWindow.location.reload(); } catch(e) { tab.iframe.src = tab.url; }
            }
        });

        window.addEventListener('message', (e) => {
            if (!e.data || e.data.type !== 'urlChange') return;
            const tab = tabs.find(t => t.iframe.contentWindow === e.source);
            if (!tab) return;
            if (e.data.url) tab.displayUrl = e.data.url;
            if (e.data.title) tab.title = e.data.title;
            renderTabs();
            if (tab.id === activeTabId) {
                const addr = document.getElementById('address-bar');
                if (document.activeElement !== addr) addr.value = tab.displayUrl || '';
            }
        });

        const addressBar = document.getElementById('address-bar');
        addressBar.addEventListener('keydown', e => {
            if (e.key === 'Enter') navigateActive(addressBar.value);
            if (e.key === 'Escape') { addressBar.blur(); }
        });
        addressBar.addEventListener('focus', () => addressBar.select());

        document.getElementById('new-tab-btn').addEventListener('click', () => createTab());

        /* ------------------------------------------------- the right-hand end
         *
         * Back, forward and refresh left the rest of the row empty. These are
         * the things a browser is actually asked for next: somewhere to keep a
         * page, a way to hand its address to something else, and a way home.
         */

        const BM_KEY = 'axiom_bookmarks';

        function readBookmarks() {
            try {
                const saved = JSON.parse(localStorage.getItem(BM_KEY) || '[]');
                return Array.isArray(saved) ? saved : [];
            } catch (e) { return []; }
        }

        function writeBookmarks(list) {
            try { localStorage.setItem(BM_KEY, JSON.stringify(list)); } catch (e) { /* full */ }
        }

        /** What the address bar is showing for the active tab, normalised. */
        function activeAddress() {
            const tab = tabs.find(t => t.id === activeTabId);
            if (!tab) return null;
            const url = tab.displayUrl != null ? tab.displayUrl : toDisplay(tab.url);
            return { url, title: (tab.title || url).replace(/…$/, '') };
        }

        const starBtn = document.getElementById('btn-star');
        const bmBtn = document.getElementById('btn-bookmarks');
        const bmPanel = document.getElementById('bm-panel');
        const bmList = document.getElementById('bm-list');
        const bmEmpty = document.getElementById('bm-empty');
        const copyBtn = document.getElementById('btn-copy');
        const homeBtn = document.getElementById('btn-home');
        const addrChip = document.getElementById('addr-chip');

        function paintStar() {
            const here = activeAddress();
            const saved = !!(here && readBookmarks().some(b => b.url === here.url));
            starBtn.classList.toggle('on', saved);
            starBtn.title = saved ? 'Remove bookmark' : 'Bookmark this page';
        }

        function renderBookmarks() {
            const list = readBookmarks();
            bmList.innerHTML = '';
            bmEmpty.hidden = list.length > 0;

            list.forEach(bm => {
                const row = document.createElement('button');
                row.type = 'button';
                row.className = 'bm-item';
                row.innerHTML =
                    '<span class="material-symbols-outlined">public</span>' +
                    '<span class="bm-text"><span class="bm-title">' + escHtml(bm.title) + '</span>' +
                    '<span class="bm-url">' + escHtml(bm.url) + '</span></span>';

                const drop = document.createElement('span');
                drop.className = 'bm-drop';
                drop.title = 'Remove';
                drop.innerHTML = '<span class="material-symbols-outlined">close</span>';
                drop.addEventListener('click', e => {
                    e.stopPropagation();
                    writeBookmarks(readBookmarks().filter(b => b.url !== bm.url));
                    renderBookmarks();
                    paintStar();
                });

                row.appendChild(drop);
                row.addEventListener('click', () => {
                    closeBookmarks();
                    navigateActive(bm.url);
                });
                bmList.appendChild(row);
            });
        }

        function closeBookmarks() { bmPanel.hidden = true; }

        starBtn.addEventListener('click', () => {
            const here = activeAddress();
            if (!here || !here.url) return;
            const list = readBookmarks();
            const at = list.findIndex(b => b.url === here.url);
            if (at === -1) list.unshift({ title: here.title, url: here.url });
            else list.splice(at, 1);
            writeBookmarks(list);
            renderBookmarks();
            paintStar();
        });

        bmBtn.addEventListener('click', e => {
            e.stopPropagation();
            const showing = !bmPanel.hidden;
            if (!showing) renderBookmarks();
            bmPanel.hidden = showing;
        });

        document.addEventListener('mousedown', e => {
            if (bmPanel.hidden) return;
            if (e.target.closest('#bm-panel') || e.target.closest('#btn-bookmarks')) return;
            closeBookmarks();
        });

        copyBtn.addEventListener('click', () => {
            const here = activeAddress();
            if (!here || !here.url) return;
            const done = () => {
                copyBtn.classList.add('done');
                const glyph = copyBtn.querySelector('.material-symbols-outlined');
                glyph.textContent = 'check';
                setTimeout(() => {
                    copyBtn.classList.remove('done');
                    glyph.textContent = 'link';
                }, 1200);
            };
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(here.url).then(done).catch(() => {});
            } else {
                // Clipboard API needs a secure context; this works anywhere.
                const pad = document.createElement('textarea');
                pad.value = here.url;
                document.body.appendChild(pad);
                pad.select();
                try { document.execCommand('copy'); done(); } catch (e) { /* denied */ }
                pad.remove();
            }
        });

        homeBtn.addEventListener('click', () => navigateActive('axiom://start'));

        /* The chip inside the pill: a proxied page is worth saying out loud. */
        function paintChip() {
            const tab = tabs.find(t => t.id === activeTabId);
            if (!tab) { addrChip.hidden = true; return; }
            const proxied = isProxyUrl(tab.url);
            addrChip.hidden = !proxied;
            addrChip.textContent = proxied ? 'Proxied' : '';
            addrChip.title = proxied
                ? 'Fetched through Axiom rather than by the browser directly'
                : '';
        }

        /* The bar's height is its padding's business, not a number typed into
         * two files. #content-area starts wherever the bar actually ends. */
        function syncChromeHeight() {
            const bar = document.getElementById('browser');
            if (!bar) return;
            document.documentElement.style.setProperty('--browser-h', bar.offsetHeight + 'px');
        }

        window.addEventListener('resize', syncChromeHeight);
        syncChromeHeight();

        document.addEventListener('keydown', e => {
            if ((e.ctrlKey || e.metaKey) && e.key === 't') { e.preventDefault(); createTab(); }
            if ((e.ctrlKey || e.metaKey) && e.key === 'w') { e.preventDefault(); if (activeTabId !== null) closeTab(activeTabId); }
            if ((e.ctrlKey || e.metaKey) && e.key === 'l') { e.preventDefault(); addressBar.focus(); }
            if ((e.ctrlKey || e.metaKey) && e.key === 'r') { e.preventDefault(); document.getElementById('btn-refresh').click(); }
        });

        function isInteractive(el) {
            return el.closest('.tab, #new-tab-btn, .nav-btn, #address-wrap, button, input, a');
        }

        function bindDragRegion(el) {
            if (!el) return;
            el.addEventListener('mousedown', e => {
                if (e.button !== 0 || isInteractive(e.target)) return;
                e.preventDefault();
                window.parent.postMessage({ type: 'axiom:drag-start', x: e.screenX, y: e.screenY }, '*');

                const onMove = me => {
                    window.parent.postMessage({ type: 'axiom:drag-move', x: me.screenX, y: me.screenY }, '*');
                };
                const onUp = () => {
                    document.removeEventListener('mousemove', onMove);
                    document.removeEventListener('mouseup', onUp);
                    window.parent.postMessage({ type: 'axiom:drag-end' }, '*');
                };
                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onUp);
            });
            el.addEventListener('dblclick', e => {
                if (isInteractive(e.target)) return;
                window.parent.postMessage({ type: 'axiom:drag-maximize-toggle' }, '*');
            });
        }
        bindDragRegion(document.getElementById('tab-bar'));
        bindDragRegion(document.getElementById('nav-bar'));

        const params = new URLSearchParams(window.location.search);
        const urlParam = params.get('url');
        if (urlParam) {
            createTab('./render.html?url=' + urlParam);
        } else if (!restoreSession()) {
            createTab();
        }
