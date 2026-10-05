const simplePages = {
    start: { title: "Home", icon: "home", src: "start.html" },
    apps: { title: "Apps", icon: "apps", src: "apps.html" },
    games: { title: "Games", icon: "sports_esports", src: "games_norm.html" },
    chat: { title: "Chat", icon: "chat", src: "chat.html" },
    settings: { title: "Settings", icon: "settings", src: "settings.html" }
};

const simpleTabs = [];
let activeTab = null;
let nextTabId = 1;

/* ---------------------------------------------------------------- loading */

const progress = document.getElementById("stage-progress");

function showProgress(loading) {
    progress.classList.remove("loading", "done");
    // Restart the animation even when a second load follows the first.
    void progress.offsetWidth;
    progress.classList.add(loading ? "loading" : "done");
}

/* ------------------------------------------------------------------- tabs */

function syncShortcuts() {
    document.querySelectorAll(".shortcut").forEach(function (button) {
        const page = button.dataset.page;
        const active = !!activeTab && activeTab.page === page;
        button.classList.toggle("active", active);
        button.classList.toggle("open", simpleTabs.some(function (tab) { return tab.page === page; }));
        if (active) button.setAttribute("aria-current", "page");
        else button.removeAttribute("aria-current");
    });
}

function selectTab(tab) {
    const changed = activeTab !== tab;
    activeTab = tab;
    simpleTabs.forEach(function (item) {
        const active = item === tab;
        item.element.classList.toggle("active", active);
        item.frame.hidden = !active;
        if (active) item.select.setAttribute("aria-current", "page");
        else item.select.removeAttribute("aria-current");
    });
    if (changed) {
        tab.frame.classList.remove("entering");
        void tab.frame.offsetWidth;
        tab.frame.classList.add("entering");
        showProgress(tab.loading);
    }
    syncShortcuts();
    syncAddress();
    tab.element.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
}

function createTab(options) {
    const id = nextTabId++;
    const element = document.createElement("div");
    element.className = "tab";

    const select = document.createElement("button");
    select.className = "tab-select";
    select.type = "button";
    select.title = options.title;

    const icon = document.createElement("span");
    icon.className = "material-symbols-outlined";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = options.icon;

    const label = document.createElement("span");
    label.className = "tab-label";
    label.textContent = options.title;
    select.append(icon, label);

    const close = document.createElement("button");
    close.className = "tab-close";
    close.type = "button";
    close.title = "Close tab (Alt+W)";
    close.setAttribute("aria-label", "Close " + options.title + " tab");
    close.innerHTML = '<span class="material-symbols-outlined" aria-hidden="true">close</span>';
    element.append(select, close);

    const frame = document.createElement("iframe");
    frame.className = "app-frame";
    frame.title = options.title;
    frame.hidden = true;
    frame.src = options.src;

    const tab = { id, page: options.page || null, key: options.key || null, loading: true, element, select, label, icon, close, frame };
    select.addEventListener("click", function () {
        // The click that ends a drag is not a request to open the tab.
        if (tab.dragged) { tab.dragged = false; return; }
        selectTab(tab);
    });
    element.addEventListener("pointerdown", function (event) { beginTabDrag(tab, event); });
    close.addEventListener("click", function () { closeTab(tab); });
    // Middle-click closes, as it does in every browser.
    element.addEventListener("auxclick", function (event) {
        if (event.button === 1) { event.preventDefault(); closeTab(tab); }
    });
    element.addEventListener("mousedown", function (event) {
        if (event.button === 1) event.preventDefault();
    });
    frame.addEventListener("load", function () {
        tab.loading = false;
        tab.url = null;
        if (activeTab === tab) showProgress(false);
        try {
            const doc = frame.contentDocument;
            // Keys pressed inside a same-origin page still reach the shell.
            frame.contentWindow.addEventListener("keydown", handleShortcutKey);
            if (doc.querySelector('script[src$="/theme.js"]')) {
                doc.body.style.setProperty("background", "var(--bg, #000)", "important");
                doc.body.style.setProperty("background-attachment", "fixed", "important");
            }
            if (!tab.page) return;
            const current = new URL(frame.contentWindow.location.href);
            if (current.pathname.endsWith("/" + simplePages[tab.page].src)) return;
            tab.page = null;
            const title = doc.title;
            label.textContent = title && title !== "Axiom" ? title : "Browser";
            select.title = label.textContent;
            icon.textContent = "language";
            if (activeTab === tab) selectTab(tab);
            else syncShortcuts();
        } catch (error) { /* Cross-origin pages keep their original tab label. */ }
    });
    frame.addEventListener("load", function () {
        if (activeTab === tab) syncAddress();
    });

    simpleTabs.push(tab);
    document.getElementById("tabs").appendChild(element);
    document.getElementById("frames").appendChild(frame);
    selectTab(tab);
    return tab;
}

function closeTab(tab) {
    const index = simpleTabs.indexOf(tab);
    if (index < 0) return;
    simpleTabs.splice(index, 1);
    tab.frame.remove();
    // Let the tab fold away instead of vanishing out from under the pointer.
    tab.element.classList.add("closing");
    setTimeout(function () { tab.element.remove(); }, 220);
    if (activeTab === tab) {
        activeTab = null;
        if (simpleTabs.length) selectTab(simpleTabs[Math.min(index, simpleTabs.length - 1)]);
        else newTab();
    } else {
        syncShortcuts();
    }
}

/* ------------------------------------------------------------ tab dragging */

/*
 * Chrome's model, not drag-and-drop: the tab under the pointer follows it
 * along the strip, and the tabs it passes slide over to make room. Nothing is
 * reordered until release, when the dragged tab glides into its slot and the
 * DOM is rearranged underneath in a single frame.
 *
 * Every position is in the strip's scroll coordinates (client x, minus the
 * strip's left edge, plus its scrollLeft), so auto-scrolling a crowded strip
 * mid-drag does not throw the dragged tab off the pointer.
 */
const tabsEl = document.getElementById("tabs");
const DRAG_THRESHOLD = 5;
const EDGE_SCROLL = 36;
let tabDrag = null;
let tabSettling = false;

function stripX(clientX) {
    return clientX - tabsEl.getBoundingClientRect().left + tabsEl.scrollLeft;
}

function beginTabDrag(tab, event) {
    if (event.button !== 0 || tabDrag || tabSettling) return;
    if (event.target.closest(".tab-close")) return;
    // Chrome activates on press, not on release.
    if (activeTab !== tab) selectTab(tab);
    tabDrag = {
        tab,
        pointerId: event.pointerId,
        startX: stripX(event.clientX),
        clientX: event.clientX,
        started: false,
        slots: null,
        from: 0,
        to: 0,
        offset: 0,
        scrollRAF: 0
    };
    window.addEventListener("pointermove", moveTabDrag);
    window.addEventListener("pointerup", endTabDrag);
    window.addEventListener("pointercancel", endTabDrag);
}

function startTabDrag() {
    const drag = tabDrag;
    drag.started = true;
    const base = tabsEl.getBoundingClientRect().left - tabsEl.scrollLeft;
    // Where every tab sits right now, before anything moves.
    drag.slots = simpleTabs.map(function (item) {
        const rect = item.element.getBoundingClientRect();
        return { tab: item, left: rect.left - base, width: rect.width };
    });
    drag.from = drag.to = simpleTabs.indexOf(drag.tab);
    const style = getComputedStyle(tabsEl);
    drag.gap = parseFloat(style.columnGap) || 0;
    try { drag.tab.element.setPointerCapture(drag.pointerId); } catch (error) { /* already released */ }
    drag.tab.element.classList.add("dragging");
    document.body.classList.add("tab-dragging");
}

// The left edge each tab would have if the strip were laid out in `order`.
function layoutLefts(order, drag) {
    const lefts = new Map();
    let x = drag.slots[0].left;
    order.forEach(function (slot) {
        lefts.set(slot.tab, x);
        x += slot.width + drag.gap;
    });
    return lefts;
}

function orderWith(drag, to) {
    const others = drag.slots.filter(function (slot) { return slot.tab !== drag.tab; });
    others.splice(to, 0, drag.slots[drag.from]);
    return others;
}

function moveTabDrag(event) {
    const drag = tabDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag.clientX = event.clientX;
    if (!drag.started) {
        if (Math.abs(stripX(event.clientX) - drag.startX) < DRAG_THRESHOLD) return;
        startTabDrag();
    }
    event.preventDefault();
    positionTabDrag();
    autoScrollTabs();
}

function positionTabDrag() {
    const drag = tabDrag;
    const own = drag.slots[drag.from];
    const first = drag.slots[0];
    const last = drag.slots[drag.slots.length - 1];
    // Held inside the strip: the tab can go to either end, never past it.
    const offset = Math.max(
        first.left - own.left,
        Math.min(last.left + last.width - own.left - own.width, stripX(drag.clientX) - drag.startX)
    );
    drag.offset = offset;
    drag.tab.element.style.transform = "translateX(" + offset + "px)";

    // The slot is decided by the dragged tab's centre, as in Chrome: it takes
    // a neighbour's place once it has covered half of it.
    const centre = own.left + offset + own.width / 2;
    let to = 0;
    drag.slots.forEach(function (slot) {
        if (slot.tab !== drag.tab && slot.left + slot.width / 2 < centre) to++;
    });
    if (to === drag.to) return;
    drag.to = to;
    const lefts = layoutLefts(orderWith(drag, to), drag);
    drag.slots.forEach(function (slot) {
        if (slot.tab === drag.tab) return;
        const shift = lefts.get(slot.tab) - slot.left;
        slot.tab.element.style.transform = shift ? "translateX(" + shift + "px)" : "";
    });
}

// A crowded strip scrolls while the pointer is held against either end.
function autoScrollTabs() {
    const drag = tabDrag;
    if (!drag || drag.scrollRAF) return;
    const rect = tabsEl.getBoundingClientRect();
    let speed = 0;
    if (drag.clientX < rect.left + EDGE_SCROLL) speed = -Math.min(14, (rect.left + EDGE_SCROLL - drag.clientX) / 3);
    else if (drag.clientX > rect.right - EDGE_SCROLL) speed = Math.min(14, (drag.clientX - rect.right + EDGE_SCROLL) / 3);
    if (!speed) return;
    const before = tabsEl.scrollLeft;
    tabsEl.scrollLeft += speed;
    if (tabsEl.scrollLeft === before) return;
    positionTabDrag();
    drag.scrollRAF = requestAnimationFrame(function () {
        drag.scrollRAF = 0;
        if (tabDrag === drag) autoScrollTabs();
    });
}

function endTabDrag(event) {
    const drag = tabDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    tabDrag = null;
    window.removeEventListener("pointermove", moveTabDrag);
    window.removeEventListener("pointerup", endTabDrag);
    window.removeEventListener("pointercancel", endTabDrag);
    if (drag.scrollRAF) cancelAnimationFrame(drag.scrollRAF);
    if (!drag.started) return;

    // Pointer capture retargets the release to the tab itself, so the click
    // may or may not reach the tab's button; either way it must not count.
    drag.tab.dragged = true;
    setTimeout(function () { drag.tab.dragged = false; }, 0);
    document.body.classList.remove("tab-dragging");

    const element = drag.tab.element;
    const target = layoutLefts(orderWith(drag, drag.to), drag).get(drag.tab) - drag.slots[drag.from].left;
    element.classList.remove("dragging");
    element.classList.add("settling");
    tabSettling = true;
    // Let the dragged tab glide the rest of the way into its slot.
    element.style.transform = "translateX(" + target + "px)";

    let done = false;
    const commit = function () {
        if (done) return;
        done = true;
        commitTabOrder(drag);
    };
    if (Math.abs(target - drag.offset) < 0.5) commit();
    else {
        element.addEventListener("transitionend", function onEnd(e) {
            if (e.propertyName !== "transform") return;
            element.removeEventListener("transitionend", onEnd);
            commit();
        });
        setTimeout(commit, 260);
    }
}

function commitTabOrder(drag) {
    tabSettling = false;
    drag.tab.element.classList.remove("settling");
    // Tabs closed mid-drag have already left simpleTabs; tabs opened mid-drag
    // were never part of it and keep their place at the end.
    const order = orderWith(drag, drag.to)
        .map(function (slot) { return slot.tab; })
        .filter(function (tab) { return simpleTabs.includes(tab); });
    simpleTabs.forEach(function (tab) { if (!order.includes(tab)) order.push(tab); });
    tabsEl.classList.add("no-anim");
    order.forEach(function (tab) {
        tab.element.style.transform = "";
        tabsEl.appendChild(tab.element);
    });
    simpleTabs.splice(0, simpleTabs.length, ...order);
    void tabsEl.offsetWidth;
    tabsEl.classList.remove("no-anim");
}

function newTab() {
    createTab({ page: "start", ...simplePages.start });
}

function navigate(page) {
    const destination = simplePages[page];
    if (!destination) return;
    const existing = simpleTabs.find(function (tab) { return tab.page === page && !tab.key; });
    if (existing) selectTab(existing);
    else createTab({ page, ...destination });
}

function openWindow(title, key, src) {
    const url = new URL(src, location.href);
    if (url.protocol !== location.protocol || url.origin !== location.origin) return;
    const existing = simpleTabs.find(function (tab) { return tab.key === key; });
    if (existing) return selectTab(existing);
    const icon = url.pathname.endsWith("/game.html") ? "sports_esports" : "language";
    createTab({ key, title, icon, src: url.href });
}

window.addEventListener("message", function (event) {
    if (event.origin !== location.origin || event.data?.type !== "urlChange") return;
    const tab = simpleTabs.find(function (item) { return item.frame.contentWindow === event.source; });
    if (!tab) return;
    if (event.data.url) {
        tab.url = String(event.data.url);
        if (activeTab === tab) syncAddress();
    }
    if (!event.data.title || event.data.title === "Axiom") return;
    tab.label.textContent = String(event.data.title).slice(0, 120);
    tab.select.title = tab.label.textContent;
});

/* -------------------------------------------------------------- keyboard */

// Alt, not Ctrl: the browser keeps Ctrl+T / Ctrl+W / Ctrl+1-9 for itself.
function handleShortcutKey(event) {
    if (!event.altKey || event.ctrlKey || event.metaKey) return;
    const key = event.key.toLowerCase();
    if (key === "t") newTab();
    else if (key === "w" && activeTab) closeTab(activeTab);
    else if (/^[1-9]$/.test(key)) {
        const tab = key === "9" ? simpleTabs[simpleTabs.length - 1] : simpleTabs[Number(key) - 1];
        if (!tab) return;
        selectTab(tab);
    } else if (key === "arrowright" || key === "arrowleft") {
        if (simpleTabs.length < 2 || !activeTab) return;
        const step = key === "arrowright" ? 1 : -1;
        const index = simpleTabs.indexOf(activeTab);
        selectTab(simpleTabs[(index + step + simpleTabs.length) % simpleTabs.length]);
    } else return;
    event.preventDefault();
}

window.addEventListener("keydown", handleShortcutKey);

/* --------------------------------------------------------------- toolbar */

// Proxied sites live in an iframe inside render.html, which takes its own
// back / forward / refresh / navigate messages; Axiom's pages are driven
// directly.
function isRenderTab(tab) {
    try { return new URL(tab.frame.contentWindow.location.href).pathname.endsWith("/render.html"); }
    catch (error) { return false; }
}

function frameHistory(step) {
    if (!activeTab) return;
    if (isRenderTab(activeTab)) {
        activeTab.frame.contentWindow.postMessage({ type: step < 0 ? "back" : "forward" }, location.origin);
        return;
    }
    try { activeTab.frame.contentWindow.history.go(step); } catch (error) { /* cross-origin */ }
}

function frameBack() { frameHistory(-1); }
function frameForward() { frameHistory(1); }

function frameReload() {
    if (!activeTab) return;
    if (isRenderTab(activeTab)) {
        activeTab.frame.contentWindow.postMessage({ type: "refresh" }, location.origin);
        return;
    }
    activeTab.loading = true;
    showProgress(true);
    try { activeTab.frame.contentWindow.location.reload(); }
    catch (error) { activeTab.frame.src = activeTab.frame.src; }
}

function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(function () {});
}

document.addEventListener("fullscreenchange", function () {
    const button = document.getElementById("fullscreen-btn");
    button.querySelector(".material-symbols-outlined").textContent =
        document.fullscreenElement ? "fullscreen_exit" : "fullscreen";
});

/* --------------------------------------------------------------- address */

const addressForm = document.getElementById("address-form");
const addressInput = document.getElementById("address");

// The same rule start.html's search box uses: anything shaped like a host is
// a URL, everything else is a search.
function resolveAddress(query) {
    const isUrl = /^(https?:\/\/|[a-zA-Z0-9-]+\.[a-zA-Z]{2,})/.test(query);
    if (!isUrl) return "https://search.brave.com/search?q=" + encodeURIComponent(query);
    return query.startsWith("http") ? query : "https://" + query;
}

// What the address bar should say for a tab: nothing for Axiom's own pages,
// the proxied site for render.html, the page itself otherwise.
function tabAddress(tab) {
    if (tab.url) return tab.url;
    if (tab.page) return "";
    try {
        const current = new URL(tab.frame.contentWindow.location.href);
        if (current.pathname.endsWith("/render.html")) {
            const encoded = current.searchParams.get("url");
            return encoded ? atob(encoded) : "";
        }
        return current.href;
    } catch (error) { return ""; }
}

function syncAddress() {
    if (document.activeElement === addressInput) return;
    addressInput.value = activeTab ? tabAddress(activeTab) : "";
}

addressForm.addEventListener("submit", function (event) {
    event.preventDefault();
    const query = addressInput.value.trim();
    if (!query) return;
    const url = resolveAddress(query);
    let encoded;
    // btoa only takes Latin-1; anything wider goes through as UTF-8 bytes.
    try { encoded = btoa(url); }
    catch (error) { encoded = btoa(unescape(encodeURIComponent(url))); }
    const src = "render.html?url=" + encodeURIComponent(encoded);
    if (activeTab && isRenderTab(activeTab)) {
        activeTab.url = url;
        activeTab.frame.contentWindow.postMessage({ type: "navigate", url }, location.origin);
    } else if (activeTab) {
        activeTab.url = url;
        activeTab.loading = true;
        showProgress(true);
        activeTab.frame.src = src;
    } else {
        createTab({ title: query, icon: "language", src });
    }
    addressInput.blur();
    if (activeTab) activeTab.frame.focus();
});

addressInput.addEventListener("focus", function () { addressInput.select(); });
addressInput.addEventListener("blur", syncAddress);
addressInput.addEventListener("keydown", function (event) {
    if (event.key !== "Escape") return;
    addressInput.blur();
    syncAddress();
});

newTab();
