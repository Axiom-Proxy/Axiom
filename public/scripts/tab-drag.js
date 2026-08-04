// Chrome-style tab dragging: the grabbed tab tracks the cursor 1:1 while the
// other tabs slide out of its way, instead of the HTML5 drag-and-drop ghost.
//
// Usage from a tab strip's pointerdown handler:
//   AxiomTabDrag.start(event, listEl, tabId, (from, to) => { /* reorder + render */ });
// The tab element is looked up by data-id only once the press becomes a drag,
// so a re-render between the press and the first move can't strand it.
// Renders must be suppressed while AxiomTabDrag.isActive() is true, otherwise
// rebuilding the strip yanks the element out from under the drag.
(function () {
    'use strict';

    const THRESHOLD = 4;      // px of travel before a press counts as a drag
    const EDGE = 40;          // autoscroll hot zone at each end of the strip
    const EDGE_SPEED = 14;    // px per frame at full strength
    const DROP_MS = 180;

    let state = null;

    function gapOf(list) {
        const cs = getComputedStyle(list);
        const g = parseFloat(cs.columnGap === 'normal' ? cs.gap : cs.columnGap);
        return Number.isFinite(g) ? g : 0;
    }

    function start(e, list, tabId, onReorder) {
        if (state || e.button !== 0) return;

        state = {
            list, tabId, onReorder,
            pointerId: e.pointerId,
            startX: e.clientX,
            pointerX: e.clientX,
            startScroll: list.scrollLeft,
            dragging: false,
            raf: 0
        };

        document.addEventListener('pointermove', onMove, true);
        document.addEventListener('pointerup', onUp, true);
        document.addEventListener('pointercancel', cancel, true);
        document.addEventListener('keydown', onKey, true);
    }

    function beginDrag() {
        const s = state;
        const els = Array.from(s.list.children);
        s.el = els.find(el => el.dataset.id === String(s.tabId));
        s.index = s.el ? els.indexOf(s.el) : -1;
        if (s.index === -1) { teardown(); return; }

        s.els = els;
        s.n = els.length;
        s.lefts = els.map(el => el.offsetLeft);
        s.widths = els.map(el => el.offsetWidth);
        s.gap = gapOf(s.list);
        s.target = s.index;
        s.dragging = true;

        s.el.classList.add('tab-dragging');
        s.list.classList.add('tabs-reordering');
        if (s.el.setPointerCapture && s.pointerId != null) {
            try { s.el.setPointerCapture(s.pointerId); } catch (err) {}
        }
        s.raf = requestAnimationFrame(tickScroll);
    }

    function onMove(e) {
        const s = state;
        if (!s) return;
        s.pointerId = e.pointerId;
        s.pointerX = e.clientX;
        if (!s.dragging) {
            if (Math.abs(e.clientX - s.startX) < THRESHOLD) return;
            beginDrag();
            if (!state) return;
        }
        e.preventDefault();
        update();
    }

    // Keeps the dragged tab under the cursor and decides which slot it now owns.
    function update() {
        const s = state;
        const raw = (s.pointerX - s.startX) + (s.list.scrollLeft - s.startScroll);
        const min = -s.lefts[s.index];
        const max = (s.lefts[s.n - 1] + s.widths[s.n - 1]) - (s.lefts[s.index] + s.widths[s.index]);
        s.dx = Math.max(min, Math.min(max, raw));
        s.el.style.transform = 'translateX(' + s.dx + 'px)';

        const center = s.lefts[s.index] + s.widths[s.index] / 2 + s.dx;
        let target = s.index;
        for (let j = 0; j < s.n; j++) {
            if (j === s.index) continue;
            const c = s.lefts[j] + s.widths[j] / 2;
            // >=/<= so that a fully clamped tab still claims the end slot.
            if (j < s.index && center <= c) target = Math.min(target, j);
            else if (j > s.index && center >= c) target = Math.max(target, j);
        }
        if (target !== s.target) {
            s.target = target;
            applyShift();
        }
    }

    // Every tab between the origin slot and the hovered slot steps over by one.
    function applyShift() {
        const s = state;
        const span = s.widths[s.index] + s.gap;
        s.els.forEach((el, j) => {
            if (j === s.index) return;
            let t = 0;
            if (j > s.index && j <= s.target) t = -span;
            else if (j < s.index && j >= s.target) t = span;
            el.style.transform = t ? 'translateX(' + t + 'px)' : '';
        });
    }

    function tickScroll() {
        const s = state;
        if (!s || !s.dragging) return;
        const r = s.list.getBoundingClientRect();
        let v = 0;
        if (s.pointerX < r.left + EDGE) v = -(1 - Math.max(0, s.pointerX - r.left) / EDGE);
        else if (s.pointerX > r.right - EDGE) v = 1 - Math.max(0, r.right - s.pointerX) / EDGE;
        if (v) {
            const before = s.list.scrollLeft;
            s.list.scrollLeft += v * EDGE_SPEED;
            if (s.list.scrollLeft !== before) update();
        }
        s.raf = requestAnimationFrame(tickScroll);
    }

    function onKey(e) {
        if (e.key !== 'Escape' || !state) return;
        e.preventDefault();
        cancel();
    }

    function cancel() {
        if (!state) return;
        if (state.dragging) { state.target = state.index; applyShift(); }
        onUp();
    }

    function onUp() {
        const s = state;
        if (!s) return;
        document.removeEventListener('pointermove', onMove, true);
        document.removeEventListener('pointerup', onUp, true);
        document.removeEventListener('pointercancel', cancel, true);
        document.removeEventListener('keydown', onKey, true);

        if (!s.dragging) { teardown(); return; }
        cancelAnimationFrame(s.raf);

        // Glide into the slot it landed on, then commit the reorder.
        let finalDx;
        if (s.target === s.index) finalDx = 0;
        else if (s.target > s.index) finalDx = s.lefts[s.target] + s.widths[s.target] - s.widths[s.index] - s.lefts[s.index];
        else finalDx = s.lefts[s.target] - s.lefts[s.index];

        s.settling = true;
        s.el.style.transition = 'transform ' + DROP_MS + 'ms cubic-bezier(0.2, 0.8, 0.3, 1)';
        s.el.style.transform = 'translateX(' + finalDx + 'px)';
        s.el.classList.remove('tab-dragging');
        s.el.classList.add('tab-settling');

        setTimeout(() => {
            const from = s.index, to = s.target;
            const cb = s.onReorder;
            teardown();
            if (cb) cb(from, to);   // always fires so the caller can flush a deferred render
        }, DROP_MS);
    }

    function teardown() {
        const s = state;
        state = null;
        if (!s) return;
        cancelAnimationFrame(s.raf);
        s.list.classList.remove('tabs-reordering');
        (s.els || (s.el ? [s.el] : [])).forEach(el => {
            el.style.transform = '';
            el.style.transition = '';
            el.classList.remove('tab-dragging', 'tab-settling');
        });
        if (s.el && s.pointerId != null && s.el.releasePointerCapture) {
            try { s.el.releasePointerCapture(s.pointerId); } catch (err) {}
        }
    }

    window.AxiomTabDrag = {
        start,
        isActive() { return !!state && (state.dragging || state.settling); }
    };
})();
