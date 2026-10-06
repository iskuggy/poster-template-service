# JUXIA DESIGN LAB 内部部署说明

## 架构

- GitHub Pages：只托管 `index.html` 静态页面。
- Cloudflare Worker：代理 OpenAI / Gemini / DeepSeek 请求，隐藏 API Key，并用内部账号密码保护接口。
- Worker 会把出图请求串行执行；多人同时点生成时，后来的请求会在 Worker 里等待前一个完成。

> 注意：GitHub Pages 静态页面本身无法真正加密。安全边界在 Cloudflare Worker：没有账号密码的人即使打开页面，也不能调用出图接口。

## 部署 Worker

复制示例配置：

```bash
cp wrangler.example.toml wrangler.toml
```

设置密钥：

```bash
wrangler secret put GEMINI_API_KEY
wrangler secret put OPENAI_API_KEY
wrangler secret put DEEPSEEK_API_KEY
wrangler secret put ACCESS_USERNAME
wrangler secret put ACCESS_PASSWORD
```

部署：

```bash
wrangler deploy
```

部署后会得到类似：

```text
https://juxia-poster-api.<your-subdomain>.workers.dev
```

当前部署地址：

```text
https://juxia-poster-api.skuggy3860.workers.dev
```

前端设置里填写：

```text
Cloudflare Worker 出图接口：
https://juxia-poster-api.skuggy3860.workers.dev/api/gemini-image
```

访问账号和密码填写 Worker secret 里的 `ACCESS_USERNAME` / `ACCESS_PASSWORD`。

## GPT Image 2.5

- 默认生成模型为 `GPT Image 2.5`，官方模型 ID 为 `gpt-image-2.5-sunburst`；浏览器已保存的模型选择仍优先使用。
- 通过同一个 Worker 的 `/api/openai-image` 接口调用 OpenAI `/v1/images/edits`，携带产品参考图；密钥只存储在 Worker 的 `OPENAI_API_KEY` secret 中。
- 固定每次生成一张 PNG，质量为 `high`；仅在 OpenAI 成功返回图片后累计一次。失败、空响应和缺少密钥不计数，不自动重试付费出图请求。
- 复用现有 `generation-stats:v1` KV 记录，保留两个 Nano Banana 模型的历史次数，新增 OpenAI 计数默认为 0，总次数包含三个模型。
- OpenAI 要求生成尺寸为 16 的倍数，Worker 按相同比例选择有效尺寸（3:4 为 1056×1408、高清 3:4 为 1248×1664、4:5 为 1088×1360、1:1 为 1088×1088、4:3 为 1408×1056），下载仍使用用户选择的最终尺寸。
- 更新顺序：配置 `OPENAI_API_KEY`，验证真实参考图出图，再部署 Worker，最后发布 GitHub Pages。已有浏览器保存的模型选择保持不变。

本地回归检查：`node --test tests/*.test.mjs`。

本地密钥放在 `.dev.vars` 中：

```dotenv
OPENAI_API_KEY="你的 OpenAI API Key"
```

`.dev.vars` 和 `.env` 文件已忽略提交，本地预览服务只监听 `127.0.0.1`，并阻止访问隐藏文件（包括密钥文件和 `.git`）。可以用 `wrangler secret bulk .dev.vars` 把本地密钥配置到 Worker。

## 发布到 GitHub Pages

把 `index.html` 推到 GitHub 仓库，并在仓库设置里开启 Pages。

建议 `wrangler.toml` 不提交真实密钥；密钥只能用 `wrangler secret put` 写入 Cloudflare。

## 安全建议

- `ACCESS_PASSWORD` 用长随机密码，不要用简单口令。
- Cloudflare Worker 的 `ALLOWED_ORIGIN` 建议改成你的 GitHub Pages 域名。
- 不要再把 Gemini / DeepSeek API Key 写进 `index.html`。
- 如果后续使用人数变多，把当前内存串行队列升级为 Durable Object 或 Cloudflare Queue。
