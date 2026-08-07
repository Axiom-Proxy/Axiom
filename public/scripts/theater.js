const resultsContainer = document.getElementById("results");
const featuredContainer = document.getElementById("featured");
const searchBar = document.querySelector(".search-bar");

const IMG_PROXY = "https://wsrv.nl/?url=https%3A%2F%2Fimage.tmdb.org%2Ft%2Fp%2Foriginal%2F";
const FEATURED_COUNT = 5;

let currentResults = [];
let debounceTimer = null;

function esc(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function getImageUrl(path) {
  if (!path) return "";
  return `${IMG_PROXY}${encodeURIComponent(path)}&output=webp&q=80&n=-1`;
}

function buildCard(item) {
  const card = document.createElement("div");
  card.className = "theater-card";
  const title = item.title || item.name || "Untitled";
  const year = item.release_date || item.first_air_date || "";
  const yearText = year ? year.split("-")[0] : "";
  const poster = getImageUrl(item.poster_path);
  const rating = item.vote_average ? item.vote_average.toFixed(1) : "";

  card.innerHTML = `
    <div class="thumb">
      <img src="${poster}" alt="${esc(title)}" loading="lazy" onerror="this.style.display='none'">
    </div>
    <div class="overlay">
      <div class="card-name">${esc(title)}</div>
      <div class="card-meta">
        ${yearText ? `<span class="card-year">${esc(yearText)}</span>` : ""}
        ${rating ? `<span class="card-rating">${esc(rating)}</span>` : ""}
        <span class="card-type">${esc(item.media_type === "tv" ? "TV" : "Movie")}</span>
      </div>
    </div>
  `;

  card.addEventListener("click", () => {
    window.location.href = `./theater-details.html?id=${item.id}&type=${item.media_type}`;
  });

  return card;
}

function renderFeatured() {
  const pool = [...currentResults];
  const featured = [];
  for (let i = 0; i < FEATURED_COUNT && pool.length; i++) {
    featured.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  }
  featuredContainer.innerHTML = "";
  featured.forEach((item) => {
    if (item) featuredContainer.appendChild(buildCard(item));
  });
}

function renderResults(results) {
  currentResults = results;
  resultsContainer.innerHTML = "";

  if (!results.length) {
    const empty = document.createElement("div");
    empty.className = "theater-empty";
    empty.textContent = "No results found";
    resultsContainer.appendChild(empty);
    return;
  }

  results.forEach((item) => {
    resultsContainer.appendChild(buildCard(item));
  });
}

async function search(query) {
  if (!query.trim()) {
    renderResults([]);
    featuredContainer.innerHTML = "";
    return;
  }

  try {
    const resp = await fetch(
      `/api/theater/search?q=${encodeURIComponent(query)}`
    );

    const data = await resp.json();
    const results = (data.results || []).filter(
      (item) => item.media_type === "movie" || item.media_type === "tv"
    );
    renderResults(results);
    renderFeatured();
  } catch (e) {
    console.error("[theater] search failed:", e);
    renderResults([]);
  }
}

searchBar.addEventListener("input", () => {
  clearTimeout(debounceTimer);
  const query = searchBar.value.trim();
  debounceTimer = setTimeout(() => search(query), 300);
});

// Initial empty state
renderResults([]);

if (window.AxiomPageReady) window.AxiomPageReady();
