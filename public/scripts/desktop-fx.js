/*
 * The parts of the desktop that are not windows: the wallpaper clock, the
 * auto-hiding chrome, and Zen mode.
 *
 * Zen is the whole point of a live wallpaper — it takes the icons, the dock
 * and the menu bar off screen and gives the picture the entire display back,
 * with each piece of chrome sliding in again when the pointer reaches its
 * edge. Auto-hide for the dock and the bar are the same machinery, available
 * one at a time.
 */
(function () {
    'use strict';

    const desk = window.AxiomDesk;
    if (!desk) return;

    const body = document.body;
    const clock = document.getElementById('desktop-clock');

    /* ------------------------------------------------------- desktop clock */

    function greetingFor(hour) {
        if (hour < 5) return 'Still up?';
        if (hour < 12) return 'Good morning';
        if (hour < 18) return 'Good afternoon';
        if (hour < 22) return 'Good evening';
        return 'Good night';
    }

    function paintClock() {
        if (!clock) return;
        const p = desk.all();
        if (p.clockWidget === 'off') return;

        const now = new Date();
        const time = clock.querySelector('.dc-time');
        const date = clock.querySelector('.dc-date');
        const hello = clock.querySelector('.dc-greeting');

        const opts = { hour: 'numeric', minute: '2-digit', hour12: !p.bar24h };
        if (p.clockSeconds) opts.second = '2-digit';
        time.textContent = now.toLocaleTimeString(undefined, opts).replace(/\s?[AP]M$/i, m => m.toLowerCase());

        date.textContent = now.toLocaleDateString(undefined, {
            weekday: 'long', month: 'long', day: 'numeric'
        });

        hello.textContent = p.greeting ? greetingFor(now.getHours()) : '';
        hello.hidden = !p.greeting;
    }

    /* ---------------------------------------------------- dock magnification */

    /*
     * macOS sizes each dock tile by how far the pointer is from it, not by
     * which tile the pointer is over. That distinction is the whole fix for
     * the shimmer this used to have: a :hover rule grew the tile out from
     * under the cursor, lost the hover, shrank, regained it, and oscillated.
     *
     * Distances are measured against each tile's LAYOUT box (offsetLeft,
     * offsetWidth), which a transform never moves, so the size a tile is
     * given can never change the number that decided it.
     */
    const dock = document.getElementById('taskbar');
    const dockItems = dock ? Array.from(dock.querySelectorAll('.taskbar-btn')) : [];

    // How far either side of the pointer the lift reaches, in tile widths.
    const MAG_REACH = 2.1;

    /*
     * Geometry is measured once per hover, not once per pointer move. The
     * naive version read getBoundingClientRect() and every tile's offsetLeft
     * in the same loop that wrote --mag, so each write invalidated style and
     * the next read forced a synchronous layout — one reflow per tile, per
     * move event, on a 1000Hz mouse. Nothing here moves the layout, so one
     * measurement holds for the whole pass over the dock.
     */
    let geo = null;         // [{ centre, reach }] in client coords, per tile
    let pending = 0;        // rAF handle, so bursts of moves paint once
    let pendingX = 0;
    const lastMag = dockItems.map(() => -1);

    function measure() {
        if (!dock) return;
        const rect = dock.getBoundingClientRect();
        // The dock is transformed (translateX(-50%)), so scale layout offsets
        // by the ratio the transform is drawing them at.
        const ratio = dock.offsetWidth ? rect.width / dock.offsetWidth : 1;
        geo = dockItems.map(btn => ({
            centre: rect.left + (btn.offsetLeft + btn.offsetWidth / 2) * ratio,
            reach: btn.offsetWidth * MAG_REACH * ratio || 1
        }));
        geo.left = rect.left;
    }

    function paintMag() {
        pending = 0;
        if (!dock) return;
        if (!geo) measure();
        // The specular the tray's gradient is centred on. Same event as the
        // magnification, so it costs one custom property, not a listener.
        dock.style.setProperty('--dock-x', (pendingX - geo.left).toFixed(1) + 'px');

        for (let i = 0; i < dockItems.length; i++) {
            const g = geo[i];
            const away = Math.abs(pendingX - g.centre) / g.reach;
            // A cosine falls off smoothly and reaches exactly zero at the
            // edge of the reach, so tiles outside it are left flat.
            const mag = away >= 1 ? 0 : (Math.cos(away * Math.PI) + 1) / 2;
            // Two decimals is finer than a pixel of lift; skipping unchanged
            // values keeps the flat tiles out of the style recalc entirely.
            const v = Math.round(mag * 100) / 100;
            if (v === lastMag[i]) continue;
            lastMag[i] = v;
            dockItems[i].style.setProperty('--mag', v);
        }
    }

    function magnify(clientX) {
        pendingX = clientX;
        if (!pending) pending = requestAnimationFrame(paintMag);
    }

    function unmagnify() {
        if (pending) { cancelAnimationFrame(pending); pending = 0; }
        dockItems.forEach((btn, i) => {
            if (lastMag[i] === 0) return;
            lastMag[i] = 0;
            btn.style.setProperty('--mag', '0');
        });
        geo = null;
    }

    if (dock) {
        // Re-measure on the way in: the dock's size follows the --dock-scale
        // pref and the tiles come and go, and a hover is the one moment where
        // a layout read costs nothing.
        dock.addEventListener('pointerenter', () => { geo = null; });
        dock.addEventListener('pointermove', e => magnify(e.clientX), { passive: true });
        dock.addEventListener('pointerleave', unmagnify);
        // A tile that opens a window takes the pointer away with it.
        dock.addEventListener('click', () => setTimeout(unmagnify, 250));
        window.addEventListener('blur', unmagnify);
        window.addEventListener('resize', () => { geo = null; }, { passive: true });
    }

    if (clock) {
        setInterval(paintClock, 1000);
        paintClock();
    }

    /* ---------------------------------------------------------- auto-hide */

    // How close to an edge the pointer has to get before the chrome returns.
    const EDGE = 4;
    const BAR_KEEP = 34;   // once shown, the bar stays until you leave its band
    const DOCK_KEEP = 96;

    let barShown = false;
    let dockShown = false;

    function setBar(on) {
        if (on === barShown) return;
        barShown = on;
        body.classList.toggle('reveal-bar', on);
    }

    function setDock(on) {
        if (on === dockShown) return;
        dockShown = on;
        body.classList.toggle('reveal-dock', on);
    }

    // Read off a cached pair rather than the prefs object: this is checked on
    // every pointer move, and desk.all() copies the whole record.
    let hideBar = false;
    let hideDock = false;

    function refreshHiding(p) {
        hideBar = !!(p.barAutohide || p.zen);
        hideDock = !!(p.dockAutohide || p.zen);
    }

    function hiding(which) {
        return which === 'bar' ? hideBar : hideDock;
    }

    refreshHiding(desk.all());

    window.addEventListener('pointermove', e => {
        if (hiding('bar')) {
            const y = e.clientY;
            setBar(barShown ? y < BAR_KEEP : y <= EDGE);
        } else {
            setBar(false);
        }

        if (hiding('dock')) {
            const fromBottom = window.innerHeight - e.clientY;
            setDock(dockShown ? fromBottom < DOCK_KEEP : fromBottom <= EDGE);
        } else {
            setDock(false);
        }
    }, { passive: true });

    // Leaving the page entirely should put the chrome away rather than
    // stranding it open because the last event was mid-screen.
    document.addEventListener('mouseleave', () => { setBar(false); setDock(false); });

    /* ---------------------------------------------------------------- zen */

    function toggleZen() {
        desk.set('zen', !desk.get('zen'));
    }

    window.addEventListener('keydown', e => {
        if (!e.ctrlKey || !e.shiftKey || e.altKey) return;
        const key = (e.key || '').toLowerCase();
        if (key === 'z') { e.preventDefault(); toggleZen(); }
        else if (key === 'd') { e.preventDefault(); desk.set('showIcons', !desk.get('showIcons')); }
    });

    /* ---------------------------------------------------------------- misc */

    desk.on((p, changed) => {
        refreshHiding(p);
        if (changed.some(k => ['clockWidget', 'clockPos', 'clockAlign', 'clockFont', 'clockSeconds', 'greeting', 'bar24h'].includes(k))) {
            paintClock();
        }
        // Coming out of an auto-hide mode must not leave the chrome stuck away.
        if (!hideBar) setBar(false);
        if (!hideDock) setDock(false);
    });

    window.AxiomZen = { toggle: toggleZen, on: () => !!desk.get('zen') };
})();
