const gameFrame = document.getElementById("game-frame");
const gameUrl = new URLSearchParams(window.location.search).get("url");
const gameTitle = new URLSearchParams(window.location.search).get("title");

if (gameTitle) {
  document.title = `${gameTitle} | Axiom`;
  gameFrame.title = gameTitle;
}

if (gameUrl) {
  const rendererUrl = new URL("./render.html", window.location.href);
  rendererUrl.searchParams.set("url", gameUrl);
  gameFrame.src = rendererUrl.href;
}

document.querySelector(".game-controls").addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button) return;

  switch (button.dataset.action) {
    case "back":
      window.location.href = "./games.html";
      break;
    case "fullscreen":
      await document.querySelector(".game-panel").requestFullscreen?.();
      break;
    case "reload":
      gameFrame.contentWindow?.postMessage({ type: "refresh" }, window.location.origin);
      break;
    case "share":
      try {
        await navigator.clipboard.writeText(window.location.href);
      } catch {
        window.prompt("Copy this link", window.location.href);
      }
      break;
    case "open":
      if (gameUrl) {
        const rendererUrl = new URL("./render.html", window.location.href);
        rendererUrl.searchParams.set("url", gameUrl);
        window.open(rendererUrl.href, "_blank", "noopener");
      }
      break;
  }
});
