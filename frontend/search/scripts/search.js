const searchInput = document.getElementById("searchInput");
const loader = document.getElementById("loader_item");
const resultsDiv = document.getElementById("results");
const resultCountDiv = document.getElementById("result_count");

function performSearch(query) {
  if (!query) return;

  resultCountDiv.textContent = "Searching...";
  const resultElements = resultsDiv.querySelectorAll(".result");
  resultElements.forEach((el) => el.remove());

  const startTime = Date.now();
  fetch(`/api/search?q=${encodeURIComponent(query)}`)
    .then((response) => response.json())
    .then((data) => {
      const endTime = Date.now();

      loader.remove();

      resultCountDiv.textContent = `Found ${data.results.length} results in ${((endTime - startTime) / 1000).toFixed(2)} seconds`;

      data.results.forEach((result) => {
        const resultDiv = document.createElement("div");
        resultDiv.classList.add("result");
        resultDiv.innerHTML = `
                            <div class="url">${result.url}</div>
                            <div class="title">${result.title}</div>
                            <div class="description">${result.description}</div>
                        `;
        resultDiv.addEventListener("click", () => {
          window.location.href = "../render.html?url=" + btoa(result.url);
        });
        resultsDiv.appendChild(resultDiv);
      });
    })
    .catch((error) => {
      console.error(error);
      window.location.href = `https://search.brave.com/search?q=${encodeURIComponent(query)}`;
    });
}

const urlParams = new URLSearchParams(window.location.search);
const query = urlParams.get("q");
if (query) {
  searchInput.value = query;
  performSearch(query);
}

const suggestionsBox = document.getElementById("suggestions");
let activeIndex = -1;
let debounceTimer = null;

function hideSuggestions() {
  suggestionsBox.style.display = "none";
  suggestionsBox.innerHTML = "";
  searchInput.classList.remove("has-suggestions");
  activeIndex = -1;
}

function showSuggestions(items) {
  if (!items.length) { hideSuggestions(); return; }
  suggestionsBox.innerHTML = "";
  searchInput.classList.add("has-suggestions");
  items.slice(0, 4).forEach((text) => {
    const div = document.createElement("div");
    div.className = "suggestion-item";
    div.textContent = text;
    div.addEventListener("mousedown", (e) => {
      e.preventDefault();
      searchInput.value = text;
      hideSuggestions();
      window.location.href = `?q=${encodeURIComponent(text)}`;
    });
    suggestionsBox.appendChild(div);
  });
  suggestionsBox.style.display = "block";
  activeIndex = -1;
}

searchInput.addEventListener("input", function () {
  const query = this.value.trim();
  clearTimeout(debounceTimer);
  if (!query) { hideSuggestions(); return; }
  debounceTimer = setTimeout(async () => {
    try {
      const res = await fetch("/search_complete/" + encodeURIComponent(query));
      const data = await res.json();
      showSuggestions(data[1] || []);
    } catch (e) { hideSuggestions(); }
  }, 200);
});

searchInput.addEventListener("keydown", (e) => {
  const items = suggestionsBox.querySelectorAll(".suggestion-item");
  if (e.key === "ArrowDown") {
    e.preventDefault();
    activeIndex = Math.min(activeIndex + 1, items.length - 1);
    items.forEach((el, i) => el.classList.toggle("active", i === activeIndex));
    if (activeIndex >= 0) searchInput.value = items[activeIndex].textContent;
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    activeIndex = Math.max(activeIndex - 1, -1);
    items.forEach((el, i) => el.classList.toggle("active", i === activeIndex));
  } else if (e.key === "Enter") {
    const newQuery = searchInput.value;
    hideSuggestions();
    if (newQuery) window.location.href = `?q=${encodeURIComponent(newQuery)}`;
  } else if (e.key === "Escape") {
    hideSuggestions();
  }
});

document.addEventListener("click", (e) => {
  if (!e.target.closest(".search-container")) hideSuggestions();
});
