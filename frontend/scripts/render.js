const search_engine_preference =

search_engine = "../search/index.html?q=";

const premium = window.premium.check()
let typing = 0;
let scramjetFrame = null;
let scramjet = null;

document
  .getElementById("search")
  .addEventListener("focusin", () => (typing = 1));
document
  .getElementById("search")
  .addEventListener("focusout", () => (typing = 0));

function getURLParameter(name) {
  const regex = new RegExp(`[\\?&]${name}=([^&#]*)`);
  const results = regex.exec(location.search);
  return results ? atob(results[1]) : "";
}

document.getElementById("search").addEventListener("keydown", function () {
  if (event.key == "Enter") {
    navigateToPage();
  }
});

function navigateToPage() {
  const input = document.getElementById("search").value;

  if (
    input.startsWith("http://") ||
    input.startsWith("https://") ||
    /^[\w-]+(\.[\w-]+)+$/.test(input)
  ) {
    window.location = `render.html?url=${btoa(input)}`;
  } else {
    window.location = `/search/index.html?q=${encodeURIComponent(input)}`;
  }
}

function cleanContent(htmlString){
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

let lastKnownUrl = "";

function updateDocumentTitle() {
  if (scramjetFrame && scramjetFrame.frame) {
    try {
      const frameTitle = scramjetFrame.frame.contentDocument
        ? scramjetFrame.frame.contentDocument.title
        : "";

      
      const currentUrl = scramjetFrame.url || "";

      
      if (currentUrl && currentUrl !== lastKnownUrl && !typing) {
        lastKnownUrl = currentUrl;

        document.getElementById("search").value = currentUrl;

        // check if URL is in bookmarks
        let bookmarks = JSON.parse(localStorage.getItem("bookmarks") || "[]"); 
        if (bookmarks.some((bookmark) => bookmark.url === currentUrl)) {
          // fill in #handle_bookmark by giving it add-bookmark.filled
          document.getElementById("handle_bookmark").classList.add("filled"); 
        }
        else {
          if (document.getElementById("handle_bookmark").classList.contains("filled")) {
            document.getElementById("handle_bookmark").classList.remove("filled");
          }
        }

        
        const newBrowserUrl = `render.html?url=${btoa(currentUrl)}`;
        if (window.location.search !== `?url=${btoa(currentUrl)}`) {
          history.replaceState(null, "", newBrowserUrl);
        }
      }

      
      if (frameTitle && document.title !== frameTitle) {
        if (premium) {
          sessionStorage.setItem("axiomAICon", cleanContent(scramjetFrame.frame.contentDocument.innerHTML));
        }
        const loaderElement = document.getElementById("loader");
        if (loaderElement) {
          loaderElement.classList.add("fade-out");
          loaderElement.addEventListener("animationend", () => {
            loaderElement.remove();
          }, { once: true });
        }
        document.title = frameTitle;
      }
    } catch (e) {
    }
  }
}

function handle_bookmark(){
  let bookmarks = JSON.parse(localStorage.getItem("bookmarks") || "[]");
  const input = document.getElementById("search").value;
  if (bookmarks.some((bookmark) => bookmark.url === input)) {
    bookmarks = bookmarks.filter((bookmark) => bookmark.url !== input);
    localStorage.setItem("bookmarks", JSON.stringify(bookmarks));
    document.getElementById("handle_bookmark").classList.remove("filled");
  } else {
    bookmarks.push({ url: input });
    localStorage.setItem("bookmarks", JSON.stringify(bookmarks));
    document.getElementById("handle_bookmark").classList.add("filled");
  }
}

const searchInput = document.querySelector("#search");

function buildSearchUrl(input, searchEngine) {
  try {
    if (
      !input.startsWith("http://") &&
      !input.startsWith("https://") &&
      input.includes(".")
    ) {
      input = "https://" + input;
    }
    return new URL(input).toString();
  } catch (err) {
    return `${searchEngine}${encodeURIComponent(input)}`;
  }
}

let eruda_status = 0;

function handle_eruda() {
  if (window.eruda == null) {
    javascript: (function () {
      var script = document.createElement("script");
      script.src = "https://cdn.jsdelivr.net/npm/eruda";
      document.body.append(script);
      script.onload = function () {
        eruda.init();
      };
    })();
    window.eruda.show();
  } else {
    if (eruda_status == 0) {
      window.eruda.show();
      eruda_status = 1;
    } else {
      window.eruda.hide();
      eruda_status = 0;
    }
  }
}

const stockSW = "/educational_sl/sw.js";

const swAllowedHostnames = ["localhost", "127.0.0.1"];

async function registerSW() {
  if (!navigator.serviceWorker) {
    if (
      location.protocol !== "https:" &&
      !swAllowedHostnames.includes(location.hostname)
    )
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

  let url = getURLParameter("url") || "";

  await scramjet.init();

  const connection = new BareMux.BareMuxConnection("/baremux/worker.js");

  try {
    await registerSW();
    console.log("Registered!");
  } catch (err) {
    console.error("Failed to register service worker:", err);
  }

  const wispUrl = (location.protocol === "https:" ? "wss" : "ws") + "://" + location.host + "/edu/"; 

  await connection.setTransport("/epoxy/index.mjs", [
    {
      wisp: wispUrl,
    },
  ]);

  if (url) {
    const finalUrl = buildSearchUrl(url, search_engine);

    document.getElementById("search").value = url;
    lastKnownUrl = finalUrl;

    scramjetFrame = scramjet.createFrame();
    scramjetFrame.frame.id = "frame";
    scramjetFrame.frame.classList.add("active");
    document.getElementById("frame-container").appendChild(scramjetFrame.frame);

    scramjetFrame.go(finalUrl);

    setInterval(updateDocumentTitle, 500);
  }
});