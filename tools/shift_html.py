#!/usr/bin/env python
"""
Wire the self-hosted SCRAMBLED Roboto font into every page in /public.

By DEFAULT (runtime mode) this does SURGICAL, offset-based edits on each
file's original source (via html.parser) — tag names, attributes, href/src,
class/id names, <script>/<style> contents and HTML comments stay byte-for-byte
intact — and changes only the <head>:

  1. Google Fonts links:
       - the "Material Symbols Outlined + Roboto" stylesheet link has its
         `family=Roboto:...` segment stripped (Material Symbols stays — it is
         NOT scrambled and must keep literal text).
       - a Google "Roboto-only" stylesheet link is removed entirely.
  2. Insert  <link rel="stylesheet" href="./fonts/fonts.css">  (the local
     scrambled-Roboto @font-face).
  3. Insert  <script src="./scripts/font-scramble.js"></script>  as the FIRST
     child of <head> so it runs before any other script and before <body> is
     parsed.  That script is the single source of truth for shifting: it
     Caesar-shifts +1 every visible text node + placeholder (both the text
     already on the page and anything JS injects later via a
     MutationObserver), skipping the same non-scrambled subtrees listed below.

With --shift-text the script ALSO pre-shifts the static text + placeholders
in the HTML itself (the original, build-time-only approach).  This is kept for
reference but is NOT used by default — runtime mode is preferred because it
also covers JS-injected text and keeps the source editable.

Skipped subtrees (rendered through an UN-scrambled font, text stays literal):
  <head>/<title>/<script>/<style>/<noscript>/<template>,
  <pre>/<code>/<kbd>/<samp>/<tt>,
  Material Symbols icon spans (.material-symbols-outlined), and the monospace
  containers term-output, term-mount-bar, term-prompt, lm-code,
  axiom-dlg-message, editor-text.

<input>/<textarea> .value is never shifted (so form submission & JS logic keep
working); placeholders are shifted (display-only).
"""

import os
import re
import sys
from html.parser import HTMLParser

PUBLIC_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "public")

SKIP_TAGS = {"head", "script", "style", "title", "pre", "code", "kbd", "samp", "tt"}
SKIP_CLASS_OR_ID = {
    "material-symbols-outlined",  # icon font (NOT scrambled)
    "term-output",                 # terminal output (monospace)
    "term-mount-bar",
    "term-prompt",
    "lm-code",                     # lmstudio code block (monospace)
    "axiom-dlg-message",           # dialog message (monospace)
    "editor-text",                 # code editor textarea (monospace)
}
VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input",
        "link", "meta", "param", "source", "track", "wbr"}

RANGES = ((0x30, 0x39, 10), (0x41, 0x5A, 26), (0x61, 0x7A, 26))
ENTITY = re.compile(r"&(#[0-9]+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);")

LOCAL_LINK = '<link rel="stylesheet" href="./fonts/fonts.css">'
RUNTIME_SCRIPT = '<script src="./scripts/font-scramble.js"></script>'


def shift_char(ch):
    o = ord(ch)
    for lo, hi, sz in RANGES:
        if lo <= o <= hi:
            return chr(lo + (o - lo + 1) % sz)
    return ch


def shift_text(s):
    return "".join(shift_char(c) for c in s)


def shift_raw(s):
    """Shift a raw HTML source slice, leaving char/entity refs intact."""
    out = []
    last = 0
    for m in ENTITY.finditer(s):
        out.append(shift_text(s[last:m.start()]))
        out.append(m.group(0))
        last = m.end()
    out.append(shift_text(s[last:]))
    return "".join(out)


def _tokens(attrs):
    toks = set()
    for key in ("class", "id"):
        if key in attrs:
            toks.update(attrs[key].split())
    return toks


class Doc(HTMLParser):
    def __init__(self, src, shift_text=False):
        super().__init__(convert_charrefs=True)
        self.src = src
        self.shift_text = shift_text   # --shift-text: also pre-shift static text
        # absolute byte offset of the start of each line (line 1 -> 0)
        self.line_starts = [0]
        for i, ch in enumerate(src):
            if ch == "\n":
                self.line_starts.append(i + 1)
        self.events = []        # list of (offset, kind, payload)
        self.stack = []         # list of skip-flags for open elements
        self.edits = []         # (start, end, replacement)
        self.inserted_local = False
        self.runtime_inserted = False
        self._cur_rawtag = None  # (start_offset, rawtext) for current start tag
        self.data_runs = []     # (start_offset, skip) ; end computed later

    def _off(self, pos):
        lineno, col = pos
        return self.line_starts[lineno - 1] + col

    # --- start tags -------------------------------------------------------
    def handle_starttag(self, tag, attrs):
        self._handle_start(tag, attrs, self.get_starttag_text(), self._off(self.getpos()))

    def handle_startendtag(self, tag, attrs):
        # self-closing form like <br/>
        self._handle_start(tag, attrs, self.get_starttag_text(), self._off(self.getpos()))

    def _handle_start(self, tag, attrs, rawtext, start):
        parent_skip = self.stack[-1] if self.stack else False
        is_skip = parent_skip or tag in SKIP_TAGS or bool(_tokens(dict(attrs)) & SKIP_CLASS_OR_ID)
        # record event so later data-end computation lines up
        self.events.append(("tag", start))

        # insert the runtime text-shifter as the FIRST child of <head> so it
        # runs before any other script and before <body> is parsed.
        if tag == "head" and not self.runtime_inserted:
            end = start + len(rawtext)
            self.edits.append((end, end, "\n    " + RUNTIME_SCRIPT))
            self.runtime_inserted = True

        # link rewriting
        if tag == "link":
            self._handle_link(rawtext, start, dict(attrs))

        # placeholder shifting on form controls (static pre-shift only)
        if self.shift_text and tag in ("input", "textarea") and not is_skip:
            if not (_tokens(dict(attrs)) & SKIP_CLASS_OR_ID):
                self._handle_placeholder(rawtext, start, dict(attrs))

        if tag not in VOID:
            self.stack.append(is_skip)

    # --- end tags ---------------------------------------------------------
    def handle_endtag(self, tag):
        start = self._off(self.getpos())
        self.events.append(("tag", start))
        if tag in ("head",):
            if not self.inserted_local:
                # insert the local stylesheet line right before </head>
                self.edits.append((start, start,
                                   "    " + LOCAL_LINK + "\n"))
                self.inserted_local = True
        if self.stack and tag not in VOID:
            self.stack.pop()

    # --- data -------------------------------------------------------------
    def handle_data(self, data):
        start = self._off(self.getpos())
        self.events.append(("data", start))
        skip = self.stack[-1] if self.stack else False
        self.data_runs.append((start, skip))

    # --- comments / decl / pi : occupy source, never shifted --------------
    def handle_comment(self, data):
        self.events.append(("other", self._off(self.getpos())))

    def handle_decl(self, decl):
        self.events.append(("other", self._off(self.getpos())))

    def handle_pi(self, data):
        self.events.append(("other", self._off(self.getpos())))

    # --- link rewrite -----------------------------------------------------
    def _handle_link(self, rawtext, start, attrs):
        rel = attrs.get("rel", "")
        href = attrs.get("href", "")
        if not href or "fonts.googleapis.com" not in href:
            return
        if "stylesheet" not in (rel or "").split():
            return  # preconnect etc.
        has_material = ("Material" in href) or ("Symbols" in href)
        # locate the href value span within rawtext
        m = re.search(r"""href\s*=\s*("([^"]*)"|'([^']*)')""", rawtext)
        if not m:
            return
        val_quote = m.group(1)[0]
        val_text = m.group(2) if m.group(2) is not None else m.group(3)
        val_start_in_tag = m.start(1) + 1  # index of char after opening quote
        val_global = start + val_start_in_tag
        if has_material:
            # remove any &family=Roboto:* (and &family=Roboto:*) segments
            new_val = re.sub(r"&family=Roboto:[^&]*", "", val_text)
            new_val = re.sub(r"&family=Roboto:[^&]*", "", new_val)
            # collapse a possibly dangling leading '?' or '&&'
            if new_val != val_text:
                self.edits.append((val_global, val_global + len(val_text), new_val))
            if not self.inserted_local:
                # insert local link right after this start tag
                end = start + len(rawtext)
                self.edits.append((end, end, "\n    " + LOCAL_LINK))
                self.inserted_local = True
        else:
            # Roboto-only google link -> replace whole start tag with local link
            end = start + len(rawtext)
            self.edits.append((start, end, LOCAL_LINK))
            self.inserted_local = True

    # --- placeholder ------------------------------------------------------
    def _handle_placeholder(self, rawtext, start, attrs):
        if not self.shift_text or "placeholder" not in attrs:
            return
        m = re.search(r"""placeholder\s*=\s*("([^"]*)"|'([^']*)')""", rawtext)
        if not m:
            return
        val_text = m.group(2) if m.group(2) is not None else m.group(3)
        val_start_in_tag = m.start(1) + 1
        val_global = start + val_start_in_tag
        new_val = shift_raw(val_text)
        if new_val != val_text:
            self.edits.append((val_global, val_global + len(val_text), new_val))

    # --- finalize ---------------------------------------------------------
    def build(self):
        # Static pre-shift of text nodes (only with --shift-text).
        if not self.shift_text:
            pass  # runtime script handles all text
        else:
            # End offset of each data run = start of the next event (or EOF).
            n = len(self.src)
            ev_starts = [s for _, s in self.events]
            for dstart, skip in self.data_runs:
                nxt = n
                for s in ev_starts:
                    if s > dstart:
                        nxt = s
                        break
                if skip:
                    continue
                raw = self.src[dstart:nxt]
                new = shift_raw(raw)
                if new != raw:
                    self.edits.append((dstart, dstart + len(raw), new))
        # apply edits, last-first (they don't overlap)
        out = self.src
        for s, e, repl in sorted(self.edits, key=lambda e: e[0], reverse=True):
            out = out[:s] + repl + out[e:]
        return out


def shift_document(text, shift_text=False):
    p = Doc(text, shift_text=shift_text)
    p.feed(text)
    p.close()
    return p.build()


def main():
    dry = "--dry-run" in sys.argv
    shift_text = "--shift-text" in sys.argv
    only = [a for a in sys.argv[1:] if not a.startswith("-")]
    files = sorted(
        os.path.join(PUBLIC_DIR, f) for f in os.listdir(PUBLIC_DIR)
        if f.endswith(".html")
    )
    if only:
        files = [f for f in files if os.path.basename(f) in only]
    for path in files:
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
        new = shift_document(text, shift_text=shift_text)
        if dry:
            print(f"DRY  {os.path.basename(path)}: changed={new != text}")
        else:
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(new)
            print(f"OK   {os.path.basename(path)}: changed={new != text}")


if __name__ == "__main__":
    main()
