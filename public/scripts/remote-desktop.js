import Guacamole from '/remote-desktop/vendor/guacamole-common.js';

const form = document.getElementById('connectionForm');
const status = document.getElementById('connectionStatus');
let client;

function setStatus(message, isError = false) {
    status.textContent = message;
    status.classList.toggle('error', isError);
}

function socketUrl(token) {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${location.host}/remote-desktop/socket?token=${encodeURIComponent(token)}`;
}

form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = form.querySelector('button');
    submit.disabled = true;
    setStatus('Connecting…');

    try {
        const fields = new FormData(form);
        const response = await fetch('/api/remote-desktop/session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(Object.fromEntries(fields))
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Unable to connect.');

        const tunnel = new Guacamole.WebSocketTunnel(socketUrl(result.token));
        client = new Guacamole.Client(tunnel);
        client.onstatechange = (state) => {
            if (state === Guacamole.Client.State.CONNECTED) setStatus('Connected.');
            if (state === Guacamole.Client.State.DISCONNECTED) setStatus('Connection closed.', true);
        };
        tunnel.onerror = () => setStatus('Connection failed.', true);

        const display = document.createElement('div');
        display.className = 'remote-desktop__display';
        display.appendChild(client.getDisplay().getElement());
        document.getElementById('remoteDesktop').replaceChildren(display);

        const mouse = new Guacamole.Mouse(client.getDisplay().getElement());
        mouse.onEach(['mousedown', 'mousemove', 'mouseup'], (event) => client.sendMouseState(event.state, true));

        const keyboard = new Guacamole.Keyboard(document);
        keyboard.onkeydown = (keysym) => client.sendKeyEvent(1, keysym);
        keyboard.onkeyup = (keysym) => client.sendKeyEvent(0, keysym);
        client.connect();
    } catch (error) {
        setStatus(error.message, true);
        submit.disabled = false;
    }
});

window.addEventListener('beforeunload', () => client?.disconnect());
