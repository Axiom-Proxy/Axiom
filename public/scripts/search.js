const input = document.getElementById("search-input");
const suggestionsList = document.getElementById("suggestions");
let activeIndex = -1;
let debounceTimer;

input.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    const q = input.value.trim();
    if (!q) { hideSuggestions(); return; }
    debounceTimer = setTimeout(() => fetchSuggestions(q), 150);
});

async function fetchSuggestions(q) {
    try {
        const res = await fetch(`/search_complete/${encodeURIComponent(q)}`);
        const data = await res.json();
        renderSuggestions(Array.isArray(data[1]) ? data[1].slice(0, 8) : []);
    } catch (e) { hideSuggestions(); }
}

function renderSuggestions(items) {
    suggestionsList.innerHTML = "";
    activeIndex = -1;
    if (!items.length) { hideSuggestions(); return; }
    items.forEach((text) => {
        const li = document.createElement("li");
        li.textContent = text;
        li.addEventListener("mousedown", (e) => { e.preventDefault(); input.value = text; hideSuggestions(); submitSearch(text); });
        suggestionsList.appendChild(li);
    });
    suggestionsList.style.display = "block";
}

function hideSuggestions() { suggestionsList.style.display = "none"; suggestionsList.innerHTML = ""; activeIndex = -1; }

input.addEventListener("keydown", (e) => {
    const items = suggestionsList.querySelectorAll("li");
    if (e.key === "ArrowDown") { e.preventDefault(); activeIndex = Math.min(activeIndex + 1, items.length - 1); updateActive(items); }
    else if (e.key === "ArrowUp") { e.preventDefault(); activeIndex = Math.max(activeIndex - 1, -1); updateActive(items); }
    else if (e.key === "Enter") { if (activeIndex >= 0 && items[activeIndex]) input.value = items[activeIndex].textContent; hideSuggestions(); submitSearch(input.value); }
    else if (e.key === "Escape") hideSuggestions();
});

function updateActive(items) { items.forEach((li, i) => li.classList.toggle("active", i === activeIndex)); if (activeIndex >= 0) input.value = items[activeIndex].textContent; }
document.addEventListener("click", (e) => { if (!e.target.closest(".search-wrapper")) hideSuggestions(); });
function submitSearch(query) { const isUrl = /^(https?:\/\/|[a-zA-Z0-9-]+\.[a-zA-Z]{2,})/.test(query); const url = isUrl && !query.startsWith("http") ? "https://" + query : isUrl ? query : `https://search.brave.com/search?q=${encodeURIComponent(query)}`; window.location.href = `/render.html?url=${btoa(url)}`; }
