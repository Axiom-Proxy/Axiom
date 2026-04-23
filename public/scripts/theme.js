
(function () {
  var LS_ID  = 'axiom_theme_id';
  var LS_VAR = 'axiom_theme_vars';

  function applyVars(vars) {
    if (!vars || typeof vars !== 'object') return;
    var root = document.documentElement;
    for (var key in vars) {
      if (Object.prototype.hasOwnProperty.call(vars, key)) {
        root.style.setProperty(key, vars[key]);
      }
    }
  }

  
  try {
    var stored = localStorage.getItem(LS_VAR);
    if (stored) applyVars(JSON.parse(stored));
  } catch (e) {}

  
  window.addEventListener('storage', function (e) {
    if (e.key === LS_VAR) {
      try { applyVars(JSON.parse(e.newValue)); } catch (e2) {}
    }
  });

  
  window.axiomTheme = {
    getSavedId: function () {
      return localStorage.getItem(LS_ID) || 'default';
    },
    setTheme: function (theme) {
      localStorage.setItem(LS_ID,  theme.id);
      localStorage.setItem(LS_VAR, JSON.stringify(theme.vars));
      applyVars(theme.vars);
    }
  };
})();
