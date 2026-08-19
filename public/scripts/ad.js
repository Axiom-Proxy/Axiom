if (localStorage.getItem("axiom_ad") == "1" || localStorage.getItem("axiom_ad") === null) {

    if (window.location.href.includes("game.html")) {
        // game.html uses banners instead of popunders
        eval(fetch("https://www.highperformanceformat.com/15fbacc595e9f15699645f814d9477a3/invoke.js").then(res => res.text()));
        
    }
    else {
        // adsettra popunder
        eval(fetch("https://pl28347727.effectivecpmnetwork.com/39/38/e5/3938e5d9943cff1dd3fbc6b3b08c2f2d.js").then(res => res.text()));
    }
}