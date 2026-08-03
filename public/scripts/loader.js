(function () {
  var loader = document.getElementById("axiom-loader");
  if (!loader) return;

  var root = document.documentElement;
  var awaitReady = root && root.getAttribute("data-await-ready") === "1";
  var hidden = false;
  var safety = awaitReady ? 4000 : 700;

  function hide() {
    if (hidden) return;
    hidden = true;
    loader.classList.add("hide");
    setTimeout(function () {
      if (loader.parentNode) loader.parentNode.removeChild(loader);
    }, 500);
  }

  window.AxiomPageReady = hide;
  window.__axiomHideLoader = hide;

  if (!awaitReady) {
    window.addEventListener("load", function () {
      setTimeout(hide, 200);
    });
  }

  setTimeout(hide, safety);
})();
