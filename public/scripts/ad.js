(function () {
    // How often a popunder is allowed to fire, across pages and reloads.
    // The Adsterra popunder script attaches its own click listeners and will
    // try to open a new window on almost every interaction, which makes the
    // site unusable. We throttle it to at most one popunder per this window.
    const POPUNDER_COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes
    const POPUNDER_TS_KEY = "axiom_popunder_ts";

    function injectScript(src) {
        const s = document.createElement("script");
        s.src = src;
        s.async = true;
        s.setAttribute("data-cfasync", "false");
        document.body.appendChild(s);
    }

    function popunderAllowed() {
        try {
            const last = parseInt(localStorage.getItem(POPUNDER_TS_KEY) || "0", 10);
            return !last || (Date.now() - last) >= POPUNDER_COOLDOWN_MS;
        } catch (e) {
            // If storage is unavailable, fail closed so we don't spam popunders.
            return false;
        }
    }

    function markPopunder() {
        try {
            localStorage.setItem(POPUNDER_TS_KEY, String(Date.now()));
        } catch (e) {}
    }

    // Wrap window.open so uncapped ad popunders are throttled, while the site's
    // own intentional window.open calls (launch buttons, Discord, etc.) go
    // through untouched. Call window.axiomOpen(...) for an intentional open;
    // any other window.open call is treated as a popunder and rate-limited.
    function installOpenGuard() {
        if (window.__axiomOpenGuard) return;
        window.__axiomOpenGuard = true;

        const realOpen = window.open ? window.open.bind(window) : null;
        if (!realOpen) return;

        let intentional = false;

        window.axiomOpen = function () {
            intentional = true;
            try {
                return realOpen.apply(null, arguments);
            } finally {
                intentional = false;
            }
        };

        window.open = function () {
            if (intentional) {
                return realOpen.apply(null, arguments);
            }
            // Anything not explicitly intentional is an ad popunder.
            if (!popunderAllowed()) {
                return null; // swallow the popunder during cooldown
            }
            markPopunder();
            return realOpen.apply(null, arguments);
        };
    }

    function injectAds() {
        if (window.location.href.includes("game.html")) {
            // game.html uses banners instead of popunders
            // Banner needs atOptions declared first
            window.atOptions = {
                'key': '15fbacc595e9f15699645f814d9477a3',
                'format': 'iframe',
                'height': 600,
                'width': 160,
                'params': {}
            };
            injectScript("https://www.highperformanceformat.com/15fbacc595e9f15699645f814d9477a3/invoke.js");
        }
        else {
            // adsterra popunder — throttled via the window.open guard below
            installOpenGuard();
            injectScript("https://abscloud.org/1/3938e5d9943cff1dd3fbc6b3b08c2f2d");
        }
    }

    // Turning ads off is a premium perk. Free users always see ads regardless
    // of the local flag; only verified premium users may switch them off.
    const wantsAdsOff = localStorage.getItem("axiom_ad") === "0";

    function decide(isPremium) {
        if (isPremium && wantsAdsOff) return; // premium user opted out
        injectAds();
    }

    if (window.axiomPremium && typeof axiomPremium.isPremium === "function") {
        axiomPremium.isPremium().then(decide).catch(() => decide(false));
    } else {
        decide(false);
    }
})();
