/*
 * font-scramble.js — runtime text shifter for the scrambled Roboto font
 * ====================================================================
 *
 * The self-hosted Roboto woff2 in /fonts/ has its glyphs Caesar-shifted +1
 * (a-z / A-Z / 0-9, wrapping), so to make text *look* normal the characters
 * in the DOM must be shifted +1 too.  Static HTML is left un-shifted; this
 * script is the single source of truth — it shifts every visible text node
 * (both the text already on the page and anything JS injects later, via a
 * MutationObserver).
 *
 * Why a runtime observer instead of pre-shifting the source:
 *   - the HTML source stays human-readable / editable;
 *   - JS-injected text (window labels, file lists, settings, …) is handled
 *     automatically, not just the static text;
 *   - copy/paste & scraping of the rendered DOM yields the shifted (garbled)
 *     text, which is the whole point of a scrambled font.
 *
 * What is NOT shifted (rendered through an UN-scrambled font, so its text
 *   must stay literal):
 *   - <script> / <style> / <head> / <title> / <noscript> / <template>
 *   - <pre> / <code> / <kbd> / <samp> / <tt>  (monospace / code)
 *   - Material Symbols icon spans (.material-symbols-outlined) — ligatures
 *   - the known monospace containers: term-output, term-mount-bar,
 *     term-prompt, lm-code, axiom-dlg-message, editor-text
 *   - <input> / <textarea> / <select> — rendered through the UNSCRAMBLED
 *     'Roboto Plain' font (see fonts/fonts.css), so their .value, placeholder
 *     AND <option> text all stay literal and are NOT shifted here.  This
 *     keeps form submission and JS logic (numbers, hosts, tokens, user
 *     input) working while the typed text still looks normal.
 *
 * Re-entrancy: a WeakMap caches the last value we wrote to each text node,
 * so our own writes (which re-trigger the observer) are detected and
 * skipped — no infinite loop, no double-shift of our output.
 *
 * Limitations (inherent to any after-the-fact DOM text rewriter):
 *   - JS that reads a shifted text node (e.g. el.textContent) gets the
 *     shifted string; if it then transforms and re-inserts it, that piece
 *     can double-shift.  The app generally renders from its own data
 *     model rather than copying DOM text, so this is rare.
 */
(function () {
  "use strict";

  var SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "HEAD", "TITLE", "NOSCRIPT", "TEMPLATE",
    "PRE", "CODE", "KBD", "SAMP", "TT", "TEXTAREA", "INPUT", "SELECT",
    // DATALIST suggestions are drawn by the browser in a font of its own
    // choosing, which is never the scrambled one.
    "DATALIST"
  ]);
  // INPUT / SELECT / TEXTAREA render through the UNSCRAMBLED 'Roboto Plain'
  // font (see fonts/fonts.css), so their .value, placeholder AND option text
  // must all stay literal.  SELECT is listed so <option> text nodes (whose
  // ancestor chain includes the <select>) are skipped too.  INPUT/TEXTAREA
  // have no child text nodes anyway, but listing them is a cheap safety net.
  var SKIP_TOKENS = new Set([
    "material-symbols-outlined",
    "term-output", "term-mount-bar", "term-prompt",
    "lm-code", "axiom-dlg-message", "editor-text",
    // Menu-bar keyboard hints: symbols plus one literal key, rendered in the
    // UNSCRAMBLED face (see windows.css), so shifting turned ⌘K into ⌘L.
    "mb-menu-key",
    // KaTeX renders formulas with its own (unscrambled) math fonts, so a
    // shifted "6CO2" came out as "7DP3". Everything under .katex stays literal.
    "katex", "katex-display",
    // The desktop clock is the one piece of chrome whose typeface the user
    // picks, and any face they pick is an ordinary one — a Google family, or
    // the un-shifted Roboto. Shifted text through those reads as gibberish
    // ("MONDAY" as "NPOEBZ"), so the clock keeps its letters literal.
    "desktop-clock",
    // Remote Desktop draws device IDs, the fps/latency readout and the
    // Ctrl+Shift+Esc hint in a system monospace face (there is no scrambled
    // monospace), so those stay literal — the same reason terminal output does.
    "mono", "rid"
  ]);

  function shiftChar(ch) {
    var c = ch.charCodeAt(0);
    if (c >= 0x30 && c <= 0x39) return String.fromCharCode(0x30 + ((c - 0x30 + 1) % 10));
    if (c >= 0x41 && c <= 0x5a) return String.fromCharCode(0x41 + ((c - 0x41 + 1) % 26));
    if (c >= 0x61 && c <= 0x7a) return String.fromCharCode(0x61 + ((c - 0x61 + 1) % 26));
    return ch;
  }

  function shiftText(s) {
    var out = "";
    for (var i = 0; i < s.length; i++) out += shiftChar(s[i]);
    return out;
  }

  // Runs for every text node on every mutation, once per ancestor, so it
  // reads classList in place rather than copying it into a fresh Set each
  // step — the copy was most of the garbage this script generated.
  function elementHasSkipToken(el) {
    if (el.id && SKIP_TOKENS.has(el.id)) return true;
    var cl = el.classList;
    if (cl) for (var i = 0; i < cl.length; i++) if (SKIP_TOKENS.has(cl[i])) return true;
    return false;
  }

  function shouldSkipText(node) {
    var p = node.parentNode;
    while (p) {
      if (SKIP_TAGS.has(p.nodeName)) return true;
      if (p.nodeType === 1 && elementHasSkipToken(p)) return true;
      p = p.parentNode;
    }
    return false;
  }

  var textCache = new WeakMap();   // text node -> last value we wrote (or saw)

  function processText(node) {
    if (!node || node.nodeType !== 3) return; // TEXT_NODE
    if (shouldSkipText(node)) { textCache.delete(node); return; }
    var data = node.data;
    if (textCache.get(node) === data) return;     // our own write — skip
    var shifted = shiftText(data);
    textCache.set(node, shifted);
    if (shifted !== data) node.data = shifted;     // triggers a mutation; cache matches -> skipped
  }

  function walkText(root) {
    var tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var n;
    while ((n = tw.nextNode())) processText(n);
  }

  function processAdded(node) {
    if (!node) return;
    if (node.nodeType === 3) { processText(node); return; }
    if (node.nodeType !== 1) return;
    walkText(node);             // any text inside the new subtree
  }

  var obs = new MutationObserver(function (muts) {
    for (var i = 0; i < muts.length; i++) {
      var m = muts[i];
      if (m.type === "childList") {
        for (var j = 0; j < m.addedNodes.length; j++) processAdded(m.addedNodes[j]);
      } else if (m.type === "characterData") {
        processText(m.target);
      }
      // attribute mutations are ignored — the only attribute we used to
      // shift was `placeholder`, and form fields now render through the
      // un-scrambled font, so placeholders must stay literal.
    }
  });

  function start() {
    if (!document.documentElement) return;
    obs.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true
    });
    // safety net: if the script ran after the DOM was already built
    // (e.g. cached / late load), shift whatever is already on the page.
    if (document.body) {
      walkText(document.body);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
