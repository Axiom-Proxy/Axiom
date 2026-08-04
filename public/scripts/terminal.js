/*
 * The terminal window: tab management, line editing and rendering.
 * Command execution itself lives in AxiomShell, running against AxiomFS.
 */
const termTabs = [];
let activeTermId = null;
let termIdCounter = 0;
let termRenderPending = false;

const escHtml = AxiomShell.escHtml;

function genTermId() { return ++termIdCounter; }

/* ------------------------------------------------------------- rendering */

function appendLine(tab, text, cls, html) {
    const out = tab.panel.querySelector('.term-output');
    const line = document.createElement('div');
    line.className = 'term-line' + (cls ? ' ' + cls : '');
    if (html != null) line.innerHTML = html;
    else line.textContent = text;
    // A foreground program prints while the input line is live, so output has
    // to land above it rather than after it.
    const current = tab.currentLineEl;
    out.insertBefore(line, current && current.parentNode === out ? current : null);
    out.scrollTop = out.scrollHeight;
    return line;
}

function promptHtml(tab) {
    if (tab.promptOverride != null) return tab.promptOverride;
    return '<span class="term-path">' + escHtml(tab.session.shortCwd()) + '</span>' +
        '<span class="term-punct">$</span>';
}

function createCurrentLine(tab) {
    const el = document.createElement('div');
    el.className = 'term-line term-current';
    el.innerHTML =
        `<span class="term-prompt">${promptHtml(tab)}</span>` +
        `<span class="term-pre"></span>` +
        `<span class="term-cursor"></span>` +
        `<span class="term-post"></span>`;
    tab.panel.querySelector('.term-output').appendChild(el);
    tab.currentLineEl = el;
}

function renderCurrentLine(tab) {
    const input = tab.hiddenInput;
    const value = input.value;
    const pos = input.selectionStart == null ? value.length : input.selectionStart;
    tab.currentLineEl.querySelector('.term-pre').textContent = value.slice(0, pos);
    tab.currentLineEl.querySelector('.term-post').textContent = value.slice(pos);
    const out = tab.panel.querySelector('.term-output');
    out.scrollTop = out.scrollHeight;
}

function clearScreen(tab) {
    tab.panel.querySelector('.term-output')
        .querySelectorAll('.term-line:not(.term-current)')
        .forEach(el => el.remove());
}

function printBanner(tab) {
    appendLine(tab, null, 'term-banner', '<span class="speciale">Axiom Terminal</span>');
    appendLine(tab, null, 'term-hint term-tip',
        'Type <kbd>help</kbd> for commands, <kbd>Tab</kbd> to complete, ' +
        '<kbd>Ctrl</kbd>+<kbd>L</kbd> to clear.');
    appendLine(tab, null, 'term-hint term-tip',
        'Run <kbd>claude</kbd> to start the coding agent, ' +
        '<kbd>node file.js</kbd> to run a script.');
    appendLine(tab, '');
}

/* -------------------------------------------------------------- actions */

function downloadFile(path) {
    const stat = AxiomFS.stat(path);
    const url = stat.binary
        ? AxiomFS.readFile(path)
        : URL.createObjectURL(new Blob([AxiomFS.readFile(path)], { type: 'text/plain' }));

    const link = document.createElement('a');
    link.href = url;
    link.download = stat.name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    if (!stat.binary) setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function handleAction(tab, action) {
    switch (action.type) {
        case 'clear': clearScreen(tab); break;
        case 'exit': closeTab(tab.id); break;
        case 'edit': AxiomFilesUI.openInFiles(action.path, true); break;
        case 'open': AxiomFilesUI.openInFiles(action.path, false); break;
        case 'download': downloadFile(action.path); break;
        case 'program': startProgram(tab, action.name, action.options); break;
    }
}

/* --------------------------------------------------- foreground programs */

/*
 * A program takes over the input line until it calls host.exit(). While one is
 * running the shell sees nothing: every submitted line goes to the program, and
 * the prompt is whatever the program asked for.
 */
const PROGRAMS = {
    claude: options => window.AxiomClaude && window.AxiomClaude.createProgram(options),
    ssh: options => window.AxiomSSH && window.AxiomSSH.createProgram(options)
};

const SPINNER_FRAMES = ['✻', '✺', '✳', '✶', '✷', '✸'];

function createHost(tab) {
    return {
        write(text, cls) { appendLine(tab, text, cls); },

        writeHtml(html, cls) { appendLine(tab, null, cls, html); },

        /** A single line that grows as chunks arrive, re-rendered as markdown. */
        stream(cls) {
            const line = appendLine(tab, null, cls, '');
            const out = tab.panel.querySelector('.term-output');
            let buffer = '';
            let frame = null;

            const paint = () => {
                frame = null;
                line.innerHTML = AxiomClaude.markdown(buffer);
                out.scrollTop = out.scrollHeight;
            };

            return {
                write(chunk) {
                    buffer += chunk;
                    if (frame == null) frame = requestAnimationFrame(paint);
                },
                end() {
                    if (frame != null) cancelAnimationFrame(frame);
                    paint();
                    if (!buffer) line.remove();
                }
            };
        },

        spinner(label) {
            const line = appendLine(tab, null, 'cc-spinner', '');
            let step = 0;
            let text = label;

            const draw = () => {
                line.innerHTML = '<span class="cc-spin-glyph">' +
                    SPINNER_FRAMES[step % SPINNER_FRAMES.length] + '</span>' +
                    '<span class="cc-spin-label">' + escHtml(text) + '</span>';
            };

            draw();
            const timer = setInterval(() => { step++; draw(); }, 120);

            return {
                set(next) { text = next; draw(); },
                stop() { clearInterval(timer); line.remove(); }
            };
        },

        setPrompt(html) {
            tab.promptOverride = html;
            const current = tab.currentLineEl;
            if (current && current.parentNode) {
                current.querySelector('.term-prompt').innerHTML = promptHtml(tab);
            }
        },

        /** Hide the input line while the program is working, not accepting keys. */
        setBusy(flag) {
            tab.busy = !!flag;
            if (tab.currentLineEl) tab.currentLineEl.classList.toggle('term-hidden', tab.busy);
        },

        clear() { clearScreen(tab); },

        /*
         * A program that draws its own UI rather than printing lines (an SSH
         * session renders itself) gets a container covering the panel. It keeps
         * its own focus, so the hidden input stands down until unmount().
         *
         * The panel is translucent, so the scrollback underneath would show
         * through the program and make both unreadable. Marking the panel
         * hides it for the duration; the lines are still there on unmount.
         */
        mount() {
            if (!tab.mountEl) {
                tab.mountEl = document.createElement('div');
                tab.mountEl.className = 'term-mount';
                tab.panel.appendChild(tab.mountEl);
                tab.panel.classList.add('term-mounted');
                tab.hiddenInput.blur();
            }
            return tab.mountEl;
        },

        unmount() {
            if (!tab.mountEl) return;
            tab.mountEl.remove();
            tab.mountEl = null;
            tab.panel.classList.remove('term-mounted');
            if (tab.id === activeTermId) tab.hiddenInput.focus();
        },

        exit() {
            this.unmount();
            tab.program = null;
            tab.promptOverride = null;
            tab.busy = false;
            if (tab.currentLineEl && tab.currentLineEl.parentNode) {
                tab.currentLineEl.classList.remove('term-hidden');
                tab.currentLineEl.querySelector('.term-prompt').innerHTML = promptHtml(tab);
            }
        }
    };
}

function startProgram(tab, name, options) {
    const program = PROGRAMS[name] && PROGRAMS[name](options || {});
    if (!program) {
        appendLine(tab, name + ': program unavailable in this window', 'term-error');
        return;
    }
    tab.program = program;
    program.start(createHost(tab));
}

/** Enter, Ctrl+C and Escape while a program owns the terminal. */
function handleProgramKey(e, tab) {
    if (e.key === 'Enter') {
        e.preventDefault();
        if (tab.busy) return;
        const line = tab.hiddenInput.value;
        const program = tab.program;
        if (line.trim()) tab.history.push(line);
        tab.histIndex = tab.history.length;
        tab.hiddenInput.value = '';
        tab.currentLineEl.remove();
        appendLine(tab, null, 'term-echo', promptHtml(tab) + ' ' + escHtml(line));
        createCurrentLine(tab);
        tab.currentLineEl.classList.add('focused');
        renderCurrentLine(tab);
        program.onLine(line);
        return true;
    }

    if (e.key === 'Escape' || (e.key === 'c' && e.ctrlKey && !window.getSelection().toString())) {
        e.preventDefault();
        const handled = tab.program.onInterrupt();
        if (!handled) appendLine(tab, null, 'term-echo', '^C');
        return true;
    }

    return false;
}

/* ------------------------------------------------------------ execution */

function runLine(tab, line) {
    appendLine(tab, null, 'term-echo', promptHtml(tab) + ' ' + escHtml(line));

    if (!line.trim()) return;

    const result = tab.session.run(line);
    result.output.forEach(record => {
        appendLine(tab, record.text, record.cls, record.html);
    });
    result.actions.forEach(action => handleAction(tab, action));
}

function completeLine(tab) {
    const input = tab.hiddenInput;
    const completion = tab.session.complete(input.value);
    if (!completion) return;

    if (completion.insert) {
        input.value += completion.insert;
        if (completion.exact && !/\/$/.test(input.value)) input.value += ' ';
        renderCurrentLine(tab);
        return;
    }

    if (completion.candidates.length > 1) {
        const pending = input.value;
        tab.currentLineEl.remove();
        appendLine(tab, null, 'term-echo', promptHtml(tab) + ' ' + escHtml(pending));
        appendLine(tab, completion.candidates.join('  '), 'term-hint');
        createCurrentLine(tab);
        tab.currentLineEl.classList.add('focused');
        renderCurrentLine(tab);
    }
}

function handleInputKey(e, tab) {
    // History and completion still work; the rest belongs to the program.
    if (tab.program && handleProgramKey(e, tab)) return;
    if (tab.program && e.key === 'Tab') { e.preventDefault(); return; }

    if (e.key === 'Enter') {
        e.preventDefault();
        const line = tab.hiddenInput.value;
        if (line.trim()) {
            tab.session.history.push(line);
            tab.history.push(line);
        }
        tab.histIndex = tab.history.length;
        tab.hiddenInput.value = '';
        tab.currentLineEl.remove();
        runLine(tab, line);
        if (!termTabs.includes(tab)) return; // `exit` closed us
        createCurrentLine(tab);
        tab.currentLineEl.classList.add('focused');
        renderCurrentLine(tab);
    } else if (e.key === 'Tab') {
        e.preventDefault();
        completeLine(tab);
    } else if (e.key === 'ArrowUp') {
        if (!tab.history.length) return;
        e.preventDefault();
        tab.histIndex = Math.max(0, tab.histIndex - 1);
        tab.hiddenInput.value = tab.history[tab.histIndex] || '';
        renderCurrentLine(tab);
    } else if (e.key === 'ArrowDown') {
        if (!tab.history.length) return;
        e.preventDefault();
        tab.histIndex = Math.min(tab.history.length, tab.histIndex + 1);
        tab.hiddenInput.value = tab.history[tab.histIndex] || '';
        renderCurrentLine(tab);
    } else if (e.key === 'c' && e.ctrlKey) {
        // Only abort the line when there is nothing selected to copy.
        if (window.getSelection().toString()) return;
        e.preventDefault();
        const pending = tab.hiddenInput.value;
        tab.hiddenInput.value = '';
        tab.currentLineEl.remove();
        appendLine(tab, null, 'term-echo', promptHtml(tab) + ' ' + escHtml(pending) + '^C');
        createCurrentLine(tab);
        tab.currentLineEl.classList.add('focused');
        renderCurrentLine(tab);
    } else if (e.key === 'l' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        clearScreen(tab);
    } else if (e.key === 'u' && e.ctrlKey) {
        e.preventDefault();
        tab.hiddenInput.value = '';
        renderCurrentLine(tab);
    }
}

/* ----------------------------------------------------------------- tabs */

function createTab() {
    const id = genTermId();

    const panel = document.createElement('div');
    panel.className = 'term-panel';
    panel.innerHTML =
        `<div class="term-output"></div>` +
        `<input class="term-hidden-input" type="text" autocomplete="off" autocapitalize="off" spellcheck="false">`;

    document.getElementById('content-area').appendChild(panel);

    const tab = {
        id,
        title: 'Terminal ' + id,
        panel,
        history: [],
        histIndex: 0,
        program: null,
        promptOverride: null,
        busy: false,
        mountEl: null,
        hiddenInput: panel.querySelector('.term-hidden-input')
    };
    tab.session = AxiomShell.createSession({
        onCwdChange() {
            tab.title = AxiomFS.basename(tab.session.cwd) || '/';
            renderTabs();
        }
    });

    termTabs.push(tab);
    printBanner(tab);
    createCurrentLine(tab);

    const input = tab.hiddenInput;
    input.addEventListener('keydown', e => handleInputKey(e, tab));
    input.addEventListener('input', () => renderCurrentLine(tab));
    input.addEventListener('keyup', () => renderCurrentLine(tab));
    input.addEventListener('click', () => renderCurrentLine(tab));
    input.addEventListener('focus', () => tab.currentLineEl.classList.add('focused'));
    input.addEventListener('blur', () => tab.currentLineEl.classList.remove('focused'));

    panel.addEventListener('mousedown', e => {
        if (e.target.closest('.tab, #new-tab-btn, button')) return;
        if (tab.mountEl) return; // a mounted program owns its own focus
        if (window.getSelection().toString()) return;
        e.preventDefault();
        input.focus();
    });

    activateTab(id);
    return tab;
}

function closeTab(id) {
    const idx = termTabs.findIndex(t => t.id === id);
    if (idx === -1) return;
    // Let a running program drop its connection rather than leaking it.
    const dying = termTabs[idx];
    if (dying.program && dying.program.onClose) dying.program.onClose();
    dying.panel.remove();
    termTabs.splice(idx, 1);
    if (termTabs.length === 0) { createTab(); return; }
    if (activeTermId === id) {
        activateTab(termTabs[Math.min(idx, termTabs.length - 1)].id);
    } else {
        renderTabs();
    }
}

function activateTab(id) {
    const next = termTabs.find(t => t.id === id);
    if (!next) return;
    termTabs.forEach(t => t.panel.classList.remove('active'));
    next.panel.classList.add('active');
    activeTermId = id;
    renderTabs();
    if (next.mountEl) next.mountEl.querySelector('.term-mount-surface').focus();
    else next.hiddenInput.focus();
}

function moveTab(from, to) {
    if (from !== to && termTabs[from]) {
        const [moved] = termTabs.splice(from, 1);
        termTabs.splice(to, 0, moved);
    } else if (!termRenderPending) {
        return;   // nothing moved and nothing was deferred
    }
    renderTabs();
}

function renderTabs() {
    // Rebuilding the strip mid-drag would tear out the tab being dragged.
    if (window.AxiomTabDrag && AxiomTabDrag.isActive()) { termRenderPending = true; return; }
    termRenderPending = false;

    const list = document.getElementById('tab-list');
    const prevScroll = list.scrollLeft;
    list.innerHTML = '';

    termTabs.forEach(tab => {
        const el = document.createElement('div');
        el.className = 'tab' + (tab.id === activeTermId ? ' active' : '');
        el.dataset.id = String(tab.id);
        el.innerHTML =
            `<div class="tab-favicon"><span class="material-symbols-outlined">terminal</span></div>` +
            `<span class="tab-title">${escHtml(tab.title)}</span>` +
            `<button class="tab-close" title="Close tab"><span class="material-symbols-outlined">close</span></button>`;

        el.querySelector('.tab-close').addEventListener('click', e => {
            e.stopPropagation();
            closeTab(tab.id);
        });

        // Browsers select a tab the instant you press it, then let the same
        // press turn into a drag once the cursor actually moves.
        el.addEventListener('pointerdown', e => {
            if (e.button !== 0 || e.target.closest('.tab-close')) return;
            e.preventDefault();
            if (activeTermId !== tab.id) activateTab(tab.id);
            AxiomTabDrag.start(e, document.getElementById('tab-list'), tab.id, moveTab);
        });

        list.appendChild(el);
    });

    list.scrollLeft = prevScroll;
}

document.getElementById('new-tab-btn').addEventListener('click', () => createTab());

document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 't') { e.preventDefault(); createTab(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'w') { e.preventDefault(); if (activeTermId !== null) closeTab(activeTermId); }
});

// If the working directory was deleted from the Files app, fall back to home.
AxiomFS.on(() => {
    if (!termTabs.length) return;
    termTabs.forEach(tab => {
        if (!AxiomFS.isDirectory(tab.session.cwd)) {
            tab.session.setCwd(AxiomFS.exists(AxiomFS.HOME) ? AxiomFS.HOME : '/');
            if (tab.currentLineEl) {
                tab.currentLineEl.querySelector('.term-prompt').innerHTML = promptHtml(tab);
            }
        }
    });
});

// The filesystem loads from IndexedDB (and seeds itself on first run) before
// the first shell can start.
AxiomFS.ready.then(() => createTab());
