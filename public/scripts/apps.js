const gamesContainer = document.getElementById("games");
const searchBar = document.querySelector(".search-bar");
const LS_KEY = "axiom_app_favorites";
let allGames = [];

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

function buildCard(game) {
  const isFav = getFavorites().includes(game.app_name);
  const card = document.createElement("div");
  card.className = "game";
  card.innerHTML = `
                <img src="${game.app_img}" alt="${game.app_name}">
                <div class="game-name">${game.app_name}</div>
                <button class="fav-btn${isFav ? " active" : ""}" title="Favorite">star</button>
            `;
  card.querySelector(".fav-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    toggleFavorite(game.app_name);
    renderAll(searchBar.value.toLowerCase());
  });
  card.addEventListener("click", () => {
    window.location.href = "./render.html?url=" + btoa(game.app_url);
  });
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
  sorted.forEach((g) => gamesContainer.appendChild(buildCard(g)));
}

fetch("./assets/apps.json")
  .then((res) => res.json())
  .then((data) => {
    allGames = data;
    renderAll("");
  });

searchBar.addEventListener("input", () => {
  renderAll(searchBar.value.toLowerCase());
});
