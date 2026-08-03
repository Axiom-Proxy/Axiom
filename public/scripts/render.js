const search_engine = "../search/index.html?q=";
const premium = false;
let scramjetFrame = null;
let scramjet = null;
let lastKnownUrl = "";

function getURLParameter(name) {
  const regex = new RegExp(`[\\?&]${name}=([^&#]*)`);
  const results = regex.exec(location.search);
  return results ? atob(decodeURIComponent(results[1])) : "";
}

function cleanContent(htmlString) {
  if (!htmlString) return "";
  return htmlString
    .replace(/<(script|style|div)\b[^>]*>([\s\S]*?)<\/\1>/gim, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function buildSearchUrl(input, searchEngine) {
  if (!input || input.trim() === "") return `${searchEngine}${encodeURIComponent("")}`;
  if (input.startsWith("http://") || input.startsWith("https://")) {
    try { return new URL(input).toString(); } catch {}
  }
  if (input.includes(".")) {
    try { return new URL("https://" + input).toString(); } catch {}
  }
  return `${searchEngine}${encodeURIComponent(input)}`;
}

function updateDocumentTitle() {
  if (!scramjetFrame) return;
  try {
    const document_ = scramjetFrame.element.contentDocument;
    const frameTitle = document_?.title || "";
    if (!frameTitle || document.title === frameTitle) return;

    if (premium) sessionStorage.setItem("axiomAICon", cleanContent(document_?.documentElement.innerHTML));
    const loaderElement = document.getElementById("loader");
    if (loaderElement) {
      loaderElement.classList.add("fade-out");
      loaderElement.addEventListener("animationend", () => loaderElement.remove(), { once: true });
    }
    document.title = frameTitle;
    window.parent.postMessage({ type: "urlChange", url: lastKnownUrl, title: frameTitle }, "*");
  } catch {}
}

function navigate(url) {
  const finalUrl = buildSearchUrl(url, search_engine);
  lastKnownUrl = finalUrl;
  scramjetFrame.go(finalUrl);
  window.parent.postMessage({ type: "urlChange", url: finalUrl, title: document.title }, "*");
}

window.addEventListener("message", (event) => {
  if (!event.data || !scramjetFrame) return;
  switch (event.data.type) {
    case "navigate": navigate(event.data.url); break;
    case "back": scramjetFrame.back(); break;
    case "forward": scramjetFrame.forward(); break;
    case "refresh": scramjetFrame.reload(); break;
  }
});

async function registerSW() {
  if (!navigator.serviceWorker) throw new Error("Your browser doesn't support service workers.");
  if (location.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(location.hostname)) {
    throw new Error("Service workers require HTTPS.");
  }
  const registration = await navigator.serviceWorker.register("/educational_sl/sw.js", { scope: "/" });
  await registration.update();

  const updatingWorker = registration.installing ?? registration.waiting;
  if (updatingWorker && updatingWorker.state !== "activated") {
    await new Promise((resolve, reject) => {
      const checkState = () => {
        if (updatingWorker.state === "activated") resolve();
        if (updatingWorker.state === "redundant") reject(new Error("Service worker update failed."));
      };
      updatingWorker.addEventListener("statechange", checkState);
      checkState();
    });
  }

  await navigator.serviceWorker.ready;
  if (!registration.active) throw new Error("Service worker is not active yet.");
  return registration;
}

document.addEventListener("DOMContentLoaded", async () => {
  try {
    const registration = await registerSW();
    if (!registration.active) throw new Error("Service worker is not active yet. Reload once after installation.");

    const { default: LibcurlClient } = await import("/libcurl/index.mjs");
    const wisp = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/edu/`;
    const transport = new LibcurlClient({ wisp });
    await transport.init();

    scramjet = new $scramjetController.Controller({
      serviceworker: registration.active,
      transport,
      config: {
        prefix: "/educational_apkn/",
        scramjetPath: "/educational_vr/scramjet.js",
        injectPath: "/educational_controller/controller.inject.js",
        wasmPath: "/educational_vr/scramjet.wasm",
      },
    });
    await scramjet.wait();

    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!registration.active) return;
      scramjet.serviceWorkerController = registration.active;
      scramjet.setupMessagePort();
    });

    const element = document.createElement("iframe");
    element.id = "frame";
    element.classList.add("active");
    document.getElementById("frame-container").appendChild(element);
    scramjetFrame = scramjet.createFrame(element);

    const url = getURLParameter("url");
    if (url) navigate(url);
    setInterval(updateDocumentTitle, 500);
  } catch (error) {
    console.error("Failed to initialize browser:", error);
  }
});
