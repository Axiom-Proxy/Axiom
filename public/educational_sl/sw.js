importScripts("/educational_sl/config.js");
importScripts("/educational_vr/scramjet.all.js");

const { ScramjetServiceWorker } = $scramjetLoadWorker();
const scramjet = new ScramjetServiceWorker();

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

async function handleRequest(event) {
	if (!event.request.url.includes(self.__scramjet$config.prefix)) {
		return fetch(event.request);
	}
	try {
		// Always read from IDB so c.Nk runs and sets the module-level config
		// that the URL rewriter uses. If we skip this (postMessage set this.config
		// first), loadConfig() short-circuits and n.$W stays undefined → prefix crash.
		scramjet.config = undefined;
		await scramjet.loadConfig();
		if (scramjet.route(event)) {
			return scramjet.fetch(event);
		}
	} catch (e) {
		console.warn("[SW] scramjet not ready, falling back:", e.message);
	}
	return fetch(event.request);
}

self.addEventListener("fetch", (event) => {
	event.respondWith(handleRequest(event));
});