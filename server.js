const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 4177);
const ROOT = __dirname;
const DEEPSEEK_ENDPOINT = "https://api.deepseek.com/chat/completions";

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp"
};

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", chunk => {
      raw += chunk;
      if (raw.length > 2_000_000) {
        reject(new Error("Request body too large."));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("Invalid JSON body."));
      }
    });
    req.on("error", reject);
  });
}

async function handleDeepseekOptimize(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: { message: "Method not allowed." } });
    return;
  }

  try {
    const body = await readJson(req);
    const apiKey = String(body.apiKey || "").trim();
    const model = String(body.model || "deepseek-v4-flash").trim();
    const prompt = String(body.prompt || "").trim();

    if (!apiKey) {
      sendJson(res, 400, { error: { message: "Missing DeepSeek API Key." } });
      return;
    }

    if (!prompt) {
      sendJson(res, 400, { error: { message: "Missing prompt." } });
      return;
    }

    const upstream = await fetch(DEEPSEEK_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content: "你是 DeepSeek，负责为商品海报生成临时视觉预设。按用户要求输出，不要添加无关解释。"
          },
          {
            role: "user",
            content: prompt
          }
        ],
        temperature: 0.35,
        max_tokens: 1800,
        response_format: { type: "json_object" },
        thinking: { type: "disabled" }
      })
    });

    const text = await upstream.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { error: { message: text || `DeepSeek returned HTTP ${upstream.status}` } };
    }

    sendJson(res, upstream.status, data);
  } catch (error) {
    sendJson(res, 500, {
      error: {
        message: error && error.message ? error.message : "DeepSeek proxy failed."
      }
    });
  }
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const requestedPath = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const filePath = path.normalize(path.join(ROOT, requestedPath));

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": mimeTypes[ext] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  if (req.url && req.url.startsWith("/api/deepseek-optimize")) {
    handleDeepseekOptimize(req, res);
    return;
  }

  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`JUXIA DESIGN LAB running at http://127.0.0.1:${PORT}/`);
});
