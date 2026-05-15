const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
const DEEPSEEK_ENDPOINT = "https://api.deepseek.com/chat/completions";
const STATS_KEY = "generation-stats:v1";
const IMAGE_MODEL_IDS = {
  pro: "gemini-3-pro-image-preview",
  fast: "gemini-2.5-flash-image"
};

let generationTail = Promise.resolve();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400"
  };
}

function jsonResponse(payload, status = 200, env = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders(env),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function unauthorized(env) {
  return jsonResponse({ error: { message: "Unauthorized." } }, 401, env);
}

function defaultGenerationStats() {
  return {
    counts: {
      [IMAGE_MODEL_IDS.pro]: 0,
      [IMAGE_MODEL_IDS.fast]: 0
    },
    total: 0,
    updatedAt: null
  };
}

function normalizeGenerationStats(raw = {}) {
  const defaults = defaultGenerationStats();
  const counts = Object.keys(defaults.counts).reduce((nextCounts, modelId) => {
    const value = Number(raw.counts?.[modelId]);
    nextCounts[modelId] = Number.isFinite(value) ? Math.max(0, value) : 0;
    return nextCounts;
  }, { ...defaults.counts });

  return {
    counts,
    total: Object.values(counts).reduce((total, value) => total + value, 0),
    updatedAt: raw.updatedAt || null
  };
}

function publicGenerationStats(stats, source = "worker-kv") {
  const normalized = normalizeGenerationStats(stats);
  return {
    source,
    counts: normalized.counts,
    total: normalized.total,
    updatedAt: normalized.updatedAt
  };
}

async function readGenerationStats(env) {
  if (!env.JUXIA_STATS) return null;
  const stored = await env.JUXIA_STATS.get(STATS_KEY, "json").catch(() => null);
  return normalizeGenerationStats(stored || {});
}

async function writeGenerationStats(env, stats) {
  if (!env.JUXIA_STATS) return null;
  const normalized = normalizeGenerationStats(stats);
  await env.JUXIA_STATS.put(STATS_KEY, JSON.stringify(normalized));
  return normalized;
}

async function incrementGenerationStats(env, model) {
  if (!env.JUXIA_STATS) return null;

  const stats = await readGenerationStats(env) || defaultGenerationStats();
  const modelId = Object.prototype.hasOwnProperty.call(stats.counts, model)
    ? model
    : IMAGE_MODEL_IDS.pro;

  stats.counts[modelId] += 1;
  stats.updatedAt = new Date().toISOString();
  return writeGenerationStats(env, stats);
}

async function handleGenerationStats(env) {
  if (!env.JUXIA_STATS) {
    return jsonResponse({
      ok: false,
      error: { message: "JUXIA_STATS KV binding is not configured." }
    }, 503, env);
  }

  const stats = await readGenerationStats(env) || defaultGenerationStats();
  return jsonResponse({
    ok: true,
    stats: publicGenerationStats(stats)
  }, 200, env);
}

function decodeBasicAuth(request) {
  const header = request.headers.get("Authorization") || "";
  if (!header.startsWith("Basic ")) return null;
  try {
    const decoded = atob(header.slice(6));
    const index = decoded.indexOf(":");
    if (index < 0) return null;
    return {
      username: decoded.slice(0, index),
      password: decoded.slice(index + 1)
    };
  } catch {
    return null;
  }
}

function isAuthorized(request, env) {
  const expectedUser = env.ACCESS_USERNAME || "";
  const expectedPassword = env.ACCESS_PASSWORD || "";
  if (!expectedUser || !expectedPassword) return false;
  const auth = decodeBasicAuth(request);
  return auth?.username === expectedUser && auth?.password === expectedPassword;
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function normalizeGeminiImage(data) {
  const parts = data.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find(part => part.inlineData || part.inline_data);
  const inlineData = imagePart?.inlineData || imagePart?.inline_data;
  if (!inlineData?.data) return null;
  return {
    mimeType: inlineData.mimeType || inlineData.mime_type || "image/png",
    data: inlineData.data
  };
}

function base64ToBytes(data) {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function imageResponse(image, env, headers = {}) {
  return new Response(base64ToBytes(image.data), {
    status: 200,
    headers: {
      ...corsHeaders(env),
      "Content-Type": image.mimeType,
      "Cache-Control": "no-store",
      ...headers
    }
  });
}

function extractGeminiText(data) {
  const parts = data.candidates?.[0]?.content?.parts || [];
  return parts
    .map(part => part.text || "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

function geminiFailureSummary(data) {
  const candidate = data.candidates?.[0] || {};
  const finishReason = candidate.finishReason || candidate.finish_reason || "";
  const text = extractGeminiText(data);
  const safety = candidate.safetyRatings || candidate.safety_ratings || [];
  const blocked = safety
    .filter(item => item.blocked || item.probability === "HIGH" || item.probability === "MEDIUM")
    .map(item => item.category)
    .filter(Boolean)
    .join(", ");

  return [finishReason && `finishReason=${finishReason}`, blocked && `safety=${blocked}`, text]
    .filter(Boolean)
    .join("；")
    .slice(0, 500);
}

function shouldRetryGemini(status, data) {
  if ([429, 500, 502, 503, 504].includes(status)) return true;
  const message = [
    data?.error?.message,
    data?.message,
    extractGeminiText(data)
  ].filter(Boolean).join(" ");
  return /high demand|temporar|try again|overloaded|rate limit|空|稍后/i.test(message);
}

async function requestGeminiImage({ prompt, model, file, imageData, env, attempt }) {
  const retryNote = attempt > 1
    ? "\n\n重试硬约束：上一次响应没有可用图片或模型临时繁忙。本次必须返回 IMAGE 模态的完整海报底图，不要只返回文字说明，不要解释。"
    : "";

  let upstream;
  try {
    upstream = await fetch(`${GEMINI_ENDPOINT}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: `${prompt}${retryNote}` },
            {
              inline_data: {
                mime_type: file.type || "image/png",
                data: imageData
              }
            }
          ]
        }],
        generationConfig: {
          responseModalities: ["TEXT", "IMAGE"]
        }
      })
    });
  } catch (error) {
    const upstreamError = new Error(`Gemini upstream fetch failed: ${error?.message || "unknown error"}`);
    upstreamError.code = "GEMINI_UPSTREAM_FETCH_FAILED";
    upstreamError.retryable = true;
    throw upstreamError;
  }

  const data = await upstream.json().catch(() => ({}));
  return { upstream, data };
}

async function runQueued(task) {
  const run = generationTail.then(task, task);
  generationTail = run.catch(() => {});
  return run;
}

async function handleGeminiImage(request, env) {
  if (!env.GEMINI_API_KEY) {
    return jsonResponse({ error: { message: "Missing GEMINI_API_KEY secret." } }, 500, env);
  }

  return runQueued(async () => {
    try {
      const formData = await request.formData();
      const prompt = String(formData.get("prompt") || "").trim();
      const model = String(formData.get("model") || "gemini-3-pro-image-preview").trim();
      const file = formData.get("reference_image");

      if (!prompt) {
        return jsonResponse({ error: { message: "Missing prompt." } }, 400, env);
      }

      if (!file || typeof file.arrayBuffer !== "function") {
        return jsonResponse({ error: { message: "Missing reference image." } }, 400, env);
      }

      const imageData = arrayBufferToBase64(await file.arrayBuffer());
      const maxAttempts = Math.max(1, Math.min(4, Number(env.GEMINI_MAX_ATTEMPTS || 3)));
      let lastData = {};
      let lastStatus = 502;
      let lastSummary = "";

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const { upstream, data } = await requestGeminiImage({ prompt, model, file, imageData, env, attempt });
        lastData = data;
        lastStatus = upstream.status;

        if (upstream.ok) {
          const image = normalizeGeminiImage(data);
          if (image) {
            const stats = await incrementGenerationStats(env, model);
            return imageResponse(image, env, {
              "X-Generation-Attempts": String(attempt),
              "X-Generation-Stats-Source": stats ? "worker-kv" : "unavailable"
            });
          }

          lastSummary = geminiFailureSummary(data);
          if (attempt < maxAttempts) {
            await sleep(900 * attempt);
            continue;
          }
          break;
        }

        lastSummary = data.error?.message || JSON.stringify(data) || `HTTP ${upstream.status}`;
        if (attempt < maxAttempts && shouldRetryGemini(upstream.status, data)) {
          await sleep(1200 * attempt);
          continue;
        }

        return jsonResponse({
          error: {
            message: lastSummary,
            retryable: shouldRetryGemini(upstream.status, data)
          },
          attempts: attempt
        }, upstream.status, env);
      }

      return jsonResponse({
        error: {
          message: `Gemini 连续 ${maxAttempts} 次没有返回图片数据，请稍后点“重新生成”。`,
          code: "NO_IMAGE_DATA",
          retryable: true,
          detail: lastSummary || "No inline image part in Gemini response."
        },
        attempts: maxAttempts,
        upstreamStatus: lastStatus,
        upstream: env.DEBUG_GEMINI_RESPONSE === "true" ? lastData : undefined
      }, 502, env);
    } catch (error) {
      return jsonResponse({
        error: {
          message: error?.message || "Worker failed before Gemini returned a response.",
          code: error?.code || "WORKER_GENERATION_FAILED",
          retryable: error?.retryable !== false
        }
      }, 502, env);
    }
  });
}

async function handleDeepseekPreset(request, env) {
  if (!env.DEEPSEEK_API_KEY) {
    return jsonResponse({ error: { message: "Missing DEEPSEEK_API_KEY secret." } }, 500, env);
  }

  const body = await request.json().catch(() => ({}));
  const prompt = String(body.prompt || "").trim();
  const model = String(body.model || "deepseek-v4-flash").trim();

  if (!prompt) {
    return jsonResponse({ error: { message: "Missing prompt." } }, 400, env);
  }

  const upstream = await fetch(DEEPSEEK_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${env.DEEPSEEK_API_KEY}`
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content: "你是 DeepSeek，负责为商品海报生成临时视觉预设。只输出 JSON，字段为 style、composition、negative。"
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

  const data = await upstream.json().catch(() => ({}));
  return jsonResponse(data, upstream.status, env);
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    const url = new URL(request.url);
    if (!isAuthorized(request, env)) {
      return unauthorized(env);
    }

    if (url.pathname === "/api/auth-check" && request.method === "GET") {
      return jsonResponse({ ok: true }, 200, env);
    }

    if (url.pathname === "/api/generation-stats" && request.method === "GET") {
      return handleGenerationStats(env);
    }

    if (url.pathname === "/api/gemini-image" && request.method === "POST") {
      return handleGeminiImage(request, env);
    }

    if (url.pathname === "/api/deepseek-optimize" && request.method === "POST") {
      return handleDeepseekPreset(request, env);
    }

    return jsonResponse({ error: { message: "Not found." } }, 404, env);
  }
};
