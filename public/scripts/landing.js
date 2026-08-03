const LS_KEY = 'axiom_mode';
let selectedMode = localStorage.getItem(LS_KEY) || 'simple';

function selectMode(mode) {
    selectedMode = mode;
    localStorage.setItem(LS_KEY, mode);
    document.getElementById('simple-mde').classList.toggle('selected', mode === 'simple');
    document.getElementById('mode-windows').classList.toggle('selected', mode === 'windows');
    document.getElementById('mode-remote-desktop').classList.toggle('selected', mode === 'remote-desktop');
}

selectMode(selectedMode);

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
    const w = window.open(targetPage(), 'Google', features);
    setTimeout(() => {
        try {
            w.document.title = 'Google';
            const link = w.document.createElement('link');
            link.rel = 'icon';
            link.href = 'https://www.google.com/favicon.ico';
            w.document.head.appendChild(link);
        } catch (e) {}
    }, 100);
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
}

function openBlobCloak() {
    const blob = new Blob([cloakHTML(targetPage())], { type: 'text/html' });
    window.open(URL.createObjectURL(blob), '_blank');
}

function openABCloak() {
    const tab = window.open('about:blank', '_blank');
    tab.document.write(cloakHTML(targetPage()));
    tab.document.close();
}
