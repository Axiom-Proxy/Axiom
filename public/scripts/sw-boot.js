/*
 * Installs the service worker that backs the /system filesystem overlay.
 *
 * It is deliberately the same script and scope the proxy registers in
 * render.js: only one worker can own scope "/", so the two share a
 * registration rather than evicting each other. Registering it here means the
 * desktop installs it on first load instead of waiting for someone to open the
 * browser app.
 */
(function () {
  'use strict';

  if (!navigator.serviceWorker) return;
  if (location.protocol !== 'https:' &&
      ['localhost', '127.0.0.1'].indexOf(location.hostname) === -1) return;
  // Recovery loads: do not (re)install the thing that may be serving the brick.
  if (location.search.indexOf('__axiom_raw') !== -1) return;

  navigator.serviceWorker.register('/educational_sl/sw.js', { scope: '/' })
    .catch(function (err) {
      console.warn('Axiom: service worker registration failed.', err);
    });
})();
