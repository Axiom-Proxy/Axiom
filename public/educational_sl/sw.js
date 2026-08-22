importScripts("/educational_controller/controller.sw.js");
importScripts("/scripts/axiom-sw.js");

// One worker, one scope: the proxy gets first refusal on every request, and
// anything it does not want is offered to the Axiom filesystem overlay before
// falling through to the network.
addEventListener("fetch", (event) => {
	if ($engnxjetController.shouldRoute(event)) {
		event.respondWith($engnxjetController.route(event));
		return;
	}

	const override = AxiomOverride.match(event);
	if (override) event.respondWith(override);
});
