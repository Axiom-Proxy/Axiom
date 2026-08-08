const gamesContainer = document.getElementById("games");
const featuredContainer = document.getElementById("featured");
const searchBar = document.querySelector(".search-bar");
const LS_KEY = "axiom_app_favorites";
const DS_KEY = "axiom_desktop_shortcuts";
const DS_CHANNEL = "axiom-desktop";
const FEATURED_COUNT = 5;
let allGames = [];

let desktopChannel = null;
try {
  if (window.BroadcastChannel) desktopChannel = new BroadcastChannel(DS_CHANNEL);
} catch (e) { desktopChannel = null; }

function getFavorites() {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY)) || [];
  } catch {
    return [];
  }
}

function setFavorites(favs) {
  localStorage.setItem(LS_KEY, JSON.stringify(favs));
}

function toggleFavorite(name) {
  const favs = getFavorites();
  const idx = favs.indexOf(name);
  if (idx === -1) favs.push(name);
  else favs.splice(idx, 1);
  setFavorites(favs);
}

function getDesktopShortcuts() {
  try {
    return JSON.parse(localStorage.getItem(DS_KEY)) || [];
  } catch {
    return [];
  }
}

function isOnDesktop(name) {
  return getDesktopShortcuts().some(s => s.name === name);
}

function addToDesktop(game) {
  const shortcuts = getDesktopShortcuts();
  if (!shortcuts.find(s => s.name === game.app_name && s.url === game.app_url)) {
    shortcuts.push({
      name: game.app_name,
      url: game.app_url,
      img: game.app_img,
      type: "app"
    });
    localStorage.setItem(DS_KEY, JSON.stringify(shortcuts));
    renderAll(searchBar.value.toLowerCase());
    // Notify desktop via BroadcastChannel
    if (desktopChannel) {
      desktopChannel.postMessage({ type: 'refresh' });
    }
  }
}

function removeFromDesktop(name) {
  const shortcuts = getDesktopShortcuts().filter(s => s.name !== name);
  localStorage.setItem(DS_KEY, JSON.stringify(shortcuts));
  renderAll(searchBar.value.toLowerCase());
  if (desktopChannel) {
    desktopChannel.postMessage({ type: 'refresh' });
  }
}

function buildCard(game) {
  const isFav = getFavorites().includes(game.app_name);
  const onDesktop = isOnDesktop(game.app_name);
  const card = document.createElement("div");
  card.className = "game";
  card.innerHTML = `
                <button class="desktop-btn${onDesktop ? " on-desktop" : ""}" title="${onDesktop ? "On desktop" : "Add to desktop"}">desktop_windows</button>
                <button class="fav-btn${isFav ? " active" : ""}" title="Favorite">star</button>
                <div class="thumb">
                    <img src="${game.app_img}" alt="${game.app_name}" loading="lazy">
                </div>
                <div class="overlay">
                    <div class="game-name">${game.app_name}</div>
                </div>
            `;
  card.querySelector(".fav-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    toggleFavorite(game.app_name);
    renderAll(searchBar.value.toLowerCase());
  });
  card.querySelector(".desktop-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    if (isOnDesktop(game.app_name)) {
      removeFromDesktop(game.app_name);
    } else {
      addToDesktop(game);
    }
  });
  card.addEventListener("click", () => {
    if (window.parent !== window && window.parent.openWindow) {
      window.parent.openWindow(game.app_name, 'app-' + btoa(game.app_url).substring(0, 16), 'render.html?url=' + btoa(game.app_url));
    } else {
      window.location.href = "./render.html?url=" + btoa(game.app_url);
    }
  });
  return card;
}

function renderFeatured() {
  const pool = [...allGames];
  const featured = [];
  for (let i = 0; i < FEATURED_COUNT && pool.length; i++) {
    featured.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  }
  featuredContainer.innerHTML = "";
  featured.forEach((g) => featuredContainer.appendChild(buildCard(g)));
}

function renderAll(query) {
  const favs = getFavorites();
  const filtered = query
    ? allGames.filter((g) => g.app_name.toLowerCase().includes(query))
    : allGames;

  const sorted = [
    ...filtered.filter((g) => favs.includes(g.app_name)),
    ...filtered.filter((g) => !favs.includes(g.app_name)),
  ];

  gamesContainer.innerHTML = "";
  sorted.forEach((g) => gamesContainer.appendChild(buildCard(g)));
}

fetch("./assets/apps.json")
  .then((res) => res.json())
  .then((data) => {
    allGames = data;
    renderFeatured();
    renderAll("");
  })
  .finally(() => {
    if (window.AxiomPageReady) window.AxiomPageReady();
  });

searchBar.addEventListener("input", () => {
  renderAll(searchBar.value.toLowerCase());
});
