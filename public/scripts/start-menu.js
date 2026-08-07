/*
 * Taskbar flyouts: the clock calendar and the search panel.
 *
 * Both hang off the taskbar and behave like their Windows counterparts - click
 * the tray clock for a month view, click search to launch apps, games, the
 * built-in windows, or anything in the Axiom filesystem.
 */
(function () {
    'use strict';

    const fs = window.AxiomFS;
    const filesUI = window.AxiomFilesUI;

    /* --------------------------------------------------------- flyout base */

    const flyouts = [];

    function registerFlyout(el, onOpen, onClose) {
        const entry = { el, onOpen, onClose };
        flyouts.push(entry);
        return entry;
    }

    function closeAll(except) {
        flyouts.forEach(entry => {
            if (entry === except || !entry.el.classList.contains('open')) return;
            entry.el.classList.remove('open');
            if (entry.onClose) entry.onClose();
        });
    }

    function toggleFlyout(entry, anchor) {
        const isOpen = entry.el.classList.contains('open');
        closeAll(entry);
        if (isOpen) {
            entry.el.classList.remove('open');
            if (entry.onClose) entry.onClose();
        } else {
            entry.el.classList.add('open');
            if (entry.onOpen) entry.onOpen();
        }
        if (anchor) anchor.classList.toggle('active', entry.el.classList.contains('open'));
    }

    /* ------------------------------------------------------------ calendar */

    const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'];

    const calendar = {
        el: document.getElementById('calendar-flyout'),
        grid: document.getElementById('cal-grid'),
        label: document.getElementById('cal-month'),
        headTime: document.getElementById('cal-now-time'),
        headDate: document.getElementById('cal-now-date'),
        view: new Date(),
        selected: null
    };

    function sameDay(a, b) {
        return a && b &&
            a.getFullYear() === b.getFullYear() &&
            a.getMonth() === b.getMonth() &&
            a.getDate() === b.getDate();
    }

    function renderCalendarHeader() {
        const now = new Date();
        calendar.headTime.textContent = now.toLocaleTimeString(undefined, {
            hour: 'numeric', minute: '2-digit'
        });
        calendar.headDate.textContent = now.toLocaleDateString(undefined, {
            weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
        });
    }

    function renderCalendar() {
        if (!calendar.grid) return;
        const view = calendar.view;
        const year = view.getFullYear();
        const month = view.getMonth();
        const today = new Date();

        calendar.label.textContent = MONTHS[month] + ' ' + year;

        // Six full weeks keeps the grid a fixed height as months are paged.
        const first = new Date(year, month, 1);
        const start = new Date(year, month, 1 - first.getDay());

        calendar.grid.innerHTML = '';
        for (let i = 0; i < 42; i++) {
            const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
            const cell = document.createElement('button');
            cell.type = 'button';
            cell.className = 'cal-day';
            if (day.getMonth() !== month) cell.classList.add('other-month');
            if (sameDay(day, today)) cell.classList.add('today');
            if (sameDay(day, calendar.selected)) cell.classList.add('selected');
            cell.textContent = day.getDate();
            cell.addEventListener('click', () => {
                calendar.selected = day;
                calendar.view = new Date(day.getFullYear(), day.getMonth(), 1);
                renderCalendar();
            });
            calendar.grid.appendChild(cell);
        }
    }

    function shiftMonth(delta) {
        calendar.view = new Date(calendar.view.getFullYear(), calendar.view.getMonth() + delta, 1);
        renderCalendar();
    }

    if (calendar.el) {
        const entry = registerFlyout(calendar.el, () => {
            calendar.view = new Date();
            renderCalendarHeader();
            renderCalendar();
        });

        const trayTime = document.getElementById('tray-time');
        if (trayTime) {
            trayTime.addEventListener('click', e => {
                e.stopPropagation();
                toggleFlyout(entry, trayTime);
            });
        }

        document.getElementById('cal-prev').addEventListener('click', () => shiftMonth(-1));
        document.getElementById('cal-next').addEventListener('click', () => shiftMonth(1));
        document.getElementById('cal-today').addEventListener('click', () => {
            const now = new Date();
            calendar.view = new Date(now.getFullYear(), now.getMonth(), 1);
            calendar.selected = now;
            renderCalendar();
        });

        // Keep the big clock live while the panel is open.
        setInterval(() => {
            if (calendar.el.classList.contains('open')) renderCalendarHeader();
        }, 1000);
    }

    /* -------------------------------------------------------------- search */

    const search = {
        el: document.getElementById('search-flyout'),
        input: document.getElementById('sf-input'),
        results: document.getElementById('sf-results'),
        items: [],
        active: -1
    };

    /** The windows the shell itself provides, searchable alongside everything else. */
    const SHELL_ITEMS = [
        { name: 'Home', icon: 'language', run: () => openWindow('Home', 'start', 'tabs.html', { chromeless: true }) },
        { name: 'Apps', icon: 'apps', run: () => openWindow('Apps', 'apps', 'apps.html') },
        { name: 'Games', icon: 'sports_esports', run: () => openWindow('Games', 'games', 'games.html') },
        { name: 'Theater', icon: 'movie', run: () => openWindow('Theater', 'theater', 'theater.html') },
        { name: 'Chat', icon: 'chat', run: () => openWindow('Chat', 'chat', 'chat.html') },
        { name: 'Files', icon: 'folder', run: () => openWindow('Files', 'files', 'explorer.html') },
        { name: 'Terminal', icon: 'terminal', run: () => openWindow('Terminal', 'terminal', 'terminal.html') },
        { name: 'LM Studio', icon: 'neurology', run: () => openWindow('LM Studio', 'lmstudio', 'lmstudio.html') },
        { name: 'Axiom Defender', icon: 'security', run: () => openWindow('Axiom Defender', 'defender', 'defender.html') },
        { name: 'Settings', icon: 'settings', run: () => openWindow('Settings', 'settings', 'settings.html') }
    ];

    let catalogs = null;
    let fileCache = null;

    function loadCatalogs() {
        if (catalogs) return catalogs;
        const grab = url => fetch(url).then(r => r.json()).catch(() => []);
        catalogs = Promise.all([grab('./assets/apps.json'), grab('./assets/gapps.json')])
            .then(([apps, games]) => ({
                apps: Array.isArray(apps) ? apps : [],
                games: (Array.isArray(games) ? games : []).filter(g => g.type === 'game')
            }));
        return catalogs;
    }

    function fileIndex() {
        if (fileCache) return fileCache;
        try {
            fileCache = fs.walk('/').filter(entry => entry.name.charAt(0) !== '.');
        } catch (e) {
            fileCache = [];
        }
        return fileCache;
    }

    if (fs && fs.on) fs.on(() => { fileCache = null; });

    /** -1 when there is no match, otherwise lower is a better match. */
    function score(name, query) {
        const i = String(name).toLowerCase().indexOf(query);
        if (i === -1) return -1;
        return i === 0 ? 0 : 1;
    }

    function rank(list, query, nameOf) {
        return list
            .map(item => ({ item, s: score(nameOf(item), query) }))
            .filter(entry => entry.s !== -1)
            .sort((a, b) => a.s - b.s || String(nameOf(a.item)).length - String(nameOf(b.item)).length)
            .map(entry => entry.item);
    }

    function openApp(app) {
        openWindow(app.app_name, 'app:' + app.app_name,
            'render.html?url=' + encodeURIComponent(btoa(app.app_url)));
    }

    function openGame(game) {
        openWindow(game.app_name, 'game:' + game.app_name,
            'game.html?url=' + encodeURIComponent(btoa(game.app_url)) +
            '&title=' + encodeURIComponent(game.app_name));
    }

    function esc(text) {
        return String(text).replace(/[&<>"']/g, ch => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[ch]));
    }

    function buildRow(opts) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'sf-item';
        row.innerHTML =
            '<div class="sf-item-art">' +
            (opts.img
                ? '<img src="' + esc(opts.img) + '" alt="" loading="lazy">'
                : '<span class="material-symbols-outlined">' + esc(opts.icon) + '</span>') +
            '</div>' +
            '<div class="sf-item-text">' +
            '<div class="sf-item-name">' + esc(opts.name) + '</div>' +
            '<div class="sf-item-sub">' + esc(opts.sub) + '</div>' +
            '</div>';
        row.addEventListener('click', () => {
            closeSearch();
            opts.run();
        });
        return row;
    }

    function addGroup(title, rows) {
        if (!rows.length) return;
        const header = document.createElement('div');
        header.className = 'sf-group';
        header.textContent = title;
        search.results.appendChild(header);
        rows.forEach(row => {
            search.results.appendChild(row);
            search.items.push(row);
        });
    }

    const LIMIT = 6;

    function buildTile(item) {
        const tile = document.createElement('button');
        tile.type = 'button';
        tile.className = 'sf-tile';
        tile.innerHTML =
            '<span class="material-symbols-outlined">' + esc(item.icon) + '</span>' +
            '<span class="sf-tile-name">' + esc(item.name) + '</span>';
        tile.addEventListener('click', () => {
            closeSearch();
            item.run();
        });
        return tile;
    }

    /** A handful of random entries, the way the Apps and Games pages pick theirs. */
    function sample(list, count) {
        const pool = list.slice();
        const out = [];
        while (out.length < count && pool.length) {
            out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
        }
        return out;
    }

    /** The idle panel: the pinned shell windows, then something to launch. */
    function renderHome() {
        const header = document.createElement('div');
        header.className = 'sf-group';
        header.textContent = 'Pinned';
        search.results.appendChild(header);

        const grid = document.createElement('div');
        grid.className = 'sf-pinned';
        SHELL_ITEMS.forEach(item => {
            const tile = buildTile(item);
            grid.appendChild(tile);
            search.items.push(tile);
        });
        search.results.appendChild(grid);

        loadCatalogs().then(data => {
            // Bail out if a query landed while the catalogs were loading.
            if (search.input.value.trim()) return;
            addGroup('Recommended', [].concat(
                sample(data.apps, 4).map(app => buildRow({
                    name: app.app_name, sub: 'App', img: app.app_img, run: () => openApp(app)
                })),
                sample(data.games, 4).map(game => buildRow({
                    name: game.app_name, sub: 'Game', img: game.app_img, run: () => openGame(game)
                }))
            ));
        });
    }

    function renderResults(query) {
        search.results.innerHTML = '';
        search.items = [];
        search.active = -1;

        if (!query) {
            renderHome();
            return;
        }

        loadCatalogs().then(data => {
            // A later keystroke may have landed while the catalogs were loading.
            if (search.input.value.trim().toLowerCase() !== query) return;

            search.results.innerHTML = '';
            search.items = [];
            search.active = -1;

            addGroup('System', rank(SHELL_ITEMS, query, i => i.name).slice(0, LIMIT).map(item =>
                buildRow({ name: item.name, sub: 'System', icon: item.icon, run: item.run })));

            addGroup('Apps', rank(data.apps, query, a => a.app_name).slice(0, LIMIT).map(app =>
                buildRow({ name: app.app_name, sub: 'App', img: app.app_img, run: () => openApp(app) })));

            addGroup('Games', rank(data.games, query, g => g.app_name).slice(0, LIMIT).map(game =>
                buildRow({ name: game.app_name, sub: 'Game', img: game.app_img, run: () => openGame(game) })));

            addGroup('Files', rank(fileIndex(), query, f => f.name).slice(0, LIMIT).map(entry =>
                buildRow({
                    name: entry.name,
                    sub: entry.path,
                    icon: fs.kindOf(entry.name, entry.isDirectory).icon,
                    run: () => filesUI.openInFiles(entry.path, entry.isFile)
                })));

            if (!search.items.length) {
                const empty = document.createElement('div');
                empty.className = 'sf-empty';
                empty.textContent = 'No results for "' + query + '"';
                search.results.appendChild(empty);
                return;
            }
            setActive(0);
        });
    }

    function setActive(index) {
        if (!search.items.length) return;
        const count = search.items.length;
        search.active = ((index % count) + count) % count;
        search.items.forEach((row, i) => row.classList.toggle('active', i === search.active));
        search.items[search.active].scrollIntoView({ block: 'nearest' });
    }

    const searchBar = document.getElementById('taskbar-search');

    function closeSearch() {
        if (!search.el) return;
        search.el.classList.remove('open');
        resetSearchBar();
    }

    /** Dismissing always empties the box, the way the Windows one does. */
    function resetSearchBar() {
        if (searchBar) searchBar.classList.remove('active');
        if (!search.input) return;
        search.input.value = '';
        search.input.blur();
    }

    if (search.el) {
        const entry = registerFlyout(search.el, () => {
            if (searchBar) searchBar.classList.add('active');
            renderResults(search.input.value.trim().toLowerCase());
        }, resetSearchBar);

        function openSearch() {
            if (search.el.classList.contains('open')) return;
            closeAll(entry);
            search.el.classList.add('open');
            if (searchBar) searchBar.classList.add('active');
            renderResults(search.input.value.trim().toLowerCase());
        }

        // The box lives in the taskbar, so focusing it is what opens the panel.
        search.input.addEventListener('focus', openSearch);
        if (searchBar) {
            // Clicking the pill's padding or icon should land in the field, but
            // let clicks on the field itself place the caret normally.
            searchBar.addEventListener('mousedown', e => {
                if (e.target !== search.input) search.input.focus();
            });
        }

        let debounce;
        search.input.addEventListener('input', () => {
            openSearch();
            clearTimeout(debounce);
            const query = search.input.value.trim().toLowerCase();
            debounce = setTimeout(() => renderResults(query), 90);
        });

        search.input.addEventListener('keydown', e => {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive(search.active + 1);
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive(search.active - 1);
            } else if (e.key === 'Enter') {
                e.preventDefault();
                if (search.items[search.active]) search.items[search.active].click();
            } else if (e.key === 'Escape') {
                closeSearch();
            }
        });

        // Ctrl+K anywhere on the desktop jumps to the box, as it does in the browser.
        window.addEventListener('keydown', e => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
                e.preventDefault();
                search.input.focus();
                search.input.select();
            }
        });
    }

    /* ------------------------------------------------------ dismiss rules */

    function dismiss() {
        closeAll();
        document.querySelectorAll('.tray-time.active').forEach(el => el.classList.remove('active'));
    }

    document.addEventListener('mousedown', e => {
        if (e.target.closest('.flyout')) return;
        if (e.target.closest('#tray-time') || e.target.closest('#taskbar-search')) return;
        dismiss();
    });

    window.addEventListener('keydown', e => {
        if (e.key === 'Escape') dismiss();
    });

    // A window taking focus should not leave a flyout floating over it.
    window.addEventListener('blur', () => closeAll());
})();
