/* Axiom chat — conversation store, sidebar, and composer.
   Conversations live in localStorage so a reload (or reopening the window)
   picks up exactly where the user left off. */

// ---------------------------------------------------------------- storage ---

const STORE_KEY = 'axiom.chat.v1';

let store = { conversations: [], activeId: null };

function loadStore() {
    try {
        const raw = localStorage.getItem(STORE_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.conversations)) {
            store.conversations = parsed.conversations.filter(c => c && Array.isArray(c.messages));
            store.activeId = parsed.activeId || null;
        }
    } catch (e) {
        console.warn('Could not read saved chats:', e);
    }
}

// Base64 images are heavy; when we blow the ~5 MB quota, shed them from the
// oldest conversations first and only then start dropping whole conversations.
function saveStore() {
    for (let attempt = 0; attempt < 12; attempt++) {
        try {
            localStorage.setItem(STORE_KEY, JSON.stringify(store));
            return true;
        } catch (e) {
            const older = [...store.conversations].sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
            const withImages = older.find(c => c.messages.some(m => m.images && m.images.length));
            if (withImages) {
                withImages.messages.forEach(m => { if (m.images) delete m.images; });
                continue;
            }
            if (store.conversations.length > 1) {
                const victim = older[0];
                store.conversations = store.conversations.filter(c => c !== victim);
                continue;
            }
            console.warn('Chat storage full; this conversation will not persist.');
            return false;
        }
    }
    return false;
}

function newId() {
    return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function getActive() {
    return store.conversations.find(c => c.id === store.activeId) || null;
}

function createConversation() {
    const convo = {
        id: newId(),
        title: 'New chat',
        titled: false,
        model: selectedModelId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: []
    };
    store.conversations.unshift(convo);
    store.activeId = convo.id;
    saveStore();
    return convo;
}

function ensureActive() {
    let convo = getActive();
    if (!convo) {
        convo = store.conversations[0] || null;
        if (convo) store.activeId = convo.id;
    }
    if (!convo) convo = createConversation();
    return convo;
}

function touch(convo) {
    convo.updatedAt = Date.now();
    saveStore();
    renderConversationList();
}

function deleteConversation(id) {
    store.conversations = store.conversations.filter(c => c.id !== id);
    if (store.activeId === id) store.activeId = store.conversations[0]?.id || null;
    if (!store.conversations.length) createConversation();
    saveStore();
    renderConversationList();
    renderActiveConversation();
}

// ----------------------------------------------------------------- models ---

const trigger = document.getElementById('dropdownTrigger');
const panel = document.getElementById('dropdownPanel');
const label = document.getElementById('dropdownLabel');

let selectedModelId = null;
let selectedModelPremium = false;
let modelMeta = {};   // id -> { codename, premium }

function selectModel(id, { persist = true } = {}) {
    const meta = modelMeta[id];
    if (!meta) return;
    selectedModelId = id;
    selectedModelPremium = !!meta.premium;
    label.textContent = meta.codename;
    panel.querySelectorAll('.dropdown-option').forEach(o => {
        o.classList.toggle('selected', o.dataset.value === id);
    });
    const convo = getActive();
    if (persist && convo) {
        convo.model = id;
        saveStore();
    }
}

async function loadModels() {
    try {
        const res = await fetch('/api/models');
        const data = await res.json();
        panel.innerHTML = '';
        data.models.forEach(m => {
            modelMeta[m.id] = { codename: m.codename, premium: !!m.premium };
            const opt = document.createElement('div');
            opt.className = 'dropdown-option';
            opt.dataset.value = m.id;
            opt.textContent = m.codename;
            if (m.premium) {
                const crown = document.createElement('span');
                crown.className = 'material-symbols-outlined';
                crown.textContent = 'crown';
                opt.appendChild(crown);
            }
            opt.addEventListener('click', () => {
                selectModel(m.id);
                panel.classList.remove('open');
                trigger.classList.remove('open');
            });
            panel.appendChild(opt);
        });

        // Prefer whatever this conversation was last using, then the default.
        const convo = getActive();
        const wanted = (convo && modelMeta[convo.model] && convo.model)
            || (modelMeta[data.default] && data.default)
            || data.models[0]?.id;
        if (wanted) selectModel(wanted, { persist: false });
    } catch (e) {
        label.textContent = 'Model load failed';
    }
}

trigger.addEventListener('click', () => {
    const isOpen = panel.classList.contains('open');
    panel.classList.toggle('open', !isOpen);
    trigger.classList.toggle('open', !isOpen);
});

document.addEventListener('click', e => {
    if (!document.getElementById('modelDropdown').contains(e.target)) {
        panel.classList.remove('open');
        trigger.classList.remove('open');
    }
});

// ------------------------------------------------------------- attachments ---

let genlock = false;
let activeRequest = null;      // AbortController for the in-flight reply
let pendingImages = [];        // array of base64 data URLs

function toggleAttachMenu() {
    const menu = document.getElementById('attach-menu');
    const showing = menu.classList.toggle('visible');
    document.getElementById('attach-icon').textContent = showing ? 'close' : 'add';
}

function closeAttachMenu() {
    document.getElementById('attach-menu').classList.remove('visible');
    document.getElementById('attach-icon').textContent = 'add';
}

function triggerFileUpload() {
    closeAttachMenu();
    document.getElementById('file-input').click();
}

document.getElementById('file-input').addEventListener('change', function () {
    Array.from(this.files).forEach(file => {
        const reader = new FileReader();
        reader.onload = e => addPreview(e.target.result);
        reader.readAsDataURL(file);
    });
    this.value = '';
});

async function captureTab() {
    closeAttachMenu();
    try {
        const stream = await navigator.mediaDevices.getDisplayMedia({
            video: {
                displaySurface: 'browser', // prefer tab/window picker
                cursor: 'always'
            },
            audio: false,
            selfBrowserSurface: 'included',  // allow current tab as option
            surfaceSwitching: 'include',     // let user switch targets
            systemAudio: 'exclude'
        });
        const video = document.createElement('video');
        video.srcObject = stream;
        await video.play();
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext('2d').drawImage(video, 0, 0);
        stream.getTracks().forEach(t => t.stop());
        addPreview(canvas.toDataURL('image/png'));
    } catch (e) {
        if (e.name !== 'AbortError') toast('Could not capture screen: ' + e.message);
    }
}

function addPreview(dataUrl) {
    pendingImages.push(dataUrl);
    renderPreviews();
}

function removePreview(idx) {
    pendingImages.splice(idx, 1);
    renderPreviews();
}

function renderPreviews() {
    const container = document.getElementById('image-previews');
    container.innerHTML = '';
    pendingImages.forEach((url, i) => {
        const wrap = document.createElement('div');
        wrap.className = 'preview-wrap';
        const img = document.createElement('img');
        img.src = url;
        const rm = document.createElement('div');
        rm.className = 'remove-img';
        rm.textContent = '×';
        rm.onclick = () => removePreview(i);
        wrap.appendChild(img);
        wrap.appendChild(rm);
        container.appendChild(wrap);
    });
}

// Paste an image straight into the composer.
document.addEventListener('paste', e => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
        if (item.type.startsWith('image/')) {
            const file = item.getAsFile();
            if (!file) continue;
            const reader = new FileReader();
            reader.onload = ev => addPreview(ev.target.result);
            reader.readAsDataURL(file);
            e.preventDefault();
        }
    }
});

// --------------------------------------------------------------- rendering ---

const katexOpts = {
    delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '$', right: '$', display: false },
        { left: '\\(', right: '\\)', display: false },
        { left: '\\[', right: '\\]', display: true }
    ],
    throwOnError: false
};

const messagesEl = document.querySelector('.messages');
const emptyStateEl = document.getElementById('empty-state');

function renderBot(el, text) {
    el.innerHTML = DOMPurify.sanitize(marked.parse(text));
    if (window.renderMathInElement) renderMathInElement(el, katexOpts);
}

function isNearBottom(el, slack = 80) {
    return el.scrollHeight - el.scrollTop - el.clientHeight <= slack;
}

function scrollToBottom(el = messagesEl) {
    el.scrollTop = el.scrollHeight;
}

function toast(text) {
    const el = document.getElementById('toast');
    el.textContent = text;
    el.classList.add('visible');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove('visible'), 2600);
}

// Builds one message bubble. `msg` is { role, content, images?, error? }.
function buildMessage(msg, index) {
    const el = document.createElement('div');
    el.classList.add('message', msg.role);
    if (msg.error) el.classList.add('error');

    const body = document.createElement('div');
    body.className = 'message-body';
    if (typeof msg.content === 'string' && msg.content) {
        if (msg.role === 'bot' && !msg.error) renderBot(body, msg.content);
        else body.textContent = msg.content;
    }
    el.appendChild(body);

    if (msg.images && msg.images.length) {
        const strip = document.createElement('div');
        strip.className = 'message-images';
        msg.images.forEach(url => {
            const img = document.createElement('img');
            img.src = url;
            strip.appendChild(img);
        });
        el.appendChild(strip);
    }

    const actions = document.createElement('div');
    actions.className = 'message-actions';

    if (msg.content) {
        actions.appendChild(iconAction('content_copy', 'Copy', () => {
            navigator.clipboard.writeText(msg.content).then(
                () => toast('Copied'),
                () => toast('Could not copy')
            );
        }));
    }
    if (msg.role === 'user') {
        actions.appendChild(iconAction('edit', 'Edit & resend', () => editMessage(index)));
    }
    if (msg.role === 'bot' && !msg.error) {
        actions.appendChild(iconAction('refresh', 'Regenerate', () => regenerate(index)));
    }
    el.appendChild(actions);

    return el;
}

function iconAction(icon, title, onClick) {
    const b = document.createElement('button');
    b.className = 'msg-action';
    b.title = title;
    b.innerHTML = `<span class="material-symbols-outlined">${icon}</span>`;
    b.addEventListener('click', onClick);
    return b;
}

function renderActiveConversation() {
    const convo = ensureActive();
    messagesEl.innerHTML = '';
    convo.messages.forEach((m, i) => messagesEl.appendChild(buildMessage(m, i)));
    emptyStateEl.classList.toggle('visible', convo.messages.length === 0);
    if (convo.model && modelMeta[convo.model] && convo.model !== selectedModelId) {
        selectModel(convo.model, { persist: false });
    }
    requestAnimationFrame(() => scrollToBottom());
}

function appendMessage(msg) {
    const convo = ensureActive();
    const stick = msg.role === 'user' || isNearBottom(messagesEl);
    convo.messages.push(msg);
    const el = buildMessage(msg, convo.messages.length - 1);
    messagesEl.appendChild(el);
    emptyStateEl.classList.remove('visible');
    if (stick) {
        scrollToBottom();
        // images (and KaTeX) change the height after layout — re-pin once they land
        el.querySelectorAll('img').forEach(img => {
            img.addEventListener('load', () => { if (isNearBottom(messagesEl, 200)) scrollToBottom(); });
        });
        requestAnimationFrame(() => scrollToBottom());
    }
    touch(convo);
    return el;
}

// ------------------------------------------------------------ conversations ---

const convoListEl = document.getElementById('convo-list');
const searchEl = document.getElementById('convo-search');

function relativeTime(ts) {
    const diff = Date.now() - (ts || 0);
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    const hours = Math.floor(mins / 60);
    if (hours < 24) return hours + 'h ago';
    const days = Math.floor(hours / 24);
    if (days < 7) return days + 'd ago';
    return new Date(ts).toLocaleDateString();
}

function conversationPreview(convo) {
    const last = convo.messages[convo.messages.length - 1];
    if (!last) return 'No messages yet';
    const who = last.role === 'user' ? 'You: ' : '';
    const plain = String(last.content || '[image]')
        .replace(/```[\s\S]*?```/g, ' [code] ')
        .replace(/[*_`#>~]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    return who + plain.slice(0, 60);
}

function renderConversationList() {
    const query = searchEl.value.trim().toLowerCase();
    convoListEl.innerHTML = '';

    const list = [...store.conversations]
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
        .filter(c => {
            if (!query) return true;
            if ((c.title || '').toLowerCase().includes(query)) return true;
            return c.messages.some(m => String(m.content || '').toLowerCase().includes(query));
        });

    if (!list.length) {
        const empty = document.createElement('div');
        empty.className = 'convo-empty';
        empty.textContent = query ? 'No matching chats' : 'No chats yet';
        convoListEl.appendChild(empty);
        return;
    }

    list.forEach(convo => {
        const item = document.createElement('div');
        item.className = 'convo-item' + (convo.id === store.activeId ? ' active' : '');
        item.dataset.id = convo.id;

        const main = document.createElement('div');
        main.className = 'convo-main';

        const title = document.createElement('div');
        title.className = 'convo-title';
        title.textContent = convo.title || 'New chat';
        if (convo.pendingTitle) title.classList.add('pending');

        const meta = document.createElement('div');
        meta.className = 'convo-meta';
        meta.textContent = relativeTime(convo.updatedAt) + ' · ' + conversationPreview(convo);

        main.appendChild(title);
        main.appendChild(meta);
        main.addEventListener('click', () => switchConversation(convo.id));

        const tools = document.createElement('div');
        tools.className = 'convo-tools';
        tools.appendChild(iconAction('edit', 'Rename', e => {
            e.stopPropagation();
            startRename(item, convo);
        }));
        tools.appendChild(iconAction('delete', 'Delete', e => {
            e.stopPropagation();
            deleteConversation(convo.id);
        }));

        item.appendChild(main);
        item.appendChild(tools);
        item.addEventListener('dblclick', () => startRename(item, convo));
        convoListEl.appendChild(item);
    });
}

function startRename(item, convo) {
    const titleEl = item.querySelector('.convo-title');
    const input = document.createElement('input');
    input.className = 'convo-rename';
    input.value = convo.title || '';
    titleEl.replaceWith(input);
    input.focus();
    input.select();

    const commit = save => {
        if (save) {
            const value = input.value.trim();
            convo.title = value || convo.title || 'New chat';
            convo.titled = true;
            saveStore();
        }
        renderConversationList();
    };
    input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); commit(true); }
        if (e.key === 'Escape') { e.preventDefault(); commit(false); }
    });
    input.addEventListener('blur', () => commit(true));
    input.addEventListener('click', e => e.stopPropagation());
}

function switchConversation(id) {
    if (id === store.activeId) { closeSidebarOnMobile(); return; }
    if (genlock) { toast('Wait for the current reply to finish'); return; }
    store.activeId = id;
    pendingImages = [];
    renderPreviews();
    saveStore();
    renderConversationList();
    renderActiveConversation();
    closeSidebarOnMobile();
}

function newChat() {
    if (genlock) { toast('Wait for the current reply to finish'); return; }
    // Don't pile up empty chats — reuse the current one if it's untouched.
    const current = getActive();
    if (current && current.messages.length === 0) {
        store.activeId = current.id;
    } else {
        createConversation();
    }
    pendingImages = [];
    renderPreviews();
    renderConversationList();
    renderActiveConversation();
    closeSidebarOnMobile();
    inputEl.focus();
}

// ------------------------------------------------------------- title naming ---

function fallbackTitle(text) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (!clean) return 'New chat';
    const words = clean.split(' ').slice(0, 6).join(' ');
    return (words.length < clean.length ? words + '…' : words).slice(0, 60);
}

async function generateTitle(convo, message, reply) {
    if (convo.titled) return;
    convo.pendingTitle = true;
    convo.title = fallbackTitle(message);
    renderConversationList();

    try {
        const res = await fetch('/api/chat-title', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message, reply })
        });
        const data = await res.json();
        if (data.title) convo.title = data.title;
    } catch (e) {
        /* keep the fallback title */
    } finally {
        convo.titled = true;
        delete convo.pendingTitle;
        saveStore();
        renderConversationList();
    }
}

// ------------------------------------------------------------------ sending ---

const inputEl = document.querySelector('.search-bar');
const sendBtn = document.getElementById('send-btn');

function autoGrow() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + 'px';
}
inputEl.addEventListener('input', autoGrow);

inputEl.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
    }
});

sendBtn.addEventListener('click', () => {
    if (genlock) {
        activeRequest?.abort();
    } else {
        send();
    }
});

document.querySelectorAll('.suggestion').forEach(btn => {
    btn.addEventListener('click', () => {
        inputEl.value = btn.dataset.prompt;
        inputEl.focus();
        autoGrow();
    });
});

function setGenerating(on) {
    genlock = on;
    sendBtn.classList.toggle('stop', on);
    sendBtn.title = on ? 'Stop' : 'Send';
    sendBtn.querySelector('.material-symbols-outlined').textContent = on ? 'stop' : 'send';
}

// Converts stored messages into the wire format the /chat endpoint expects.
function buildHistory(messages) {
    return messages.map(m => {
        if (m.role === 'user' && m.images && m.images.length) {
            return {
                role: 'user',
                content: [
                    { type: 'text', text: m.content || '' },
                    ...m.images.map(u => ({ type: 'image_url', image_url: { url: u } }))
                ]
            };
        }
        return { role: m.role === 'user' ? 'user' : 'assistant', content: m.content };
    });
}

function showTyping() {
    const typingEl = document.createElement('div');
    typingEl.classList.add('message', 'bot', 'typing');
    typingEl.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';
    const stick = isNearBottom(messagesEl);
    messagesEl.appendChild(typingEl);
    if (stick) scrollToBottom();
    return typingEl;
}

// Runs one turn: `message`/`images` are already appended to the conversation,
// `history` is everything before them.
async function requestReply(convo, message, images, history) {
    setGenerating(true);
    const typingEl = showTyping();
    activeRequest = new AbortController();

    const headers = { 'Content-Type': 'application/json' };
    const premiumKey = axiomPremium.getKey();
    if (premiumKey) headers['key'] = premiumKey;

    try {
        const res = await fetch('/chat', {
            method: 'POST',
            headers,
            body: JSON.stringify({ message, history, images, model: selectedModelId }),
            signal: activeRequest.signal
        });
        const data = await res.json();
        typingEl.remove();

        if (data.error) {
            appendMessage({ role: 'bot', content: 'Error: ' + data.error, error: true });
        } else {
            appendMessage({ role: 'bot', content: data.response });
            if (!convo.titled) generateTitle(convo, message, data.response);
        }
    } catch (e) {
        typingEl.remove();
        if (e.name === 'AbortError') {
            appendMessage({ role: 'bot', content: 'Stopped.', error: true });
        } else {
            appendMessage({ role: 'bot', content: 'Error: Failed to connect to AI service', error: true });
        }
    } finally {
        activeRequest = null;
        setGenerating(false);
    }
}

async function send() {
    if (genlock) return;
    const message = inputEl.value.trim();
    const images = [...pendingImages];
    if (!message && images.length === 0) return;

    if (selectedModelPremium) {
        const hasPremium = await axiomPremium.isPremium();
        if (!hasPremium) {
            appendMessage({
                role: 'bot',
                content: 'This model requires a premium key. Go to Settings to activate premium.',
                error: true
            });
            return;
        }
    }

    const convo = ensureActive();
    const history = buildHistory(convo.messages);

    inputEl.value = '';
    autoGrow();
    pendingImages = [];
    renderPreviews();
    closeAttachMenu();

    appendMessage({ role: 'user', content: message, images: images.length ? images : undefined });
    await requestReply(convo, message, images, history);
}

// Drops everything from `index` onward and re-asks with the same user turn.
async function regenerate(index) {
    if (genlock) return;
    const convo = ensureActive();
    const userIdx = index - 1;
    const userMsg = convo.messages[userIdx];
    if (!userMsg || userMsg.role !== 'user') { toast('Nothing to regenerate from'); return; }

    convo.messages.splice(userIdx + 1);
    saveStore();
    renderActiveConversation();

    const history = buildHistory(convo.messages.slice(0, userIdx));
    await requestReply(convo, userMsg.content, userMsg.images || [], history);
}

// Puts a user message back in the composer and truncates the conversation there.
function editMessage(index) {
    if (genlock) return;
    const convo = ensureActive();
    const msg = convo.messages[index];
    if (!msg || msg.role !== 'user') return;

    inputEl.value = msg.content || '';
    pendingImages = [...(msg.images || [])];
    convo.messages.splice(index);
    saveStore();
    renderPreviews();
    renderActiveConversation();
    renderConversationList();
    autoGrow();
    inputEl.focus();
}

// ------------------------------------------------------------------ sidebar ---

const sidebarEl = document.getElementById('sidebar');
const SIDEBAR_KEY = 'axiom.chat.sidebar';

function setSidebar(open) {
    document.body.classList.toggle('sidebar-collapsed', !open);
    try { localStorage.setItem(SIDEBAR_KEY, open ? '1' : '0'); } catch (e) { /* ignore */ }
}

function closeSidebarOnMobile() {
    if (window.matchMedia('(max-width: 900px)').matches) setSidebar(false);
}

document.getElementById('collapse-btn').addEventListener('click', () => setSidebar(false));
document.getElementById('open-btn').addEventListener('click', () => setSidebar(true));
document.getElementById('sidebar-scrim').addEventListener('click', () => setSidebar(false));
document.getElementById('new-chat-btn').addEventListener('click', newChat);
searchEl.addEventListener('input', renderConversationList);

document.getElementById('clear-all-btn').addEventListener('click', () => {
    if (genlock) { toast('Wait for the current reply to finish'); return; }
    if (!confirm('Delete every saved chat? This cannot be undone.')) return;
    store.conversations = [];
    store.activeId = null;
    createConversation();
    renderConversationList();
    renderActiveConversation();
});

document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        newChat();
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSidebar(true);
        searchEl.focus();
        searchEl.select();
    }
});

// Another tab (or window) changed the store — pick up its edits.
window.addEventListener('storage', e => {
    if (e.key !== STORE_KEY || genlock) return;
    loadStore();
    renderConversationList();
    renderActiveConversation();
});

// -------------------------------------------------------------------- boot ---

loadStore();
try {
    setSidebar(localStorage.getItem(SIDEBAR_KEY) !== '0');
} catch (e) {
    setSidebar(true);
}
ensureActive();
renderConversationList();
renderActiveConversation();
loadModels();
autoGrow();
