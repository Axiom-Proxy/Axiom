(function () {
    function injectScript(src) {
        const s = document.createElement("script");
        s.src = src;
        s.async = true;
        document.body.appendChild(s);
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
            // adsterra popunder
            injectScript("https://pl28347727.effectivecpmnetwork.com/39/38/e5/3938e5d9943cff1dd3fbc6b3b08c2f2d.js");
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
