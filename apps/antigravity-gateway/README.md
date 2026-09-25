# Unified Local LLM Gateway (formerly antigravity-gateway)

本地统一多 Provider 智能代理与路由网关，支持聚合纳管 **Codex/ChatGPT OAuth 订阅、OpenAI API、Anthropic API、Super Relay、CPA、sub2api、Google Antigravity OAuth**，并提供双向协议转译（Anthropic Messages API ↔ OpenAI Responses API ↔ OpenAI Chat Completions API ↔ Gemini API）。

本地启动后，**Claude Code** 和 **Codex** 可以直接接入该网关，在同一个客户端内同时、自由调用不同 Upstream 的任意模型（例如：Codex 主模型走官方 GPT-5.6，Subagent 模型走 Super Relay 派发）。

---

## 核心特性

1. **官方模型自动拉取发现**：官方 Provider（OpenAI / Anthropic）支持 `autoDiscoverModels: true`，异步自动拉取上游最新发布的可用模型并定期缓存刷新，无需手动维护。
2. **私有/非官方模型精确手动配置**：Super Relay、CPA、sub2api 等渠道支持在配置文件中手动显式声明模型列表、别名（Alias）以及前缀路由规则（如 `cpa/*`, `relay/*`, `sub/*`）。
3. **统一模型清单（`/v1/models`）**：合并所有配置渠道的可用模型，供客户端自由获取与展示。
4. **全协议跨端双向互转与直通（Passthrough）**：
   - **Codex (OpenAI Responses 协议)** 访问 **Codex/ChatGPT OAuth 订阅**时，保留 Responses、Responses-Lite、订阅模型列表和 Codex 请求头。
   - **Claude Code (Anthropic Messages 协议)** 访问 **Codex/ChatGPT OAuth 订阅**时，自动完成 Messages ↔ Responses 与 SSE 双向转译。
   - **Codex (OpenAI 协议)** 访问 **Super Relay / CPA (Anthropic 协议)** 时，自动进行双向协议与流式 SSE 转译。
   - 普通 `openai` Provider 明确表示 OpenAI API Key 计费渠道，不再冒充 ChatGPT/Codex 订阅。
5. **极轻量、零外部重型依赖**：纯 TypeScript 原生驱动，毫秒级启动，极低内存开销。

---

## 快速上手

```sh
pnpm install
cp config.example.json config.json  # 根据实际情况填写你的凭据与渠道
pnpm dev:antigravity-gateway        # 启动网关服务 (默认监听 http://127.0.0.1:51120)
```

网关也支持后台生命周期管理：

```sh
pnpm gateway:start                  # 后台启动并等待 /healthz
pnpm gateway:status                 # 查看 PID、健康状态和日志路径
pnpm gateway:logs                   # 查看最近日志
pnpm gateway:stop                   # 优雅停止
pnpm gateway:restart                # 重启
```

项目内等价命令是 `pnpm --dir apps/antigravity-gateway gateway <start|stop|restart|status|logs>`；`pnpm dev:gateway` 仍是前台开发模式。后台运行时的 PID 和日志位于被 Git 忽略的 `apps/antigravity-gateway/.runtime/`。

安装全局命令后，可以从任意目录控制同一个后台网关：

```sh
pcpa start
pcpa status
pcpa logs --lines 100
pcpa restart
pcpa stop
```

全局命令支持网关生命周期和模型配置管理；Provider 凭据仍由本项目被忽略的 `.local/credentials/` 管理。

```sh
pcpa models list
pcpa models add alwaysday1_max --provider super-relay
pcpa models add my-model --provider super-relay --target alwaysday1_max
pcpa models remove my-model
pcpa restart
```

`models list` 展示磁盘配置中的模型、provider、上游名称、前缀规则和禁用名称，不代表正在运行的进程配置，也不包含全部自动发现的模型。新增必须指定已有 provider（列表会展示 ID）；不指定 `--target` 时模型名称原样传到上游。重复新增会更新该名称的精确路由。

删除会清除该名称的静态声明和精确路由，并加入 `disabledModels`，防止自动发现、前缀路由或单 provider 回退重新启用它。禁用只针对客户端请求名称，不会删除其他名称的别名。再次新增会解除禁用。修改以权限 0600 原子写回 `config.json`，保留其他配置；命令不会自动重启，执行 `pcpa restart` 后生效。

运行验证测试套件：

```sh
pnpm verify:antigravity-gateway     # 自动化测试 + 类型检查 + 冒烟验证
```

---

## 配置说明（`config.json`）

在 `config.json` 中声明你的 Providers 和 Routes：

```json
{
  "port": 51120,
  "host": "127.0.0.1",
  "apiKeys": [],
  "providers": {
    // 1. Codex/ChatGPT 官方订阅（读取本机 Codex OAuth，不填写 API Key）
    "codex-subscription": {
      "type": "codex-oauth",
      "baseUrl": "https://chatgpt.com/backend-api/codex",
      "authFile": "~/.codex/auth.json",
      "clientVersion": "0.147.0",
      "originator": "codex_cli_rs",
      "autoDiscoverModels": true,
      "modelRefreshIntervalMs": 3600000
    },

    // 2. OpenAI API（独立的 API Key 计费渠道）
    "openai-api": {
      "type": "openai",
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "sk-proj-xxxxxx",
      "autoDiscoverModels": true,
      "modelRefreshIntervalMs": 3600000
    },

    // 3. Anthropic API
    "official-anthropic": {
      "type": "anthropic",
      "baseUrl": "https://api.anthropic.com",
      "apiKey": "sk-ant-xxxxxx",
      "autoDiscoverModels": true
    },

    // 4. Super Relay（手动精确声明模型）
    "super-relay": {
      "type": "anthropic",
      "baseUrl": "https://super-relay.byted.org",
      "apiKey": "plat_xxxxxxxxxxxxxxxxxxxx",
      "models": [
        "model_api/experimental_0812_256k",
        "model_api/experimental_0812",
        "model_hub/es1_orange_o48",
        "auto_model/alwaysday1"
      ]
    },

    // 5. CPA 逆向/内部中转源
    "cpa": {
      "type": "anthropic",
      "baseUrl": "https://cpa.mjclouds.com",
      "apiKeyFile": "/path/to/latam-c/.claude/cpa-token",
      "autoDiscoverModels": true,
      "models": [
        "gemini-3.7-flash-high",
        "gemini-3-flash"
      ]
    },

    // 6. sub2api 聚合订阅
    "sub2api": {
      "type": "openai",
      "baseUrl": "https://sub2api.example.com/v1",
      "apiKey": "sk-sub2api-token",
      "models": [
        "deepseek-chat",
        "deepseek-reasoner"
      ]
    },

    // 7. Google Antigravity OAuth (Gemini 凭据池)
    "antigravity-oauth": {
      "type": "google-oauth",
      "authDir": "./auth"
    }
  },
  "routes": [
    { "match": "claude-sonnet-4-6", "provider": "codex-subscription", "targetModel": "gpt-5.6-sol" },
    { "match": ["gemini-3.7-flash-high", "gemini-3-flash"], "provider": "cpa" },
    { "modelPrefix": "gemini-", "provider": "cpa" },
    { "modelPrefix": "cpa/", "provider": "cpa", "stripPrefix": true },
    { "modelPrefix": "relay/", "provider": "super-relay", "stripPrefix": true },
    { "modelPrefix": "sub/", "provider": "sub2api", "stripPrefix": true }
  ]
}
```

### 路由解析顺序

网关按以下顺序解析请求中的模型名，命中即停：

1. `routes` 显式规则（`match` 精确匹配，`modelPrefix` 前缀匹配）
2. Provider 的 `models` 静态声明列表
3. Gemini 模型目录（仅当配置了 `google-oauth` Provider）
4. Provider 的 `autoDiscoverModels` 上游发现结果（精确匹配 ID）
5. 仅配置了单个 Provider 时，直接使用该 Provider

**没有兜底 Provider。** 全部未命中时网关返回 `404 no upstream provider configured for model 'X'`，不会把请求转发给任意一个 Provider。这是有意的设计：若静默转发，上游会拒绝一个本不该由它服务的模型，其报错会指向错误的 Provider（例如 ChatGPT 后端返回 `The 'gemini-3.8-flash-high' model is not supported when using Codex with a ChatGPT account.`），从而掩盖「缺少路由」这一真实原因。

因此，新增上游模型时应在 `routes` 或 Provider 的 `models` 中登记。对于版本号会持续演进的模型族（如 `gemini-3.8` / `gemini-3.9`），建议直接配置前缀规则（如 `{ "modelPrefix": "gemini-", "provider": "cpa" }`）而不是逐个枚举——尤其在上游 `/v1/models` 返回混淆 ID 时，自动发现无法用于匹配。

`anthropic` Provider 支持 `apiKeyFile`；它会在每次请求时读取文件内容并仅以内存 Header 转发。建议将 CPA/Relay token 副本放在当前项目的 `.local/credentials/`（目录已忽略且文件权限应为 `0600`），不要把 token 写进 `config.json` 或提交到仓库。GPT 官方订阅仍单独读取 `~/.codex/auth.json`。

Google Antigravity 登录或凭据刷新时才会读取 OAuth client 配置。任选一种方式提供完整的一对值；不要提交真实值：

```sh
export GOOGLE_OAUTH_CLIENT_ID='<google-oauth-client-id>'
export GOOGLE_OAUTH_CLIENT_SECRET='<google-oauth-client-secret>'
```

也可以设置 `PINGU_GOOGLE_OAUTH_CLIENT_FILE=/absolute/path/to/google-oauth-client.json`，文件内容为：

```json
{
  "clientId": "<google-oauth-client-id>",
  "clientSecret": "<google-oauth-client-secret>"
}
```

未设置上述环境变量时，默认读取 package 根目录下被 Git 忽略的 `.local/google-oauth-client.json`。建议将私有文件权限设为 `0600`。只设置一项环境变量、文件缺失或内容无效时，Google OAuth 操作会返回不包含凭据内容的配置错误；其他 Provider 的启动、健康检查和模型列表不依赖该文件。

### `geminiSchemaConstraints`：Gemini 后端的工具 schema 清理

部分 `anthropic` Provider 说 Anthropic 协议，但后端实际是 Gemini（例如 CPA 的 `gemini-*`）。Gemini 对工具 schema 的校验比 Anthropic 严格，会拒绝 Anthropic 能接受的写法，典型症状：

```
400 GenerateContentRequest.tools[0].function_declarations[1]
    .parameters.properties[query].properties[where].items.items: missing field.
```

原因是 Gemini 没有元组概念、且要求每个 `array` 都必须带 `items`，而 JSON Schema 2020-12 的 `prefixItems`（元组语法，Claude Code 的 `Artifact` 等工具会用）只有 `prefixItems` 没有 `items`。

给这类 Provider 加上 `"geminiSchemaConstraints": true`，网关就会在转发前对 `tools[].input_schema` 跑 `sanitizeSchema`（与 `google-oauth` 路径同一套清理链），把 `prefixItems` 折叠成 `items` 并把元组形状写进 `description` 供模型参考：

```json
"cpa": {
  "type": "anthropic",
  "baseUrl": "https://cpa.mjclouds.com",
  "geminiSchemaConstraints": true
}
```

**真正的 Anthropic 上游不要开这个开关**（默认关闭）。Claude 后端原生接受 `prefixItems` 等完整 schema，开启清理只会无谓地降级类型信息。

---

## 客户端接入指南

### 1. Codex 接入配置

让 Codex 的 Responses 请求统一指向本地网关。Codex CLI 的 ChatGPT 登录模式需要显式声明一个本地 Responses Provider；不要设置 `OPENAI_API_KEY`，网关会从 `~/.codex/auth.json` 读取并刷新 ChatGPT OAuth：

```sh
codex exec \
  -c 'model_provider="local-subscription-gateway"' \
  -c 'model_providers.local-subscription-gateway.name="local-subscription-gateway"' \
  -c 'model_providers.local-subscription-gateway.base_url="http://127.0.0.1:51120/v1"' \
  -c 'model_providers.local-subscription-gateway.wire_api="responses"' \
  -c 'model_providers.local-subscription-gateway.requires_openai_auth=true' \
  --model gpt-5.6-sol
```

其他 OpenAI-compatible 客户端仍可使用 `OPENAI_BASE_URL=http://127.0.0.1:51120/v1`；这只改变请求入口，不会把 ChatGPT 订阅变成 OpenAI API Key 计费。

示例配置默认只监听 `127.0.0.1` 且不要求网关层 API Key；若改为对外监听，必须设置 `apiKeys` 并通过客户端的独立本地鉴权 Header 接入，不能把 Codex OAuth token 当作网关 API Key。

**多模型协同实战**：
- **主会话模型**：指定 `/models` 返回的 `gpt-5.6-sol`、`gpt-5.6-terra` 或 `gpt-5.6-luna`（直接使用 Codex/ChatGPT OAuth 订阅）。
- **Subagent / Worker 派发模型**：指定 `model_api/experimental_0812_256k`（自动路由到 Super Relay，网关将 Codex Responses 请求转译为 Anthropic Messages）。
- **随时探索其他模型**：在模型名中输入 `cpa/claude-3-7-sonnet`、`gemini-3.7-flash-high` 或 `sub/deepseek-chat`。

### 2. Claude Code 接入配置

运行 Claude Code 前指定环境变量：

```sh
export ANTHROPIC_BASE_URL=http://127.0.0.1:51120
export ANTHROPIC_API_KEY=dev-local-key
```

Claude Code 即可直接使用：
- `model_api/experimental_0812_256k`（直通 Super Relay，原生支持 Prompt Caching 与 Thinking）
- `gemini-3.7-flash-high` / `gemini-3-flash`（按示例配置走 Gemini CPA）
- `gpt-5.6-sol` / `gpt-5.6-terra`（走 Codex OAuth/Responses 转换）
- `cpa/claude-3-7-sonnet`（走 CPA 前缀路由）
- `cpa/gemini-3.7-flash-high`（走 CPA 前缀路由）

使用项目 launcher 时可保留其 OAuth/CPA 认证链路，仅临时覆盖地址到本地网关：

```sh
CPA_BASE_URL=http://127.0.0.1:51120 \
  /path/to/latam-c/.claude/claude-cpa --model gemini-3.7-flash-high -p 'hello'
```
