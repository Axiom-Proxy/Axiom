// Track open windows count
let openWindowsCount = 0;
const logo = document.querySelector('.logo');

// Track open window count per app
const appWindowCounts = {};

function updateLogoVisibility() {
  if (openWindowsCount > 0) {
    // Fade out logo when windows are open
    logo.style.transition = 'opacity 0.3s ease-in-out';
    logo.style.opacity = '0';
  } else {
    // Fade in logo when all windows are closed
    logo.style.transition = 'opacity 0.3s ease-in-out';
    logo.style.opacity = '1';
  }
}

function setAppDot(appId, visible) {
  const btn = document.getElementById(appId);
  if (!btn) return;
  if (visible) {
    btn.classList.add('has-dot');
  } else {
    btn.classList.remove('has-dot');
  }
}

function createWindow(name, content, appId) {
  const winbox = new WinBox({
    title: name,
    html: content,
    width: "800px",
    height: "600px",
    background: "rgba(0, 0, 0, 0.5)",
    x: "center",
    y: "center",
    onclose: function() {
      openWindowsCount--;
      updateLogoVisibility();
      if (appId) {
        appWindowCounts[appId] = (appWindowCounts[appId] || 1) - 1;
        setAppDot(appId, appWindowCounts[appId] > 0);
      }
      return false; // Allow the window to close
    }
  });

  openWindowsCount++;
  updateLogoVisibility();
  if (appId) {
    appWindowCounts[appId] = (appWindowCounts[appId] || 0) + 1;
    setAppDot(appId, true);
  }

  return winbox;
}

// listeners

document.getElementById("browser").addEventListener("click", () => {
  createWindow(
    "Axiom Browser",
    "<iframe style='width: 100%; height: 100%; border: none; border-radius: 5px;' src='./browser/browser.html'></iframe>",
    "browser"
  );
});

document.getElementById("games").addEventListener("click", () => {
  createWindow(
    "Games",
    "<iframe style='width: 100%; height: 100%; border: none; border-radius: 5px;' src='./browser/gapps.html'></iframe>",
    "games"
  );
});

document.getElementById("ai").addEventListener("click", () => {
  createWindow(
    "AI Chat",
    "<iframe style='width: 100%; height: 100%; border: none; border-radius: 5px;' src='./browser/ai.html'></iframe>",
    "ai"
  );
});

document.getElementById("settings").addEventListener("click", () => {
  createWindow(
    "Settings",
    "<iframe style='width: 100%; height: 100%; border: none; border-radius: 5px;' src='./browser/settings.html'></iframe>",
    "settings"
  );
});

document.getElementById("terminal").addEventListener("click", () => {
  createWindow(
    "Terminal",
    "<iframe style='width: 100%; height: 100%; border: none; border-radius: 5px;' src='./os/terminal.html'></iframe>",
    "terminal"
  );
});

document.getElementById("info").addEventListener("click", () => {
  createWindow(
    "Axiom Info",
    "<iframe style='width: 100%; height: 100%; border: none; border-radius: 5px;' src='axiom.html'></iframe>",
    "terminal"
  );
});

const contextMenu = document.getElementById("contextMenu");
const desktop = document.getElementById("desktop");

function hideContextMenu() {
  contextMenu.classList.remove("visible");
}

function showContextMenu(x, y) {
  contextMenu.classList.add("visible");
  contextMenu.style.left = x + "px";
  contextMenu.style.top = y + "px";
}

desktop.addEventListener("contextmenu", (e) => {
  e.preventDefault();

  let x = e.clientX;
  let y = e.clientY;

  const menuRect = contextMenu.getBoundingClientRect();
  const menuWidth = 180;
  const menuHeight = 250;

  if (x + menuWidth > window.innerWidth) {
    x = window.innerWidth - menuWidth - 10;
  }
  if (y + menuHeight > window.innerHeight) {
    y = window.innerHeight - menuHeight - 10;
  }

  showContextMenu(x, y);
});

document.addEventListener("click", hideContextMenu);
document.getElementById("taskbar").addEventListener("click", (e) => {
  e.stopPropagation();
});

document.querySelectorAll(".context-menu-item").forEach((item) => {
  item.addEventListener("click", (e) => {
    e.preventDefault();
    const appId = item.getAttribute("data-app");
    document.getElementById(appId).click();
    hideContextMenu();
  });
});

setInterval(function () {
  if (sessionStorage.getItem("axiomReload") === "true") {
    sessionStorage.removeItem("axiomReload");
    location.reload();
  }
}, 50);

// give things around a second to load
setTimeout(() => {
  document.getElementById("loader").style.animation = "fade 0.3s ease-in-out";

  setTimeout(() => {
    document.getElementById("loader").style.display = "none";
  }, 300);
}, 200);