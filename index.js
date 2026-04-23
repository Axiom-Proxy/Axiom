const dotenv = require("dotenv");
const https = require("https");
const { server: wisp } = require("@mercuryworkshop/wisp-js/server");
const { scramjetPath } = require("@mercuryworkshop/scramjet/path");
const { epoxyPath } = require("@mercuryworkshop/epoxy-transport");
const { baremuxPath } = require("@mercuryworkshop/bare-mux/node");
const cheerio = require("cheerio");
const fastify = require("fastify")
const path = require("path")
const server = fastify()
const { createWorker } = require("tesseract.js")

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
https.globalAgent.options.rejectUnauthorized = false;

server.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: 4 * 1024 * 1024 }, function (req, body, done) {
    try {
        var json = JSON.parse(body);
        done(null, json);
    } catch (err) {
        err.statusCode = 400;
        done(err, undefined);
    }
});

server.register(require("@fastify/static"), {
    root: path.join(__dirname, "/public/"),
    prefix: "/"
})

server.register(require("@fastify/static"), { root: scramjetPath, prefix: "/educational_vr/", decorateReply: false });
server.register(require("@fastify/static"), { root: epoxyPath, prefix: "/epoxy/", decorateReply: false });
server.register(require("@fastify/static"), { root: baremuxPath, prefix: "/baremux/", decorateReply: false });


server.register(require("@fastify/rate-limit"), {
    max: 1000,
    timeWindow: "1m"
})

server.register(require("@fastify/rate-limit"), {
    max: 20,
    timeWindow: "1m",
    keyGenerator: (req) => req.ip,
    onLimitReached: (req) => {
        console.warn(`Rate limit exceeded for IP: ${req.ip}`);
    }
}, { routeSpecific: true });

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
        try {
            const worker = await createWorker("eng", 1, {
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
            await worker.terminate();
        } catch (err) {
            console.error("OCR error:", err);
            imageText = "\n[Warning: Could not extract text from images]\n";
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
  socket.on("error", (err) => { try { socket.destroy(); } catch (e) {} });
  if (req.url.startsWith("/edu/")) {
    try { wisp.routeRequest(req, socket, head); } 
    catch (err) { socket.destroy(); }
  } else {
    socket.destroy();
  }
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
  const keys = dotenv.config().parsed?.PREMIUM_KEYS;
  if (keys) premium_keys = keys.split(",");
} catch (e) { console.warn("Using default keys."); }

server.get("/api/check-premium", async (req, res) => {
  res.send({ success: premium_keys.includes(req.headers.key) });
});

server.listen({port: 8080}).then(function(){
    console.log("Axiom started!")
    console.log("http://localhost:8080/")
    console.log('http://127.0.0.1:8080')
}).catch(function(e){
    console.log("Failed to start server with error: " + e)
})