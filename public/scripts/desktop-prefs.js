/*
 * Every knob the desktop exposes lives here.
 *
 * One flat object in localStorage, one broadcast channel, one `apply()` that
 * turns the object into CSS custom properties and body classes. Both the
 * shell (windows.html) and Settings — which runs in an iframe inside it —
 * load this file, so a change made in one is on screen in the other before
 * the click finishes.
 */
(function () {
    'use strict';

    const KEY = 'axiom_desktop_prefs';
    const CHANNEL = 'axiom-desktop-prefs';

    const DEFAULTS = {
        /* ------------------------------------------------------ wallpaper */
        wpMode: 'live',         // 'still' | 'live'
        wpLive: '',             // filename inside animated_wallpapers/
        wpShuffle: false,
        wpShuffleMins: 10,
        wpRate: 1,              // playback speed, 0.25 - 2
        wpBlur: 0,              // px
        wpDim: 0,               // 0 - 80 (%)
        wpSat: 100,             // 50 - 200 (%)
        wpVignette: false,
        wpParallax: true,
        wpPauseHidden: true,    // stop decoding while the tab is in the back
        wpPauseWindows: false,  // stop decoding while a window covers it

        /* -------------------------------------------------------- desktop */
        // The desktop ships empty: the wallpaper is the point of it, and the
        // icons are one keystroke (Ctrl+Shift+D) away when they are wanted.
        showIcons: false,
        iconSize: 1,            // 0.75 - 1.5
        clockWidget: 'large',   // 'off' | 'small' | 'large'
        clockPos: 'center',     // 'left' | 'center' | 'right'
        clockAlign: 'middle',   // 'top' | 'middle' | 'bottom'
        clockFont: '',          // a Google Fonts family; '' is Axiom's own
        clockSeconds: false,
        greeting: false,
        zen: false,

        /* ----------------------------------------------------------- dock */
        dockSize: 1,            // 0.7 - 1.4
        dockMagnify: true,
        dockAutohide: false,

        /* ------------------------------------------------------- menu bar */
        barAutohide: false,
        barSeconds: false,
        bar24h: false,
        barDate: true,
        barBattPct: false,
        barWallpaper: true,     // the live-wallpaper control in the menu bar

        /* ---------------------------------------------------------- glass */
        transparency: 0,        // 0 = solid panels, 100 = fully frosted glass
        tint: false             // wash the panels with the accent colour
    };

    /*
     * The faces the clock picker offers. Any Google family works — the field
     * takes free text — but a shortlist saves everyone a trip to fonts.google.
     */
    const CLOCK_FONTS = [
        '', 'Inter', 'Poppins', 'Montserrat', 'Playfair Display', 'Bebas Neue',
        'Space Grotesk', 'DM Serif Display', 'Orbitron', 'JetBrains Mono',
        'Lexend', 'Josefin Sans'
    ];

    function read() {
        let saved = null;
        try { saved = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { /* corrupt */ }
        const out = Object.assign({}, DEFAULTS);
        if (saved && typeof saved === 'object') {
            for (const k in DEFAULTS) {
                if (Object.prototype.hasOwnProperty.call(saved, k)) out[k] = saved[k];
            }
        }
        return out;
    }

    let prefs = read();

    const listeners = new Set();
    let chan = null;
    try { chan = new BroadcastChannel(CHANNEL); } catch (e) { /* older browser */ }

    function announce(changed, fromRemote) {
        applyLocal();
        listeners.forEach(fn => { try { fn(prefs, changed); } catch (e) { console.error(e); } });
        if (fromRemote || !chan) return;
        try { chan.postMessage({ prefs, changed }); } catch (e) { /* closed */ }
    }

    function adopt(next, changed, fromRemote) {
        prefs = next;
        announce(changed, fromRemote);
    }

    /* ------------------------------------------------------------- writes */

    function patch(obj) {
        const changed = [];
        const next = Object.assign({}, prefs);
        for (const k in obj) {
            if (!Object.prototype.hasOwnProperty.call(DEFAULTS, k)) continue;
            if (next[k] === obj[k]) continue;
            next[k] = obj[k];
            changed.push(k);
        }
        if (!changed.length) return prefs;
        try { localStorage.setItem(KEY, JSON.stringify(next)); } catch (e) { /* full */ }
        adopt(next, changed, false);
        return prefs;
    }

    /* --------------------------------------------------------- applying it */

    const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Number(n) || 0));

    /**
     * Turns the prefs into the handful of custom properties and body classes
     * every stylesheet in Axiom reads. Safe to call before <body> exists.
     */
    function applyLocal() {
        const root = document.documentElement;
        const S = root.style;

        S.setProperty('--wp-blur', clamp(prefs.wpBlur, 0, 60) + 'px');
        S.setProperty('--wp-dim', clamp(prefs.wpDim, 0, 85) / 100);
        S.setProperty('--wp-sat', clamp(prefs.wpSat, 40, 220) + '%');
        // The desktop clock's own face. Quoted, because a Google family name
        // is as likely as not to have a space in it.
        const face = String(prefs.clockFont || '').trim();
        // Whatever the face, the clock's text is literal — font-scramble.js
        // skips it — so the fallback is the un-shifted Roboto, never the
        // scrambled one every other panel uses.
        S.setProperty('--clock-font',
            (face ? '"' + face + '", ' : '') + '"Roboto Plain", "Roboto", sans-serif');
        if (face) loadFont(face);

        S.setProperty('--icon-scale', clamp(prefs.iconSize, 0.6, 1.8));
        S.setProperty('--dock-scale', clamp(prefs.dockSize, 0.6, 1.8));
        // Transparency is one number the whole shell reads: at 0 the panels are
        // solid and cheap to paint, at 100 they are full frosted glass.
        const clear = clamp(prefs.transparency, 0, 100) / 100;
        S.setProperty('--glass-blur', Math.round(40 * clear) + 'px');
        S.setProperty('--glass-sat', Math.round(100 + 80 * clear) + '%');
        S.setProperty('--glass-alpha', (0.96 - 0.6 * clear).toFixed(3));
        S.setProperty('--glass-line', (0.1 + 0.12 * clear).toFixed(3));

        const body = document.body;
        if (!body) return;
        const flag = (name, on) => body.classList.toggle(name, !!on);

        flag('zen', prefs.zen);
        flag('hide-icons', !prefs.showIcons);
        flag('dock-magnify', prefs.dockMagnify);
        flag('dock-autohide', prefs.dockAutohide || prefs.zen);
        flag('bar-autohide', prefs.barAutohide || prefs.zen);
        flag('wp-vignette', prefs.wpVignette);
        flag('glass-tint', prefs.tint);
        body.dataset.clockWidget = prefs.clockWidget;
        body.dataset.clockPos = prefs.clockPos;
        body.dataset.clockAlign = prefs.clockAlign;
    }

    /* ---------------------------------------------------------- webfonts */

    /*
     * The clock is the one thing on the desktop people want in their own
     * typeface, so its face is a free-text Google Fonts family. Each family is
     * pulled in once per document and the stylesheet is left in place: the
     * picker in Settings flips through a dozen of them while you look at it.
     */
    const fontsAsked = new Set();

    function loadFont(family) {
        const name = String(family || '').trim();
        if (!name || fontsAsked.has(name)) return;
        fontsAsked.add(name);

        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.dataset.axiomFont = name;
        link.href = 'https://fonts.googleapis.com/css2?family=' +
            encodeURIComponent(name).replace(/%20/g, '+') +
            ':wght@100;200;300;400;500;600;700&display=swap';
        (document.head || document.documentElement).appendChild(link);
    }

    /* ------------------------------------------------------- other windows */

    if (chan) {
        chan.onmessage = ev => {
            const data = ev && ev.data;
            if (!data || !data.prefs) return;
            adopt(Object.assign({}, DEFAULTS, data.prefs), data.changed || [], true);
        };
    }

    // Fallback for contexts without BroadcastChannel, and for other tabs.
    window.addEventListener('storage', e => {
        if (e.key !== KEY) return;
        adopt(read(), Object.keys(DEFAULTS), true);
    });

    /*
     * "12a1da5ecc_winter-cabin-under-the-stars-live-wallpaper-wallsflow-com.mp4"
     * is not a name anybody wants to read. Drop the content hash, the source
     * site's signature and the extension, then title-case what is left.
     *
     * It lives here rather than in wallpaper.js because Settings runs in an
     * iframe that has no wallpaper engine of its own, and its gallery has to
     * label the same files the same way.
     */
    function wallpaperTitle(name) {
        return String(name)
            .replace(/\.mp4$/i, '')
            .replace(/^[0-9a-f]{6,}_/i, '')
            .replace(/\s*\(\d+\)$/, '')
            .replace(/[-_](live[-_])?wallpaper([-_]wallsflow)?([-_]com)?$/i, '')
            .replace(/[-_]wallsflow([-_]com)?$/i, '')
            .replace(/[-_]+/g, ' ')
            .trim()
            .replace(/\b\w/g, c => c.toUpperCase()) || 'Untitled';
    }

    window.AxiomDesk = {
        DEFAULTS,
        wallpaperTitle,
        loadFont,
        CLOCK_FONTS,
        all: () => Object.assign({}, prefs),
        get: k => prefs[k],
        set: (k, v) => patch({ [k]: v }),
        patch,
        reset() {
            try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ }
            adopt(Object.assign({}, DEFAULTS), Object.keys(DEFAULTS), false);
        },
        on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
        apply: applyLocal
    };

    applyLocal();
    if (!document.body) {
        document.addEventListener('DOMContentLoaded', applyLocal, { once: true });
    }
})();
