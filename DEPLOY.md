# JUXIA DESIGN LAB 内部部署说明

## 架构

- GitHub Pages：只托管 `index.html` 静态页面。
- Cloudflare Worker：代理 Gemini / DeepSeek 请求，隐藏 API Key，并用内部账号密码保护接口。
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

## 发布到 GitHub Pages

把 `index.html` 推到 GitHub 仓库，并在仓库设置里开启 Pages。

建议 `wrangler.toml` 不提交真实密钥；密钥只能用 `wrangler secret put` 写入 Cloudflare。

## 安全建议

- `ACCESS_PASSWORD` 用长随机密码，不要用简单口令。
- Cloudflare Worker 的 `ALLOWED_ORIGIN` 建议改成你的 GitHub Pages 域名。
- 不要再把 Gemini / DeepSeek API Key 写进 `index.html`。
- 如果后续使用人数变多，把当前内存串行队列升级为 Durable Object 或 Cloudflare Queue。
