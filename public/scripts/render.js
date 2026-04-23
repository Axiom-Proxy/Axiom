const search_engine = "../search/index.html?q=";
const premium = false;
let scramjetFrame = null;
let scramjet = null;

function getURLParameter(name) {
  const regex = new RegExp(`[\\?&]${name}=([^&#]*)`);
  const results = regex.exec(location.search);
  return results ? atob(results[1]) : "";
}

function cleanContent(htmlString) {
  if (!htmlString) return "";
  const nukeTags = /<(script|style|div)\b[^>]*>([\s\S]*?)<\/\1>/gim;
  let cleaned = htmlString.replace(nukeTags, "");
  const stripTags = /<[^>]+>/g;
  cleaned = cleaned.replace(stripTags, "");
  return cleaned
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function buildSearchUrl(input, searchEngine) {
  try {
    if (!input || input.trim() === "") {
      return `${searchEngine}${encodeURIComponent("")}`;
    }
    if (input.startsWith("http://") || input.startsWith("https://")) {
      try {
        return new URL(input).toString();
      } catch (e) {
        return `${searchEngine}${encodeURIComponent(input)}`;
      }
    }
    if (input.includes(".")) {
      try {
        return new URL("https://" + input).toString();
      } catch (e) {
        return `${searchEngine}${encodeURIComponent(input)}`;
      }
    }
    return `${searchEngine}${encodeURIComponent(input)}`;
  } catch (err) {
    return `${searchEngine}${encodeURIComponent(input)}`;
  }
}

let lastKnownUrl = "";

function updateDocumentTitle() {
  if (!scramjetFrame || !scramjetFrame.frame) return;
  try {
    const frameTitle = scramjetFrame.frame.contentDocument
      ? scramjetFrame.frame.contentDocument.title
      : "";
    const currentUrl = scramjetFrame.url || "";
    let changed = false;

    if (currentUrl && currentUrl !== lastKnownUrl) {
      lastKnownUrl = currentUrl;
      changed = true;
    }

    if (frameTitle && document.title !== frameTitle) {
      if (premium) {
        sessionStorage.setItem("axiomAICon", cleanContent(scramjetFrame.frame.contentDocument.innerHTML));
      }
      const loaderElement = document.getElementById("loader");
      if (loaderElement) {
        loaderElement.classList.add("fade-out");
        loaderElement.addEventListener("animationend", () => loaderElement.remove(), { once: true });
      }
      document.title = frameTitle;
      changed = true;
    }

    if (changed) {
      window.parent.postMessage({ type: "urlChange", url: lastKnownUrl, title: document.title }, "*");
    }
  } catch (e) {}
}

// Listen for navigation commands from tabs.html
window.addEventListener("message", (e) => {
  if (!e.data) return;
  switch (e.data.type) {
    case "navigate":
      if (scramjetFrame) {
        const finalUrl = buildSearchUrl(e.data.url, search_engine);
        scramjetFrame.go(finalUrl);
      }
      break;
    case "back":
      try { scramjetFrame?.frame.contentWindow.history.back(); } catch (err) {}
      break;
    case "forward":
      try { scramjetFrame?.frame.contentWindow.history.forward(); } catch (err) {}
      break;
    case "refresh":
      try {
        scramjetFrame?.frame.contentWindow.location.reload();
      } catch (err) {
        if (scramjetFrame && lastKnownUrl) scramjetFrame.go(lastKnownUrl);
      }
      break;
  }
});

const stockSW = "/educational_sl/sw.js";
const swAllowedHostnames = ["localhost", "127.0.0.1"];

async function registerSW() {
  if (!navigator.serviceWorker) {
    if (location.protocol !== "https:" && !swAllowedHostnames.includes(location.hostname))
      throw new Error("Service workers cannot be registered without https.");
    throw new Error("Your browser doesn't support service workers.");
  }
  await navigator.serviceWorker.register(stockSW, { scope: "/" });
}

document.addEventListener("DOMContentLoaded", async () => {
  while (typeof BareMux === "undefined") {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const { ScramjetController } = $scramjetLoadController();
  scramjet = new ScramjetController(__scramjet$config);

  const url = getURLParameter("url") || "";

  await scramjet.init();

  const connection = new BareMux.BareMuxConnection("/baremux/worker.js");

  try {
    await registerSW();
    console.log("Registered!");
  } catch (err) {
    console.error("Failed to register service worker:", err);
  }

  const wispUrl = (location.protocol === "https:" ? "wss" : "ws") + "://" + location.host + "/edu/";
  await connection.setTransport("/epoxy/index.mjs", [{ wisp: wispUrl }]);

  if (url) {
    const finalUrl = buildSearchUrl(url, search_engine);
    lastKnownUrl = finalUrl;

    scramjetFrame = scramjet.createFrame();
    scramjetFrame.frame.id = "frame";
    scramjetFrame.frame.classList.add("active");
    document.getElementById("frame-container").appendChild(scramjetFrame.frame);

    scramjetFrame.go(finalUrl);

    // Tell the parent tabs.html what URL we're loading right away
    window.parent.postMessage({ type: "urlChange", url: finalUrl, title: document.title }, "*");

    setInterval(updateDocumentTitle, 500);
  }
});
