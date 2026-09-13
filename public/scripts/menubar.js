/*
 * The macOS-style menu bar.
 *
 * Every entry in here does something: the bar carries no decorative titles.
 * Each menu is built from a small table of commands that call straight into
 * the shell (openWindow), the filesystem UI (AxiomFilesUI.openInFiles) or the
 * Spotlight panel, and the Window menu is rebuilt from the live window list
 * each time it is opened.
 */
(function () {
    'use strict';

    const HOME = '/home/user';
    const DISCORD = 'https://discord.gg/pnGGmHqjGj';

    const bar = document.getElementById('menubar');
    if (!bar) return;

    const filesUI = window.AxiomFilesUI;

    /* ------------------------------------------------------------ commands */

    function app(title, key, page, opts) {
        return () => openWindow(title, key, page, opts || {});
    }

    function browse(path) {
        return () => {
            if (filesUI) filesUI.openInFiles(path, false);
            else window.openWindow('Files', 'files', 'explorer.html');
        };
    }

    /**
     * What macOS calls the front window. WinBox marks the focused instance
     * with `.focused` and stamps its stacking order on `.index`, so the
     * focused window wins and the highest stack position is the fallback.
     */
    function frontWindow() {
        let front = null;
        let top = -Infinity;
        for (const key in openWindows) {
            const wb = openWindows[key];
            if (!wb || wb.closed) continue;
            if (wb.focused) return wb;
            const z = typeof wb.index === 'number' ? wb.index : 0;
            if (z >= top) { top = z; front = wb; }
        }
        return front;
    }

    function eachWindow(fn) {
        for (const key in openWindows) {
            const wb = openWindows[key];
            if (wb && !wb.closed) fn(wb, key);
        }
    }

    function fullscreenOn() {
        return !!document.fullscreenElement;
    }

    function toggleFullscreen() {
        if (fullscreenOn()) document.exitFullscreen();
        else document.documentElement.requestFullscreen();
    }

    // Showing and hiding the icons is a saved preference, not a scratch
    // style on the layer: it has to survive a reload and reach Settings.
    const desk = window.AxiomDesk;

    function iconsHidden() {
        return desk ? !desk.get('showIcons') : false;
    }

    function toggleIcons() {
        if (desk) desk.set('showIcons', !desk.get('showIcons'));
    }

    function zenOn() {
        return !!(desk && desk.get('zen'));
    }

    function toggleZen() {
        if (desk) desk.set('zen', !desk.get('zen'));
    }

    /* --------------------------------------------------------------- menus */

    const SEP = { separator: true };

    const MENUS = {
        system: () => [
            { label: 'About This Axiom', run: app('Settings', 'settings', 'settings.html') },
            SEP,
            { label: 'System Settings…', run: app('Settings', 'settings', 'settings.html') },
            { label: 'Axiom Defender', run: app('Axiom Defender', 'defender', 'defender.html') },
            { label: 'LM Studio', run: app('LM Studio', 'lmstudio', 'lmstudio.html') },
            SEP,
            { label: 'Restart', run: () => location.reload() },
            { label: 'Log Out…', run: () => { location.href = '/index.html'; } }
        ],
        axiom: () => [
            { label: 'Home', run: app('Home', 'start', 'tabs.html', { chromeless: true }) },
            { label: 'Apps', run: app('Apps', 'apps', 'apps.html') },
            { label: 'Games', run: app('Games', 'games', 'games_norm.html') },
            { label: 'Web Games', run: app('Web Games', 'games-web', 'games_web.html') },
            { label: 'Theater', run: app('Theater', 'theater', 'theater.html') },
            { label: 'Chat', run: app('Chat', 'chat', 'chat.html') },
            SEP,
            { label: 'Settings…', run: app('Settings', 'settings', 'settings.html') }
        ],
        file: () => [
            { label: 'New Finder Window', run: browse(HOME) },
            { label: 'Open File…', run: browse(HOME + '/Desktop') },
            { label: 'New Terminal Window', run: app('Terminal', 'terminal', 'terminal.html') },
            SEP,
            {
                label: 'Close Window',
                enabled: () => !!frontWindow(),
                run: () => { const wb = frontWindow(); if (wb) wb.close(); }
            }
        ],
        go: () => [
            { label: 'Home', run: browse(HOME) },
            { label: 'Desktop', run: browse(HOME + '/Desktop') },
            { label: 'Documents', run: browse(HOME + '/Documents') },
            { label: 'Downloads', run: browse(HOME + '/Downloads') },
            { label: 'Pictures', run: browse(HOME + '/Pictures') },
            SEP,
            { label: 'Computer', run: browse('/') }
        ],
        view: () => [
            {
                label: iconsHidden() ? 'Show Desktop Icons' : 'Hide Desktop Icons',
                shortcut: '⌃⇧D',
                run: toggleIcons
            },
            {
                label: zenOn() ? 'Leave Zen Mode' : 'Enter Zen Mode',
                shortcut: '⌃⇧Z',
                run: toggleZen
            },
            { label: 'Change Wallpaper…', run: app('Settings', 'settings', 'settings.html') },
            SEP,
            {
                label: 'Spotlight Search',
                shortcut: '⌘K',
                run: () => { if (window.AxiomSpotlight) window.AxiomSpotlight.open(); }
            },
            {
                label: fullscreenOn() ? 'Exit Full Screen' : 'Enter Full Screen',
                run: toggleFullscreen
            }
        ],
        window: () => {
            const items = [
                {
                    label: 'Minimize',
                    enabled: () => !!frontWindow(),
                    run: () => { const wb = frontWindow(); if (wb) wb.minimize(); }
                },
                {
                    label: 'Zoom',
                    enabled: () => !!frontWindow(),
                    run: () => { const wb = frontWindow(); if (wb) wb.max ? wb.restore() : wb.maximize(); }
                },
                {
                    label: 'Close All',
                    enabled: () => !!frontWindow(),
                    run: () => eachWindow(wb => wb.close())
                }
            ];

            // Every open window is listed, as macOS does, and brings itself
            // to the front when picked.
            const open = [];
            eachWindow((wb, key) => open.push({ label: wb.title || key, run: () => wb.focus() }));
            if (open.length) items.push(SEP, ...open);
            return items;
        },
        // Only ever opened from the control that live wallpapers put in the
        // bar, so everything in it assumes a clip is loaded.
        wallpaper: () => {
            const wp = window.AxiomWallpaper;
            const state = wp ? wp.state() : { title: '', playing: false, shuffle: false };
            return [
                { label: state.title || 'Live Wallpaper', enabled: () => false, run() {} },
                SEP,
                { label: state.playing ? 'Pause' : 'Play', run: () => { if (wp) wp.toggle(); } },
                { label: 'Shuffle Now', run: () => { if (wp) wp.next(); } },
                {
                    label: (state.shuffle ? '✓ ' : '') + 'Shuffle Automatically',
                    run: () => { if (desk) desk.set('wpShuffle', !desk.get('wpShuffle')); }
                },
                SEP,
                { label: 'Use a Still Picture', run: () => { if (desk) desk.set('wpMode', 'still'); } },
                { label: 'Wallpaper Settings…', run: app('Settings', 'settings', 'settings.html') }
            ];
        },
        wifi: () => [
            {
                label: navigator.onLine ? 'Wi-Fi: Connected' : 'Wi-Fi: Offline',
                enabled: () => false,
                run() {}
            },
            SEP,
            { label: 'Network Settings…', run: app('Settings', 'settings', 'settings.html') }
        ],
        help: () => [
            { label: 'Axiom Home Page', run: app('Home', 'start', 'tabs.html', { chromeless: true }) },
            { label: 'Open Terminal', run: app('Terminal', 'terminal', 'terminal.html') },
            SEP,
            { label: 'Discord Community', run: () => window.open(DISCORD, '_blank', 'noopener') }
        ]
    };

    /* -------------------------------------------------------------- panel */

    const panel = document.createElement('div');
    panel.className = 'mb-menu';
    document.body.appendChild(panel);

    let openAnchor = null;

    function closeMenu() {
        if (!openAnchor) return;
        openAnchor.classList.remove('active');
        openAnchor = null;
        panel.classList.remove('open');
        // An auto-hidden bar may now slide away again.
        document.body.classList.remove('hold-bar');
    }

    function buildItem(spec) {
        if (spec.separator) {
            const line = document.createElement('div');
            line.className = 'mb-menu-sep';
            return line;
        }

        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'mb-menu-item';

        const label = document.createElement('span');
        label.textContent = spec.label;
        item.appendChild(label);

        if (spec.shortcut) {
            const hint = document.createElement('span');
            hint.className = 'mb-menu-key';
            hint.textContent = spec.shortcut;
            item.appendChild(hint);
        }

        // A command that cannot run right now is shown greyed rather than
        // silently doing nothing when clicked.
        if (spec.enabled && !spec.enabled()) {
            item.disabled = true;
            item.classList.add('disabled');
        } else {
            item.addEventListener('click', () => {
                closeMenu();
                spec.run();
            });
        }
        return item;
    }

    function openMenu(anchor) {
        const build = MENUS[anchor.dataset.menu];
        if (!build) return;

        // Anything else floating (Spotlight, the calendar) gives way first.
        if (window.AxiomPanels) window.AxiomPanels.closeAll();

        closeMenu();
        panel.innerHTML = '';
        build().forEach(spec => panel.appendChild(buildItem(spec)));

        const rect = anchor.getBoundingClientRect();
        panel.style.left = Math.round(rect.left) + 'px';
        panel.classList.add('open');

        // Keep the panel on screen when a menu near the right edge is opened.
        const overflow = panel.getBoundingClientRect().right - (window.innerWidth - 8);
        if (overflow > 0) panel.style.left = Math.round(rect.left - overflow) + 'px';

        anchor.classList.add('active');
        openAnchor = anchor;
        // Keep an auto-hidden bar on screen for as long as a menu is down.
        document.body.classList.add('hold-bar');
    }

    bar.querySelectorAll('.mb-item[data-menu]').forEach(anchor => {
        anchor.addEventListener('mousedown', e => {
            e.preventDefault();
            e.stopPropagation();
            if (openAnchor === anchor) closeMenu();
            else openMenu(anchor);
        });

        // Once a menu is down, sliding along the bar switches between them.
        anchor.addEventListener('mouseenter', () => {
            if (openAnchor && openAnchor !== anchor) openMenu(anchor);
        });
    });

    document.addEventListener('mousedown', e => {
        if (e.target.closest('.mb-menu')) return;
        closeMenu();
    });

    window.addEventListener('keydown', e => {
        if (e.key === 'Escape') closeMenu();
    });

    window.addEventListener('blur', closeMenu);
    window.addEventListener('resize', closeMenu);

    /* -------------------------------------------- the live-wallpaper item */

    const wpName = document.getElementById('mb-wp-name');
    const wpItem = document.getElementById('btn-wallpaper');

    if (wpName && window.AxiomWallpaper) {
        window.AxiomWallpaper.watch(state => {
            wpName.textContent = state.title;
            if (wpItem) {
                wpItem.title = state.title
                    ? state.title + (state.playing ? '' : ' (paused)')
                    : 'Live wallpaper';
            }
        });
    }

    // The clip's name is only worth the space when the bar is not crowded.
    function fitWallpaperItem() {
        if (wpName) wpName.hidden = window.innerWidth < 760;
    }

    window.addEventListener('resize', fitWallpaperItem);
    fitWallpaperItem();

    // Settings can take the control out of the bar altogether.
    if (desk) {
        const syncBar = p => document.body.classList.toggle('hide-bar-wallpaper', !p.barWallpaper);
        desk.on(syncBar);
        syncBar(desk.all());
    }
})();
