/*
 * AxiomFilesUI - the pieces shared by every view onto AxiomFS: the context
 * menu, the prompt/confirm dialog, and the file operations that need them.
 *
 * Both the Files app and the desktop use this, so a rename behaves the same
 * way (and reports errors the same way) wherever you start it from.
 */
(function (global) {
    'use strict';

    const fs = global.AxiomFS;
    const REQUEST_KEY = 'axiom_files_request';
    const FILES_CHANNEL = 'axiom-files';

    let menuEl = null;
    let overlayEl = null;
    let dialogResolve = null;
    let filesChannel = null;

    try {
        if (global.BroadcastChannel) filesChannel = new BroadcastChannel(FILES_CHANNEL);
    } catch (e) { filesChannel = null; }

    function escHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    /** Turn an AxiomFS errno into something worth showing a person. */
    function reason(err) {
        const map = {
            ENOENT: 'That file no longer exists.',
            EEXIST: 'Something with that name already exists here.',
            ENOTDIR: 'That path is not a folder.',
            EISDIR: 'That path is a folder.',
            ENOTEMPTY: 'That folder is not empty.',
            ENOSPC: 'There is no room left. Delete something to free up space.',
            EINVAL: 'That is not a valid destination.'
        };
        return map[err.code] || err.message;
    }

    /* ------------------------------------------------------- context menu */

    function ensureMenu() {
        if (menuEl) return menuEl;
        menuEl = document.createElement('div');
        menuEl.id = 'axiom-menu';
        menuEl.className = 'axiom-hidden';
        document.body.appendChild(menuEl);

        document.addEventListener('mousedown', e => {
            if (!e.target.closest('#axiom-menu')) hideMenu();
        });
        global.addEventListener('blur', hideMenu);
        return menuEl;
    }

    /**
     * items: [{ label, icon, action, hint?, disabled?, danger? } | { divider: true }]
     */
    function showMenu(items, x, y) {
        const menu = ensureMenu();
        menu.innerHTML = '';

        items.filter(Boolean).forEach(item => {
            if (item.divider) {
                const divider = document.createElement('div');
                divider.className = 'axiom-menu-divider';
                menu.appendChild(divider);
                return;
            }
            const el = document.createElement('button');
            el.className = 'axiom-menu-item' + (item.danger ? ' danger' : '');
            el.disabled = !!item.disabled;
            el.innerHTML = `<span class="material-symbols-outlined">${item.icon}</span>` +
                `<span class="axiom-menu-label">${escHtml(item.label)}</span>` +
                (item.hint ? `<span class="axiom-menu-hint">${escHtml(item.hint)}</span>` : '');
            el.addEventListener('click', () => {
                hideMenu();
                item.action();
            });
            menu.appendChild(el);
        });

        // Unhide before measuring, so the clamp uses the real size.
        menu.classList.remove('axiom-hidden');
        const rect = menu.getBoundingClientRect();
        menu.style.left = Math.max(4, Math.min(x, innerWidth - rect.width - 8)) + 'px';
        menu.style.top = Math.max(4, Math.min(y, innerHeight - rect.height - 8)) + 'px';
    }

    function hideMenu() {
        if (menuEl) menuEl.classList.add('axiom-hidden');
    }

    /* -------------------------------------------------------------- dialog */

    function ensureDialog() {
        if (overlayEl) return overlayEl;

        overlayEl = document.createElement('div');
        overlayEl.id = 'axiom-overlay';
        overlayEl.className = 'axiom-hidden';
        overlayEl.innerHTML =
            '<div id="axiom-dialog">' +
            '  <div class="axiom-dlg-head">' +
            '    <span class="material-symbols-outlined" id="axiom-dlg-icon">edit</span>' +
            '    <span id="axiom-dlg-title"></span>' +
            '  </div>' +
            '  <div class="axiom-dlg-body">' +
            '    <p id="axiom-dlg-message"></p>' +
            '    <input id="axiom-dlg-input" type="text" autocomplete="off" spellcheck="false">' +
            '  </div>' +
            '  <div class="axiom-dlg-actions">' +
            '    <button class="axiom-dlg-btn" id="axiom-dlg-cancel">Cancel</button>' +
            '    <button class="axiom-dlg-btn primary" id="axiom-dlg-confirm">OK</button>' +
            '  </div>' +
            '</div>';
        document.body.appendChild(overlayEl);

        const input = overlayEl.querySelector('#axiom-dlg-input');

        overlayEl.querySelector('#axiom-dlg-confirm').addEventListener('click', () => {
            settle(input.classList.contains('axiom-hidden') ? true : input.value.trim() || null);
        });
        overlayEl.querySelector('#axiom-dlg-cancel').addEventListener('click', () => settle(null));
        input.addEventListener('keydown', e => {
            if (e.key === 'Enter') {
                e.preventDefault();
                overlayEl.querySelector('#axiom-dlg-confirm').click();
            }
        });
        overlayEl.addEventListener('mousedown', e => {
            if (e.target === overlayEl) settle(null);
        });

        // Capture, so the host page never also acts on this Escape.
        document.addEventListener('keydown', e => {
            if (!isDialogOpen() || e.key !== 'Escape') return;
            e.preventDefault();
            e.stopPropagation();
            settle(null);
        }, true);

        return overlayEl;
    }

    function isDialogOpen() {
        return !!overlayEl && !overlayEl.classList.contains('axiom-hidden');
    }

    function settle(value) {
        const resolve = dialogResolve;
        dialogResolve = null;
        if (overlayEl) overlayEl.classList.add('axiom-hidden');
        if (resolve) resolve(value);
    }

    /**
     * Replaces prompt()/confirm(), which are unreliable inside sandboxed
     * iframes. Resolves with the entered text, true, or null when cancelled.
     *
     * config: { title, message?, icon?, prompt?, value?, confirmLabel?,
     *           danger?, acknowledge? }
     */
    function ask(config) {
        const overlay = ensureDialog();
        hideMenu();

        return new Promise(resolve => {
            dialogResolve = resolve;
            overlay.querySelector('#axiom-dlg-icon').textContent = config.icon || 'edit';
            overlay.querySelector('#axiom-dlg-title').textContent = config.title;

            const message = overlay.querySelector('#axiom-dlg-message');
            message.textContent = config.message || '';
            message.classList.toggle('axiom-hidden', !config.message);

            const confirm = overlay.querySelector('#axiom-dlg-confirm');
            confirm.textContent = config.confirmLabel || 'OK';
            confirm.classList.toggle('danger', !!config.danger);
            overlay.querySelector('#axiom-dlg-cancel').classList.toggle('axiom-hidden', !!config.acknowledge);

            const input = overlay.querySelector('#axiom-dlg-input');
            input.classList.toggle('axiom-hidden', !config.prompt);
            input.value = config.value || '';

            overlay.classList.remove('axiom-hidden');

            if (config.prompt) {
                input.focus();
                const dot = input.value.lastIndexOf('.');
                input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
            } else {
                confirm.focus();
            }
        });
    }

    function notify(title, message, icon) {
        return ask({
            title: title,
            message: message,
            icon: icon || 'error',
            acknowledge: true,
            confirmLabel: 'Close'
        });
    }

    /* ---------------------------------------------------------- operations */

    const ops = {
        async createFolder(cwd) {
            const name = await ask({
                title: 'New folder', prompt: true, icon: 'create_new_folder',
                value: fs.uniqueName(cwd, 'New folder', 'copy'), confirmLabel: 'Create'
            });
            if (!name) return null;
            try {
                return fs.mkdir(fs.join(cwd, name));
            } catch (e) {
                await notify('Could not create folder', reason(e));
                return null;
            }
        },

        async createFile(cwd) {
            const name = await ask({
                title: 'New file', prompt: true, icon: 'note_add',
                value: fs.uniqueName(cwd, 'untitled.txt'), confirmLabel: 'Create'
            });
            if (!name) return null;
            const path = fs.join(cwd, name);
            if (fs.exists(path)) {
                await notify('Could not create file', reason({ code: 'EEXIST' }));
                return null;
            }
            try {
                return fs.writeFile(path, '');
            } catch (e) {
                await notify('Could not create file', reason(e));
                return null;
            }
        },

        async rename(path) {
            const current = fs.basename(path);
            const name = await ask({
                title: 'Rename', prompt: true, icon: 'edit',
                value: current, confirmLabel: 'Rename'
            });
            if (!name || name === current) return null;
            try {
                return fs.rename(path, fs.join(fs.dirname(path), name));
            } catch (e) {
                await notify('Could not rename', reason(e));
                return null;
            }
        },

        async remove(paths) {
            if (!paths.length) return false;
            const label = paths.length === 1
                ? '"' + fs.basename(paths[0]) + '"'
                : paths.length + ' items';

            const confirmed = await ask({
                title: 'Delete ' + label + '?',
                message: 'This cannot be undone.',
                icon: 'delete', confirmLabel: 'Delete', danger: true
            });
            if (!confirmed) return false;

            try {
                paths.forEach(path => fs.rm(path, { recursive: true, force: true }));
                return true;
            } catch (e) {
                await notify('Could not delete', reason(e));
                return false;
            }
        },

        duplicate(paths) {
            try {
                return paths.map(path => {
                    const name = fs.uniqueName(fs.dirname(path), fs.basename(path));
                    return fs.copy(path, fs.join(fs.dirname(path), name), { recursive: true });
                });
            } catch (e) {
                notify('Could not duplicate', reason(e));
                return [];
            }
        },

        /** clipboard: { paths, cut }. Returns the paths created in `cwd`. */
        paste(clipboard, cwd) {
            if (!clipboard || !clipboard.paths.length) return [];
            const created = [];
            try {
                clipboard.paths.forEach(path => {
                    if (!fs.exists(path)) return;
                    const name = fs.uniqueName(cwd, fs.basename(path));
                    const dest = fs.join(cwd, name);
                    created.push(clipboard.cut
                        ? fs.rename(path, dest)
                        : fs.copy(path, dest, { recursive: true }));
                });
            } catch (e) {
                notify('Could not paste', reason(e));
            }
            return created;
        },

        /** Move paths into a folder, e.g. after a drag. Returns new paths. */
        move(paths, destination) {
            const moved = [];
            try {
                paths.forEach(path => {
                    if (fs.dirname(path) === fs.normalize(destination)) return;
                    const name = fs.uniqueName(destination, fs.basename(path));
                    moved.push(fs.rename(path, fs.join(destination, name)));
                });
            } catch (e) {
                notify('Could not move', reason(e));
            }
            return moved;
        },

        download(path) {
            let stat;
            try { stat = fs.stat(path); } catch (e) { return; }
            if (stat.isDirectory) {
                notify('Cannot download', 'Folders cannot be downloaded.');
                return;
            }

            const data = fs.readFile(path);
            const url = stat.binary ? data : URL.createObjectURL(new Blob([data], { type: 'text/plain' }));
            const link = document.createElement('a');
            link.href = url;
            link.download = stat.name;
            document.body.appendChild(link);
            link.click();
            link.remove();
            if (!stat.binary) setTimeout(() => URL.revokeObjectURL(url), 1000);
        },

        properties(path) {
            let stat;
            try { stat = fs.stat(path); } catch (e) { return Promise.resolve(); }

            const kind = stat.isDirectory ? 'Folder' : (fs.kindOf(stat.name, false).kind + ' file');
            const size = stat.isDirectory ? fs.size(stat.path) : stat.size;
            const contents = stat.isDirectory ? fs.walk(stat.path) : [];

            const details = [
                'Name:      ' + stat.name,
                'Location:  ' + fs.dirname(stat.path),
                'Type:      ' + kind,
                'Size:      ' + fs.formatSize(size) + ' (' + size.toLocaleString() + ' bytes)',
                stat.isDirectory
                    ? 'Contents:  ' + contents.filter(e => e.isFile).length + ' files, ' +
                      contents.filter(e => e.isDirectory).length + ' folders'
                    : null,
                'Modified:  ' + fs.formatDate(stat.mtime)
            ].filter(Boolean).join('\n');

            return ask({
                title: 'Properties', message: details, icon: 'info',
                acknowledge: true, confirmLabel: 'Close'
            });
        }
    };

    /* ------------------------------------------------------- window routing */

    /**
     * Show `path` in the Files app, opening the window if it is not up yet.
     * Works from the desktop itself, from inside a window, and standalone.
     */
    function openInFiles(path, edit) {
        const request = { type: 'navigate', path: path, edit: !!edit, at: Date.now() };
        try { localStorage.setItem(REQUEST_KEY, JSON.stringify(request)); } catch (e) {}
        if (filesChannel) filesChannel.postMessage(request);

        if (typeof global.openWindow === 'function') {
            global.openWindow('Files', 'files', 'explorer.html');
        } else if (global.parent !== global) {
            global.parent.postMessage({
                type: 'axiom:open-window', key: 'files', title: 'Files', page: 'explorer.html'
            }, '*');
        } else {
            global.open('./explorer.html?path=' + encodeURIComponent(path) + (edit ? '&edit=1' : ''), '_blank');
        }
    }

    /** A navigation request written just before this window opened. */
    function pendingRequest() {
        const params = new URLSearchParams(location.search);
        if (params.get('path')) {
            return { path: params.get('path'), edit: params.get('edit') === '1' };
        }
        try {
            const stored = JSON.parse(localStorage.getItem(REQUEST_KEY));
            if (stored && Date.now() - stored.at < 10000) return stored;
        } catch (e) {}
        return null;
    }

    function onNavigate(handler) {
        if (!filesChannel) return;
        filesChannel.addEventListener('message', event => {
            if (event.data && event.data.type === 'navigate') handler(event.data);
        });
    }

    global.AxiomFilesUI = {
        escHtml: escHtml,
        reason: reason,
        showMenu: showMenu,
        hideMenu: hideMenu,
        ask: ask,
        notify: notify,
        isDialogOpen: isDialogOpen,
        ops: ops,
        openInFiles: openInFiles,
        pendingRequest: pendingRequest,
        onNavigate: onNavigate
    };
})(window);
