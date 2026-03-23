let jsonFile = window.location.pathname.includes('gapps.html') ? 'gapps.json' : 'apps.json';
let allApps = [];

fetch("./assets/" + jsonFile)
.then(response => response.json())
.then(jsonData => {
    allApps = jsonData;
    renderApps(allApps);

    const searchInput = document.getElementById("searchInput");
    searchInput.addEventListener("input", (e) => {
        const searchTerm = e.target.value.toLowerCase();
        const filteredApps = allApps.filter(app =>
            app.app_name.toLowerCase().includes(searchTerm)
        );
        renderApps(filteredApps);
    });
});

if (window.location.href.includes('gapps.html')) {
    fetch("./assets/gapps_2.json")
.then(response => response.json())
.then(jsonData => {
    allApps = jsonData;
    renderApps(allApps);

    const searchInput = document.getElementById("searchInput");
    searchInput.addEventListener("input", (e) => {
        const searchTerm = e.target.value.toLowerCase();
        const filteredApps = allApps.filter(app =>
            app.app_name.toLowerCase().includes(searchTerm)
        );
        renderApps(filteredApps);
    });
});
}
function renderApps(apps) {
    let appsContainer = document.getElementById("apps");
    appsContainer.innerHTML = "";

    apps.forEach(app => {
        let appElement = document.createElement("div");
        appElement.classList.add("app");
        appElement.innerHTML = `
            <img src="${app.app_img}" loading="lazy" alt="${app.app_name}">
            <h3>${app.app_name}</h3>
        `;
        appElement.addEventListener("click", () => {
            window.location.href = "../render.html?url=" + btoa(app.app_url);
        });
        appsContainer.appendChild(appElement);
    });
}