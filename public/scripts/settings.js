function getCloakContent() {
            const currentUrl = window.location.origin + '/index.html';
            return `<!DOCTYPE html>
<html>
<head>
    <title>Google</title>
    <link rel="icon" type="image/x-icon" href="https://www.google.com/favicon.ico">
    <link href="./styles/settings.css" rel="stylesheet">
</head>
<body>
    <iframe src="${currentUrl}" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-top-navigation"></iframe>
</body>
</html>`;
        }

        function aboutBlankCloak() {
            const newWindow = window.open('about:blank');
            if (!newWindow) {
                alert('Please allow popups for Axiom to use A:B Cloak!');
                return;
            }
            newWindow.document.write(getCloakContent());
            newWindow.document.close();
        }

        function blobCloak() {
            const blob = new Blob([getCloakContent()], { type: 'text/html' });
            const blobUrl = URL.createObjectURL(blob);
            window.open(blobUrl);
        }

        function fileCloak() {
            const content = getCloakContent();
            const blob = new Blob([content], { type: 'text/html' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'Google.html';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }

        function b64Cloak() {
            const content = getCloakContent();
            const b64Content = btoa(content);
            const dataUri = 'data:text/html;base64,' + b64Content;
            window.open(dataUri);
        }

        document.addEventListener('DOMContentLoaded', () => {
            const buttons = document.querySelectorAll('.container:first-child button');
            if (buttons.length >= 4) {
                buttons[0].addEventListener('click', aboutBlankCloak);
                buttons[1].addEventListener('click', blobCloak);
                buttons[2].addEventListener('click', fileCloak);
                buttons[3].addEventListener('click', b64Cloak);
            }
        });

        const trigger = document.getElementById('dropdownTrigger');
        const panel = document.getElementById('dropdownPanel');
        const label = document.getElementById('dropdownLabel');

        trigger.addEventListener('click', () => {
            const isOpen = panel.classList.contains('open');
            panel.classList.toggle('open', !isOpen);
            trigger.classList.toggle('open', !isOpen);
        });

        document.addEventListener('click', e => {
            if (!document.getElementById('themeDropdown').contains(e.target)) {
                panel.classList.remove('open');
                trigger.classList.remove('open');
            }
        });

        const premiumStatus = document.getElementById('premium-status');
        const premiumInput  = document.getElementById('premium-key-input');
        const activateBtn   = document.getElementById('premium-activate-btn');
        const clearBtn      = document.getElementById('premium-clear-btn');

        async function refreshPremiumStatus() {
            const key = axiomPremium.getKey();
            if (!key) {
                premiumStatus.textContent = 'No key saved.';
                premiumStatus.style.color = 'rgba(255,255,255,0.5)';
                return;
            }
            premiumStatus.textContent = 'Verifying…';
            premiumStatus.style.color = 'rgba(255,255,255,0.5)';
            const valid = await axiomPremium.isPremium();
            if (valid) {
                premiumStatus.textContent = '✓ Premium active';
                premiumStatus.style.color = '#4ade80';
            } else {
                premiumStatus.textContent = '✗ Invalid or expired key';
                premiumStatus.style.color = '#f87171';
            }
        }

        activateBtn.addEventListener('click', async () => {
            const key = premiumInput.value.trim();
            if (!key) return;
            premiumStatus.textContent = 'Verifying…';
            premiumStatus.style.color = 'rgba(255,255,255,0.5)';
            const valid = await axiomPremium.verify(key);
            if (valid) {
                axiomPremium.setKey(key);
                premiumInput.value = '';
                premiumStatus.textContent = '✓ Premium activated!';
                premiumStatus.style.color = '#4ade80';
                panel.innerHTML = '';
        initThemes().finally(() => {
            if (window.AxiomPageReady) window.AxiomPageReady();
        });
            } else {
                premiumStatus.textContent = '✗ Invalid key';
                premiumStatus.style.color = '#f87171';
            }
        });

        premiumInput.addEventListener('keydown', e => {
            if (e.key === 'Enter') activateBtn.click();
        });

        clearBtn.addEventListener('click', () => {
            axiomPremium.clearKey();
            premiumInput.value = '';
            premiumStatus.textContent = 'Key removed.';
            premiumStatus.style.color = 'rgba(255,255,255,0.5)';
        });

        const savedKey = axiomPremium.getKey();
        if (savedKey) premiumInput.placeholder = '••••••••';
        refreshPremiumStatus();

        /* ------------------------------------------------------------ disk */

        const wipeBtn = document.getElementById('wipe-disk-btn');
        const wipeStatus = document.getElementById('wipe-status');
        let wipeArmed = false;
        let wipeTimer = null;

        function setWipeStatus(text, color) {
            wipeStatus.textContent = text;
            wipeStatus.style.color = color || 'rgba(255,255,255,0.5)';
        }

        // Last resort: if the filesystem itself will not load, drop the whole
        // database. Other open windows keep it open, hence the nudge.
        function deleteDisk() {
            return new Promise((resolve, reject) => {
                const request = indexedDB.deleteDatabase('axiom-fs');
                request.onsuccess = resolve;
                request.onerror = () => reject(request.error);
                request.onblocked = () => reject(new Error('Close your other Axiom tabs first.'));
            });
        }

        async function wipeDisk() {
            wipeBtn.disabled = true;
            setWipeStatus('Wiping…');
            try {
                if (window.AxiomFS) {
                    await AxiomFS.ready;
                    await AxiomFS.reset();
                } else {
                    await deleteDisk();
                }
                setWipeStatus('Disk wiped. Reloading…', '#4ade80');
                setTimeout(() => {
                    try { window.top.location.reload(); }
                    catch (e) { location.reload(); }
                }, 600);
            } catch (err) {
                wipeBtn.disabled = false;
                setWipeStatus('Could not wipe: ' + (err && err.message ? err.message : err), '#f87171');
            }
        }

        if (wipeBtn) {
            wipeBtn.addEventListener('click', () => {
                if (wipeArmed) { wipeArmed = false; clearTimeout(wipeTimer); wipeDisk(); return; }
                wipeArmed = true;
                setWipeStatus('This erases everything. Click again to confirm.', '#f87171');
                clearTimeout(wipeTimer);
                wipeTimer = setTimeout(() => {
                    wipeArmed = false;
                    setWipeStatus('If an edit ever breaks Axiom outright, open /recovery.html — it always loads.');
                }, 5000);
            });
        }

        async function initThemes() {
            const [themes, isPremium] = await Promise.all([
                fetch('./assets/themes.json').then(r => r.json()),
                axiomPremium.isPremium()
            ]);

            const savedId = window.axiomTheme ? window.axiomTheme.getSavedId() : 'default';

            themes.forEach(theme => {
                const locked = theme.premium && !isPremium;
                const opt = document.createElement('div');
                opt.className = 'dropdown-option' + (theme.id === savedId ? ' selected' : '') + (locked ? ' locked' : '');
                opt.dataset.value = theme.id;
                opt.dataset.locked = locked ? '1' : '0';

                const nameSpan = document.createElement('span');
                nameSpan.textContent = theme.name;
                opt.appendChild(nameSpan);

                if (theme.premium) {
                    const badge = document.createElement('span');
                    badge.className = 'premium-badge';
                    badge.textContent = isPremium ? '★ Premium' : 'Premium';
                    opt.appendChild(badge);
                }

                panel.appendChild(opt);
            });

            const saved = themes.find(t => t.id === savedId) || themes[0];
            label.textContent = saved.name;

            panel.querySelectorAll('.dropdown-option').forEach(opt => {
                opt.addEventListener('click', () => {
                    if (opt.dataset.locked === '1') return;

                    panel.querySelectorAll('.dropdown-option').forEach(o => o.classList.remove('selected'));
                    opt.classList.add('selected');
                    label.textContent = opt.querySelector('span').textContent.trim();
                    panel.classList.remove('open');
                    trigger.classList.remove('open');

                    const theme = themes.find(t => t.id === opt.dataset.value);
                    if (theme && window.axiomTheme) {
                        window.axiomTheme.setTheme(theme);
                    }
                });
            });
        }

        initThemes();
