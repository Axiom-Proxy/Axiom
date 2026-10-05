/*
 * Points --wallpaper at the picture the desktop shows, for pages that stand
 * on backdrop.css rather than inside windows.html (which keeps its own copy
 * in windows.js). Settings pings axiom_wallpaper_broadcast when it changes.
 */
(function () {
    'use strict';

    function applyWallpaper() {
        let saved = window.AxiomDesk?.DEFAULT_WALLPAPER || 'forest';
        let custom = null;
        try {
            saved = localStorage.getItem('axiom_wallpaper') || saved;
            custom = localStorage.getItem('axiom_custom_wallpaper');
        } catch (error) { /* storage blocked: default picture */ }
        const url = custom && saved === '_custom' ? custom : '/assets/wallpapers/' + saved + '.webp';
        document.documentElement.style.setProperty('--wallpaper', 'url("' + url + '")');
    }

    applyWallpaper();
    window.addEventListener('storage', function (event) {
        if (['axiom_theme_id', 'axiom_wallpaper', 'axiom_custom_wallpaper', 'axiom_wallpaper_broadcast'].includes(event.key)) {
            applyWallpaper();
        }
    });
})();
