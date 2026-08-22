const dotenv = require("dotenv");
const crypto = require("crypto");
const https = require("https");
const GuacamoleLite = require("guacamole-lite");
const { server: wisp } = require("@mercuryworkshop/wisp-js/server");
const { baremuxPath } = require("@mercuryworkshop/bare-mux/node");
const cheerio = require("cheerio");
const fastify = require("fastify")
const fs = require("fs");
const path = require("path")
const epoxyPath = path.dirname(require.resolve("@mercuryworkshop/epoxy-transport"));
const libcurlPath = path.dirname(require.resolve("@mercuryworkshop/libcurl-transport"));
const server = fastify()
const { createWorker } = require("tesseract.js")

dotenv.config();

const NSFW_BLOCKLIST_URL = "https://nsfw.oisd.nl/";
const NSFW_BLOCKLIST_REFRESH_MS = 12 * 60 * 60 * 1000;
const nsfwDomains = new Set();
let nsfwBlocklistLoaded = false;

function parseNsfwBlocklist(text) {
    const domains = new Set();
    for (const line of text.split(/\r?\n/)) {
        const match = line.trim().match(/^\|\|([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)\^/i);
        if (match) domains.add(match[1].toLowerCase());
    }
    return domains;
}

async function refreshNsfwBlocklist() {
    const response = await fetch(NSFW_BLOCKLIST_URL, {
        signal: AbortSignal.timeout(30_000)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const domains = parseNsfwBlocklist(await response.text());
    if (domains.size === 0) throw new Error("The blocklist contained no hostname rules");

    nsfwDomains.clear();
    for (const domain of domains) nsfwDomains.add(domain);
    nsfwBlocklistLoaded = true;
    console.log(`Loaded ${nsfwDomains.size} NSFW hostname blocks.`);
}

function isNsfwHostname(hostname) {
    // Fail open: if the blocklist hasn't loaded (endpoint down, rate-limited,
    // or still pending), don't block everything — that would brick the whole
    // proxy. The filter only applies once the list is actually available.
    if (!nsfwBlocklistLoaded) return false;
    const normalized = hostname.toLowerCase().replace(/\.$/, "");
    const labels = normalized.split(".");
    for (let index = 0; index < labels.length; index++) {
        if (nsfwDomains.has(labels.slice(index).join("."))) return true;
    }
    return false;
}

// The in-browser SSH client reaches hosts through Wisp's TCP streams. Wisp
// blocks private and loopback ranges by default, which would rule out LAN and
// localhost boxes — the usual thing to SSH into. Opt in explicitly.
Object.assign(wisp.options, {
    allow_private_ips: true,
    allow_loopback_ips: true,
    hostname_blacklist: [{ test: isNsfwHostname }],
    dns_servers: ["1.1.1.3", "1.0.0.3"]
});

refreshNsfwBlocklist().catch((error) => {
    console.error(`Failed to load the NSFW hostname blocklist: ${error.message}`);
});
setInterval(() => {
    refreshNsfwBlocklist().catch((error) => {
        console.error(`Failed to refresh the NSFW hostname blocklist: ${error.message}`);
    });
}, NSFW_BLOCKLIST_REFRESH_MS).unref();

// Shared by every guacd-backed protocol (RDP and SSH); guacamole-lite decrypts
// tokens with this same key.
const guacTokenKey = crypto.createHash("sha256")
    .update(crypto.randomBytes(32))
    .digest();
const guacTokens = new Map();

function createGuacToken(payload) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv("aes-256-cbc", guacTokenKey, iv);
    const value = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
    return Buffer.from(JSON.stringify({
        iv: iv.toString("base64"),
        value: value.toString("base64")
    })).toString("base64");
}

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
https.globalAgent.options.rejectUnauthorized = false;

process.on("uncaughtException", (err) => {
    console.error("Uncaught exception:", err);
});
process.on("unhandledRejection", (reason) => {
    console.error("Unhandled rejection:", reason);
});

server.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: 4 * 1024 * 1024 }, function (req, body, done) {
    try {
        var json = JSON.parse(body);
        done(null, json);
    } catch (err) {
        err.statusCode = 400;
        done(err, undefined);
    }
});

server.register(require("@fastify/static"), { root: baremuxPath, prefix: "/baremux/", decorateReply: false });
server.register(require("@fastify/static"), { root: epoxyPath, prefix: "/epoxy/", decorateReply: false });
server.register(require("@fastify/static"), { root: libcurlPath, prefix: "/libcurl/", decorateReply: false });
server.register(require("@fastify/static"), {
    root: path.join(__dirname, "node_modules/guacamole-common-js/dist/esm"),
    prefix: "/remote-desktop/vendor/",
    decorateReply: false
});

// The SSH terminal runs the protocol in the browser: a Go/WASM client plus
// xterm.js. Nothing here decrypts the session, so these are plain assets.
server.register(require("@fastify/static"), {
    root: path.join(__dirname, "node_modules/sshclient-wasm/dist"),
    prefix: "/ssh/vendor/",
    decorateReply: false
});
server.register(require("@fastify/static"), {
    root: path.join(__dirname, "node_modules/@xterm/xterm/lib"),
    prefix: "/ssh/xterm/",
    decorateReply: false
});
server.register(require("@fastify/static"), {
    root: path.join(__dirname, "node_modules/@xterm/xterm/css"),
    prefix: "/ssh/xterm-css/",
    decorateReply: false
});
server.register(require("@fastify/static"), {
    root: path.join(__dirname, "node_modules/@mercuryworkshop/wisp-js/dist"),
    prefix: "/wisp/",
    decorateReply: false
});

const guacamoleServer = new GuacamoleLite({ server: undefined, noServer: true }, {
    host: "127.0.0.1",
    port: 4822
}, {
    maxInactivityTime: 0,
    log: { level: 0 },
    crypt: { cypher: "aes-256-cbc", key: guacTokenKey }
}, {
    processConnectionSettings(settings, callback) {
        const token = guacTokens.get(settings.nonce);
        guacTokens.delete(settings.nonce);

        if (!token || token.expiresAt < Date.now()) {
            return callback(new Error("Invalid or expired remote desktop session"));
        }

        callback(undefined, settings);
    }
});

setInterval(() => {
    const now = Date.now();
    for (const [nonce, token] of guacTokens) {
        if (token.expiresAt < now) guacTokens.delete(nonce);
    }
}, 60_000).unref();

server.post("/api/remote-desktop/session", {
    config: { rateLimit: { max: 10, timeWindow: "1m" } }
}, async (req, res) => {
    const body = req.body || {};
    const host = typeof body.host === "string" ? body.host.trim() : "";
    const port = Number(body.port);
    const username = typeof body.username === "string" ? body.username : "";
    const accessToken = typeof body.accessToken === "string" ? body.accessToken : "";
    const domain = typeof body.domain === "string" ? body.domain.trim() : "";

    if (!host || !accessToken || !Number.isInteger(port) || port < 1 || port > 65535) {
        return res.code(400).send({ error: "Invalid remote desktop connection." });
    }

    if (host.length > 253 || username.length > 512 || accessToken.length > 1024 || domain.length > 253) {
        return res.code(400).send({ error: "Invalid remote desktop connection." });
    }

    const nonce = crypto.randomUUID();
    const expiresAt = Date.now() + 30_000;
    guacTokens.set(nonce, { expiresAt });

    return res.send({
        token: createGuacToken({
            nonce,
            connection: {
                type: "rdp",
                settings: {
                    hostname: host,
                    port: String(port),
                    username,
                    password: accessToken,
                    domain,
                    security: "any",
                    "ignore-cert": true,
                    "enable-wallpaper": false
                }
            }
        })
    });
});

// Limit concurrent OCR workers to avoid memory exhaustion over time.
let ocrActive = 0;
const OCR_MAX_CONCURRENT = 2;

server.post("/chat", {
    config: {
        rateLimit: {
            max: 3,
            timeWindow: "1m",
            keyGenerator: (req) => req.ip,
            onLimitReached: (req) => {
                console.warn(`Chat rate limit exceeded for IP: ${req.ip}`);
            }
        }
    }
}, async function(req, res){
    const { message, history = [], images = [] } = req.body;

    if (!message && images.length === 0) {
        return res.code(400).send({ error: "Message required" });
    }

    let imageText = "";
    if (images.length > 0) {
        // Guard against unlimited concurrent OCR workers (each is ~100-300 MB).
        if (ocrActive >= OCR_MAX_CONCURRENT) {
            return res.code(503).send({ error: "OCR is busy, please try again shortly." });
        }

        ocrActive++;
        let worker;
        let terminateTimer;
        try {
            worker = await createWorker("eng", 1, {
                logger: m => { if (m.status === "recognizing text") console.log(`OCR progress: ${Math.round(m.progress * 100)}%`); }
            });

            const limitedImages = images.slice(0, 3);
            for (const imgData of limitedImages) {
                const base64Data = imgData.replace(/^data:image\/\w+;base64,/, "");
                const buffer = Buffer.from(base64Data, "base64");
                const { data: { text } } = await worker.recognize(buffer);
                if (text.trim()) {
                    imageText += `\n[Image text]: ${text.trim()}\n`;
                }
            }
        } catch (err) {
            console.error("OCR error:", err);
            imageText = "\n[Warning: Could not extract text from images]\n";
        } finally {
            // Force-kill the worker after a grace period so a stuck terminate()
            // doesn't leave a zombie child process consuming memory forever.
            if (worker) {
                terminateTimer = setTimeout(() => {
                    console.warn("OCR worker terminate() timed out — force killing.");
                    try { worker.terminate({ force: true }); } catch (_) {}
                }, 10_000);
                try {
                    await worker.terminate();
                } catch (e) {
                    console.error("OCR worker terminate() threw:", e.message);
                    // Still try to force-kill so we don't leak the process.
                    try { worker.terminate({ force: true }); } catch (_) {}
                } finally {
                    clearTimeout(terminateTimer);
                }
            }
            ocrActive--;
        }
    }

    let userContent;
    if (imageText) {
        userContent = `${message || "Analyze the following image content:"}\n${imageText}`;
    } else {
        userContent = message;
    }

    const messages = [
        {
            "role": "system",
            "content": "You are Axiom AI, a helpful assistant who's only job is to assist with homework/quizzes/etc for the user. You are powered by Composite (https://composite.lucidity.sh) models. When the user sends images, text has been extracted using OCR and is provided below in [Image text] tags. Use this extracted text along with the user's message to provide helpful responses."
        },
        ...history,
        {
            "role": "user",
            "content": userContent
        }
    ];

    try {
        const requestedModel = req.body.model;

        // Server-side premium enforcement — client-side checks can always be bypassed
        if (PREMIUM_MODELS.has(requestedModel) && !premium_keys.includes(req.headers.key)) {
            return res.code(403).send({ error: `${MODEL_CODENAMES[requestedModel] || requestedModel} requires a valid premium key.` });
        }

        const modelToUse = SUPPORTED_MODELS.includes(requestedModel) ? requestedModel : DEFAULT_MODEL;

        const response = await fetch("https://composite.lucidity.sh/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${process.env.COMPOSITE_API_KEY}`
            },
            body: JSON.stringify({
                model: modelToUse,
                messages: messages,
                max_tokens: 4096,
                temperature: 0.7
            }),
            signal: AbortSignal.timeout(60_000)
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.error?.message || `Composite API failed with status ${response.status}`);
        }

        const data = await response.json();

        if (data.choices && data.choices[0] && data.choices[0].message) {
            return res.send({ response: data.choices[0].message.content });
        } else {
            return res.code(500).send({ error: "Invalid response from AI service", response: data });
        }
    } catch (error) {
        console.error("Chat error:", error);
        return res.code(500).send({ error: "Failed to get response from AI: " + error.message });
    }
})

server.get("/educational_sl/sw.js", (req, res) => {
  res.header("Service-Worker-Allowed", "/");
  res.sendFile("educational_sl/sw.js");
});

server.server.on("upgrade", (req, socket, head) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  if (pathname === "/edu/") {
    try { wisp.routeRequest(req, socket, head); }
    catch (err) { socket.destroy(); }
    return;
  }
  if (pathname === "/remote-desktop/socket") {
    guacamoleServer.webSocketServer.handleUpgrade(req, socket, head, (ws) => {
      guacamoleServer.webSocketServer.emit("connection", ws, req);
    });
    return;
  }
  socket.destroy();
});

server.get("/api/theater/search", async (request, res) => {
  const { q } = request.query;
  if (!q) return res.code(400).send({ error: "Query required" });
  try {
    const response = await fetch(`https://db.speedracelight.com/3/search/multi?language=en&page=1&query=${encodeURIComponent(q)}`, {
      signal: AbortSignal.timeout(15_000),
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:153.0) Gecko/20100101 Firefox/153.0",
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "cross-site",
        "Priority": "u=4",
        "Pragma": "no-cache",
        "Cache-Control": "no-cache"
      }
    });
    const data = await response.json();
    res.send(data);
  } catch (error) {
    res.code(500).send({ error: "Search failed: " + error.message });
  }
});

const HOME_THEATER_QUERIES = ["comedy","umamusume"];
const HOME_THEATER_CACHE_TTL = 30 * 60 * 1000;
let homeTheaterCache = null;
let homeTheaterCacheAt = 0;

function shuffleArray(array) {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

async function fetchTheaterSearch(query) {
  const response = await fetch(`https://db.speedracelight.com/3/search/multi?language=en&page=1&query=${encodeURIComponent(query)}`, {
    signal: AbortSignal.timeout(15_000),
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:153.0) Gecko/20100101 Firefox/153.0",
      "Accept": "*/*",
      "Accept-Language": "en-US,en;q=0.9",
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "cross-site",
      "Priority": "u=4",
      "Pragma": "no-cache",
      "Cache-Control": "no-cache"
    }
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function buildHomeTheater() {
  const combined = [];
  const seen = new Set();
  for (const query of HOME_THEATER_QUERIES) {
    try {
      const data = await fetchTheaterSearch(query);
      for (const item of data.results || []) {
        if (item.media_type !== "movie" && item.media_type !== "tv") continue;
        const key = `${item.media_type}:${item.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        combined.push(item);
      }
    } catch (error) {
      console.error(`[theater] home query "${query}" failed:`, error.message);
    }
  }
  return shuffleArray(combined);
}

server.get("/api/theater/home", async (request, res) => {
  if (homeTheaterCache && Date.now() - homeTheaterCacheAt < HOME_THEATER_CACHE_TTL) {
    return res.send({ results: homeTheaterCache });
  }
  try {
    const results = await buildHomeTheater();
    homeTheaterCache = results;
    homeTheaterCacheAt = Date.now();
    res.send({ results });
  } catch (error) {
    res.code(500).send({ error: "Home load failed: " + error.message });
  }
});

server.get("/api/theater/tv/:id", async (request, res) => {
  const { id } = request.params;
  try {
    const response = await fetch(`https://db.speedracelight.com/3/tv/${id}?append_to_response=credits,external_ids,similar,videos,recommendations,translations&language=en&include_video_language=en,null`, {
      signal: AbortSignal.timeout(15_000),
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:153.0) Gecko/20100101 Firefox/153.0",
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "cross-site",
        "Priority": "u=4",
        "Pragma": "no-cache",
        "Cache-Control": "no-cache"
      }
    });
    const data = await response.json();
    res.send(data);
  } catch (error) {
    res.code(500).send({ error: "TV details failed: " + error.message });
  }
});

server.get("/api/theater/movie/:id", async (request, res) => {
  const { id } = request.params;
  try {
    const response = await fetch(`https://db.speedracelight.com/3/movie/${id}?append_to_response=credits,external_ids,videos,recommendations,translations,similar,release_dates&language=en&include_video_language=en,null`, {
      signal: AbortSignal.timeout(15_000),
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:153.0) Gecko/20100101 Firefox/153.0",
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "cross-site",
        "Priority": "u=4",
        "Pragma": "no-cache",
        "Cache-Control": "no-cache"
      }
    });
    const data = await response.json();
    res.send(data);
  } catch (error) {
    res.code(500).send({ error: "Movie details failed: " + error.message });
  }
});

server.get("/api/search", async (request, res) => {
  const { q } = request.query;
  if (!q) return res.code(400).send({ error: "Query required" });
  try {
    const response = await fetch(`https://lite.duckduckgo.com/lite/search?q=${encodeURIComponent(q)}`, {
      signal: AbortSignal.timeout(15_000),
      headers: { "User-Agent": "Mozilla/5.0" }
    });
    const html = await response.text();
    res.send({ results: getDuckDuckGoLiteUrls(html) });
  } catch (error) {
    res.code(500).send({ error: "Search failed: " + error.message });
  }
});

function getDuckDuckGoLiteUrls(html) {
  const $ = cheerio.load(html);
  const results = [];
  
  $("a.result-link").each((i, el) => {
    const $link = $(el);
    const url = $link.attr("href");
    
    if (!url) return;
    
    let actualUrl = url;
    const uddgMatch = url.match(/uddg=([^&]+)/);
    if (uddgMatch) {
      try {
        actualUrl = decodeURIComponent(uddgMatch[1]);
      } catch (e) {}
    } else if (url.startsWith("//")) {
      actualUrl = "https:" + url;
    }
    
    const title = $link.text().trim() || "Unknown";
    
    let description = "N/A";
    const $parentTd = $link.closest("td");
    const $parentTr = $parentTd.closest("tr");
    const $snippetRow = $parentTr.next("tr");
    const $snippet = $snippetRow.find("td.result-snippet");
    
    if ($snippet.length > 0) {
      description = $snippet.text().trim();
    }
    
    results.push({
      url: actualUrl,
      title,
      description: description || "N/A",
    });
  });
  
  return results;
}


server.get('/search_complete/*', async (req, res) => {
  const query = req.params['*'];
  if (!query) return res.code(400).send('Missing query');
  try {
    const response = await fetch(`https://google.com/complete/search?client=firefox&hl=en&q=${encodeURIComponent(query)}`, {
      signal: AbortSignal.timeout(10_000)
    });
    res.send(await response.json());
  } catch (e) { res.code(500).send('Error: ' + e); }
});


const MODEL_CODENAMES = {
    "lucidityai/gemma-4-26b-a4b-it:free": "Lucidity Gemma 4 26B A4B IT",
    "open/deepseek-ai/deepseek-v4-flash:free": "DeepSeek V4 Flash",
    "open/deepseek-ai/deepseek-v4-pro:free": "DeepSeek V4 Pro",
    "open/moonshotai/kimi-k2.6:free": "Moonshot Kimi K2.6",
    "open/stepfun-ai/step-3.5-flash:free": "StepFun Step 3.5 Flash",
    "open/stepfun-ai/step-3.7-flash:free": "StepFun Step 3.7 Flash",
    "open/z-ai/glm-5.2:free": "Z-AI GLM 5.2",
    "open/meta/llama-3.3-70b-instruct:free": "Meta Llama 3.3 70B Instruct",
    "open/google/gemma-4-31b-it:free": "Google Gemma 4 31B IT",
    "open/openai/gpt-oss-120b:free": "OpenAI GPT-OSS 120B",
    "open/qwen/qwen3.5-397b-a17b:free": "Qwen 3.5 397B A17B",
    "open/ibm/granite-34b-code-instruct:free": "IBM Granite 34B Code Instruct"
};

const SUPPORTED_MODELS = fs.readFileSync(path.join(__dirname, "models.txt"), "utf8")
    .split("\n")
    .map(s => s.trim())
    .filter(Boolean);

const PREMIUM_MODELS = new Set([
    "open/deepseek-ai/deepseek-v4-pro:free",
    "open/meta/llama-3.3-70b-instruct:free",
    "open/openai/gpt-oss-120b:free",
    "open/qwen/qwen3.5-397b-a17b:free",
    "open/z-ai/glm-5.2:free",
    "open/moonshotai/kimi-k2.6:free"
]);

const MODELS_LIST = SUPPORTED_MODELS
    .map(id => ({
        id,
        codename: MODEL_CODENAMES[id] || id,
        premium: PREMIUM_MODELS.has(id)
    }))
    .sort((a, b) => (a.premium ? 1 : 0) - (b.premium ? 1 : 0));

const DEFAULT_MODEL = SUPPORTED_MODELS[0] || "lucidityai/gemma-4-26b-a4b-it:free";

server.get("/api/models", async (req, res) => {
    res.send({ models: MODELS_LIST, default: DEFAULT_MODEL });
});

let premium_keys = ["stya"];
try {
  const keys = process.env.PREMIUM_KEYS;
  if (keys) premium_keys = keys.split(",");
} catch (e) { console.warn("Using default keys."); }

server.get("/api/check-premium", async (req, res) => {
  res.send({ success: premium_keys.includes(req.headers.key) });
});

server.get("/ask", async (req, res) => {
  res.send(true);
});

// Lists public/default/ so the browser filesystem can seed itself on first run.
// Anything dropped into that folder shows up for new users automatically.
const defaultFsRoot = path.join(__dirname, "public", "default");

function listDefaultFs(dir, prefix, entries) {
    for (const item of require("fs").readdirSync(dir, { withFileTypes: true })) {
        if (item.name === ".gitkeep") continue;
        const route = prefix + "/" + item.name;
        if (item.isDirectory()) {
            entries.push({ path: route, dir: true });
            listDefaultFs(path.join(dir, item.name), route, entries);
        } else if (item.isFile()) {
            entries.push({ path: route, dir: false });
        }
    }
    return entries;
}

server.get("/api/default-fs", async (req, res) => {
    try {
        res.send({ entries: listDefaultFs(defaultFsRoot, "", []) });
    } catch (e) {
        res.send({ entries: [] });
    }
});

// Lists the site's own source files so they can be mounted at /system inside
// the browser filesystem, where the service worker serves any edited copy back
// in place of the real thing. See tools/site-fs.js.
const { listSiteFiles } = require("./tools/site-fs");

server.get("/api/site-fs", async (req, res) => {
    try {
        res.send(listSiteFiles());
    } catch (e) {
        res.send({ version: 0, entries: [] });
    }
});

server.register(require("@fastify/static"), {
    root: path.join(__dirname, "/public/"),
    prefix: "/"
})

const PORT = Number(process.env.PORT) || 8080;

// Health-check endpoint so watch.py can detect a hung server and restart it.
server.get("/health", async (req, res) => {
    res.send({ status: "ok", uptime: process.uptime() });
});

server.listen({port: PORT}).then(function(){
    console.log("Axiom started!")
    console.log(`http://localhost:${PORT}/`)
    console.log(`http://127.0.0.1:${PORT}`)
    // Pre-warm the cached, shuffled home page before anyone searches.
    buildHomeTheater().then((results) => {
        homeTheaterCache = results;
        homeTheaterCacheAt = Date.now();
        console.log(`Preloaded ${results.length} shuffled home theater titles.`);
    }).catch((error) => {
        console.error("Failed to preload home theater titles:", error.message);
    });
}).catch(function(e){
    console.log("Failed to start server with error: " + e)
})
