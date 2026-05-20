# Codex2API 使用文档

> 基础地址：`http://10.14.0.113:8888`
> 默认认证：`Authorization: Bearer <api-key>`

---

## 1. 快速接入

挑选你常用的 AI 客户端，复制配置或一键唤起：

- **Claude Code** (CLI) — 官方 Anthropic CLI，配置环境变量即可接入。

  ```bash
  export ANTHROPIC_BASE_URL="http://10.14.0.113:8888"
  export ANTHROPIC_AUTH_TOKEN="<API_KEY>"
  export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
  ```

````

- **CC Switch** (Desktop) — Claude Code 多账号切换器，一键唤起并写入配置。

  `ccswitch://v1/import?resource=provider&app=claude&name=Codex2API+Claude&endpoint=http%3A%2F%2F10.14.0.113%3A8888&apiKey=<API_KEY>&model=claude-sonnet-4-5-20250514&homepage=http%3A%2F%2F10.14.0.113%3A8888&enabled=true`

- **Codex CLI** (CLI) — 官方 OpenAI Responses CLI，写入 config.toml 即可。

  ```toml
model_provider = "OpenAI"
model = "gpt-5.5"
review_model = "gpt-5.5"
model_reasoning_effort = "xhigh"
disable_response_storage = true
network_access = "enabled"
model_context_window = 1000000
model_auto_compact_token_limit = 900000

[model_providers.OpenAI]
name = "OpenAI"
base_url = "http://10.14.0.113:8888"
wire_api = "responses"
requires_openai_auth = true
````

- **Cherry Studio** (Desktop) — 点击按钮唤起桌面应用并自动导入 OpenAI 凭据。

  `cherrystudio://providers/api-keys?v=1&data=eyJpZCI6ImNvZGV4MmFwaSIsImJhc2VVcmwiOiJodHRwOi8vMTAuMTQuMC4xMTM6ODg4OCIsImFwaUtleSI6InNrLTQ3N2RlMGFkYTE2YjVhZjAzNmUyZGQ0NGQ2YTQyYjAzMTAwOTRiMjYwNzI2NTRlZiJ9`

- **Lobe Chat** (Web) — 在浏览器中打开 Lobe Chat 并预填 OpenAI 设置。

  `https://chat-preview.lobehub.com/?settings={"keyVaults":{"openai":{"apiKey":"<API_KEY>","baseURL":"http%3A%2F%2F10.14.0.113%3A8888/v1"}}}`

- **OpenCat** (Mobile) — 唤起 iOS / macOS 客户端并加入服务器配置。

  `opencat://team/join?domain=http%3A%2F%2F10.14.0.113%3A8888&token=<API_KEY>`

### cURL 快速验证

```bash
curl -X POST http://10.14.0.113:8888/v1/responses \
  -H "Authorization: Bearer <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.5","input":[{"role":"user","content":[{"type":"input_text","text":"Hello"}]}]}'
```

---

## 2. 客户端配置

### Codex CLI

写入 `~/.codex/config.toml`：

```toml
model_provider = "OpenAI"
model = "gpt-5.5"

[model_providers.OpenAI]
name = "OpenAI"
base_url = "http://10.14.0.113:8888"
wire_api = "responses"
requires_openai_auth = true
```

`~/.codex/auth.json`：

```json
{ "OPENAI_API_KEY": "<API_KEY>" }
```

### Claude Code

环境变量（`~/.bashrc` / `~/.zshrc`）：

```bash
export ANTHROPIC_BASE_URL="http://10.14.0.113:8888"
export ANTHROPIC_AUTH_TOKEN="<API_KEY>"
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
```

或 `~/.claude/settings.json`：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://10.14.0.113:8888",
    "ANTHROPIC_AUTH_TOKEN": "<API_KEY>",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
  }
}
```

---

## 3. 认证方式

所有端点（除 `/health` 外）需要密钥，按以下任一方式传入：

- `Authorization: Bearer <key>` — 标准方式（推荐）
- `x-api-key: <key>` — Anthropic SDK 默认
- `anthropic-auth-token: <key>` — 备用兼容

管理接口需要 `X-Admin-Key: <admin_secret>`。

---

## 4. 模型 API

### POST /v1/responses — 创建 Responses 响应

Codex Responses API 原生端点，支持流式响应，直接转发到上游服务。

```bash
curl --request POST \
  --url http://10.14.0.113:8888/v1/responses \
  --header 'Authorization: Bearer <token>' \
  --header 'Content-Type: application/json' \
  --data '{
  "model": "gpt-5.5",
  "input": [
    {"role": "user", "content": [{"type": "input_text", "text": "Hello, what can you do?"}]}
  ],
  "stream": true,
  "reasoning": {"effort": "high"}
}'
```

**200**

```json
{
  "id": "resp_abc123",
  "object": "response",
  "model": "gpt-5.5",
  "status": "completed",
  "output": [
    {
      "type": "message",
      "role": "assistant",
      "content": [{ "type": "output_text", "text": "Hello!" }]
    }
  ],
  "usage": { "input_tokens": 12, "output_tokens": 45, "total_tokens": 57 }
}
```

**400**

```json
{
  "error": {
    "code": "invalid_request",
    "message": "model is required",
    "type": "invalid_request_error"
  }
}
```

**401**

```json
{
  "error": {
    "code": "invalid_api_key",
    "message": "Invalid API key provided",
    "type": "authentication_error"
  }
}
```

**503**

```json
{
  "error": {
    "message": "无可用账号，请稍后重试",
    "type": "server_error",
    "code": "no_available_account"
  }
}
```

**429**

```json
{
  "error": {
    "message": "Rate limit exceeded",
    "type": "server_error",
    "code": "account_pool_usage_limit_reached",
    "resets_in_seconds": 18000
  }
}
```

### POST /v1/chat/completions — 创建 Chat Completions 响应

OpenAI Chat Completions 兼容端点，会在 OpenAI 与 Codex Responses 格式之间自动转换。

```bash
curl --request POST \
  --url http://10.14.0.113:8888/v1/chat/completions \
  --header 'Authorization: Bearer <token>' \
  --header 'Content-Type: application/json' \
  --data '{
  "model": "gpt-5.5",
  "messages": [
    {"role": "system", "content": "You are a helpful assistant."},
    {"role": "user", "content": "Hello!"}
  ],
  "stream": true,
  "reasoning_effort": "high"
}'
```

**200**

```json
{
  "id": "chatcmpl-abc123",
  "object": "chat.completion",
  "model": "gpt-5.5",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Hello! How can I help you today?"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": { "prompt_tokens": 18, "completion_tokens": 9, "total_tokens": 27 }
}
```

**400**

```json
{
  "error": {
    "code": "invalid_request",
    "message": "Request validation failed",
    "type": "invalid_request_error"
  }
}
```

**401**

```json
{
  "error": {
    "code": "invalid_api_key",
    "message": "Invalid API key provided",
    "type": "authentication_error"
  }
}
```

### POST /v1/messages — 创建 Messages 响应

Anthropic Messages API 兼容端点，会在 Claude 与 Codex Responses 格式之间自动转换，模型名按系统设置映射。

```bash
curl --request POST \
  --url http://10.14.0.113:8888/v1/messages \
  --header 'x-api-key: <token>' \
  --header 'Content-Type: application/json' \
  --header 'anthropic-version: 2023-06-01' \
  --data '{
  "model": "claude-sonnet-4-5-20250514",
  "max_tokens": 1024,
  "messages": [{"role": "user", "content": "Hello, Claude!"}]
}'
```

**200**

```json
{
  "id": "msg_abc123",
  "type": "message",
  "role": "assistant",
  "model": "claude-sonnet-4-5-20250514",
  "content": [{ "type": "text", "text": "Hello! How can I assist you today?" }],
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": {
    "input_tokens": 10,
    "output_tokens": 12,
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 0
  }
}
```

**400**

```json
{
  "type": "error",
  "error": { "type": "invalid_request_error", "message": "model is required" }
}
```

**401**

```json
{
  "type": "error",
  "error": { "type": "authentication_error", "message": "Invalid API key" }
}
```

**429**

```json
{
  "type": "error",
  "error": {
    "type": "rate_limit_error",
    "message": "All accounts rate limited"
  }
}
```

### POST /v1/images/generations — 生成图片

OpenAI Images 兼容端点，底层使用 Codex Responses 的 image_generation 能力。

```bash
curl --request POST \
  --url http://10.14.0.113:8888/v1/images/generations \
  --header 'Authorization: Bearer <token>' \
  --header 'Content-Type: application/json' \
  --data '{
  "model": "gpt-image-2",
  "prompt": "Draw a small orange cat",
  "response_format": "b64_json"
}'
```

**200**

```json
{
  "created": 1710000000,
  "model": "gpt-image-2",
  "data": [{ "b64_json": "..." }],
  "usage": { "images": 1 }
}
```

### POST /v1/images/edits — 编辑图片

OpenAI Images 编辑兼容端点，支持 JSON image_url 和 multipart 文件上传。

```bash
curl --request POST \
  --url http://10.14.0.113:8888/v1/images/edits \
  --header 'Authorization: Bearer <token>' \
  --header 'Content-Type: application/json' \
  --data '{
  "model": "gpt-image-2",
  "prompt": "Replace the background with aurora lights",
  "images": [{"image_url": "https://example.com/source.png"}]
}'
```

**200**

```json
{
  "created": 1710000000,
  "model": "gpt-image-2",
  "data": [{ "b64_json": "..." }]
}
```

### GET /v1/models — 列出模型

列出当前代理对外暴露的可用模型。

```bash
curl --request GET \
  --url http://10.14.0.113:8888/v1/models \
  --header 'Authorization: Bearer <token>'
```

**200**

```json
{
  "object": "list",
  "data": [
    { "id": "gpt-5.5", "object": "model", "owned_by": "openai" },
    { "id": "gpt-5.5", "object": "model", "owned_by": "openai" },
    { "id": "gpt-5.4-mini", "object": "model", "owned_by": "openai" },
    { "id": "gpt-5.3-codex", "object": "model", "owned_by": "openai" },
    { "id": "gpt-5.3-codex-spark", "object": "model", "owned_by": "openai" },
    { "id": "gpt-5.2", "object": "model", "owned_by": "openai" },
    { "id": "gpt-image-2", "object": "model", "owned_by": "openai" }
  ]
}
```

**401**

```json
{
  "error": {
    "code": "invalid_api_key",
    "message": "Invalid API key provided",
    "type": "authentication_error"
  }
}
```

### GET /health — 健康检查

查看服务状态和可用账号数量；该端点不需要认证。

```bash
curl --request GET \
  --url http://10.14.0.113:8888/health
```

**200**

```json
{
  "status": "ok",
  "available": 5,
  "total": 8
}
```

---

## 5. 账号管理 API

> 所有管理接口需要 `X-Admin-Key` 请求头。

### POST /api/admin/accounts — 添加账号（Refresh Token）

通过 Refresh Token 添加账号，系统会自动刷新 Access Token 并加入号池。

```bash
curl --request POST \
  --url http://10.14.0.113:8888/api/admin/accounts \
  --header 'X-Admin-Key: <admin_secret>' \
  --header 'Content-Type: application/json' \
  --data '{
  "name": "my-account",
  "refresh_token": "rt_XPqsKO3Ld...\nrt_H2qdhY",
  "proxy_url": ""
}'
```

**200**

```json
{
  "message": "成功添加 1 个账号",
  "success": 1,
  "failed": 0
}
```

**400**

```json
{ "error": "refresh_token 是必填字段" }
```

**401**

```json
{ "error": "Unauthorized" }
```

### POST /api/admin/accounts/at — 添加账号（Access Token）

添加 AT-only 账号；access_token 字段支持用换行分隔多个 Token。

```bash
curl --request POST \
  --url http://10.14.0.113:8888/api/admin/accounts/at \
  --header 'X-Admin-Key: <admin_secret>' \
  --header 'Content-Type: application/json' \
  --data '{
  "name": "at-account",
  "access_token": "eyJhbGciOi...",
  "proxy_url": ""
}'
```

**200**

```json
{
  "message": "成功添加 1 个 AT-only 账号",
  "success": 1,
  "failed": 0
}
```

**400**

```json
{ "error": "access_token 是必填字段" }
```

### POST /api/admin/accounts/import — 文件批量导入账号

通过文件批量导入账号，支持 txt、CLIProxyAPI 导出的 json、以及每行一个 AT 的 at_txt，文件最大 20MB。

```bash
# TXT — one Refresh Token per line
curl --request POST \
  --url http://10.14.0.113:8888/api/admin/accounts/import \
  --header 'X-Admin-Key: <admin_secret>' \
  --form 'file=@tokens.txt' \
  --form 'format=txt' \
  --form 'proxy_url='

# JSON — CLIProxyAPI credential export
curl --request POST \
  --url http://10.14.0.113:8888/api/admin/accounts/import \
  --header 'X-Admin-Key: <admin_secret>' \
  --form 'file=@credentials.json' \
  --form 'format=json' \
  --form 'proxy_url='

# AT TXT — one Access Token per line
curl --request POST \
  --url http://10.14.0.113:8888/api/admin/accounts/import \
  --header 'X-Admin-Key: <admin_secret>' \
  --form 'file=@access_tokens.txt' \
  --form 'format=at_txt' \
  --form 'proxy_url='
```

**200**

```json
{
  "message": "导入完成：成功 5，失败 0，重复 2",
  "total": 7,
  "success": 5,
  "failed": 0,
  "duplicate": 2
}
```

**400**

```json
{ "error": "请上传文件（字段名: file）" }
```

### DELETE /api/admin/accounts/:id — 删除账号

按账号 ID 删除账号，并从可用号池中移除。

```bash
curl --request DELETE \
  --url http://10.14.0.113:8888/api/admin/accounts/1 \
  --header 'X-Admin-Key: <admin_secret>'
```

**200**

```json
{ "message": "账号已删除" }
```

**404**

```json
{ "error": "账号不存在" }
```

### GET /api/admin/accounts — 列出账号

列出所有账号的状态、用量、标签、账号分组和基础元数据。

```bash
curl --request GET \
  --url http://10.14.0.113:8888/api/admin/accounts \
  --header 'X-Admin-Key: <admin_secret>'
```

**200**

```json
{
  "accounts": [
    {
      "id": 1,
      "name": "my-account",
      "email": "user@example.com",
      "plan_type": "team",
      "status": "active",
      "proxy_url": "",
      "tags": ["team"],
      "group_ids": [1],
      "allowed_api_key_ids": [],
      "created_at": "2025-01-01T00:00:00Z",
      "total_requests": 128,
      "success_requests": 125
    }
  ]
}
```

### PATCH /api/admin/accounts/:id/scheduler — 更新账号调度配置

更新账号代理、标签、账号分组、并发/评分覆盖和 API Key 反向授权。字段省略时保持原值；allowed_api_key_ids 传 null 或空数组表示不限制 API Key。

```bash
curl --request PATCH \
  --url http://10.14.0.113:8888/api/admin/accounts/1/scheduler \
  --header 'X-Admin-Key: <admin_secret>' \
  --header 'Content-Type: application/json' \
  --data '{
  "tags": ["team", "paid"],
  "group_ids": [1, 2],
  "allowed_api_key_ids": []
}'
```

**200**

```json
{ "message": "账号调度配置已更新" }
```

**400**

```json
{ "error": "allowed_api_key_ids 包含不存在的 API Key ID: 99" }
```

**404**

```json
{ "error": "账号不存在" }
```

### GET /api/admin/keys — 列出 API 密钥

列出后台创建的下游调用密钥，包含额度、用量、过期时间、状态和允许账号分组。该接口会在 raw_key 返回完整密钥，只能在受信任后台使用。

```bash
curl --request GET \
  --url http://10.14.0.113:8888/api/admin/keys \
  --header 'X-Admin-Key: <admin_secret>'
```

**200**

```json
{
  "keys": [
    {
      "id": 1,
      "name": "Claude Code",
      "key": "sk-****...abcd",
      "raw_key": "sk-live-full-key",
      "quota_limit": 10,
      "quota_used": 1.25,
      "expires_at": "2026-06-01T00:00:00Z",
      "allowed_group_ids": [1],
      "status": "active",
      "created_at": "2026-05-13T00:00:00Z"
    }
  ]
}
```

### POST /api/admin/keys — 创建 API 密钥

创建下游客户端使用的 API Key。key 可省略由系统生成；quota_limit 为 0 或省略表示不限额；allowed_group_ids 为空表示可调度全部账号分组。

```bash
curl --request POST \
  --url http://10.14.0.113:8888/api/admin/keys \
  --header 'X-Admin-Key: <admin_secret>' \
  --header 'Content-Type: application/json' \
  --data '{
  "name": "Claude Code",
  "quota_limit": 10,
  "expires_in_days": 30,
  "allowed_group_ids": [1]
}'
```

**200**

```json
{
  "id": 2,
  "key": "sk-...",
  "name": "Claude Code",
  "quota_limit": 10,
  "quota_used": 0,
  "expires_at": "2026-06-12T00:00:00Z",
  "allowed_group_ids": [1]
}
```

**400**

```json
{ "error": "allowed_group_ids 包含不存在的分组 ID: 99" }
```

### PATCH /api/admin/keys/:id — 编辑 API 密钥

编辑密钥名称、额度、过期时间和允许账号分组。字段省略时保持原值；quota_limit 传 0/null 清除额度；expires_at 传 null 或 expires_in_days 传 0 清除过期时间。

```bash
curl --request PATCH \
  --url http://10.14.0.113:8888/api/admin/keys/2 \
  --header 'X-Admin-Key: <admin_secret>' \
  --header 'Content-Type: application/json' \
  --data '{
  "name": "Cherry Studio",
  "quota_limit": 25,
  "expires_at": null,
  "allowed_group_ids": []
}'
```

**200**

```json
{ "message": "API Key 已更新" }
```

**400**

```json
{ "error": "额度限制不能小于 0" }
```

**404**

```json
{ "error": "API Key 不存在" }
```

### DELETE /api/admin/keys/:id — 删除 API 密钥

删除 API Key 并立即让使用该密钥的客户端失去访问权限。

```bash
curl --request DELETE \
  --url http://10.14.0.113:8888/api/admin/keys/2 \
  --header 'X-Admin-Key: <admin_secret>'
```

**200**

```json
{ "message": "已删除" }
```

### GET /api/admin/account-groups — 列出账号分组

列出账号分组、颜色、描述和成员数量。

```bash
curl --request GET \
  --url http://10.14.0.113:8888/api/admin/account-groups \
  --header 'X-Admin-Key: <admin_secret>'
```

**200**

```json
{
  "groups": [
    {
      "id": 1,
      "name": "Team",
      "description": "付费团队账号",
      "color": "#2563eb",
      "member_count": 8,
      "sort_order": 0
    }
  ]
}
```

### POST /api/admin/account-groups — 创建账号分组

创建账号分组。账号可属于多个分组；API Key 可限制只能调度指定分组。

```bash
curl --request POST \
  --url http://10.14.0.113:8888/api/admin/account-groups \
  --header 'X-Admin-Key: <admin_secret>' \
  --header 'Content-Type: application/json' \
  --data '{"name":"Team","description":"付费团队账号","color":"#2563eb"}'
```

**200**

```json
{ "id": 1, "message": "分组已创建" }
```

**400**

```json
{ "error": "分组名称不能为空" }
```

### PATCH /api/admin/account-groups/:id — 编辑账号分组

编辑账号分组名称、描述、颜色和排序。删除或改名分组后，账号和 API Key 的分组关系会按 ID 继续保持。

```bash
curl --request PATCH \
  --url http://10.14.0.113:8888/api/admin/account-groups/1 \
  --header 'X-Admin-Key: <admin_secret>' \
  --header 'Content-Type: application/json' \
  --data '{"name":"Team Plus","description":"高优先级账号","color":"#16a34a","sort_order":10}'
```

**200**

```json
{ "message": "分组已更新" }
```

**404**

```json
{ "error": "分组不存在" }
```

### DELETE /api/admin/account-groups/:id — 删除账号分组

删除空分组。若分组仍有成员，需要追加 ?force=true；删除后会从账号关系中移除该 ID，并尽量从 API Key 允许分组中清理。若某个 API Key 仅绑定该分组，为避免权限被意外放大，会保留为缺失分组状态。

```bash
curl --request DELETE \
  --url 'http://10.14.0.113:8888/api/admin/account-groups/1?force=true' \
  --header 'X-Admin-Key: <admin_secret>'
```

**200**

```json
{ "message": "分组已删除" }
```

**409**

````json
{ "error": "分组仍有账号，确认后可强制删除"
```json
{"error": "分组仍有账号，确认后可强制删除"}
````
