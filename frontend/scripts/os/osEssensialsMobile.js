function swapWindow(name, url) {
    document.getElementById("main").src = url;
}

// listeners

document.getElementById("browser").addEventListener("click", () => {
  swapWindow(
    "Axiom Browser",
    "browser/browser.html"
  );
});

document.getElementById("games").addEventListener("click", () => {
  swapWindow(
    "Games",
    "browser/gapps.html"
  );
});

document.getElementById("ai").addEventListener("click", () => {
  swapWindow(
    "AI Chat",
    "browser/ai.html"
  );
});

document.getElementById("notepad").addEventListener("click", () => {
  swapWindow(
    "Notepad",
    "os/notepad.html"
  );
});

document.getElementById("settings").addEventListener("click", () => {
  swapWindow(
    "Settings",
    "browser/settings.html"
  );
});

// give images around a second to load
setTimeout(() => {
  document.getElementById("loader").style.animation = "fade 0.3s ease-in-out";

  setTimeout(() => {
    document.getElementById("loader").style.display = "none";
  }, 300);
}, 100);