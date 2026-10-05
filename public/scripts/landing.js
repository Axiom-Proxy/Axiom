const LS_KEY = 'axiom_mode';
let selectedMode = localStorage.getItem(LS_KEY) || 'simple';

const modeCards = Array.from(document.querySelectorAll('.mode-card'));

function selectMode(mode) {
    if (!modeCards.some(card => card.dataset.mode === mode)) mode = 'simple';
    selectedMode = mode;
    localStorage.setItem(LS_KEY, mode);
    modeCards.forEach(card => {
        const on = card.dataset.mode === mode;
        card.setAttribute('aria-checked', String(on));
        // Radio group: only the chosen card is in the tab order.
        card.tabIndex = on ? 0 : -1;
    });
}

selectMode(selectedMode);

// Arrow keys move the choice along the row, as in any radio group.
modeCards.forEach((card, index) => {
    card.addEventListener('keydown', event => {
        const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
        if (!step) return;
        event.preventDefault();
        const next = modeCards[(index + step + modeCards.length) % modeCards.length];
        selectMode(next.dataset.mode);
        next.focus();
    });
});

/* The same date and clock the desktop's menu bar keeps. */
let shownClock = '';

function tickClock() {
    const now = new Date();
    const prefs = window.AxiomDesk ? window.AxiomDesk.all() : {};
    const date = prefs.barDate === false ? '' :
        now.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    const time = now.toLocaleTimeString(undefined, {
        hour: 'numeric',
        minute: '2-digit',
        second: prefs.barSeconds ? '2-digit' : undefined,
        hour12: !prefs.bar24h
    });
    // font-scramble.js re-shifts every write; skip the ticks that change nothing.
    if (date + '|' + time === shownClock) return;
    shownClock = date + '|' + time;
    document.getElementById('cc-date').textContent = date;
    document.getElementById('cc-time').textContent = time;
}

tickClock();
setInterval(tickClock, 1000);

function targetPage() {
    return window.location.origin + '/' + selectedMode + '.html';
}

function cloakHTML(src) {
    return `<html>
<head>
  <title>Google</title>
  <link rel="icon" href="https://www.google.com/favicon.ico" type="image/x-icon">
  <link rel="stylesheet" href="${window.location.origin}/styles/cloak.css">
</head>
<body class="cloak-body">
  <iframe src="${src}" style="border: none; height: 100%; width: 100%; position: fixed; left: 0; top: 0;" class="cloak-frame"></iframe>
</body>
</html>`;
}

function openWindowAB() {
    const features = 'width=1200,height=800,resizable=yes,scrollbars=yes,status=yes';
    const w = (window.axiomOpen || window.open)(targetPage(), 'Google', features);
    setTimeout(() => {
        try {
            w.document.title = 'Google';
            const link = w.document.createElement('link');
            link.rel = 'icon';
            link.href = 'https://www.google.com/favicon.ico';
            w.document.head.appendChild(link);
        } catch (e) {}
    }, 100);
    window.location = "https://www.effectivecpmnetwork.com/apcwya80vu?key=d11bdcac615d998ece47753baf97c298"
}

function openFileCloak() {
    const blob = new Blob([cloakHTML(targetPage())], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'axiom.html';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.location = "https://www.effectivecpmnetwork.com/apcwya80vu?key=d11bdcac615d998ece47753baf97c298"
}

function openBlobCloak() {
    const blob = new Blob([cloakHTML(targetPage())], { type: 'text/html' });
    (window.axiomOpen || window.open)(URL.createObjectURL(blob), '_blank');
    window.location = "https://www.effectivecpmnetwork.com/apcwya80vu?key=d11bdcac615d998ece47753baf97c298"
}

function openABCloak() {
    const tab = (window.axiomOpen || window.open)('about:blank', '_blank');
    tab.document.write(cloakHTML(targetPage()));
    tab.document.close();
}

function openB64Cloak() {
    const html = cloakHTML(targetPage());
    const b64 = btoa(unescape(encodeURIComponent(html)));
    window.location = ('data:text/html;base64,' + b64, '_blank');
}
