const fastify = require("fastify");
const path = require("path");
const dotenv = require("dotenv");
const https = require("https");
const { server: wisp } = require("@mercuryworkshop/wisp-js/server");
const { scramjetPath } = require("@mercuryworkshop/scramjet/path");
const { epoxyPath } = require("@mercuryworkshop/epoxy-transport");
const { baremuxPath } = require("@mercuryworkshop/bare-mux/node");
const cheerio = require("cheerio");

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
https.globalAgent.options.rejectUnauthorized = false;

let premium_keys = ["stya"];
try {
  const keys = dotenv.config().parsed?.PREMIUM_KEYS;
  if (keys) premium_keys = keys.split(",");
} catch (e) { console.warn("Using default keys."); }

const server = fastify({ logger: true, trustProxy: true });

async function safeFetch(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeout);
    return response;
  } catch (error) {
    clearTimeout(timeout);
    throw error;
  }
}

server.register(require("@fastify/static"), { root: scramjetPath, prefix: "/educational_vr/", decorateReply: false });
server.register(require("@fastify/static"), { root: epoxyPath, prefix: "/epoxy/", decorateReply: false });
server.register(require("@fastify/static"), { root: baremuxPath, prefix: "/baremux/", decorateReply: false });

server.register(require("@fastify/rate-limit"), { timeWindow: "1m", max: 100 });

server.post("/v1/chat/completions", async (req, res) => {
  try {
    await callPollinationsAI(req, res, req.body.stream);
  } catch (err) {
    console.error("AI Route Error:", err);
    res.code(500).send({ error: "AI request failed" });
  }
});

server.post("/v1/models", async (req, res) => {
  res.send({
    object: "list",
    data: ["mistral"].map(m => ({ id: m, object: "model", created: Math.floor(Date.now() / 1000), owned_by: "axiom" })),
  });
});

server.get("/api/check-premium", async (req, res) => {
  res.send({ success: premium_keys.includes(req.headers.key) });
});

server.get("/ask", async (req, res) => res.send("OK"));

server.get("/api/search", async (request, res) => {
  const { q } = request.query;
  if (!q) return res.code(400).send({ error: "Query required" });
  try {
    const response = await safeFetch(`https://search.bladerunn.in/search?q=${encodeURIComponent(q)}`, {
      headers: { "User-Agent": "Mozilla/5.0" }
    });
    const html = await response.text();
    res.send({ results: getSearXNGUrls(html) });
  } catch (error) {
    res.code(500).send({ error: "Search failed" });
  }
});

server.get("/api/youtube/search", async (request, res) => {
  const { query } = request.query;
  if (!query) return res.code(400).send({ error: "Query required" });

  try {
    const invidiousUrl = `https://inv.nadeko.net/search?q=${encodeURIComponent(query)}`;
    
    const response = await safeFetch(invidiousUrl, {
        headers: { "User-Agent": "Mozilla/5.0" }
    });
    const html = await response.text();
    
    const $ = cheerio.load(html);
    const videos = [];

    $(".pure-u-1.pure-u-md-1-4").each((i, el) => {
      const $video = $(el);
      
      const $thumbnailLink = $video.find(".thumbnail a");
      const videoPath = $thumbnailLink.attr("href");
      const videoId = videoPath ? videoPath.split("v=")[1] : null;
      
      if (!videoId) return; 

      const $img = $video.find(".thumbnail img.thumbnail");
      let thumbnailUrl = $img.attr("data-src") || $img.attr("src");

       if (!thumbnailUrl || thumbnailUrl.startsWith("data:")) {
         thumbnailUrl = `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
      } else if (thumbnailUrl.startsWith("/")) {
         thumbnailUrl = `https://inv.nadeko.net${thumbnailUrl}`;
      }

      const title = $video.find(".video-card-row a p[title]").attr("title") || 
                    $video.find(".video-card-row a p").text().trim() || 
                    "Unknown Title";

      const channelName = $video.find(".channel-name").text().trim();

      const length = $video.find(".length").text().trim();
      const lengthSeconds = parseDuration(length);

      // 6. Metadata
      const videoData = $video.find(".video-data").text().trim();

      videos.push({
        videoId,
        title,
        author: channelName || "Unknown",
        lengthSeconds,
        published: videoData, // Simplified
        videoThumbnails: [{ url: thumbnailUrl }],
        url: `https://www.youtube.com/watch?v=${videoId}`,
        invidiousUrl: `https://inv.nadeko.net${videoPath}`
      });
    });

    res.send({ videos });
  } catch (error) {
    console.error("YouTube scrape error:", error);
    res.code(500).send({ error: "YouTube search failed" });
  }
});

server.get('/search_complete/*', async (req, res) => {
  const query = req.params['*'];
  if (!query) return res.code(400).send('Missing query');
  try {
    const response = await safeFetch(`https://google.com/complete/search?client=firefox&hl=en&q=${encodeURIComponent(query)}`);
    res.send(await response.json());
  } catch (e) { res.code(500).send('Error'); }
});

function getSearXNGUrls(html) {
  const $ = cheerio.load(html);
  return $("article.result")
    .map((i, el) => {
      const $article = $(el);
      const url = $article.find("a.url_header").attr("href");
      if (!url) return null;
      return {
        url,
        title: $article.find("h3 a").text().trim() || "Unknown",
        description: $article.find("p.content").text().trim() || "N/A",
      };
    })
    .get()
    .filter(Boolean);
}

function parseDuration(str) {
  if (!str) return 0;
  const p = str.split(":");
  let s = 0, m = 1;
  while (p.length > 0) {
    s += m * parseInt(p.pop(), 10);
    m *= 60;
  }
  return s;
}

async function callPollinationsAI(req, res, isStreaming, model = "mistral") {
  const payload = { model, messages: req.body.messages || [], ...(isStreaming && { stream: true }) };
  const response = await fetch("https://gen.pollinations.ai/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", "authorization": `Bearer pk_XDXnwCpYbihkQcEg` },
    body: JSON.stringify(payload),
  });

  if (isStreaming) {
    res.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
    response.body.pipe(res.raw);
  } else {
    res.send(await response.json());
  }
}

server.register(require("@fastify/static"), {
  root: path.join(__dirname, "/frontend"),
  prefix: "/",
  decorateReply: true,
  setHeaders: (res, path) => {
    if (path.endsWith("sw.js")) res.setHeader("Service-Worker-Allowed", "/");
  },
});

server.server.on("upgrade", (req, socket, head) => {
  socket.on("error", (err) => { try { socket.destroy(); } catch (e) {} });
  if (req.url.startsWith("/edu/")) {
    try { wisp.routeRequest(req, socket, head); } 
    catch (err) { socket.destroy(); }
  } else {
    socket.destroy();
  }
});

process.on("uncaughtException", (err) => console.error("Uncaught:", err));
process.on("unhandledRejection", (r) => console.error("Unhandled:", r));

const port = process.env.PORT || 8085;
server.listen({ port, host: "0.0.0.0" }).then(() => console.log(`Running on ${port}`));