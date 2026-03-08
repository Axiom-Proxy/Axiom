const { error } = require("console");
const fastify = require("fastify");
const path = require("path");
const dotenv = require("dotenv");
const https = require("https");

// Allow self-signed and untrusted SSL certificates for proxying
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
https.globalAgent.options.rejectUnauthorized = false;

const { server: wisp } = require("@mercuryworkshop/wisp-js/server");
const { scramjetPath } = require("@mercuryworkshop/scramjet/path");
const { epoxyPath } = require("@mercuryworkshop/epoxy-transport");
const { baremuxPath } = require("@mercuryworkshop/bare-mux/node");
const cheerio = require("cheerio");
const puppeteer = require("puppeteer");

let premium_keys;
try {
  premium_keys = dotenv.config().parsed.PREMIUM_KEYS.split(",");
} catch (e) {
  premium_keys = ["defu"];
}

const server = fastify();

async function fetchPageContent(url, browser) {
  const page = await browser.newPage();
  try {
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });
    const content = await page.content();
    return content;
  } finally {
    await page.close();
  }
}

async function search(query) {
  console.log(`[WebSearch] Starting Puppeteer search for query: "${query}"`);

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const searchUrl = `https://searxng.site/searxng/search?q=${encodeURIComponent(query)}`;
    console.log(`[WebSearch] Opening search URL: ${searchUrl}`);

    const page = await browser.newPage();
    await page.goto(searchUrl, {
      waitUntil: "networkidle0",
      timeout: 30000,
    });
    console.log(`[WebSearch] Search page loaded`);

    await page
      .waitForSelector("#urls article.result h3 a", { timeout: 15000 })
      .then(() => console.log(`[WebSearch] Search results found`))

    const html = await page.content();
    await page.close();

    const urls = getSearXNGUrls(html);

    return urls;
  } finally {
    await browser.close();
  }
}

function getSearXNGUrls(html) {
  const $ = cheerio.load(html);
  return $("article.result")
    .map((i, el) => {
      const $article = $(el);
      const url = $article.find("a.url_header").attr("href");
      const title = $article.find("h3 a").text().trim();
      const description = $article.find("p.content").text().trim();

      if (!url) return null;

      return {
        url,
        title: title || "Unknown Title",
        description: description || "No description available",
      };
    })
    .get()
    .filter((item) => item !== null);
}

server.register(require("@fastify/static"), {
  root: path.join(__dirname, "/frontend"),
  prefix: "/",
  decorateReply: true,
  setHeaders: (res, path) => {
    if (path.endsWith("sw.js")) {
      res.setHeader("Service-Worker-Allowed", "/");
    }
  },
});

async function callPollinationsAI(req, res, isStreaming, model = "mistral") {
    const payload = {
        model: model,
        messages: req.body.messages || [],
        ...(isStreaming && { stream: true })
    };

    const response = await fetch("https://gen.pollinations.ai/v1/chat/completions", {
        method: "POST",
        headers: {
            "accept": "*/*",
            "accept-language": "en-US,en;q=0.6",
            "cache-control": "no-cache",
            "content-type": "application/json",
            "authorization": `Bearer pk_XDXnwCpYbihkQcEg`, // not my key
            "pragma": "no-cache",
            "priority": "u=1, i",
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": "\"Windows\"",
            "sec-fetch-dest": "empty",
            "sec-fetch-mode": "cors",
            "sec-fetch-site": "same-site",
            "sec-gpc": "1"
        },
        referrer: "https://pollinations.ai/",
        body: JSON.stringify(payload),
        mode: "cors",
        credentials: "include"
    });

    if (isStreaming) {
        res.raw.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "Access-Control-Allow-Origin": "*",
            "X-Accel-Buffering": "no"
        });
        response.body.pipe(res.raw);
    } else {
        const data = await response.json();
        res.send(data);
    }
}

server.post("/v1/chat/completions", async (req, res) => {
    callPollinationsAI(req, res, req.body.stream);
});

server.post("/v1/models", async (req, res) => {
    const models = [
        "mistral",
    ];
    reply.send({
        object: "list",
        data: models.map(m => ({ id: m, object: "model", created: Math.floor(Date.now() / 1000), owned_by: "axiom" })),
    });
});

server.get("/api/search", async (request, reply) => {
  const { q } = request.query;
  const results = await search(q);
  reply.send({ results });
});

server.register(require("@fastify/static"), {
  root: scramjetPath,
  prefix: "/educational_vr/",
  decorateReply: false,
});

server.register(require("@fastify/static"), {
  root: epoxyPath,
  prefix: "/epoxy/",
  decorateReply: false,
});

server.register(require("@fastify/static"), {
  root: baremuxPath,
  prefix: "/baremux/",
  decorateReply: false,
});

server.register(require("@fastify/rate-limit"), {
  timeWindow: "1m",
  max: 50,
});

server.get("/api/check-premium", async function (req, res) {
  const key = req.headers.key;
  if (premium_keys.includes(key)) {
    res.send({ success: true });
  } else {
    res.send({ success: false });
  }
});

server.get("/ask", async function (req, res) {
  res.send("OK");
});

server.get('/search_complete/*', async (req, reply) => {
    const query = req.params['*'];
    if (!query) {
        reply.status(400).send('Search query is missing');
        return;
    }
    try {
        const response = await fetch(`https://google.com/complete/search?client=firefox&hl=en&q=${encodeURIComponent(query)}`);
        const suggestions = await response.json();
        reply.status(200).send(suggestions);
    } catch (error) {
        console.error('Error fetching search suggestions:', error);
        reply.status(500).send('no search results.');
    }
});

server.get("/api/youtube/search", async (request, reply) => {
  try {
    const { query } = request.query;

    if (!query) {
      return reply.code(400).send({ error: "Query parameter is required" });
    }

    const invidiousUrl = `https://inv.nadeko.net/search?q=${encodeURIComponent(query)}`;
    console.log(`[YouTubeSearch] Starting Puppeteer search for query: "${query}"`);

    const browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    let html;
    try {
      const page = await browser.newPage();
      await page.goto(invidiousUrl, {
        waitUntil: "networkidle0",
        timeout: 30000,
      });
      console.log(`[YouTubeSearch] Page loaded`);

      await page
        .waitForSelector(".pure-u-1.pure-u-md-1-4", { timeout: 15000 })
        .then(() => console.log(`[YouTubeSearch] Video results found`))
        .catch(() => console.log(`[YouTubeSearch] No video results selector found`));

      html = await page.content();
      await page.close();
    } finally {
      await browser.close();
    }
    const $ = cheerio.load(html);

    const videos = $(".pure-u-1.pure-u-md-1-4")
      .map((index, element) => {
        const $video = $(element);
        const $thumbnailLink = $video.find(".thumbnail a");
        const videoUrl = $thumbnailLink.attr("href");
        const videoId = videoUrl ? videoUrl.split("v=")[1] : null;

        if (!videoId) return null;

        const title =
          $video.find(".video-card-row a p[title]").text().trim() ||
          $video.find(".video-card-row a p").text().trim();

        const channelName = $video
          .find(".video-card-row.flexible .flex-left a p.channel-name")
          .text()
          .trim()
          .replace(/\s+/g, " ")
          .replace(/\s*$/, "");

        const length = $video
          .find(".bottom-right-overlay p.length")
          .text()
          .trim();

        const videoDataElements = $video.find(
          ".video-card-row.flexible .flex-left p.video-data, .video-card-row.flexible .flex-right p.video-data",
        );
        let uploadDate = "";
        let viewCount = "";
        videoDataElements.each((i, el) => {
          const text = $(el).text().trim();
          if (
            text.toLowerCase().includes("ago") ||
            text.toLowerCase().includes("shared")
          ) {
            uploadDate = text;
          } else if (text.toLowerCase().includes("view")) {
            viewCount = text;
          }
        });

        const thumbnailUrl = $video
          .find(".thumbnail img.thumbnail")
          .attr("src");
        const fullThumbnailUrl =
          thumbnailUrl && thumbnailUrl.startsWith("http")
            ? thumbnailUrl
            : `https://inv.nadeko.net${thumbnailUrl || `/vi/${videoId}/mqdefault.jpg`}`;

        let lengthSeconds = 0;
        if (length) {
          const parts = length.split(":");
          if (parts.length === 3) {
            // HH:MM:SS
            lengthSeconds =
              parseInt(parts[0]) * 3600 +
              parseInt(parts[1]) * 60 +
              parseInt(parts[2]);
          } else if (parts.length === 2) {
            // MM:SS
            lengthSeconds = parseInt(parts[0]) * 60 + parseInt(parts[1]);
          }
        }

        return {
          videoId: videoId,
          title: title || "Unknown Title",
          author: channelName || "Unknown Channel",
          lengthSeconds: lengthSeconds,
          published: uploadDate || "Unknown date",
          views: viewCount || "0 views",
          videoThumbnails: [
            { url: fullThumbnailUrl },
            { url: fullThumbnailUrl },
            { url: fullThumbnailUrl },
          ],
          url: `https://www.youtube.com/watch?v=${videoId}`,
          invidiousUrl: `https://inv.nadeko.net${videoUrl}`,
        };
      })
      .get()
      .filter((video) => video !== null);

    reply.send({ videos });
  } catch (error) {
    console.error("YouTube search error:", error);
    reply.code(500).send({ error: "YouTube search failed" });
  }
});

server.server.on("upgrade", (req, socket, head) => {
  socket.on("error", (err) => {
    console.error("WebSocket socket error:", err.message);
  });

  if (req.url.endsWith("/edu/")) {
    try {
      wisp.routeRequest(req, socket, head);
    } catch (err) {
      console.error("Wisp routing error:", err.message);
      socket.destroy();
    }
  } else {
    socket.end();
  }
});

process.on("uncaughtException", (err) => {
  console.error("There was an uncaught error", err);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

const port = process.env.port || 8085;

server.listen({ port: port, host: "0.0.0.0" }).then(function () {
  console.log("AXIOM started!");
  console.log("Listening on port " + port);
  console.log("http://localhost:" + port + "/");
});
