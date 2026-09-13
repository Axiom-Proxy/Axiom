
(function () {
  var LS_ID  = 'axiom_theme_id';
  var LS_VAR = 'axiom_theme_vars';
  var LS_ACCENT = 'axiom_accent';

  /* --------------------------------------------------------------- colour */

  function parse(color) {
    var c = String(color || '').trim();
    var m = c.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (m) {
      var h = m[1];
      if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    }
    m = c.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
    if (m) return [+m[1], +m[2], +m[3]];
    return null;
  }

  function hex(rgb) {
    return '#' + rgb.map(function (v) {
      return Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0');
    }).join('');
  }

  function toHsl(rgb) {
    var r = rgb[0] / 255, g = rgb[1] / 255, b = rgb[2] / 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var l = (max + min) / 2, h = 0, s = 0;
    if (max !== min) {
      var d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h /= 6;
    }
    return [h, s, l];
  }

  function toRgb(hsl) {
    var h = hsl[0], s = hsl[1], l = hsl[2];
    if (s === 0) return [l * 255, l * 255, l * 255];
    var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    var p = 2 * l - q;
    function ch(t) {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    }
    return [ch(h + 1 / 3) * 255, ch(h) * 255, ch(h - 1 / 3) * 255];
  }

  function luminance(rgb) {
    var c = rgb.map(function (v) {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }

  /*
   * Every accent fill in Axiom carries white text on it, so the raw accent —
   * the themes ship pale pastels — is taken down until white reads against
   * it. Only as far as it has to go: the fill is meant to look like the
   * swatch that was clicked, so this steps down to the threshold rather than
   * clamping to some fixed dark lightness and landing on a different colour.
   *
   * 0.24 is white at about 3.5:1, which is the honest floor for a 13px label
   * on a saturated fill. The bright original stays on --accent for glyphs and
   * hairlines, where it sits on a dark panel and needs no help.
   */
  var INK_TARGET = 0.24;

  function solidify(rgb) {
    var hsl = toHsl(rgb);
    var out = rgb;
    while (luminance(out) > INK_TARGET && hsl[2] > 0.12) {
      hsl[2] -= 0.02;
      out = toRgb(hsl);
    }
    return out;
  }

  function applyAccent(color) {
    var rgb = parse(color);
    if (!rgb) return;
    var root = document.documentElement;
    root.style.setProperty('--accent', hex(rgb));
    root.style.setProperty('--accent-solid', hex(solidify(rgb)));
    // White, always: that is what solidifying the fill buys.
    root.style.setProperty('--on-accent', '#ffffff');
  }

  function customAccent() {
    try { return localStorage.getItem(LS_ACCENT) || ''; } catch (e) { return ''; }
  }

  /* ---------------------------------------------------------------- theme */

  function applyVars(vars) {
    if (!vars || typeof vars !== 'object') return;
    var root = document.documentElement;
    for (var key in vars) {
      if (Object.prototype.hasOwnProperty.call(vars, key)) {
        root.style.setProperty(key, vars[key]);
      }
    }
    // A theme brings its own accent; a chosen one outranks it. Picking a
    // colour is a decision about Axiom, not about the theme it is wearing.
    applyAccent(customAccent() || (vars['--accent'] || ''));
  }

  try {
    var stored = localStorage.getItem(LS_VAR);
    if (stored) applyVars(JSON.parse(stored));
    else applyAccent(customAccent() || '#8ed4f4');
  } catch (e) {}

  window.addEventListener('storage', function (e) {
    if (e.key === LS_VAR) {
      try { applyVars(JSON.parse(e.newValue)); } catch (e2) {}
    } else if (e.key === LS_ACCENT) {
      applyAccent(e.newValue || themeAccent());
    }
  });

  function themeAccent() {
    try {
      var vars = JSON.parse(localStorage.getItem(LS_VAR) || 'null');
      if (vars && vars['--accent']) return vars['--accent'];
    } catch (e) {}
    return '#8ed4f4';
  }

  window.axiomTheme = {
    getSavedId: function () {
      return localStorage.getItem(LS_ID) || 'default';
    },
    setTheme: function (theme) {
      localStorage.setItem(LS_ID,  theme.id);
      localStorage.setItem(LS_VAR, JSON.stringify(theme.vars));
      applyVars(theme.vars);
    },

    /* The accent is its own setting, kept across theme changes. */
    themeAccent: themeAccent,
    getAccent: function () {
      return customAccent() || themeAccent();
    },
    isAccentCustom: function () { return !!customAccent(); },
    /* What a colour will actually look like once it is a fill — the picker
     * paints its swatches with this so it cannot promise a colour the UI
     * will not use. */
    solidFor: function (color) {
      var rgb = parse(color);
      return rgb ? hex(solidify(rgb)) : '';
    },
    setAccent: function (color) {
      if (color) localStorage.setItem(LS_ACCENT, color);
      else localStorage.removeItem(LS_ACCENT);
      applyAccent(color || themeAccent());
      // Other windows in this tab's family (Settings runs in an iframe) do
      // not see `storage` events, so nudge them the way wallpaper does.
      try { localStorage.setItem('axiom_accent_broadcast', String(Date.now())); } catch (e) {}
    },
    applyAccent: applyAccent
  };

  // The broadcast key is what actually crosses the iframe boundary.
  window.addEventListener('storage', function (e) {
    if (e.key === 'axiom_accent_broadcast') applyAccent(customAccent() || themeAccent());
  });
})();
