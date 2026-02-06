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
      resultCountDiv.textContent = "Error performing search";
    });
}

const urlParams = new URLSearchParams(window.location.search);
const query = urlParams.get("q");
if (query) {
  searchInput.value = query;
  performSearch(query);
}

searchInput.addEventListener("keypress", (e) => {
  if (e.key === "Enter") {
    const newQuery = searchInput.value;
    if (newQuery) {
      window.location.href = `?q=${encodeURIComponent(newQuery)}`;
    }
  }
});
