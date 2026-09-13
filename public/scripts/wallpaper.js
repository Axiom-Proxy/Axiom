/*
 * The wallpaper layer.
 *
 * Two <video> buffers sit under everything else so one can load while the
 * other is still on screen — that is what makes shuffling, and switching
 * pictures from Settings, a crossfade instead of a black flash. A still
 * wallpaper is the same layer with the video buffers faded out; the picture
 * itself still comes from the --wallpaper property windows.js maintains.
 *
 * Decoding a 4K clip forever is the one genuinely expensive thing a desktop
 * like this can do, so the engine stops the video whenever nobody can see it:
 * the tab is in the background, the machine asked for reduced motion, or the
 * user chose to pause it behind open windows.
 */
(function () {
    'use strict';

    const layer = document.getElementById('wallpaper-layer');
    if (!layer) return;

    const desk = window.AxiomDesk;
    const videos = Array.from(layer.querySelectorAll('.wp-video'));
    if (videos.length < 2 || !desk) return;

    const VIDEO_BASE = '/animated_wallpapers/';
    const FRAME_BASE = '/wallpaper-frames/';

    let active = 0;          // which buffer is on screen
    let currentName = '';    // the clip that buffer is showing
    let manualPause = false; // the menu-bar pause button, not a policy
    let shuffleTimer = null;
    let listPromise = null;

    /* --------------------------------------------------------- the library */

    function urlFor(name) { return VIDEO_BASE + encodeURIComponent(name); }
    function frameFor(name) { return FRAME_BASE + encodeURIComponent(name.replace(/\.mp4$/i, '.jpg')); }

    /** The registry, fetched once and shared with the Settings gallery. */
    function list() {
        if (!listPromise) {
            listPromise = fetch('/api/wallpapers')
                .then(r => (r.ok ? r.json() : { wallpapers: [] }))
                .then(d => (d && Array.isArray(d.wallpapers) ? d.wallpapers : []))
                .catch(() => []);
        }
        return listPromise;
    }

    // Turning a filename into something readable lives in desktop-prefs.js,
    // which the Settings iframe also loads: its gallery has to label the same
    // files the same way this bar does.
    const prettyName = desk.wallpaperTitle;

    /* ------------------------------------------------------------ playback */

    function reducedMotion() {
        return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    }

    function windowsCover() {
        // windows.js declares openWindows with `const`, so it lives in the
        // script-global lexical scope and never lands on `window`.
        const open = typeof openWindows === 'undefined' ? null : openWindows;
        if (!open) return false;
        for (const key in open) {
            const wb = open[key];
            if (wb && !wb.closed && !wb.min) return true;
        }
        return false;
    }

    /** Everything that decides whether frames should be moving right now. */
    function shouldPlay() {
        const p = desk.all();
        if (p.wpMode !== 'live' || !currentName) return false;
        if (manualPause) return false;
        if (reducedMotion()) return false;
        if (p.wpPauseHidden && document.hidden) return false;
        if (p.wpPauseWindows && windowsCover()) return false;
        return true;
    }

    function syncPlayback() {
        const rate = Math.min(2, Math.max(0.25, Number(desk.get('wpRate')) || 1));
        const go = shouldPlay();
        videos.forEach((v, i) => {
            v.playbackRate = rate;
            if (go && i === active) {
                const started = v.play();
                if (started && started.catch) started.catch(() => { /* autoplay blocked */ });
            } else {
                v.pause();
            }
        });
        if (document.body) {
            document.body.classList.toggle('wp-paused', desk.get('wpMode') === 'live' && !go);
        }
        emit();
    }

    /* ------------------------------------------------------------ swapping */

    function showBuffer(index) {
        videos.forEach((v, i) => v.classList.toggle('on', i === index));
        active = index;
    }

    /** Loads `name` into the spare buffer and crossfades to it. */
    function loadClip(name) {
        if (!name) return;
        if (name === currentName) { syncPlayback(); return; }

        const nextIndex = (active + 1) % videos.length;
        const el = videos[nextIndex];
        const previous = videos[active];

        el.poster = frameFor(name);
        el.src = urlFor(name);
        el.load();

        let settled = false;
        const commit = () => {
            if (settled) return;
            settled = true;
            currentName = name;
            showBuffer(nextIndex);
            syncPlayback();
            // Free the buffer that just left: a paused clip still holds its
            // decoded frames, and at 4K that is real memory.
            setTimeout(() => {
                if (videos[active] === previous) return;
                previous.pause();
                previous.removeAttribute('src');
                previous.load();
            }, 900);
        };

        el.addEventListener('loadeddata', commit, { once: true });
        el.addEventListener('error', () => { settled = true; console.warn('[wallpaper] could not load', name); }, { once: true });
        // A cold clip over a slow link should still get its first frame up.
        setTimeout(commit, 2500);
    }

    /* --------------------------------------------------------------- modes */

    function applyMode() {
        const p = desk.all();
        const live = p.wpMode === 'live';
        if (document.body) document.body.classList.toggle('wp-live', live);

        if (!live) {
            videos.forEach(v => { v.pause(); v.classList.remove('on'); });
            currentName = '';
            stopShuffle();
            emit();
            return;
        }

        if (p.wpShuffle) startShuffle();
        else stopShuffle();

        if (p.wpLive) {
            loadClip(p.wpLive);
        } else {
            // Live mode with nothing chosen yet — which is how Axiom ships —
            // takes the first clip there is. An install with no clips at all
            // falls back to the still picture rather than to a black screen.
            list().then(all => {
                if (all.length) desk.set('wpLive', all[0].name);
                else desk.set('wpMode', 'still');
            });
        }
    }

    /* ------------------------------------------------------------- shuffle */

    function startShuffle() {
        stopShuffle();
        const mins = Math.max(1, Number(desk.get('wpShuffleMins')) || 10);
        shuffleTimer = setInterval(next, mins * 60000);
    }

    function stopShuffle() {
        if (shuffleTimer) clearInterval(shuffleTimer);
        shuffleTimer = null;
    }

    function next() {
        return list().then(all => {
            if (!all.length) return;
            const others = all.filter(w => w.name !== currentName);
            const pool = others.length ? others : all;
            const pick = pool[Math.floor(Math.random() * pool.length)];
            manualPause = false;
            desk.patch({ wpLive: pick.name, wpMode: 'live' });
        });
    }

    /* ------------------------------------------------------------ parallax */

    let parallaxBound = false;

    function bindParallax() {
        if (parallaxBound) return;
        parallaxBound = true;
        window.addEventListener('pointermove', e => {
            if (!desk.get('wpParallax')) return;
            const dx = (e.clientX / window.innerWidth - 0.5) * 2;
            const dy = (e.clientY / window.innerHeight - 0.5) * 2;
            layer.style.setProperty('--wp-shift-x', (-dx * 14).toFixed(1) + 'px');
            layer.style.setProperty('--wp-shift-y', (-dy * 10).toFixed(1) + 'px');
        }, { passive: true });
    }

    function applyParallax() {
        const on = !!desk.get('wpParallax');
        layer.classList.toggle('parallax', on);
        if (on) {
            bindParallax();
        } else {
            layer.style.setProperty('--wp-shift-x', '0px');
            layer.style.setProperty('--wp-shift-y', '0px');
        }
    }

    /* --------------------------------------------------- who wants to know */

    const watchers = new Set();

    function state() {
        return {
            mode: desk.get('wpMode'),
            name: currentName,
            title: currentName ? prettyName(currentName) : '',
            playing: shouldPlay(),
            shuffle: !!desk.get('wpShuffle')
        };
    }

    function emit() {
        const s = state();
        watchers.forEach(fn => { try { fn(s); } catch (e) { console.error(e); } });
    }

    /* ---------------------------------------------------------------- wire */

    desk.on((p, changed) => {
        if (changed.includes('wpMode') || changed.includes('wpLive')) {
            manualPause = false;
            applyMode();
        } else if (changed.includes('wpShuffle')) {
            p.wpShuffle ? startShuffle() : stopShuffle();
            emit();
        } else if (changed.includes('wpShuffleMins')) {
            if (p.wpShuffle) startShuffle();
        }
        if (changed.includes('wpParallax')) applyParallax();
        if (changed.includes('wpRate') || changed.includes('wpPauseHidden') || changed.includes('wpPauseWindows')) {
            syncPlayback();
        }
    });

    document.addEventListener('visibilitychange', syncPlayback);

    // Only worth watching the window list when the user asked us to.
    setInterval(() => {
        if (desk.get('wpPauseWindows') && desk.get('wpMode') === 'live') syncPlayback();
    }, 2000);

    window.AxiomWallpaper = {
        list,
        prettyName,
        urlFor,
        frameFor,
        state,
        next,
        toggle() {
            if (desk.get('wpMode') !== 'live') return;
            manualPause = !manualPause;
            syncPlayback();
        },
        watch(fn) { watchers.add(fn); fn(state()); return () => watchers.delete(fn); }
    };

    applyParallax();
    applyMode();
})();
