const { error } = require("console")
const fastify = require("fastify")
const path = require("path")
const dotenv = require("dotenv")
const { server: wisp } = require("@mercuryworkshop/wisp-js/server");
const { scramjetPath } = require("@mercuryworkshop/scramjet/path");
const { epoxyPath } = require("@mercuryworkshop/epoxy-transport")
const { baremuxPath } = require("@mercuryworkshop/bare-mux/node")
const cheerio = require("cheerio")

let premium_keys
try {
  premium_keys = dotenv.config().parsed.PREMIUM_KEYS.split(",")
} catch (e) {
  premium_keys = ["defu"]
}

const server = fastify()

server.register(require("@fastify/static"), {
    "root": path.join(__dirname, "/frontend"),
    "prefix": "/",
    "decorateReply": true,
    "setHeaders": (res, path) => {
        if (path.endsWith("sw.js")) {
            res.setHeader("Service-Worker-Allowed", "/");
        }
    }
})

server.register(require("@fastify/static"), {
    root: scramjetPath,
    prefix: "/scram/",
    decorateReply: false
})

server.register(require("@fastify/static"), {
    root: epoxyPath,
    prefix: "/epoxy/",
    decorateReply: false
})

server.register(require("@fastify/static"), {
    root: baremuxPath,
    prefix: "/baremux/",
    decorateReply: false
})

server.register(require("@fastify/rate-limit"), {
    timeWindow: "1m",
    max: 50
})

server.get("/api/check-premium", async function(req, res) {
  const key = req.headers.key
  if (premium_keys.includes(key)) {
    res.send({ success: true })
  }
  else {
    res.send({ success: false })
  }
})

server.get('/ask', async function(req, res) {
  res.send("OK")
})

server.get("/api/youtube/search", async (request, reply) => {
    try {
        const { query } = request.query;

        if (!query) {
            return reply.code(400).send({ error: "Query parameter is required" });
        }

        const invidiousUrl = `https://inv.nadeko.net/search?q=${encodeURIComponent(query)}`;
        const response = await fetch(invidiousUrl, {
            headers: {
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });

        if (!response.ok) {
            throw new Error('Invidious request failed');
        }

        const html = await response.text();
        const $ = cheerio.load(html);

        const videos = $('.pure-u-1.pure-u-md-1-4').map((index, element) => {
            const $video = $(element);
            const $thumbnailLink = $video.find('.thumbnail a');
            const videoUrl = $thumbnailLink.attr('href');
            const videoId = videoUrl ? videoUrl.split('v=')[1] : null;

            if (!videoId) return null;

            const title = $video.find('.video-card-row a p[title]').text().trim() ||
                         $video.find('.video-card-row a p').text().trim();

            const channelName = $video.find('.video-card-row.flexible .flex-left a p.channel-name')
                .text().trim()
                .replace(/\s+/g, ' ')
                .replace(/\s*$/, '');

            const length = $video.find('.bottom-right-overlay p.length').text().trim();

            const videoDataElements = $video.find('.video-card-row.flexible .flex-left p.video-data, .video-card-row.flexible .flex-right p.video-data');
            let uploadDate = '';
            let viewCount = '';
            videoDataElements.each((i, el) => {
                const text = $(el).text().trim();
                if (text.toLowerCase().includes('ago') || text.toLowerCase().includes('shared')) {
                    uploadDate = text;
                } else if (text.toLowerCase().includes('view')) {
                    viewCount = text;
                }
            });

            const thumbnailUrl = $video.find('.thumbnail img.thumbnail').attr('src');
            const fullThumbnailUrl = thumbnailUrl && thumbnailUrl.startsWith('http') ?
                thumbnailUrl : `https://inv.nadeko.net${thumbnailUrl || `/vi/${videoId}/mqdefault.jpg`}`;

            let lengthSeconds = 0;
            if (length) {
                const parts = length.split(':');
                if (parts.length === 3) { // HH:MM:SS
                    lengthSeconds = parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseInt(parts[2]);
                } else if (parts.length === 2) { // MM:SS
                    lengthSeconds = parseInt(parts[0]) * 60 + parseInt(parts[1]);
                }
            }

            return {
                videoId: videoId,
                title: title || 'Unknown Title',
                author: channelName || 'Unknown Channel',
                lengthSeconds: lengthSeconds,
                published: uploadDate || 'Unknown date',
                views: viewCount || '0 views',
                videoThumbnails: [
                    { url: fullThumbnailUrl },
                    { url: fullThumbnailUrl },
                    { url: fullThumbnailUrl }
                ],
                url: `https://www.youtube.com/watch?v=${videoId}`,
                invidiousUrl: `https://inv.nadeko.net${videoUrl}`
            };
        }).get().filter(video => video !== null);

        reply.send({ videos });

    } catch (error) {
        console.error('YouTube search error:', error);
        reply.code(500).send({ error: 'YouTube search failed' });
    }
})

// not my api key lol
const apiKey = '1070730380f5fee0d87cf0382670b255'; 

server.get("/api/movies/search", async (request, reply) => {
    const query = request.query.query || '';

    if (!query.trim()) {
        return reply.code(400).send({ error: 'Query parameter is required' });
    }

    const movieResponse = await fetch(`https://api.themoviedb.org/3/search/movie?api_key=${apiKey}&query=${query}`);
    const tvResponse = await fetch(`https://api.themoviedb.org/3/search/tv?api_key=${apiKey}&query=${query}`);
    const animeResponse = await fetch(`https://api.themoviedb.org/3/search/collection?api_key=${apiKey}&query=${query}`); 

    let movieData = await movieResponse.json();
    let tvData = await tvResponse.json();
    let animeData = await animeResponse.json();
    movieData.results.forEach(result => result.media_type = 'Movie');
    tvData.results.forEach(result => result.media_type = 'TV Show');
    animeData.results.forEach(result => result.media_type = 'Anime');

    const results = [...movieData.results, ...tvData.results, ...animeData.results];
    reply.send({ results });
})

server.server.on("upgrade", (req, socket, head) => {
    if (req.url.endsWith("/wisp/")) {
        wisp.routeRequest(req, socket, head)
    } else {
        socket.end()
    }
})

const port = process.env.port || 8080

server.listen({port: port, host: "0.0.0.0"}).then(function(){
    console.log("AXIOM started!")
    console.log("Listening on port " + port)
    console.log("http://localhost:" + port + "/")
})