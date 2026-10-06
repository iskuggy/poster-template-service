import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { test } from "node:test";

const source = await readFile(new URL("../cloudflare-worker.js", import.meta.url), "utf8");
const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const OPENAI = "gpt-image-2.5-sunburst";
const PRO = "gemini-3-pro-image-preview";
const FAST = "gemini-2.5-flash-image";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT1EAAAAASUVORK5CYII=";
const previousStats = { counts: { [PRO]: 359, [FAST]: 205 }, total: 564, updatedAt: "2026-09-23T09:29:00Z" };

function fixture(upstream = async () => Response.json({ data: [{ b64_json: PNG }] })) {
  const calls = [];
  let stored = structuredClone(previousStats);
  let writes = 0;
  const env = {
    ACCESS_USERNAME: "test-team", ACCESS_PASSWORD: "test-password", OPENAI_API_KEY: "test-openai-key",
    GEMINI_API_KEY: "test-gemini-key", ALLOWED_ORIGIN: "https://iskuggy.github.io",
    JUXIA_STATS: {
      async get(key) { assert.equal(key, "generation-stats:v1"); return structuredClone(stored); },
      async put(key, value) { assert.equal(key, "generation-stats:v1"); stored = JSON.parse(value); writes++; }
    }
  };
  const context = vm.createContext({
    Response, Request, URL, Blob, FormData, Uint8Array, AbortController, atob, btoa, setTimeout, clearTimeout,
    fetch: async (url, options) => { calls.push({ url, options }); return upstream(url, options); }
  });
  vm.runInContext(source.replace("export default {", "globalThis.worker = {"), context);
  return { env, calls, worker: context.worker, stats: () => stored, writes: () => writes };
}

function request({ path = "/api/openai-image", model = OPENAI, size = "1080x1440", image = true, auth = true, base64 = PNG, file = false } = {}) {
  const form = new FormData();
  form.append("model", model);
  form.append("prompt", "保留参考图产品结构，生成电影自然光无字海报底图。");
  form.append("size", size);
  if (image) {
    if (file) form.append("reference_image", new Blob([Buffer.from(PNG, "base64")], { type: "image/png" }), "reference.png");
    else {
      form.append("reference_image_base64", base64);
      form.append("reference_mime_type", "image/png");
    }
  }
  return new Request(`https://worker.example${path}`, {
    method: "POST", headers: auth ? { Authorization: `Basic ${btoa("test-team:test-password")}` } : {}, body: form
  });
}

test("OpenAI sends the reference image and counts one success without changing Nano Banana history", async () => {
  const f = fixture();
  const response = await f.worker.fetch(request(), f.env);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.imageUrl, `data:image/png;base64,${PNG}`);
  assert.deepEqual(payload.stats.counts, { [OPENAI]: 1, [PRO]: 359, [FAST]: 205 });
  assert.equal(payload.stats.total, 565);
  assert.equal(f.writes(), 1);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), f.env.ALLOWED_ORIGIN);
  const { url, options } = f.calls[0];
  assert.equal(url, "https://api.openai.com/v1/images/edits");
  assert.equal(options.headers.Authorization, "Bearer test-openai-key");
  assert.equal(options.headers["Content-Type"], undefined);
  for (const [key, value] of Object.entries({ model: OPENAI, size: "1056x1408", quality: "high", output_format: "png", n: "1" })) {
    assert.equal(options.body.get(key), value);
  }
  assert.equal(options.body.get("image[]").type, "image/png");
  assert.deepEqual(Buffer.from(await options.body.get("image[]").arrayBuffer()), Buffer.from(PNG, "base64"));
  assert.ok(!JSON.stringify(payload).includes("test-openai-key"));
});

test("old KV data gains an OpenAI zero without resetting prior totals", async () => {
  const f = fixture();
  const response = await f.worker.fetch(new Request("https://worker.example/api/generation-stats", {
    headers: { Authorization: `Basic ${btoa("test-team:test-password")}` }
  }), f.env);
  const { stats } = await response.json();
  assert.deepEqual(stats.counts, { [OPENAI]: 0, [PRO]: 359, [FAST]: 205 });
  assert.equal(stats.total, 564);
  assert.equal(f.writes(), 0);
});

test("each selected size maps to valid OpenAI dimensions and exports retain their own dimensions", async () => {
  for (const [size, expected] of Object.entries({ "1080x1440": "1056x1408", "1242x1660": "1248x1664", "1080x1350": "1088x1360", "1080x1080": "1088x1088", "1440x1080": "1408x1056" })) {
    const f = fixture();
    assert.equal((await f.worker.fetch(request({ size }), f.env)).status, 200);
    assert.equal(f.calls[0].options.body.get("size"), expected);
    const [w, h] = expected.split("x").map(Number);
    assert.equal(w % 16, 0); assert.equal(h % 16, 0);
    assert.ok(w * h >= 655360 && w * h <= 8294400);
    assert.ok(html.includes(`"${size}": {`));
  }
});

test("multipart reference files work as well as browser base64", async () => {
  const f = fixture();
  assert.equal((await f.worker.fetch(request({ file: true }), f.env)).status, 200);
  assert.equal(f.calls[0].options.body.get("image[]").size, Buffer.from(PNG, "base64").length);
});

test("unauthorized, missing key, missing image and invalid input never reach OpenAI or increment counts", async () => {
  for (const [options, expected, missingKey] of [
    [{ auth: false }, 401], [{}, 503, true], [{ image: false }, 400],
    [{ model: PRO }, 400], [{ size: "1x1" }, 400], [{ base64: "%%%" }, 400]
  ]) {
    const f = fixture();
    if (missingKey) delete f.env.OPENAI_API_KEY;
    assert.equal((await f.worker.fetch(request(options), f.env)).status, expected);
    assert.equal(f.calls.length, 0); assert.equal(f.writes(), 0);
    assert.deepEqual(f.stats(), previousStats);
  }
});

test("upstream errors and empty output do not count or trigger automatic paid retries", async () => {
  for (const [status, body, expected] of [
    [429, { error: { message: "Rate limited", code: "rate_limit" } }, 429],
    [403, { error: { message: "Model access denied" } }, 403],
    [200, { data: [] }, 502], [200, { data: [{ b64_json: "" }] }, 502]
  ]) {
    const f = fixture(async () => Response.json(body, { status }));
    assert.equal((await f.worker.fetch(request(), f.env)).status, expected);
    assert.equal(f.calls.length, 1); assert.equal(f.writes(), 0);
  }
  const f = fixture(async () => { throw new TypeError("network failed"); });
  assert.equal((await f.worker.fetch(request(), f.env)).status, 502);
  assert.equal(f.calls.length, 1); assert.equal(f.writes(), 0);
});

test("existing Gemini generation still increments only its own model", async () => {
  const f = fixture(async () => Response.json({ candidates: [{ content: { parts: [{ inlineData: { data: PNG, mimeType: "image/png" } }] } }] }));
  const response = await f.worker.fetch(request({ path: "/api/gemini-image", model: FAST }), f.env);
  assert.equal(response.status, 200);
  const { stats } = await response.json();
  assert.deepEqual(stats.counts, { [OPENAI]: 0, [PRO]: 359, [FAST]: 206 });
  assert.equal(stats.total, 565);
});

test("OpenAI and Gemini share the existing instance queue and cumulative counts", async () => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  let arrived;
  const started = new Promise(resolve => { arrived = resolve; });
  const f = fixture(async url => {
    if (url.includes("openai.com")) { arrived(); await waiting; return Response.json({ data: [{ b64_json: PNG }] }); }
    return Response.json({ candidates: [{ content: { parts: [{ inlineData: { data: PNG } }] } }] });
  });
  const first = f.worker.fetch(request(), f.env);
  await started;
  const second = f.worker.fetch(request({ path: "/api/gemini-image", model: PRO }), f.env);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.length, 1);
  release();
  assert.equal((await first).status, 200); assert.equal((await second).status, 200);
  assert.equal(f.stats().total, 566);
  assert.deepEqual(f.stats().counts, { [OPENAI]: 1, [PRO]: 360, [FAST]: 205 });
});

function browserFixture(fetch) {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      id, value: "", textContent: "", options: [], style: {}, dataset: {},
      classList: { toggle() {}, add() {}, remove() {} }, addEventListener() {}, querySelector() { return null; },
      appendChild(option) { this.options.push(option); }
    });
    return elements.get(id);
  }
  const context = vm.createContext({
    document: { getElementById: element, querySelector: () => null, querySelectorAll: () => [],
      addEventListener() {}, createElement: () => ({ value: "", textContent: "" }) },
    window: { location: { protocol: "https:", hostname: "iskuggy.github.io" }, addEventListener() {} },
    localStorage: { setItem() {} }, URL, FormData, AbortController, setTimeout, clearTimeout, btoa, fetch
  });
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  // Load actual app declarations and event wiring without auto-login or DOM rendering.
  const startup = script.lastIndexOf("    configureServiceOptionsForDeployment();");
  vm.runInContext(script.slice(0, startup) + `
    globalThis.app = { state, fields, serviceModels, applyGenerationStats, getGenerationTotal, getModelPromptStrategy, callLocalProxy };
    fileToBase64 = async () => "${PNG}";
  `, context);
  return { app: context.app, elements };
}

test("browser offers OpenAI first, routes to its Worker endpoint and displays migrated success counts", async () => {
  const f = fixture();
  const { app, elements } = browserFixture(async (url, options) => f.worker.fetch(new Request(url, options), f.env));
  app.state.apiConfig.accessUsername = f.env.ACCESS_USERNAME;
  app.state.apiConfig.accessPassword = f.env.ACCESS_PASSWORD;
  app.state.referenceFile = { type: "image/png" };
  assert.equal(app.serviceModels["local-proxy"][0][0], OPENAI);
  assert.equal(app.serviceModels["gemini-direct"].some(([model]) => model === OPENAI), false);
  assert.ok(app.getModelPromptStrategy(OPENAI).join().includes("OpenAI"));
  assert.ok(!app.getModelPromptStrategy(OPENAI).join().includes("Nano Banana"));
  assert.equal(html.indexOf('data-model-count="gpt-image-2.5-sunburst"') < html.indexOf('data-model-count="gemini-3-pro-image-preview"'), true);
  app.applyGenerationStats(previousStats);
  assert.equal(elements.get("generationCountOpenAI").textContent, "0");
  assert.equal(app.getGenerationTotal(), 564);
  const image = await app.callLocalProxy({ ...app.state.apiConfig, model: OPENAI, prompt: "真实产品商业摄影无字底图" });
  assert.equal(image, `data:image/png;base64,${PNG}`);
  app.applyGenerationStats(app.state.pendingGenerationStats);
  assert.equal(elements.get("generationCountOpenAI").textContent, "1");
  assert.equal(elements.get("generationCountPro").textContent, "359");
  assert.equal(elements.get("generationCountFast").textContent, "205");
  assert.equal(elements.get("generationTotalCount").textContent, "565");
});
