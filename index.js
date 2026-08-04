const dotenv = require("dotenv");
const crypto = require("crypto");
const https = require("https");
const GuacamoleLite = require("guacamole-lite");
const { server: wisp } = require("@mercuryworkshop/wisp-js/server");
const { scramjetPath } = require("@mercuryworkshop/scramjet/path");
console.log(scramjetPath);
const { baremuxPath } = require("@mercuryworkshop/bare-mux/node");
const cheerio = require("cheerio");
const fastify = require("fastify")
const path = require("path")
const epoxyPath = path.dirname(require.resolve("@mercuryworkshop/epoxy-transport"));
const libcurlPath = path.dirname(require.resolve("@mercuryworkshop/libcurl-transport"));
const scramjetControllerPath = path.dirname(require.resolve("@mercuryworkshop/scramjet-controller"));
const server = fastify()
const { createWorker } = require("tesseract.js")

dotenv.config();

// The in-browser SSH client reaches hosts through Wisp's TCP streams. Wisp
// blocks private and loopback ranges by default, which would rule out LAN and
// localhost boxes — the usual thing to SSH into. Opt in explicitly.
wisp.options.allow_private_ips = true;
wisp.options.allow_loopback_ips = true;

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
server.register(require("@fastify/static"), { root: scramjetPath, prefix: "/educational_vr/", decorateReply: false });
server.register(require("@fastify/static"), { root: scramjetControllerPath, prefix: "/educational_controller/", decorateReply: false });
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
        let worker;
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
            if (worker) await worker.terminate().catch(() => {});
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
            "content": "You are Axiom AI, a helpful assistant who's only job is to assist with homework/quizzes/etc for the user. You are powered by Groq models. When the user sends images, text has been extracted using OCR and is provided below in [Image text] tags. Use this extracted text along with the user's message to provide helpful responses."
        },
        ...history,
        {
            "role": "user",
            "content": userContent
        }
    ];

    try {
        const modelMap = {
            "0": "llama-3.1-8b-instant",
            "1": "openai/gpt-oss-120b",
            "default": "llama-3.1-8b-instant"
        };

        const requestedModel = req.body.model;

        // Server-side premium enforcement — client-side checks can always be bypassed
        if (requestedModel === "1" && !premium_keys.includes(req.headers.key)) {
            return res.code(403).send({ error: "GPT-OSS-120B requires a valid premium key." });
        }

        const modelToUse = modelMap[requestedModel] || modelMap.default;

        const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${process.env.GROQ_API_KEY}`
            },
            body: JSON.stringify({
                model: modelToUse,
                messages: messages,
                max_tokens: 4096,
                temperature: 0.7
            })
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.error?.message || `Groq API failed with status ${response.status}`);
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

server.get("/api/search", async (request, res) => {
  const { q } = request.query;
  if (!q) return res.code(400).send({ error: "Query required" });
  try {
    const response = await safeFetch(`https://lite.duckduckgo.com/lite/search?q=${encodeURIComponent(q)}`, {
      headers: { "User-Agent": "Mozilla/5.0" }
    });
    const html = await response.text();
    res.send({ results: getDuckDuckGoLiteUrls(html) });
  } catch (error) {
    res.code(500).send({ error: "Search failed because" + error.message });
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
    const response = await safeFetch(`https://google.com/complete/search?client=firefox&hl=en&q=${encodeURIComponent(query)}`);
    res.send(await response.json());
  } catch (e) { res.code(500).send('Error: ' + e); }
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

const PORT = Number(process.env.PORT) || 8081;

server.listen({port: PORT}).then(function(){
    console.log("Axiom started!")
    console.log(`http://localhost:${PORT}/`)
    console.log(`http://127.0.0.1:${PORT}`)
}).catch(function(e){
    console.log("Failed to start server with error: " + e)
})
