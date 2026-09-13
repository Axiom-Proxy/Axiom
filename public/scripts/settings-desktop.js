/*
 * Settings ▸ Desktop, and the live half of Settings ▸ Wallpaper.
 *
 * Every control here is the same three things — a label, a sub-label and a
 * widget bound to one key in AxiomDesk — so they are built from a table
 * rather than written out thirty times in the HTML. The shell picks the
 * changes up over the prefs broadcast channel, so the desktop behind this
 * window updates as the slider moves, with no Apply button anywhere.
 */
(function () {
    'use strict';

    const desk = window.AxiomDesk;
    if (!desk) return;

    /* --------------------------------------------------------- control kit */

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    }

    /** One labelled row inside a group. */
    function row(spec, control) {
        const r = el('div', 'grow');
        const text = el('div', 'grow-text');
        text.appendChild(el('div', 'grow-label', spec.label));
        if (spec.sub) text.appendChild(el('div', 'grow-sub', spec.sub));
        r.appendChild(text);

        const holder = el('div', 'grow-control');
        holder.appendChild(control);
        r.appendChild(holder);
        return r;
    }

    function switchControl(spec) {
        const label = el('label', 'switch');
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = !!desk.get(spec.key);
        label.title = spec.label;
        label.appendChild(input);
        label.appendChild(el('span', 'switch-track'));
        input.addEventListener('change', () => desk.set(spec.key, input.checked));
        desk.on(p => { input.checked = !!p[spec.key]; });
        return label;
    }

    /**
     * A slider with its own readout. The value is written on every `input`
     * event, not on `change`, because watching the wallpaper blur follow the
     * thumb is the entire point of putting it here.
     */
    function sliderControl(spec) {
        const wrap = el('div', 'slider-control');
        const input = document.createElement('input');
        input.type = 'range';
        input.className = 'mac-slider';
        input.min = spec.min;
        input.max = spec.max;
        input.step = spec.step || 1;
        input.value = desk.get(spec.key);
        input.title = spec.label;

        const out = el('span', 'slider-value');
        const paint = v => { out.textContent = spec.format ? spec.format(v) : v; };
        paint(input.value);

        input.addEventListener('input', () => {
            paint(input.value);
            desk.set(spec.key, Number(input.value));
        });
        desk.on(p => {
            if (document.activeElement === input) return;
            input.value = p[spec.key];
            paint(input.value);
        });

        wrap.appendChild(input);
        wrap.appendChild(out);
        return wrap;
    }

    /** Two to four mutually exclusive choices, as one pill. */
    function segmentControl(spec) {
        const seg = el('div', 'seg');
        seg.setAttribute('role', 'group');

        const buttons = spec.options.map(opt => {
            const b = el('button', 'seg-btn', opt.label);
            b.type = 'button';
            b.dataset.value = String(opt.value);
            b.addEventListener('click', () => desk.set(spec.key, opt.value));
            seg.appendChild(b);
            return b;
        });

        const paint = value => buttons.forEach(b => {
            b.classList.toggle('selected', b.dataset.value === String(value));
        });
        paint(desk.get(spec.key));
        desk.on(p => paint(p[spec.key]));
        return seg;
    }

    /*
     * Any Google Fonts family, typed. The shortlist rides in a <datalist> so
     * the common answers are one click away without shutting out the other
     * fifteen hundred; the field itself renders in whatever is chosen, which
     * is the only preview worth having.
     */
    function fontControl(spec) {
        const wrap = el('div', 'font-control');
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'mac-input font-input';
        input.placeholder = 'System default';
        input.setAttribute('list', 'clock-font-list');
        input.autocomplete = 'off';
        input.spellcheck = false;
        input.value = desk.get(spec.key) || '';

        if (!document.getElementById('clock-font-list')) {
            const list = document.createElement('datalist');
            list.id = 'clock-font-list';
            (desk.CLOCK_FONTS || []).forEach(name => {
                if (!name) return;
                const opt = document.createElement('option');
                opt.value = name;
                list.appendChild(opt);
            });
            document.body.appendChild(list);
        }

        const preview = value => {
            input.style.fontFamily = value ? '"' + value + '", "Roboto Plain", sans-serif' : '';
        };

        const commit = () => {
            const name = input.value.trim();
            // Load it before it is saved: a family that never arrives should
            // still show the fallback rather than a blank clock.
            if (name) desk.loadFont(name);
            desk.set(spec.key, name);
            preview(name);
        };

        input.addEventListener('change', commit);
        input.addEventListener('blur', commit);
        input.addEventListener('keydown', e => { if (e.key === 'Enter') commit(); });
        desk.on(p => {
            if (document.activeElement === input) return;
            input.value = p[spec.key] || '';
            preview(input.value);
        });
        preview(input.value);

        const clear = el('button', 'mac-btn', 'Default');
        clear.type = 'button';
        clear.addEventListener('click', () => {
            input.value = '';
            desk.set(spec.key, '');
            preview('');
        });

        wrap.appendChild(input);
        wrap.appendChild(clear);
        return wrap;
    }

    function control(spec) {
        if (spec.kind === 'font') return fontControl(spec);
        if (spec.kind === 'switch') return switchControl(spec);
        if (spec.kind === 'slider') return sliderControl(spec);
        if (spec.kind === 'segment') return segmentControl(spec);
        return el('div');
    }

    /** A settings card: the hairline-separated box every pane is made of. */
    function group(spec) {
        const box = el('div', 'group');
        box.dataset.keywords = spec.keywords || '';
        spec.rows.forEach(r => box.appendChild(row(r, r.node || control(r))));
        return box;
    }

    function render(host, blocks) {
        blocks.forEach(block => {
            if (block.title) {
                const heading = el('div', 'group-label', block.title);
                // The heading carries the same keywords as its box so search
                // never leaves a title stranded above a hidden group.
                heading.dataset.keywords = block.keywords || '';
                host.appendChild(heading);
            }
            host.appendChild(group(block));
        });
    }

    /* --------------------------------------------------- formatting helpers */

    const px = v => Math.round(Number(v)) + ' px';
    const pct = v => Math.round(Number(v)) + '%';
    const scale = v => Number(v).toFixed(2) + '×';
    const mins = v => (Number(v) === 1 ? '1 min' : Math.round(v) + ' min');
    const relative = v => Math.round(Number(v) * 100) + '%';

    /* ------------------------------------------- wallpaper: the live half */

    const modeSeg = document.getElementById('wp-mode-seg');
    if (modeSeg) {
        const buttons = Array.from(modeSeg.querySelectorAll('.seg-btn'));
        const paint = mode => buttons.forEach(b => b.classList.toggle('selected', b.dataset.value === mode));
        buttons.forEach(b => b.addEventListener('click', () => desk.set('wpMode', b.dataset.value)));
        paint(desk.get('wpMode'));
        desk.on(p => paint(p.wpMode));
    }

    const liveOptions = document.getElementById('wp-live-options');
    if (liveOptions) {
        render(liveOptions, [
            {
                title: 'Playback',
                keywords: 'live wallpaper shuffle speed playback rotate rotation interval',
                rows: [
                    {
                        kind: 'switch', key: 'wpShuffle', label: 'Shuffle Automatically',
                        sub: 'Move to another live wallpaper on a timer.'
                    },
                    {
                        kind: 'slider', key: 'wpShuffleMins', label: 'Shuffle Every',
                        min: 1, max: 60, step: 1, format: mins
                    },
                    {
                        kind: 'slider', key: 'wpRate', label: 'Playback Speed',
                        sub: 'Slowing a clip down is usually what makes it read as a wallpaper rather than a video.',
                        min: 0.25, max: 2, step: 0.05, format: scale
                    }
                ]
            },
            {
                title: 'Look',
                keywords: 'blur dim darken brightness saturation colour color vignette parallax depth',
                rows: [
                    { kind: 'slider', key: 'wpBlur', label: 'Blur', min: 0, max: 40, step: 1, format: px },
                    {
                        kind: 'slider', key: 'wpDim', label: 'Dim',
                        sub: 'Darkens the picture so icons and window text stay readable over it.',
                        min: 0, max: 80, step: 1, format: pct
                    },
                    { kind: 'slider', key: 'wpSat', label: 'Colour', min: 50, max: 200, step: 5, format: pct },
                    {
                        kind: 'switch', key: 'wpVignette', label: 'Vignette',
                        sub: 'Shades the edges instead of the whole picture.'
                    },
                    {
                        kind: 'switch', key: 'wpParallax', label: 'Parallax',
                        sub: 'The wallpaper drifts a few pixels against the pointer.'
                    }
                ]
            },
            {
                title: 'Performance',
                keywords: 'battery performance pause cpu power saving hidden windows',
                rows: [
                    {
                        kind: 'switch', key: 'wpPauseHidden', label: 'Pause in the Background',
                        sub: 'Stop decoding while this tab is not the one on screen.'
                    },
                    {
                        kind: 'switch', key: 'wpPauseWindows', label: 'Pause Behind Windows',
                        sub: 'Stop while a window is open over the desktop. Kindest to the battery.'
                    }
                ]
            }
        ]);
    }

    /* ------------------------------------------------------- live gallery */

    const grid = document.getElementById('liveWallpaperGrid');
    const note = document.getElementById('liveWallpaperNote');

    function buildGallery(all) {
        if (!grid) return;

        if (!all.length) {
            grid.innerHTML = '';
            if (note) note.textContent = 'No live wallpapers are installed. Drop MP4s into animated_wallpapers/ and restart the server.';
            return;
        }

        const tiles = all.map(w => {
            const title = desk.wallpaperTitle(w.name);
            const item = el('div', 'wallpaper-item live');
            item.dataset.value = w.name;
            item.dataset.search = title.toLowerCase();
            item.title = title;

            const thumb = el('div', 'wallpaper-thumb');
            thumb.style.backgroundImage = 'url("' + w.frame + '")';
            const badge = el('span', 'live-badge');
            badge.appendChild(el('span', 'material-symbols-outlined', 'play_arrow'));
            thumb.appendChild(badge);

            item.appendChild(thumb);
            item.appendChild(el('span', 'wallpaper-name', title));

            // The clip itself is only fetched once somebody looks at the tile;
            // eagerly loading sixty 4K videos would be absurd.
            let preview = null;
            item.addEventListener('pointerenter', () => {
                if (preview) { preview.play().catch(() => {}); return; }
                preview = document.createElement('video');
                preview.className = 'wallpaper-preview';
                preview.muted = true;
                preview.loop = true;
                preview.playsInline = true;
                preview.preload = 'none';
                preview.src = w.video;
                thumb.appendChild(preview);
                preview.play().then(() => preview.classList.add('on')).catch(() => {});
            });
            item.addEventListener('pointerleave', () => {
                if (!preview) return;
                preview.classList.remove('on');
                preview.pause();
            });

            item.addEventListener('click', () => {
                desk.patch({ wpLive: w.name, wpMode: 'live' });
            });

            grid.appendChild(item);
            return item;
        });

        const paint = p => tiles.forEach(t => {
            t.classList.toggle('selected', p.wpMode === 'live' && t.dataset.value === p.wpLive);
        });
        paint(desk.all());
        desk.on(paint);

        // Sixty tiles is a lot to scroll past, so the gallery filters itself.
        const filter = document.createElement('input');
        filter.type = 'search';
        filter.className = 'mac-input gallery-filter';
        filter.placeholder = 'Filter ' + all.length + ' live wallpapers';
        filter.addEventListener('input', () => {
            const q = filter.value.trim().toLowerCase();
            tiles.forEach(t => { t.hidden = !!q && t.dataset.search.indexOf(q) === -1; });
        });
        grid.parentNode.insertBefore(filter, grid);
    }

    if (grid) {
        const source = window.AxiomWallpaper
            ? window.AxiomWallpaper.list()
            : fetch('/api/wallpapers')
                .then(r => (r.ok ? r.json() : { wallpapers: [] }))
                .then(d => (d && Array.isArray(d.wallpapers) ? d.wallpapers : []))
                .catch(() => []);
        source.then(buildGallery);
    }

    /* ---------------------------------------------------- the Desktop pane */

    const pane = document.getElementById('pane-desktop');
    if (!pane) return;

    render(pane, [
        {
            keywords: 'desktop icons hide show size zen focus distraction wallpaper',
            rows: [
                {
                    kind: 'switch', key: 'showIcons', label: 'Show Desktop Icons',
                    sub: 'Off gives the wallpaper the whole screen. Ctrl+Shift+D toggles it from anywhere.'
                },
                { kind: 'slider', key: 'iconSize', label: 'Icon Size', min: 0.75, max: 1.5, step: 0.05, format: relative },
                {
                    kind: 'switch', key: 'zen', label: 'Zen Mode',
                    sub: 'Icons, dock and menu bar all step aside; each comes back when the pointer reaches its edge. Ctrl+Shift+Z.'
                }
            ]
        },
        {
            title: 'Wallpaper Clock',
            keywords: 'clock time date widget greeting desktop seconds',
            rows: [
                {
                    kind: 'segment', key: 'clockWidget', label: 'Clock',
                    sub: 'A clock painted straight onto the wallpaper, under the icons.',
                    options: [
                        { value: 'off', label: 'Off' },
                        { value: 'small', label: 'Small' },
                        { value: 'large', label: 'Large' }
                    ]
                },
                {
                    kind: 'segment', key: 'clockPos', label: 'Position',
                    options: [
                        { value: 'left', label: 'Left' },
                        { value: 'center', label: 'Centre' },
                        { value: 'right', label: 'Right' }
                    ]
                },
                {
                    kind: 'segment', key: 'clockAlign', label: 'Height',
                    sub: 'Where down the screen it sits. Centred puts it in the middle of the wallpaper rather than up against the menu bar.',
                    options: [
                        { value: 'top', label: 'Top' },
                        { value: 'middle', label: 'Centre' },
                        { value: 'bottom', label: 'Bottom' }
                    ]
                },
                {
                    kind: 'font', key: 'clockFont', label: 'Font',
                    sub: 'Any family on Google Fonts — type its name, or pick one from the list.'
                },
                { kind: 'switch', key: 'clockSeconds', label: 'Show Seconds' },
                {
                    kind: 'switch', key: 'greeting', label: 'Greeting',
                    sub: 'Good morning, good evening, and — after midnight — still up?'
                }
            ]
        },
        {
            title: 'Dock',
            keywords: 'dock taskbar size magnification hide autohide',
            rows: [
                { kind: 'slider', key: 'dockSize', label: 'Size', min: 0.7, max: 1.4, step: 0.05, format: relative },
                {
                    kind: 'switch', key: 'dockMagnify', label: 'Magnification',
                    sub: 'Icons lift and grow under the pointer.'
                },
                { kind: 'switch', key: 'dockAutohide', label: 'Automatically Hide' }
            ]
        },
        {
            title: 'Menu Bar',
            keywords: 'menu bar clock time date battery percentage wallpaper control hide 24 hour seconds',
            rows: [
                { kind: 'switch', key: 'barAutohide', label: 'Automatically Hide' },
                { kind: 'switch', key: 'bar24h', label: '24-Hour Time' },
                { kind: 'switch', key: 'barSeconds', label: 'Show Seconds' },
                { kind: 'switch', key: 'barDate', label: 'Show Date' },
                { kind: 'switch', key: 'barBattPct', label: 'Battery Percentage' },
                {
                    kind: 'switch', key: 'barWallpaper', label: 'Live Wallpaper Control',
                    sub: 'Puts the playing clip, and its pause and shuffle commands, in the menu bar.'
                }
            ]
        },
        {
            title: 'Glass',
            keywords: 'glass blur translucency transparency tint accent frosted opaque solid',
            rows: [
                {
                    kind: 'slider', key: 'transparency', label: 'Transparency',
                    sub: 'At 0% the menu bar, dock, panels and windows are solid. Raising it thins them out and frosts whatever is behind.',
                    min: 0, max: 100, step: 5, format: pct
                },
                {
                    kind: 'switch', key: 'tint', label: 'Accent Tint',
                    sub: 'Washes the frosted surfaces with the theme colour.'
                }
            ]
        }
    ]);

    // Thirty switches deserve one way back.
    const resetBox = el('div', 'group');
    resetBox.dataset.keywords = 'reset defaults desktop restore';
    const resetBtn = el('button', 'mac-btn', 'Reset');
    resetBtn.type = 'button';
    resetBtn.addEventListener('click', () => desk.reset());
    resetBox.appendChild(row({
        label: 'Reset Desktop Settings',
        sub: 'Puts everything on this page, and the wallpaper options, back to how they shipped.'
    }, resetBtn));
    pane.appendChild(resetBox);
})();
