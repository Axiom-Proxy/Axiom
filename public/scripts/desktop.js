/*
 * Desktop icons: a live view of ~/Desktop rendered onto the wallpaper.
 *
 * Opening anything hands off to the Files app; the menus and dialogs come from
 * AxiomFilesUI so they behave exactly as they do there.
 *
 * Icons can be drag-reordered; the order is persisted in localStorage so it
 * survives reloads.
 */
(function () {
    'use strict';

    const fs = window.AxiomFS;
    const ui = window.AxiomFilesUI;
    const DESKTOP = fs.HOME + '/Desktop';
    const DS_KEY = 'axiom_desktop_shortcuts';
    const DS_ORDER_KEY = 'axiom_desktop_order';
    const DS_CHANNEL = 'axiom-desktop';

    let desktopChannel = null;
    try {
        if (window.BroadcastChannel) desktopChannel = new BroadcastChannel(DS_CHANNEL);
    } catch (e) { desktopChannel = null; }

    // Built-in app shortcuts that always appear on the desktop.
    const APP_SHORTCUTS = [
        { title: 'Chat',         key: 'chat',      page: 'chat.html',      icon: 'chat' },
        { title: 'Files',        key: 'files',     page: 'explorer.html',  icon: 'folder' },
        { title: 'LM Studio',    key: 'lmstudio',  page: 'lmstudio.html',  icon: 'neurology' },
        { title: 'Axiom Defender', key: 'defender', page: 'defender.html', icon: 'security' },
        { title: 'Theater',      key: 'theater',   page: 'theater.html',   icon: 'movie' },
        { title: 'Settings',     key: 'settings',  page: 'settings.html',  icon: 'settings' }
    ];

    const state = {
        selection: new Set(),
        lastClicked: null,
        clipboard: null
    };

    let layer = null;
    let dragReorder = null;  // { el, id } while the user drags an icon to reorder

    /* --------------------------------------------------- order persistence */

    function getOrder() {
        try { return JSON.parse(localStorage.getItem(DS_ORDER_KEY)) || []; }
        catch { return []; }
    }

    function setOrder(order) {
        localStorage.setItem(DS_ORDER_KEY, JSON.stringify(order));
    }

    /* Delete stale entries from the order (icons that no longer exist). */
    function pruneOrder(validIds) {
        const set = new Set(validIds);
        const order = getOrder().filter(id => set.has(id));
        if (order.length !== getOrder().length) setOrder(order);
        return order;
    }

    /* -------------------------------------------------------- shortcuts */

    function userShortcuts() {
        try { return JSON.parse(localStorage.getItem(DS_KEY)) || []; }
        catch { return []; }
    }

    function removeUserShortcut(name) {
        const shortcuts = userShortcuts().filter(s => s.name !== name);
        localStorage.setItem(DS_KEY, JSON.stringify(shortcuts));
        // Remove from order too
        const order = getOrder().filter(id => id !== iconId({ name: name }));
        setOrder(order);
        render();
        if (desktopChannel) desktopChannel.postMessage({ type: 'refresh' });
    }

    function iconId(shortcut) {
        return 'user:' + shortcut.name;
    }

    function resolveImgSrc(src) {
        if (!src) return '';
        if (/^(https?:\/\/|data:)/i.test(src)) return src;
        return new URL(src, location.origin + '/').href;
    }

    /* ----------------------------------------------------- file helpers */

    function entries() {
        try { return fs.list(DESKTOP).filter(e => e.name.charAt(0) !== '.'); }
        catch { return []; }
    }

    function thumbnailFor(entry) {
        if (fs.kindOf(entry.name, entry.isDirectory).kind !== 'image') return null;
        try {
            const data = fs.readFile(entry.path);
            if (entry.binary) return data;
            if (fs.extname(entry.name) === 'svg')
                return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(data);
        } catch (e) { /* fall back */ }
        return null;
    }

    /* ---------------------------------------------------------- render */

    function render() {
        if (!layer) return;
        const list = entries();

        // --- Build a flat list of every icon that should appear ---
        const allIcons = [];

        // 1. File-system entries
        list.forEach(entry => {
            const kind = fs.kindOf(entry.name, entry.isDirectory);
            const thumb = thumbnailFor(entry);
            allIcons.push({
                id: 'file:' + entry.path,
                class: 'desktop-icon' +
                    (state.selection.has(entry.path) ? ' selected' : '') +
                    (entry.isDirectory ? ' is-dir' : ''),
                dataset: { path: entry.path },
                draggable: true,
                title: entry.name,
                html:
                    `<div class="desktop-icon-art ${kind.kind}">` +
                    (thumb
                        ? `<img src="${ui.escHtml(thumb)}" alt="">`
                        : `<span class="material-symbols-outlined">${kind.icon}</span>`) +
                    `</div>` +
                    `<div class="desktop-icon-label">${ui.escHtml(entry.name)}</div>`
            });
        });

        // 2. User-added shortcuts
        userShortcuts().forEach((shortcut, idx) => {
            const imgSrc = resolveImgSrc(shortcut.img);
            const fallbackIcon = shortcut.type === 'game' ? 'sports_esports' : 'widgets';

            const artHtml = imgSrc
                ? `<img src="${ui.escHtml(imgSrc)}" alt="" onerror="var s=document.createElement('span');s.className='material-symbols-outlined';s.textContent='${fallbackIcon}';this.replaceWith(s)">`
                : `<span class="material-symbols-outlined">${fallbackIcon}</span>`;

            allIcons.push({
                id: iconId(shortcut),
                class: 'desktop-icon user-shortcut',
                dataset: {
                    shortcutIdx: String(idx),
                    shortcutName: shortcut.name,
                    shortcutUrl: shortcut.url,
                    shortcutType: shortcut.type
                },
                draggable: true,
                title: shortcut.name,
                html:
                    `<div class="desktop-icon-art app">${artHtml}</div>` +
                    `<div class="desktop-icon-label">${ui.escHtml(shortcut.name)}</div>`
            });
        });

        // 3. Built-in shortcuts
        APP_SHORTCUTS.forEach(shortcut => {
            allIcons.push({
                id: 'builtin:' + shortcut.key,
                class: 'desktop-icon app-shortcut',
                dataset: { key: shortcut.key, page: shortcut.page, title: shortcut.title },
                draggable: true,
                title: shortcut.title,
                html:
                    `<div class="desktop-icon-art app">` +
                    `<span class="material-symbols-outlined">${shortcut.icon}</span>` +
                    `</div>` +
                    `<div class="desktop-icon-label">${ui.escHtml(shortcut.title)}</div>`
            });
        });

        // --- Sort by persisted order ---
        const validIds = allIcons.map(i => i.id);
        const order = pruneOrder(validIds);

        allIcons.sort((a, b) => {
            const ai = order.indexOf(a.id);
            const bi = order.indexOf(b.id);
            if (ai === -1 && bi === -1) return 0;   // both new
            if (ai === -1) return 1;                 // a new → end
            if (bi === -1) return -1;                // b new → end
            return ai - bi;
        });

        // Append new icons (not yet in order) to the order so they are
        // persisted for the next render.
        const newIds = allIcons.map(i => i.id).filter(id => order.indexOf(id) === -1);
        if (newIds.length) setOrder([...order, ...newIds]);

        // --- Render ---
        layer.innerHTML = '';
        allIcons.forEach(icon => {
            const el = document.createElement('div');
            el.className = icon.class;
            el.draggable = icon.draggable;
            el.title = icon.title;
            el.dataset.iconId = icon.id;
            Object.assign(el.dataset, icon.dataset);
            el.innerHTML = icon.html;
            layer.appendChild(el);
        });

        layer.classList.toggle('empty', allIcons.length === 0);
    }

    /* -------------------------------------------------------- selection */

    function refreshSelection() {
        if (!layer) return;
        const cut = state.clipboard && state.clipboard.cut ? state.clipboard.paths : [];
        layer.querySelectorAll('.desktop-icon').forEach(el => {
            el.classList.toggle('selected', state.selection.has(el.dataset.path));
            el.classList.toggle('cut', cut.indexOf(el.dataset.path) !== -1);
        });
    }

    function selected() {
        return Array.from(state.selection);
    }

    function open(path) {
        let stat;
        try { stat = fs.stat(path); } catch (e) { render(); return; }
        ui.openInFiles(stat.path, stat.isFile);
    }

    function handleClick(e, path) {
        const list = entries();

        if (e.shiftKey && state.lastClicked) {
            const from = list.findIndex(entry => entry.path === state.lastClicked);
            const to   = list.findIndex(entry => entry.path === path);
            if (from !== -1 && to !== -1) {
                const [start, end] = from < to ? [from, to] : [to, from];
                state.selection = new Set(list.slice(start, end + 1).map(e => e.path));
                refreshSelection();
                return;
            }
        }

        if (e.ctrlKey || e.metaKey) {
            if (state.selection.has(path)) state.selection.delete(path);
            else state.selection.add(path);
        } else {
            state.selection = new Set([path]);
        }
        state.lastClicked = path;
        refreshSelection();
    }

    /* ------------------------------------------------------------- menus */

    function iconMenu(stat) {
        const many = state.selection.size > 1;
        const canPaste = !!(state.clipboard && state.clipboard.paths.length);

        return [
            { label: 'Open', icon: 'open_in_new', action: () => open(stat.path) },
            stat.isDirectory
                ? { label: 'Open in Files', icon: 'folder_open', action: () => ui.openInFiles(stat.path, false) }
                : { label: 'Edit', icon: 'edit_note', disabled: stat.binary, action: () => ui.openInFiles(stat.path, true) },
            { divider: true },
            { label: 'Cut',      icon: 'content_cut',   hint: 'Ctrl+X', action: () => setClipboard(true) },
            { label: 'Copy',     icon: 'content_copy',  hint: 'Ctrl+C', action: () => setClipboard(false) },
            stat.isDirectory
                ? { label: 'Paste into', icon: 'content_paste', disabled: !canPaste, action: () => pasteInto(stat.path) }
                : null,
            { label: 'Duplicate', icon: 'file_copy',
                action: () => { state.selection = new Set(ui.ops.duplicate(selected())); render(); } },
            { divider: true },
            { label: 'Rename',   icon: 'drive_file_rename_outline', hint: 'F2', disabled: many, action: renameSelection },
            stat.isDirectory ? null
                : { label: 'Download', icon: 'download', disabled: many, action: () => ui.ops.download(stat.path) },
            { label: 'Delete',   icon: 'delete',  hint: 'Del', danger: true, action: deleteSelection },
            { divider: true },
            { label: 'Properties', icon: 'info', action: () => ui.ops.properties(stat.path) }
        ];
    }

    function desktopMenu() {
        const canPaste = !!(state.clipboard && state.clipboard.paths.length);
        return [
            { label: 'New folder', icon: 'create_new_folder', action: async () => {
                const path = await ui.ops.createFolder(DESKTOP);
                if (path) selectOnly(path);
            }},
            { label: 'New file', icon: 'note_add', action: async () => {
                const path = await ui.ops.createFile(DESKTOP);
                if (!path) return;
                selectOnly(path);
                ui.openInFiles(path, true);
            }},
            { divider: true },
            { label: 'Paste',   icon: 'content_paste', hint: 'Ctrl+V', disabled: !canPaste, action: paste },
            { label: 'Select all', icon: 'select_all', hint: 'Ctrl+A', action: () => {
                state.selection = new Set(entries().map(e => e.path));
                refreshSelection();
            }},
            { divider: true },
            { label: 'Open Files here', icon: 'folder_open', action: () => ui.openInFiles(DESKTOP, false) },
            { label: 'Open Terminal',   icon: 'terminal',    action: () => openWindow('Terminal', 'terminal', 'terminal.html') },
            { divider: true },
            { label: 'Refresh',    icon: 'refresh',    action: render },
            { label: 'Properties', icon: 'info',       action: () => ui.ops.properties(DESKTOP) }
        ];
    }

    /* -------------------------------------------------------- operations */

    function selectOnly(path) {
        state.selection = new Set([path]);
        state.lastClicked = path;
        render();
    }

    function setClipboard(cut) {
        const paths = selected();
        if (!paths.length) return;
        state.clipboard = { paths: paths, cut: cut };
        refreshSelection();
    }

    function paste() {
        const created = ui.ops.paste(state.clipboard, DESKTOP);
        if (state.clipboard && state.clipboard.cut) state.clipboard = null;
        state.selection = new Set(created);
        render();
    }

    function pasteInto(path) {
        ui.ops.paste(state.clipboard, path);
        if (state.clipboard && state.clipboard.cut) state.clipboard = null;
        render();
    }

    async function renameSelection() {
        const paths = selected();
        if (paths.length !== 1) return;
        const moved = await ui.ops.rename(paths[0]);
        if (moved) selectOnly(moved);
    }

    async function deleteSelection() {
        if (await ui.ops.remove(selected())) {
            state.selection.clear();
            render();
        }
    }

    /* ------------------------------------------------------------ wiring */

    function finishDragReorder() {
        // Clear any lingering drop-zone highlights
        if (layer) {
            layer.querySelectorAll('.drop-reorder-before, .drop-reorder-after').forEach(n =>
                n.classList.remove('drop-reorder-before', 'drop-reorder-after'));
        }
        dragReorder = null;
    }

    function init() {
        layer = document.getElementById('desktop-icons');
        if (!layer) return;

        /* -------------------------------------------- click / double-click */

        layer.addEventListener('click', e => {
            const el = e.target.closest('.desktop-icon');
            if (!el || el.classList.contains('app-shortcut') || el.classList.contains('user-shortcut')) return;
            handleClick(e, el.dataset.path);
        });

        layer.addEventListener('dblclick', e => {
            const el = e.target.closest('.desktop-icon');
            if (!el) return;
            if (el.classList.contains('app-shortcut')) {
                openWindow(el.dataset.title, el.dataset.key, el.dataset.page);
                return;
            }
            if (el.classList.contains('user-shortcut')) {
                const name = el.dataset.shortcutName;
                const url  = el.dataset.shortcutUrl;
                const type = el.dataset.shortcutType;
                const key  = 'shortcut-' + encodeURIComponent(name);
                if (type === 'game')
                    openWindow(name, key, 'game.html?url=' + encodeURIComponent(btoa(url)) + '&title=' + encodeURIComponent(name));
                else
                    openWindow(name, key, 'render.html?url=' + btoa(url));
                return;
            }
            open(el.dataset.path);
        });

        /* -------------------------------------------------- context menu */

        layer.addEventListener('contextmenu', e => {
            const el = e.target.closest('.desktop-icon');
            e.preventDefault();
            e.stopPropagation();

            if (!el) { ui.showMenu(desktopMenu(), e.clientX, e.clientY); return; }
            if (el.classList.contains('app-shortcut')) {
                ui.showMenu([
                    { label: 'Open', icon: 'open_in_new',
                        action: () => openWindow(el.dataset.title, el.dataset.key, el.dataset.page) }
                ], e.clientX, e.clientY);
                return;
            }
            if (el.classList.contains('user-shortcut')) {
                const name = el.dataset.shortcutName;
                const url  = el.dataset.shortcutUrl;
                const type = el.dataset.shortcutType;
                const key  = 'shortcut-' + encodeURIComponent(name);
                ui.showMenu([
                    { label: 'Open', icon: 'open_in_new', action: () => {
                        if (type === 'game')
                            openWindow(name, key, 'game.html?url=' + encodeURIComponent(btoa(url)) + '&title=' + encodeURIComponent(name));
                        else
                            openWindow(name, key, 'render.html?url=' + btoa(url));
                    }},
                    { divider: true },
                    { label: 'Remove from Desktop', icon: 'delete', danger: true,
                        action: () => removeUserShortcut(name) }
                ], e.clientX, e.clientY);
                return;
            }
            if (!state.selection.has(el.dataset.path)) {
                state.selection = new Set([el.dataset.path]);
                state.lastClicked = el.dataset.path;
                refreshSelection();
            }
            try {
                ui.showMenu(iconMenu(fs.stat(el.dataset.path)), e.clientX, e.clientY);
            } catch (err) {
                render();
            }
        });

        /* The icon layer stops taking pointer events when the icons are
         * hidden (or when there are none), which used to hand the wallpaper
         * back to the browser's own context menu. The desktop underneath
         * catches those, so the menu is the same either way. The layer's
         * handler stops propagation, so this never fires twice. */
        const desktop = document.getElementById('desktop') || document.body;
        desktop.addEventListener('contextmenu', e => {
            if (e.defaultPrevented) return;
            e.preventDefault();
            ui.showMenu(desktopMenu(), e.clientX, e.clientY);
        });

        /* --------------------------------------------- mousedown on empty */

        layer.addEventListener('mousedown', e => {
            if (e.button !== 0 || e.target.closest('.desktop-icon')) return;
            state.selection.clear();
            refreshSelection();
        });

        /* ============================== DRAG-AND-DROP REORDERING ===== */

        layer.addEventListener('dragstart', e => {
            const el = e.target.closest('.desktop-icon');
            if (!el || !el.dataset.iconId) return;

            // If it's a file icon, also populate the folder-drop data
            if (el.dataset.path) {
                if (!state.selection.has(el.dataset.path))
                    state.selection = new Set([el.dataset.path]);
                e.dataTransfer.setData('application/axiom-paths', JSON.stringify(selected()));
            }

            dragReorder = { el: el, id: el.dataset.iconId };
            e.dataTransfer.effectAllowed = 'move';
            requestAnimationFrame(() => el.classList.add('dragging'));
        });

        layer.addEventListener('dragend', e => {
            const el = e.target.closest('.desktop-icon');
            if (el) el.classList.remove('dragging');
            finishDragReorder();
        });

        layer.addEventListener('dragover', e => {
            // If the drag carries folder-drop data, let that handler take over
            if (e.dataTransfer.types.includes('application/axiom-paths')) {
                const el = e.target.closest('.desktop-icon.is-dir');
                layer.querySelectorAll('.drop-target').forEach(t => t.classList.remove('drop-target'));
                if (el && !state.selection.has(el.dataset.path)) {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    el.classList.add('drop-target');
                }
                // Also clear reorder highlights if folder-drag is active
                layer.querySelectorAll('.drop-reorder-before, .drop-reorder-after').forEach(n =>
                    n.classList.remove('drop-reorder-before', 'drop-reorder-after'));
                return;
            }

            if (!dragReorder) return;
            const el = e.target.closest('.desktop-icon');
            if (!el || el === dragReorder.el) {
                layer.querySelectorAll('.drop-reorder-before, .drop-reorder-after').forEach(n =>
                    n.classList.remove('drop-reorder-before', 'drop-reorder-after'));
                return;
            }

            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';

            layer.querySelectorAll('.drop-reorder-before, .drop-reorder-after').forEach(n =>
                n.classList.remove('drop-reorder-before', 'drop-reorder-after'));

            const rect = el.getBoundingClientRect();
            if (e.clientX < rect.left + rect.width / 2)
                el.classList.add('drop-reorder-before');
            else
                el.classList.add('drop-reorder-after');
        });

        layer.addEventListener('drop', e => {
            // Folder drop takes priority
            const folderEl = e.target.closest('.desktop-icon.is-dir');
            if (folderEl && e.dataTransfer.types.includes('application/axiom-paths')) {
                layer.querySelectorAll('.drop-target').forEach(t => t.classList.remove('drop-target'));
                e.preventDefault();
                let paths;
                try { paths = JSON.parse(e.dataTransfer.getData('application/axiom-paths')); } catch (err) { return; }
                ui.ops.move(paths, folderEl.dataset.path);
                state.selection.clear();
                render();
                finishDragReorder();
                return;
            }

            if (!dragReorder) return;
            const el = e.target.closest('.desktop-icon');
            const dragged = dragReorder;
            finishDragReorder();

            if (!el || el === dragged.el) return;
            e.preventDefault();

            // Determine drop position
            const rect = el.getBoundingClientRect();
            const dropBefore = e.clientX < rect.left + rect.width / 2;

            // Build new order from current DOM children
            const children = Array.from(layer.children);
            const newOrder = children.map(c => c.dataset.iconId).filter(Boolean);
            const dragIdx = newOrder.indexOf(dragged.id);
            if (dragIdx !== -1) newOrder.splice(dragIdx, 1);

            let targetIdx = newOrder.indexOf(el.dataset.iconId);
            if (!dropBefore) targetIdx++;
            if (targetIdx > newOrder.length) targetIdx = newOrder.length;
            newOrder.splice(targetIdx, 0, dragged.id);

            setOrder(newOrder);
            dragReorder = null;
            render();
        });

        /* ============================================================== */

        document.addEventListener('keydown', e => {
            if (ui.isDialogOpen()) return;
            if (e.target.closest('.winbox, input, textarea')) return;
            if (!state.selection.size && ['Delete', 'F2'].indexOf(e.key) !== -1) return;

            switch (e.key) {
                case 'Delete': e.preventDefault(); deleteSelection(); break;
                case 'F2':     e.preventDefault(); renameSelection(); break;
                case 'Escape': state.selection.clear(); refreshSelection(); break;
                case 'Enter': {
                    const paths = selected();
                    if (paths.length !== 1) return;
                    e.preventDefault();
                    open(paths[0]);
                    break;
                }
                case 'a': if (e.ctrlKey || e.metaKey) {
                    e.preventDefault();
                    state.selection = new Set(entries().map(e => e.path));
                    refreshSelection();
                } break;
                case 'c': if ((e.ctrlKey || e.metaKey) && state.selection.size) {
                    e.preventDefault(); setClipboard(false);
                } break;
                case 'x': if ((e.ctrlKey || e.metaKey) && state.selection.size) {
                    e.preventDefault(); setClipboard(true);
                } break;
                case 'v': if (e.ctrlKey || e.metaKey) {
                    e.preventDefault(); paste();
                } break;
            }
        });

        // BroadcastChannel: listen for shortcut changes from apps/games
        if (desktopChannel) {
            desktopChannel.onmessage = function () { render(); };
        }

        // Storage events from other tabs
        window.addEventListener('storage', function (e) {
            if (e.key === DS_KEY) render();
        });

        // Filesystem changes
        fs.on(() => {
            state.selection.forEach(path => {
                if (!fs.exists(path)) state.selection.delete(path);
            });
            render();
        });

        fs.ready.then(() => {
            if (!fs.exists(DESKTOP)) {
                try { fs.mkdir(DESKTOP, { recursive: true }); } catch (e) {}
            }
            render();
        });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();