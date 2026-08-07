const IMG_PROXY = "https://wsrv.nl/?url=https%3A%2F%2Fimage.tmdb.org%2Ft%2Fp%2Foriginal%2F";

const urlParams = new URLSearchParams(window.location.search);
const mediaId = urlParams.get("id");
const mediaType = urlParams.get("type");

const detailsBackdrop = document.getElementById("details-backdrop");
const detailsPoster = document.getElementById("details-poster");
const detailsTitle = document.getElementById("details-title");
const detailsMeta = document.getElementById("details-meta");
const detailsOverview = document.getElementById("details-overview");
const detailsCast = document.getElementById("details-cast");
const detailsSimilar = document.getElementById("details-similar");
const detailsWatch = document.getElementById("details-watch");
const detailsBack = document.getElementById("details-back");

const playerOverlay = document.getElementById("player-overlay");
const playerIframe = document.getElementById("player-iframe");
const playerTitle = document.getElementById("player-title");
const playerClose = document.getElementById("player-close");

let currentData = null;

function esc(text) {
  if (!text) return "";
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function getImageUrl(path, width = "original") {
  if (!path) return "";
  return `${IMG_PROXY}${encodeURIComponent(path)}&output=webp&q=80&n=-1`;
}

function getAccentColor() {
  const style = getComputedStyle(document.documentElement);
  const accent = style.getPropertyValue("--accent").trim();
  return accent.replace("#", "");
}

function getEmbedUrl(id, mediaType) {
  const color = getAccentColor() || "ff0000";
  if (mediaType === "tv") {
    return `https://www.vidking.net/embed/tv/${id}/1/1?color=${color}&episodeSelector=true`;
  }
  return `https://www.vidking.net/embed/movie/${id}?color=${color}&episodeSelector=true`;
}

function formatRuntime(minutes) {
  if (!minutes) return "";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function renderGenres(genres) {
  if (!genres || !genres.length) return "";
  return genres.map(g => g.name).join(", ");
}

function renderCast(cast, limit = 6) {
  if (!cast || !cast.length) return "";
  const people = cast.slice(0, limit);
  return people.map(person => {
    const img = person.profile_path 
      ? `<img src="${getImageUrl(person.profile_path)}" alt="${esc(person.name)}" loading="lazy" onerror="this.style.display='none'">`
      : `<span class="material-symbols-outlined">person</span>`;
    return `
      <div class="cast-member">
        <div class="cast-photo">${img}</div>
        <div class="cast-name">${esc(person.name)}</div>
        <div class="cast-role">${esc(person.character || person.known_for_department || "")}</div>
      </div>
    `;
  }).join("");
}

function buildSimilarCard(item) {
  const card = document.createElement("div");
  card.className = "similar-card";
  const title = item.title || item.name || "Untitled";
  const poster = getImageUrl(item.poster_path);
  
  card.innerHTML = `
    <div class="similar-thumb">
      <img src="${poster}" alt="${esc(title)}" loading="lazy" onerror="this.style.display='none'">
    </div>
    <div class="similar-info">
      <div class="similar-title">${esc(title)}</div>
    </div>
  `;
  
  card.addEventListener("click", () => {
    const type = item.media_type || (item.first_air_date ? "tv" : "movie");
    window.location.href = `./theater-details.html?id=${item.id}&type=${type}`;
  });
  
  return card;
}

function openPlayer() {
  if (!currentData) return;
  const title = currentData.title || currentData.name || "Untitled";
  playerTitle.textContent = title;
  playerIframe.src = getEmbedUrl(currentData.id, mediaType);
  playerOverlay.classList.add("open");
}

function closePlayer() {
  playerOverlay.classList.remove("open");
  playerIframe.src = "";
}

playerClose.addEventListener("click", closePlayer);
playerOverlay.addEventListener("click", (e) => {
  if (e.target === playerOverlay) closePlayer();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && playerOverlay.classList.contains("open")) {
    closePlayer();
  }
});

detailsWatch.addEventListener("click", openPlayer);
detailsBack.addEventListener("click", () => {
  window.location.href = "./theater.html";
});

async function loadDetails() {
  if (!mediaId || !mediaType) {
    window.location.href = "./theater.html";
    return;
  }

  try {
    const endpoint = mediaType === "tv" ? `/api/theater/tv/${mediaId}` : `/api/theater/movie/${mediaId}`;
    const resp = await fetch(endpoint);
    const data = await resp.json();
    currentData = data;

    // Backdrop
    if (data.backdrop_path) {
      detailsBackdrop.style.backgroundImage = `url(${getImageUrl(data.backdrop_path)})`;
    }

    // Poster
    if (data.poster_path) {
      detailsPoster.innerHTML = `<img src="${getImageUrl(data.poster_path)}" alt="${esc(data.title || data.name)}">`;
    }

    // Title
    detailsTitle.textContent = data.title || data.name || "Untitled";

    // Meta info
    const year = data.release_date || data.first_air_date || "";
    const yearText = year ? year.split("-")[0] : "";
    const rating = data.vote_average ? data.vote_average.toFixed(1) : "";
    const runtime = data.runtime ? formatRuntime(data.runtime) : "";
    const episodes = data.number_of_episodes ? `${data.number_of_episodes} episodes` : "";
    const seasons = data.number_of_seasons ? `${data.number_of_seasons} seasons` : "";
    const genres = renderGenres(data.genres);
    
    let metaParts = [];
    if (yearText) metaParts.push(yearText);
    if (rating) metaParts.push(`⭐ ${rating}`);
    if (runtime) metaParts.push(runtime);
    if (seasons) metaParts.push(seasons);
    if (episodes) metaParts.push(episodes);
    if (genres) metaParts.push(genres);
    if (data.status) metaParts.push(data.status);

    detailsMeta.innerHTML = metaParts.map(p => `<span>${esc(p)}</span>`).join("<span class=\"meta-sep\">\u2022</span>");

    // Overview
    detailsOverview.textContent = data.overview || "No description available.";

    // Cast
    if (data.credits && data.credits.cast && data.credits.cast.length) {
      detailsCast.innerHTML = `<h3>Cast</h3><div class="cast-list">${renderCast(data.credits.cast)}</div>`;
    }

    // Similar
    const similarItems = (data.similar && data.similar.results) || (data.recommendations && data.recommendations.results) || [];
    if (similarItems.length) {
      detailsSimilar.innerHTML = "";
      similarItems.slice(0, 12).forEach(item => {
        detailsSimilar.appendChild(buildSimilarCard(item));
      });
    } else {
      document.getElementById("details-similar-section").style.display = "none";
    }

  } catch (e) {
    console.error("[theater-details] failed to load:", e);
    window.location.href = "./theater.html";
  }
}

loadDetails();

if (window.AxiomPageReady) window.AxiomPageReady();
