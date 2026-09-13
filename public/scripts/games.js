const gamesContainer = document.getElementById("games");
const featuredContainer = document.getElementById("featured");
const searchBar = document.querySelector(".search-bar");
const LS_KEY = "axiom_game_favorites";
const DS_KEY = "axiom_desktop_shortcuts";
const DS_CHANNEL = "axiom-desktop";
const FEATURED_COUNT = 5;
// Set by the host page (games_norm.html / games_web.html). Falsy = show every game.
const GAMES_CATEGORY = window.GAMES_CATEGORY || null;
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
      type: "game"
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
  card.className = "game" + (isFav ? " is-fav" : "");
  card.innerHTML = `
                <button class="material-symbols-outlined desktop-btn${onDesktop ? " on-desktop" : ""}" title="${onDesktop ? "On desktop" : "Add to desktop"}">desktop_windows</button>
                <button class="material-symbols-outlined fav-btn${isFav ? " active" : ""}" title="Favorite">star</button>
                <div class="thumb">
                    <img src="${game.app_img}" alt="${game.app_name}" loading="lazy">
                    <div class="play-badge"><span>play_arrow</span></div>
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
      window.parent.openWindow(game.app_name, 'game-' + btoa(game.app_url).substring(0, 16), 'game.html?url=' + encodeURIComponent(btoa(game.app_url)) + '&title=' + encodeURIComponent(game.app_name));
    } else {
      window.location.href = "./game.html?url=" + encodeURIComponent(btoa(game.app_url)) + "&title=" + encodeURIComponent(game.app_name);
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
  featured.forEach((g, i) => featuredContainer.appendChild(stagger(buildCard(g), i)));
}

// Cards fade in one after another; cap the delay so long lists don't crawl.
function stagger(card, i) {
  card.style.setProperty("--d", Math.min(i, 20) * 28 + "ms");
  return card;
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
  if (!sorted.length) {
    gamesContainer.innerHTML = `
      <div class="empty-state">
        <div class="material-symbols-outlined">search_off</div>
        <p>No games match &ldquo;${String(query).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]))}&rdquo;</p>
      </div>`;
  } else {
    sorted.forEach((g, i) => gamesContainer.appendChild(stagger(buildCard(g), i)));
  }

  const count = document.getElementById("games-count");
  if (count) count.textContent = sorted.length;
}

fetch("./assets/gapps.json")
  .then((res) => res.json())
  .then((data) => {
    allGames = data.filter((g) => g.type === "game" && (!GAMES_CATEGORY || (g.category || "web") === GAMES_CATEGORY));
    renderFeatured();
    renderAll("");
  })
  .finally(() => {
    if (window.AxiomPageReady) window.AxiomPageReady();
  });

searchBar.addEventListener("input", () => {
  renderAll(searchBar.value.toLowerCase());
});
