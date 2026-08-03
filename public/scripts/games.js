const gamesContainer = document.getElementById("games");
const featuredContainer = document.getElementById("featured");
const searchBar = document.querySelector(".search-bar");
const LS_KEY = "axiom_game_favorites";
const FEATURED_COUNT = 5;
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
  card.addEventListener("click", () => {
    window.location.href =
      "./game.html?url=" + encodeURIComponent(btoa(game.app_url)) + "&title=" + encodeURIComponent(game.app_name);
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

fetch("./assets/gapps.json")
  .then((res) => res.json())
  .then((data) => {
    allGames = data.filter((g) => g.type === "game");
    renderFeatured();
    renderAll("");
  })
  .finally(() => {
    if (window.AxiomPageReady) window.AxiomPageReady();
  });

searchBar.addEventListener("input", () => {
  renderAll(searchBar.value.toLowerCase());
});
