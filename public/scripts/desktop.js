/*
 * Desktop icons: a live view of ~/Desktop rendered onto the wallpaper.
 *
 * Opening anything hands off to the Files app; the menus and dialogs come from
 * AxiomFilesUI so they behave exactly as they do there.
 */
(function () {
    'use strict';

    const fs = window.AxiomFS;
    const ui = window.AxiomFilesUI;
    const DESKTOP = fs.HOME + '/Desktop';

    // Apps that used to live in the taskbar now live here instead, so the
    // taskbar can stay down to the essentials (web, apps, games, terminal).
    const APP_SHORTCUTS = [
        { title: 'Chat', key: 'chat', page: 'chat.html', icon: 'chat' },
        { title: 'Files', key: 'files', page: 'explorer.html', icon: 'folder' },
        { title: 'LM Studio', key: 'lmstudio', page: 'lmstudio.html', icon: 'neurology' },
        { title: 'Axiom Defender', key: 'defender', page: 'defender.html', icon: 'security' },
        { title: 'Settings', key: 'settings', page: 'settings.html', icon: 'settings' }
    ];

    const state = {
        selection: new Set(),
        lastClicked: null,
        clipboard: null
    };

    let layer = null;

    function entries() {
        try {
            return fs.list(DESKTOP).filter(entry => entry.name.charAt(0) !== '.');
        } catch (e) {
            return [];
        }
    }

    function thumbnailFor(entry) {
        if (fs.kindOf(entry.name, entry.isDirectory).kind !== 'image') return null;
        try {
            const data = fs.readFile(entry.path);
            if (entry.binary) return data;
            if (fs.extname(entry.name) === 'svg') {
                return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(data);
            }
        } catch (e) { /* fall back to the generic icon */ }
        return null;
    }

    function render() {
        if (!layer) return;
        const list = entries();
        layer.innerHTML = '';

        list.forEach(entry => {
            const kind = fs.kindOf(entry.name, entry.isDirectory);
            const thumb = thumbnailFor(entry);

            const el = document.createElement('div');
            el.className = 'desktop-icon' +
                (state.selection.has(entry.path) ? ' selected' : '') +
                (entry.isDirectory ? ' is-dir' : '');
            el.dataset.path = entry.path;
            el.draggable = true;
            el.title = entry.name;
            el.innerHTML =
                `<div class="desktop-icon-art ${kind.kind}">` +
                (thumb
                    ? `<img src="${ui.escHtml(thumb)}" alt="">`
                    : `<span class="material-symbols-outlined">${kind.icon}</span>`) +
                `</div>` +
                `<div class="desktop-icon-label">${ui.escHtml(entry.name)}</div>`;

            layer.appendChild(el);
        });

        APP_SHORTCUTS.forEach(shortcut => {
            const el = document.createElement('div');
            el.className = 'desktop-icon app-shortcut';
            el.dataset.key = shortcut.key;
            el.dataset.page = shortcut.page;
            el.dataset.title = shortcut.title;
            el.draggable = false;
            el.title = shortcut.title;
            el.innerHTML =
                `<div class="desktop-icon-art app">` +
                `<span class="material-symbols-outlined">${shortcut.icon}</span>` +
                `</div>` +
                `<div class="desktop-icon-label">${ui.escHtml(shortcut.title)}</div>`;
            layer.appendChild(el);
        });

        layer.classList.toggle('empty', list.length === 0 && APP_SHORTCUTS.length === 0);
    }

    /** Selection styling only - never rebuild between the halves of a dblclick. */
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
        // Folders open in Files; files open there too, in its editor or preview.
        ui.openInFiles(stat.path, stat.isFile);
    }

    function handleClick(e, path) {
        const list = entries();

        if (e.shiftKey && state.lastClicked) {
            const from = list.findIndex(entry => entry.path === state.lastClicked);
            const to = list.findIndex(entry => entry.path === path);
            if (from !== -1 && to !== -1) {
                const [start, end] = from < to ? [from, to] : [to, from];
                state.selection = new Set(list.slice(start, end + 1).map(entry => entry.path));
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
            { label: 'Cut', icon: 'content_cut', hint: 'Ctrl+X', action: () => setClipboard(true) },
            { label: 'Copy', icon: 'content_copy', hint: 'Ctrl+C', action: () => setClipboard(false) },
            stat.isDirectory
                ? { label: 'Paste into', icon: 'content_paste', disabled: !canPaste, action: () => pasteInto(stat.path) }
                : null,
            {
                label: 'Duplicate', icon: 'file_copy', action: () => {
                    state.selection = new Set(ui.ops.duplicate(selected()));
                    render();
                }
            },
            { divider: true },
            {
                label: 'Rename', icon: 'drive_file_rename_outline', hint: 'F2', disabled: many,
                action: renameSelection
            },
            stat.isDirectory ? null
                : { label: 'Download', icon: 'download', disabled: many, action: () => ui.ops.download(stat.path) },
            { label: 'Delete', icon: 'delete', hint: 'Del', danger: true, action: deleteSelection },
            { divider: true },
            { label: 'Properties', icon: 'info', action: () => ui.ops.properties(stat.path) }
        ];
    }

    function desktopMenu() {
        const canPaste = !!(state.clipboard && state.clipboard.paths.length);
        return [
            {
                label: 'New folder', icon: 'create_new_folder', action: async () => {
                    const path = await ui.ops.createFolder(DESKTOP);
                    if (path) selectOnly(path);
                }
            },
            {
                label: 'New file', icon: 'note_add', action: async () => {
                    const path = await ui.ops.createFile(DESKTOP);
                    if (!path) return;
                    selectOnly(path);
                    ui.openInFiles(path, true);
                }
            },
            { divider: true },
            { label: 'Paste', icon: 'content_paste', hint: 'Ctrl+V', disabled: !canPaste, action: paste },
            {
                label: 'Select all', icon: 'select_all', hint: 'Ctrl+A', action: () => {
                    state.selection = new Set(entries().map(entry => entry.path));
                    refreshSelection();
                }
            },
            { divider: true },
            { label: 'Open Files here', icon: 'folder_open', action: () => ui.openInFiles(DESKTOP, false) },
            { label: 'Open Terminal', icon: 'terminal', action: () => openWindow('Terminal', 'terminal', 'terminal.html') },
            { divider: true },
            { label: 'Refresh', icon: 'refresh', action: render },
            { label: 'Properties', icon: 'info', action: () => ui.ops.properties(DESKTOP) }
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

    function init() {
        layer = document.getElementById('desktop-icons');
        if (!layer) return;

        layer.addEventListener('click', e => {
            const el = e.target.closest('.desktop-icon');
            if (!el || el.classList.contains('app-shortcut')) return;
            handleClick(e, el.dataset.path);
        });

        layer.addEventListener('dblclick', e => {
            const el = e.target.closest('.desktop-icon');
            if (!el) return;
            if (el.classList.contains('app-shortcut')) {
                openWindow(el.dataset.title, el.dataset.key, el.dataset.page);
                return;
            }
            open(el.dataset.path);
        });

        layer.addEventListener('contextmenu', e => {
            const el = e.target.closest('.desktop-icon');
            e.preventDefault();
            e.stopPropagation();

            if (!el) { ui.showMenu(desktopMenu(), e.clientX, e.clientY); return; }
            if (el.classList.contains('app-shortcut')) {
                ui.showMenu([
                    { label: 'Open', icon: 'open_in_new', action: () => openWindow(el.dataset.title, el.dataset.key, el.dataset.page) }
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

        layer.addEventListener('mousedown', e => {
            if (e.button !== 0 || e.target.closest('.desktop-icon')) return;
            state.selection.clear();
            refreshSelection();
        });

        // Dragging an icon onto a folder on the desktop moves it in.
        layer.addEventListener('dragstart', e => {
            const el = e.target.closest('.desktop-icon');
            if (!el) return;
            if (!state.selection.has(el.dataset.path)) state.selection = new Set([el.dataset.path]);
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('application/axiom-paths', JSON.stringify(selected()));
        });

        layer.addEventListener('dragover', e => {
            const el = e.target.closest('.desktop-icon.is-dir');
            layer.querySelectorAll('.drop-target').forEach(t => t.classList.remove('drop-target'));
            if (!el || !e.dataTransfer.types.includes('application/axiom-paths')) return;
            if (state.selection.has(el.dataset.path)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            el.classList.add('drop-target');
        });

        layer.addEventListener('drop', e => {
            const el = e.target.closest('.desktop-icon.is-dir');
            layer.querySelectorAll('.drop-target').forEach(t => t.classList.remove('drop-target'));
            if (!el) return;
            e.preventDefault();

            let paths;
            try { paths = JSON.parse(e.dataTransfer.getData('application/axiom-paths')); } catch (err) { return; }
            ui.ops.move(paths, el.dataset.path);
            state.selection.clear();
            render();
        });

        document.addEventListener('keydown', e => {
            // Ignore anything typed into a window, or while a dialog is up.
            if (ui.isDialogOpen()) return;
            if (e.target.closest('.winbox, input, textarea')) return;
            if (!state.selection.size && ['Delete', 'F2'].indexOf(e.key) !== -1) return;

            switch (e.key) {
                case 'Delete': e.preventDefault(); deleteSelection(); break;
                case 'F2': e.preventDefault(); renameSelection(); break;
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
                    state.selection = new Set(entries().map(entry => entry.path));
                    refreshSelection();
                } break;
                case 'c': if ((e.ctrlKey || e.metaKey) && state.selection.size) { e.preventDefault(); setClipboard(false); } break;
                case 'x': if ((e.ctrlKey || e.metaKey) && state.selection.size) { e.preventDefault(); setClipboard(true); } break;
                case 'v': if (e.ctrlKey || e.metaKey) { e.preventDefault(); paste(); } break;
            }
        });

        // Anything the terminal or Files app does shows up here too.
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
