/*
 * Files - a graphical front end for AxiomFS.
 *
 * Shares its filesystem with the terminal and the desktop, so anything created
 * in one shows up in the others immediately. Menus, dialogs and the file
 * operations themselves come from AxiomFilesUI.
 */
(function () {
    'use strict';

    const fs = window.AxiomFS;
    const ui = window.AxiomFilesUI;
    const escHtml = ui.escHtml;
    const $ = id => document.getElementById(id);

    const VIEW_KEY = 'axiom_files_view';
    const SORT_KEY = 'axiom_files_sort';
    const HIDDEN_KEY = 'axiom_files_hidden';
    const OPEN_KEY = 'axiom_files_open';

    const PLACES = [
        { label: 'Home', path: fs.HOME, icon: 'home' },
        { label: 'Desktop', path: fs.HOME + '/Desktop', icon: 'desktop_windows' },
        { label: 'Documents', path: fs.HOME + '/Documents', icon: 'description' },
        { label: 'Downloads', path: fs.HOME + '/Downloads', icon: 'download' },
        { label: 'Pictures', path: fs.HOME + '/Pictures', icon: 'image' },
        { label: 'Music', path: fs.HOME + '/Music', icon: 'music_note' },
        { label: 'Projects', path: fs.HOME + '/Projects', icon: 'code_blocks' },
        { divider: true },
        { label: 'Computer', path: '/', icon: 'computer' }
    ];

    const TEXT_EXTENSIONS = ['txt', 'md', 'json', 'js', 'mjs', 'ts', 'css', 'html', 'htm', 'xml',
        'svg', 'csv', 'log', 'yml', 'yaml', 'sh', 'py', 'rb', 'go', 'rs', 'c', 'h', 'cpp', 'java', 'toml'];

    const state = {
        cwd: fs.HOME,
        history: [],
        histIndex: -1,
        view: localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid',
        sort: localStorage.getItem(SORT_KEY) || 'name',
        showHidden: localStorage.getItem(HIDDEN_KEY) === '1',
        singleClick: localStorage.getItem(OPEN_KEY) === 'single',
        selection: new Set(),
        lastClicked: null,
        clipboard: null,
        query: '',
        editing: null
    };

    /* ---------------------------------------------------------- navigation */

    function navigate(path, options) {
        options = options || {};
        let abs = fs.normalize(path);
        if (!fs.isDirectory(abs)) abs = fs.exists(fs.HOME) ? fs.HOME : '/';

        state.cwd = abs;
        state.selection.clear();
        state.lastClicked = null;
        state.query = '';
        $('search').value = '';
        $('search-clear').classList.remove('visible');

        if (!options.replace) {
            state.history = state.history.slice(0, state.histIndex + 1);
            if (state.history[state.history.length - 1] !== abs) state.history.push(abs);
            state.histIndex = state.history.length - 1;
        }

        render();
    }

    function goBack() {
        if (state.histIndex <= 0) return;
        state.histIndex--;
        navigate(state.history[state.histIndex], { replace: true });
    }

    function goForward() {
        if (state.histIndex >= state.history.length - 1) return;
        state.histIndex++;
        navigate(state.history[state.histIndex], { replace: true });
    }

    function goUp() {
        if (state.cwd === '/') return;
        navigate(fs.dirname(state.cwd));
    }

    /* ------------------------------------------------------------ rendering */

    function currentEntries() {
        let entries;
        try {
            entries = state.query
                ? fs.walk(state.cwd).filter(e => e.name.toLowerCase().indexOf(state.query) !== -1)
                : fs.list(state.cwd);
        } catch (e) {
            return [];
        }

        if (!state.showHidden) entries = entries.filter(e => e.name.charAt(0) !== '.');

        const direction = state.sort === 'name' || state.sort === 'type' ? 1 : -1;
        entries.sort((a, b) => {
            if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
            switch (state.sort) {
                case 'size': return direction * (a.size - b.size);
                case 'modified': return direction * (a.mtime - b.mtime);
                case 'type': {
                    const cmp = fs.extname(a.name).localeCompare(fs.extname(b.name));
                    if (cmp) return cmp;
                    break;
                }
            }
            return a.name.localeCompare(b.name, undefined, { numeric: true });
        });

        return entries;
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

    function renderItems() {
        const container = $('items');
        const entries = currentEntries();
        container.className = state.view;
        container.innerHTML = '';

        entries.forEach(entry => {
            const kind = fs.kindOf(entry.name, entry.isDirectory);
            const thumb = thumbnailFor(entry);

            const el = document.createElement('div');
            el.className = 'item' + (entry.isDirectory ? ' is-dir' : '');
            el.dataset.path = entry.path;
            el.draggable = true;
            el.title = entry.name;

            const subtitle = state.query
                ? escHtml(fs.dirname(entry.path))
                : escHtml(entry.isDirectory
                    ? entry.children + ' item' + (entry.children === 1 ? '' : 's')
                    : fs.formatSize(entry.size));

            el.innerHTML =
                `<div class="item-icon ${kind.kind}">` +
                (thumb
                    ? `<img src="${escHtml(thumb)}" alt="">`
                    : `<span class="material-symbols-outlined">${kind.icon}</span>`) +
                `</div>` +
                `<div class="item-name">${escHtml(entry.name)}</div>` +
                `<div class="item-sub">${subtitle}</div>` +
                `<div class="item-date">${escHtml(fs.formatDate(entry.mtime))}</div>`;

            container.appendChild(el);
        });

        $('empty').classList.toggle('hidden', entries.length > 0);
        $('empty-text').textContent = state.query
            ? 'No files match "' + state.query + '"'
            : 'This folder is empty';

        refreshSelection();
    }

    /**
     * Update selection styling without rebuilding the list. Re-rendering here
     * would replace the element between the two halves of a double-click, so
     * the dblclick event would never reach it.
     */
    function refreshSelection() {
        const cut = state.clipboard && state.clipboard.cut ? state.clipboard.paths : [];
        $('items').querySelectorAll('.item').forEach(el => {
            el.classList.toggle('selected', state.selection.has(el.dataset.path));
            el.classList.toggle('cut', cut.indexOf(el.dataset.path) !== -1);
        });
        renderStatus(currentEntries());
    }

    function renderStatus(entries) {
        const selected = entries.filter(e => state.selection.has(e.path));
        $('status-left').textContent = selected.length
            ? selected.length + ' of ' + entries.length + ' selected'
            : entries.length + ' item' + (entries.length === 1 ? '' : 's');

        let bytes = 0;
        (selected.length ? selected : entries).forEach(e => {
            bytes += e.isDirectory ? fs.size(e.path) : e.size;
        });
        $('status-right').textContent = fs.formatSize(bytes);
    }

    function renderBreadcrumb() {
        const bar = $('breadcrumb');
        bar.innerHTML = '';

        const crumbs = [];
        if (state.cwd === fs.HOME || state.cwd.indexOf(fs.HOME + '/') === 0) {
            crumbs.push({ label: 'Home', path: fs.HOME, icon: 'home' });
            state.cwd.slice(fs.HOME.length).split('/').filter(Boolean).forEach((part, i, parts) => {
                crumbs.push({ label: part, path: fs.HOME + '/' + parts.slice(0, i + 1).join('/') });
            });
        } else {
            crumbs.push({ label: 'Computer', path: '/', icon: 'computer' });
            state.cwd.split('/').filter(Boolean).forEach((part, i, parts) => {
                crumbs.push({ label: part, path: '/' + parts.slice(0, i + 1).join('/') });
            });
        }

        crumbs.forEach((crumb, index) => {
            if (index) {
                const sep = document.createElement('span');
                sep.className = 'crumb-sep material-symbols-outlined';
                sep.textContent = 'chevron_right';
                bar.appendChild(sep);
            }
            const el = document.createElement('button');
            el.className = 'crumb' + (index === crumbs.length - 1 ? ' current' : '');
            el.innerHTML = (crumb.icon ? `<span class="material-symbols-outlined">${crumb.icon}</span>` : '') +
                escHtml(crumb.label);
            el.addEventListener('click', () => navigate(crumb.path));
            bar.appendChild(el);
        });
    }

    function renderSidebar() {
        const bar = $('sidebar');
        bar.innerHTML = '';

        PLACES.forEach(place => {
            if (place.divider) {
                const divider = document.createElement('div');
                divider.className = 'side-divider';
                bar.appendChild(divider);
                return;
            }
            if (place.path !== '/' && !fs.isDirectory(place.path)) return;

            const el = document.createElement('button');
            el.className = 'side-item' + (state.cwd === place.path ? ' active' : '');
            el.innerHTML = `<span class="material-symbols-outlined">${place.icon}</span>` +
                `<span class="side-label">${escHtml(place.label)}</span>`;
            el.addEventListener('click', () => navigate(place.path));
            el.addEventListener('dragover', e => {
                if (!e.dataTransfer.types.includes('application/axiom-paths')) return;
                e.preventDefault();
                el.classList.add('drop-target');
            });
            el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
            el.addEventListener('drop', e => {
                el.classList.remove('drop-target');
                handleInternalDrop(e, place.path);
            });
            bar.appendChild(el);
        });
    }

    function render() {
        renderBreadcrumb();
        renderSidebar();
        renderItems();
        $('nav-back').disabled = state.histIndex <= 0;
        $('nav-forward').disabled = state.histIndex >= state.history.length - 1;
        $('nav-up').disabled = state.cwd === '/';
        $('act-view').querySelector('.material-symbols-outlined').textContent =
            state.view === 'grid' ? 'view_list' : 'grid_view';
        $('act-view').title = state.view === 'grid' ? 'Switch to list view' : 'Switch to grid view';
    }

    /* ------------------------------------------------------ editor & preview */

    function showPanel(id) {
        $('overlay').classList.remove('hidden');
        ['editor', 'preview'].forEach(panel => $(panel).classList.toggle('hidden', panel !== id));
    }

    function hidePanel() {
        $('overlay').classList.add('hidden');
        ['editor', 'preview'].forEach(panel => $(panel).classList.add('hidden'));
        $('preview-body').innerHTML = '';
        state.editing = null;
    }

    function openEditor(path) {
        let text;
        try {
            text = fs.readFile(path);
        } catch (e) {
            ui.notify('Cannot open file', ui.reason(e));
            return;
        }

        state.editing = { path: path, dirty: false };
        $('editor-title').textContent = fs.basename(path);
        $('editor-icon').textContent = fs.kindOf(fs.basename(path), false).icon;
        $('editor-text').value = text;
        $('editor-dirty').classList.add('hidden');
        showPanel('editor');
        $('editor-text').focus();
    }

    function saveEditor() {
        if (!state.editing) return;
        try {
            fs.writeFile(state.editing.path, $('editor-text').value);
            state.editing.dirty = false;
            $('editor-dirty').classList.add('hidden');
        } catch (e) {
            ui.notify('Could not save', ui.reason(e));
        }
    }

    async function closeEditor() {
        if (state.editing && state.editing.dirty) {
            const editing = state.editing;
            const discard = await ui.ask({
                title: 'Discard changes?',
                message: 'You have unsaved changes to ' + fs.basename(editing.path) + '.',
                icon: 'warning', confirmLabel: 'Discard', danger: true
            });
            if (!discard) { state.editing = editing; showPanel('editor'); return; }
        }
        hidePanel();
    }

    function openPreview(entry) {
        const src = thumbnailFor(entry);
        if (!src) { ui.ops.download(entry.path); return; }
        $('preview-title').textContent = entry.name;
        $('preview-body').innerHTML = `<img src="${escHtml(src)}" alt="${escHtml(entry.name)}">`;
        $('preview-download').onclick = () => ui.ops.download(entry.path);
        showPanel('preview');
    }

    function openEntry(entry) {
        if (entry.isDirectory) { navigate(entry.path); return; }
        if (fs.kindOf(entry.name, false).kind === 'image') { openPreview(entry); return; }
        if (entry.binary) { ui.ops.download(entry.path); return; }
        openEditor(entry.path);
    }

    function openByPath(path) {
        try { openEntry(fs.stat(path)); } catch (e) { render(); }
    }

    /* ---------------------------------------------------------- selection */

    function selectedPaths() {
        return Array.from(state.selection);
    }

    function selectOnly(path) {
        state.selection = new Set([path]);
        state.lastClicked = path;
        render();
    }

    function selectAll() {
        state.selection = new Set(currentEntries().map(entry => entry.path));
        refreshSelection();
    }

    function handleItemClick(e, path) {
        const entries = currentEntries();

        if (e.shiftKey && state.lastClicked) {
            const from = entries.findIndex(entry => entry.path === state.lastClicked);
            const to = entries.findIndex(entry => entry.path === path);
            if (from !== -1 && to !== -1) {
                const [start, end] = from < to ? [from, to] : [to, from];
                state.selection = new Set(entries.slice(start, end + 1).map(entry => entry.path));
                refreshSelection();
                return;
            }
        }

        if (e.ctrlKey || e.metaKey) {
            if (state.selection.has(path)) state.selection.delete(path);
            else state.selection.add(path);
            state.lastClicked = path;
            refreshSelection();
            return;
        }

        state.selection = new Set([path]);
        state.lastClicked = path;
        refreshSelection();

        if (state.singleClick) openByPath(path);
    }

    /* -------------------------------------------------------- file actions */

    async function createFolder() {
        const path = await ui.ops.createFolder(state.cwd);
        if (path) selectOnly(path);
    }

    async function createFile() {
        const path = await ui.ops.createFile(state.cwd);
        if (!path) return;
        selectOnly(path);
        openEditor(path);
    }

    async function renameSelection() {
        const paths = selectedPaths();
        if (paths.length !== 1) return;
        const moved = await ui.ops.rename(paths[0]);
        if (moved) selectOnly(moved);
    }

    async function deleteSelection() {
        if (await ui.ops.remove(selectedPaths())) {
            state.selection.clear();
            render();
        }
    }

    function duplicateSelection() {
        state.selection = new Set(ui.ops.duplicate(selectedPaths()));
        render();
    }

    function setClipboard(cut) {
        const paths = selectedPaths();
        if (!paths.length) return;
        state.clipboard = { paths: paths, cut: cut };
        refreshSelection();
    }

    function paste(destination) {
        const created = ui.ops.paste(state.clipboard, destination || state.cwd);
        if (state.clipboard && state.clipboard.cut) state.clipboard = null;
        if (!destination) state.selection = new Set(created);
        render();
    }

    function toggleHidden() {
        state.showHidden = !state.showHidden;
        localStorage.setItem(HIDDEN_KEY, state.showHidden ? '1' : '0');
        renderItems();
    }

    function toggleSingleClick() {
        state.singleClick = !state.singleClick;
        localStorage.setItem(OPEN_KEY, state.singleClick ? 'single' : 'double');
    }

    /* -------------------------------------------------------------- menus */

    function itemMenu(entry) {
        const many = state.selection.size > 1;
        const canPaste = !!(state.clipboard && state.clipboard.paths.length);

        return [
            { label: 'Open', icon: 'open_in_new', action: () => openEntry(entry) },
            entry.isDirectory || entry.binary ? null
                : { label: 'Edit', icon: 'edit_note', action: () => openEditor(entry.path) },
            { divider: true },
            { label: 'Cut', icon: 'content_cut', hint: 'Ctrl+X', action: () => setClipboard(true) },
            { label: 'Copy', icon: 'content_copy', hint: 'Ctrl+C', action: () => setClipboard(false) },
            entry.isDirectory
                ? { label: 'Paste into', icon: 'content_paste', disabled: !canPaste, action: () => paste(entry.path) }
                : null,
            { label: 'Duplicate', icon: 'file_copy', action: duplicateSelection },
            { divider: true },
            { label: 'Rename', icon: 'drive_file_rename_outline', hint: 'F2', disabled: many, action: renameSelection },
            entry.isDirectory ? null
                : { label: 'Download', icon: 'download', disabled: many, action: () => ui.ops.download(entry.path) },
            { label: 'Delete', icon: 'delete', hint: 'Del', danger: true, action: deleteSelection },
            { divider: true },
            { label: 'Properties', icon: 'info', action: () => ui.ops.properties(entry.path) }
        ];
    }

    function backgroundMenu() {
        const canPaste = !!(state.clipboard && state.clipboard.paths.length);
        return [
            { label: 'New folder', icon: 'create_new_folder', action: createFolder },
            { label: 'New file', icon: 'note_add', action: createFile },
            { divider: true },
            { label: 'Paste', icon: 'content_paste', hint: 'Ctrl+V', disabled: !canPaste, action: () => paste() },
            { label: 'Import from computer', icon: 'upload', action: () => $('file-input').click() },
            { divider: true },
            { label: 'Select all', icon: 'select_all', hint: 'Ctrl+A', action: selectAll },
            {
                label: 'Show hidden files', hint: 'Ctrl+H',
                icon: state.showHidden ? 'check_box' : 'check_box_outline_blank',
                action: toggleHidden
            },
            {
                label: 'Single-click to open',
                icon: state.singleClick ? 'check_box' : 'check_box_outline_blank',
                action: toggleSingleClick
            },
            { divider: true },
            { label: 'Refresh', icon: 'refresh', action: render },
            { label: 'Properties', icon: 'info', action: () => ui.ops.properties(state.cwd) }
        ];
    }

    function sortMenu() {
        return [
            { key: 'name', label: 'Name', icon: 'sort_by_alpha' },
            { key: 'size', label: 'Size', icon: 'straighten' },
            { key: 'modified', label: 'Last modified', icon: 'schedule' },
            { key: 'type', label: 'Type', icon: 'category' }
        ].map(option => ({
            label: option.label,
            icon: state.sort === option.key ? 'check' : option.icon,
            action: () => {
                state.sort = option.key;
                localStorage.setItem(SORT_KEY, option.key);
                renderItems();
            }
        }));
    }

    /* ------------------------------------------------------------ importing */

    function isTextFile(file) {
        if (file.type.indexOf('text/') === 0) return true;
        if (file.type === 'application/json') return true;
        return TEXT_EXTENSIONS.indexOf(fs.extname(file.name)) !== -1;
    }

    function readUpload(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error);
            if (isTextFile(file)) reader.readAsText(file);
            else reader.readAsDataURL(file);
        });
    }

    async function importFiles(fileList, destination) {
        const target = destination || state.cwd;
        const created = [];

        for (const file of Array.from(fileList)) {
            try {
                const data = await readUpload(file);
                const name = fs.uniqueName(target, file.name);
                created.push(fs.writeFile(fs.join(target, name), data, { binary: !isTextFile(file) }));
            } catch (e) {
                await ui.notify('Could not import ' + file.name, ui.reason(e));
                break;
            }
        }

        if (target === state.cwd) state.selection = new Set(created);
        render();
    }

    function handleInternalDrop(e, destination) {
        const raw = e.dataTransfer.getData('application/axiom-paths');
        if (!raw) return;
        e.preventDefault();

        let paths;
        try { paths = JSON.parse(raw); } catch (err) { return; }
        ui.ops.move(paths, destination);
        state.selection.clear();
        render();
    }

    /* ------------------------------------------------------------- wiring */

    $('nav-back').addEventListener('click', goBack);
    $('nav-forward').addEventListener('click', goForward);
    $('nav-up').addEventListener('click', goUp);
    $('act-new-folder').addEventListener('click', createFolder);
    $('act-new-file').addEventListener('click', createFile);
    $('act-upload').addEventListener('click', () => $('file-input').click());

    $('act-sort').addEventListener('click', e => {
        const rect = e.currentTarget.getBoundingClientRect();
        ui.showMenu(sortMenu(), rect.left - 60, rect.bottom + 6);
    });

    $('act-view').addEventListener('click', () => {
        state.view = state.view === 'grid' ? 'list' : 'grid';
        localStorage.setItem(VIEW_KEY, state.view);
        render();
    });

    $('file-input').addEventListener('change', e => {
        importFiles(e.target.files);
        e.target.value = '';
    });

    $('search').addEventListener('input', e => {
        state.query = e.target.value.trim().toLowerCase();
        state.selection.clear();
        $('search-clear').classList.toggle('visible', !!state.query);
        renderItems();
    });

    $('search-clear').addEventListener('click', () => {
        $('search').value = '';
        state.query = '';
        $('search-clear').classList.remove('visible');
        renderItems();
    });

    const items = $('items');

    items.addEventListener('click', e => {
        const el = e.target.closest('.item');
        if (!el) return;
        handleItemClick(e, el.dataset.path);
    });

    items.addEventListener('dblclick', e => {
        const el = e.target.closest('.item');
        if (!el || state.singleClick) return;
        openByPath(el.dataset.path);
    });

    items.addEventListener('contextmenu', e => {
        const el = e.target.closest('.item');
        e.preventDefault();
        if (!el) { ui.showMenu(backgroundMenu(), e.clientX, e.clientY); return; }
        if (!state.selection.has(el.dataset.path)) {
            state.selection = new Set([el.dataset.path]);
            state.lastClicked = el.dataset.path;
            refreshSelection();
        }
        try { ui.showMenu(itemMenu(fs.stat(el.dataset.path)), e.clientX, e.clientY); } catch (err) { render(); }
    });

    items.addEventListener('dragstart', e => {
        const el = e.target.closest('.item');
        if (!el) return;
        if (!state.selection.has(el.dataset.path)) state.selection = new Set([el.dataset.path]);
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('application/axiom-paths', JSON.stringify(selectedPaths()));
    });

    items.addEventListener('dragover', e => {
        const el = e.target.closest('.item.is-dir');
        items.querySelectorAll('.drop-target').forEach(t => t.classList.remove('drop-target'));
        if (!el || !e.dataTransfer.types.includes('application/axiom-paths')) return;
        if (state.selection.has(el.dataset.path)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        el.classList.add('drop-target');
    });

    items.addEventListener('drop', e => {
        const el = e.target.closest('.item.is-dir');
        items.querySelectorAll('.drop-target').forEach(t => t.classList.remove('drop-target'));
        if (!el) return;
        handleInternalDrop(e, el.dataset.path);
    });

    const filesPane = $('files');

    filesPane.addEventListener('mousedown', e => {
        if (e.button !== 0 || e.target.closest('.item')) return;
        state.selection.clear();
        refreshSelection();
    });

    filesPane.addEventListener('contextmenu', e => {
        if (e.target.closest('.item')) return;
        e.preventDefault();
        ui.showMenu(backgroundMenu(), e.clientX, e.clientY);
    });

    let dragDepth = 0;

    filesPane.addEventListener('dragenter', e => {
        if (!e.dataTransfer.types.includes('Files')) return;
        dragDepth++;
        filesPane.classList.add('importing');
    });

    filesPane.addEventListener('dragover', e => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
    });

    filesPane.addEventListener('dragleave', () => {
        if (--dragDepth <= 0) { dragDepth = 0; filesPane.classList.remove('importing'); }
    });

    filesPane.addEventListener('drop', e => {
        dragDepth = 0;
        filesPane.classList.remove('importing');
        if (!e.dataTransfer.files || !e.dataTransfer.files.length) return;
        e.preventDefault();
        const folder = e.target.closest('.item.is-dir');
        importFiles(e.dataTransfer.files, folder ? folder.dataset.path : state.cwd);
    });

    $('editor-save').addEventListener('click', saveEditor);
    $('editor-close').addEventListener('click', closeEditor);
    $('preview-close').addEventListener('click', hidePanel);

    $('editor-text').addEventListener('input', () => {
        if (!state.editing || state.editing.dirty) return;
        state.editing.dirty = true;
        $('editor-dirty').classList.remove('hidden');
    });

    $('overlay').addEventListener('mousedown', e => {
        if (e.target !== $('overlay')) return;
        if (state.editing) closeEditor();
        else hidePanel();
    });

    /* --- keyboard --- */

    document.addEventListener('keydown', e => {
        if (ui.isDialogOpen()) return;

        if (!$('overlay').classList.contains('hidden')) {
            if (e.key === 'Escape') {
                e.preventDefault();
                if (state.editing) closeEditor();
                else hidePanel();
            } else if (e.key === 's' && (e.ctrlKey || e.metaKey) && state.editing) {
                e.preventDefault();
                saveEditor();
            }
            return;
        }

        if (document.activeElement === $('search')) {
            if (e.key === 'Escape') $('search-clear').click();
            return;
        }

        switch (e.key) {
            case 'Delete': e.preventDefault(); deleteSelection(); break;
            case 'F2': e.preventDefault(); renameSelection(); break;
            case 'Backspace': e.preventDefault(); goUp(); break;
            case 'Escape': state.selection.clear(); refreshSelection(); break;
            case 'Enter': {
                const paths = selectedPaths();
                if (paths.length !== 1) return;
                e.preventDefault();
                openByPath(paths[0]);
                break;
            }
            case 'a': if (e.ctrlKey || e.metaKey) { e.preventDefault(); selectAll(); } break;
            case 'c': if (e.ctrlKey || e.metaKey) { e.preventDefault(); setClipboard(false); } break;
            case 'x': if (e.ctrlKey || e.metaKey) { e.preventDefault(); setClipboard(true); } break;
            case 'v': if (e.ctrlKey || e.metaKey) { e.preventDefault(); paste(); } break;
            case 'f': if (e.ctrlKey || e.metaKey) { e.preventDefault(); $('search').focus(); } break;
            case 'h': if (e.ctrlKey || e.metaKey) { e.preventDefault(); toggleHidden(); } break;
        }
    });

    /* --- requests from the terminal and the desktop --- */

    function applyRequest(request) {
        if (!request || !request.path) return;
        let stat;
        try { stat = fs.stat(request.path); } catch (e) { return; }

        if (stat.isDirectory) { navigate(stat.path); return; }
        navigate(fs.dirname(stat.path));
        state.selection = new Set([stat.path]);
        refreshSelection();
        if (request.edit) openEntry(stat);
    }

    ui.onNavigate(applyRequest);

    // Keep in step with changes made elsewhere.
    fs.on(detail => {
        if (detail.remote && state.editing) return; // don't clobber an open editor
        render();
    });

    // Nothing can be listed until IndexedDB has loaded (and, on a first run,
    // seeded itself from public/default/).
    fs.ready.then(() => {
        const request = ui.pendingRequest();
        const start = request && request.path
            ? (fs.isDirectory(request.path) ? request.path : fs.dirname(request.path))
            : (fs.exists(fs.HOME) ? fs.HOME : '/');

        navigate(start, { replace: true });
        state.history = [state.cwd];
        state.histIndex = 0;
        applyRequest(request);
    });
})();
