# ChinaMNOs

运营商公开资费聚合与监控站：自动采集中国移动 / 中国联通 / 中国电信 / 中国广电官网公开资费与公告，提供变更对比、跳蚤市集（号卡交易）、工单支持与社区板块。原生 JavaScript 前端 + Cloudflare Workers 后端 + Python 采集端，全栈可自部署。

> 仅供学习研究使用。所有数据均来自运营商官方网站公开渠道，本站不保证数据实时性与准确性，不构成任何消费建议。

## 功能总览

- **资费中心**：四运营商官网公开资费自动采集（多线程 + 分级重试）、套餐变更对比（changelog）、运营商公告采集、Playwright 过盾回退
- **跳蚤市集**：配置驱动板块（求购/出让/出租/求租）、发布审核、在线沟通、车队板块、收藏/置顶
- **工单中心**：卡商担保人申请、站内工单沟通
- **工具宝库 / 情报酒馆 / 唠嗑聚落**：链接收录、活动攻略投稿（Markdown + 图床外链）、社群收录
- **公告与推广系统**：全站公告、模块级弹窗（可按 资费/跳蚤市集/工单/工具 模块作用域投放）、强制同意门控
- **用户体系**：注册登录（Argon2 思路密钥派生）、Turnstile 人机校验、邮箱验证 / 密码找回（Resend）
- **多线路容灾部署**：Cloudflare Pages / EdgeOne Pages / GitHub Pages 任意组合，`__ROUTES__` 线路清单注入 + 前端容灾守卫自动跳线
- **边缘缓存**：公开只读接口 Cache API 边缘缓存 + 公共配置快照静态化（`public-config.json`），降低 Worker 配额消耗

## 架构

```
┌─────────────┐     采集+部署      ┌──────────────────────┐
│ 采集端       │ ─────────────────▶ │ 静态站（前端+数据）    │
│ chinamnos.py │  CF Pages /        │ Cloudflare Pages      │
│ (青龙面板)   │  EdgeOne / GitHub  │ EdgeOne Pages (多线路) │
└─────────────┘                    └──────────┬───────────┘
                                              │ /api/*（自定义域）
                                   ┌──────────▼───────────┐
                                   │ Cloudflare Worker     │
                                   │ D1 (数据) + R2 (凭证)  │
                                   └──────────────────────┘
```

- **采集端** `chinamnos.py`：单文件 Python 脚本，适配青龙面板定时任务；负责资费/公告采集、变更对比、多线路存储编排、前端联合部署
- **后端** `worker/`：Cloudflare Worker（TypeScript），用户/帖子/工单/社区/公告 API，D1 数据库 + R2 附件存储
- **前端** `pages-dist/`：原生 JS SPA（无构建步骤），由采集端联合部署或从 GitHub 仓库拉取

## 目录结构

```
├── chinamnos.py            # 采集端（单文件）
├── worker/                 # Cloudflare Worker 后端
│   ├── src/                #   TypeScript 源码
│   ├── migrations/         #   D1 数据库迁移（0001→0030）
│   └── wrangler.toml.example  # 部署配置模板（复制为 wrangler.toml 填写）
├── pages-dist/             # 前端（原生 JS，无构建）
├── stats.schema.json 等    # 数据格式参考
└── serve.cjs               # 本地前端预览（端口 3000）
```

## 快速开始

### 1. 部署后端（Cloudflare Worker）

```bash
cd worker
npm install
cp wrangler.toml.example wrangler.toml   # 填入你的 D1/R2 资源 ID 与域名
npx wrangler d1 create <数据库名>          # 创建后把 id 填回 wrangler.toml
npx wrangler r2 bucket create <桶名>
npx wrangler d1 migrations apply <数据库名> --remote
npx wrangler secret put RESEND_API_KEY    # Resend 邮件 API Key
npx wrangler secret put CARDHUB_SECRET    # 32 字节随机十六进制（会话签名/联系方式加密）
npx wrangler secret put TURNSTILE_SECRET  # Cloudflare Turnstile 服务端密钥
npx wrangler deploy
```

### 2. 配置采集端

复制 `config.json` 模板（见下）填写，或使用青龙环境变量 `TARIFF_CONFIG` 注入完整 JSON：

```json
{
  "storage": {
    "primary": "cloudflare",
    "backends": {
      "cloudflare": {
        "enabled": true,
        "account_id": "...",
        "project_name": "chinamnos",
        "api_token": "...",
        "domain": "https://your-site.example.com"
      }
    },
    "frontend_source": {
      "mode": "github_prefer",
      "frontend_dir": "./pages-dist",
      "repo": "you/your-frontend-repo",
      "branch": "main",
      "subdir": "pages-dist"
    }
  },
  "carriers": { "cmcc": { "enabled": true }, "cucc": { "enabled": true }, "ctcc": { "enabled": true }, "cbn": { "enabled": true } }
}
```

Python 依赖：`requests`、`pycryptodome`（可选：`playwright-chromium`，用于电信公告过盾回退）。青龙面板用户通过面板 UI 安装依赖即可。

### 3. 前端

前端随采集端**联合部署**：每次采集把 `frontend_source.frontend_dir` 目录下的文件一并推送到各线路，全量替换。

前端文件来源（`storage.frontend_source.mode`）四档：

| 模式 | 行为 |
|---|---|
| `github_prefer`（默认） | 每次部署前从 GitHub 仓库拉取最新前端，失败回落本地目录 |
| `local_only` | 只读本地目录，不做拉取 |
| `local_prefer` | 本地目录有内容用本地，为空才拉取 |
| `github_only` | 必须拉取成功，失败则本轮前端部署报错 |

即：把 `pages-dist/` 推到你自己的 GitHub 仓库，青龙端不再需要手动同步前端文件；`index.html` 中的 `__ROUTES__` 占位符由采集端部署时注入线路清单，保持原样提交即可。

## 本地开发

```bash
node serve.cjs        # 前端预览：http://localhost:3000（no-cache，改动即刷新）
cd worker && npm run dev   # Worker 本地调试（wrangler dev）
```

## 配置说明

采集端完整配置通过 `config.json`（或环境变量 `TARIFF_CONFIG`）注入，主要分段：

- `storage`：多线路存储编排（primary + backends 任意组合启用）、前端文件来源（`frontend_source`）、本地缓存 / 部署清单缓存
- `crawl`：分页模式、重试（指数退避 + 抖动）、分类/翻页间隔、UA 池
- `carriers.<key>`：各运营商开关、采集分类、公告采集、省份并发度覆盖、波动阈值、通知范围
- `announce`：运营商公告采集（可独立于资费单独启用）
- `schedule` / `notification`：cron 展示值与变更通知开关

各线路必填项、Turnstile 白名单（需包含所有启用线路的域名）等细节参见 `worker/wrangler.toml.example` 内注释与配置页字段提示。

## 免责声明

1. 本项目采集的数据均来自运营商官方网站公开渠道，仅作信息聚合展示，请以运营商官方渠道为准
2. 采集行为仅限低频请求并遵循公开页面访问规则；请使用者自行评估并承担使用本项目带来的风险
3. 跳蚤市集等社区板块内容由用户发布，站点部署者应履行审核义务，本项目作者不对用户发布内容负责
4. 请勿将本项目用于任何违反法律法规或运营商服务条款的用途

## License

[MIT](LICENSE)
