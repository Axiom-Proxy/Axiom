/*
 * The System Settings shell: sidebar navigation, the sidebar search field and
 * the one control that had no home elsewhere (the ads switch).
 *
 * settings.js still owns every panel's own behaviour — themes, wallpaper,
 * premium, disk. This file only decides which panel is on screen.
 */
(function () {
    'use strict';

    const nav = document.getElementById('sidebar-nav');
    const content = document.getElementById('settings-content');
    if (!nav || !content) return;

    const items = Array.from(nav.querySelectorAll('.nav-item'));
    const panes = Array.from(content.querySelectorAll('.pane'));
    const empty = document.getElementById('search-empty');

    let current = (items[0] && items[0].dataset.section) || '';

    function show(section) {
        current = section;
        items.forEach(item => item.classList.toggle('selected', item.dataset.section === section));
        panes.forEach(pane => pane.classList.toggle('selected', pane.dataset.section === section));
        if (empty) empty.classList.remove('show');
        content.scrollTop = 0;
    }

    items.forEach(item => {
        item.addEventListener('click', () => {
            const field = document.getElementById('settings-search');
            if (field && field.value) {
                field.value = '';
                restoreGroups();
            }
            show(item.dataset.section);
        });
    });

    /* -------------------------------------------------------------- search */

    const groups = Array.from(content.querySelectorAll('.group, .group-label'));

    function restoreGroups() {
        groups.forEach(group => { group.style.display = ''; });
    }

    /**
     * Searching flattens the panels: every group that matches is shown at
     * once, whichever category it belongs to, the way macOS surfaces results
     * from across System Settings.
     */
    function runSearch(query) {
        if (!query) {
            restoreGroups();
            show(current);
            return;
        }

        let hits = 0;
        panes.forEach(pane => {
            let paneHits = 0;
            pane.querySelectorAll('.group, .group-label').forEach(group => {
                // Matching runs against the literal `data-keywords` and the
                // category name, never the DOM text: font-scramble.js has
                // Caesar-shifted every visible string by the time we look.
                const text = ((group.dataset.keywords || '') + ' ' +
                    pane.dataset.section).toLowerCase();
                const match = text.indexOf(query) !== -1;
                group.style.display = match ? '' : 'none';
                if (match) paneHits++;
            });
            // The title stays with its groups, so a pane with no hit goes away.
            pane.classList.toggle('selected', paneHits > 0);
            hits += paneHits;
        });

        items.forEach(item => item.classList.remove('selected'));
        if (empty) empty.classList.toggle('show', hits === 0);
    }

    const field = document.getElementById('settings-search');
    if (field) {
        const box = field.parentElement;
        if (box) {
            box.addEventListener('mousedown', e => {
                if (e.target !== field) field.focus();
            });
        }

        field.addEventListener('input', () => runSearch(field.value.trim().toLowerCase()));
        field.addEventListener('keydown', e => {
            if (e.key !== 'Escape') return;
            field.value = '';
            runSearch('');
            field.blur();
        });
    }

    /* ----------------------------------------------------------- ads switch */

    // ad.js treats a missing flag as "on", so the switch has to as well.
    const AD_KEY = 'axiom_ad';
    const adsToggle = document.getElementById('ads-toggle');
    if (adsToggle) {
        adsToggle.checked = localStorage.getItem(AD_KEY) !== '0';
        adsToggle.addEventListener('change', () => {
            localStorage.setItem(AD_KEY, adsToggle.checked ? '1' : '0');
        });
    }
})();
