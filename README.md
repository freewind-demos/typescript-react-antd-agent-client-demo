# Agent Client Demo（三协议原始日志调试器）

## 简介

这个 Demo 演示一个 **Agent Client 调试工具**：在一个微信式聊天界面里，通过三种不同的 AI 协议（Anthropic Messages、OpenAI Chat Completions、OpenAI Responses）与模型对话，并在底部日志面板**从 Client 视角原样展示每一次请求和响应的完整内容**——包括请求的 method、URL、全部 headers、body，响应的状态码、全部 headers、body，流式响应时每一个 SSE 分片单独一条、绝不合并。

它解决的问题：真实业务中我们调用 AI 协议时用的是官方 SDK，SDK 内部自动拼接 URL、自动加 headers（如 `x-api-key`、`anthropic-version`、`user-agent`），出了问题很难看到"网络上到底发了什么"。本 Demo 在 SDK 底层注入一层日志中间件，把 SDK 发出的每一个 HTTP 请求原样记录下来，让你看清协议的真实形态。

## 快速开始

### 环境要求

- Node.js 18+（本机开发使用 v26）
- pnpm
- 一个可用的 AI API：Anthropic API Key 或 OpenAI API Key（或任何兼容这两个协议的中转服务）

### 运行

```bash
# 安装依赖
pnpm install

# 启动 Node Server（端口 3001，负责调用 SDK 与记录日志）
pnpm start

# 另开一个终端，启动前端（端口 5173）
pnpm dev
```

浏览器打开 `http://localhost:5173`。

使用步骤：

1. 选择协议（三种下拉任选，切换后 API URL 会自动换成该协议默认地址，可改）
2. 填 API URL 和 API Key（Anthropic 填根地址如 `https://api.anthropic.com`；OpenAI 填到 `/v1` 如 `https://api.openai.com/v1`；中转服务按其要求填）
3. 点 Fetch Models 拉取模型列表，从下拉里选一个模型
4. 打开/关闭"流式"开关，在聊天框输入消息回车发送
5. 看底部日志面板：每个请求/响应的原始内容实时滚动展示

## 注意事项

- **API Key 会被原样记录进日志文件**。这是"原样展示"需求的一部分（你看到的 headers 就是真实发出的 headers，包含鉴权头）。Demo 是本地工具，日志文件在 `logs/` 目录（已被 .gitignore 忽略），请勿把日志文件提交到仓库或外发。
- **必须走本地 Server，不能浏览器直连**。Anthropic API 对浏览器跨域直连有 CORS 限制，本 Demo 的所有请求都由 Node Server 里的 SDK 发出，前端只与本地 Server 通信。
- 非流式模式下，响应体（JSON）也会作为一条 CHUNK 日志展示——它同样是你"收到的原始内容"。
- 换协议时模型列表不会自动复用，需要重新 Fetch Models。
- 日志文件按会话隔离：点"新会话"会生成新的 sessionId 和新的日志文件，同一会话内多轮聊天累积在同一文件里。

## 教程

### 架构

```
前端 (React + antd)          Node Server (express)             真实 AI API
┌─────────────────┐         ┌─────────────────────────┐
│ 配置区/聊天区    │  HTTP   │ /api/anthropic/messages │   SDK 发请求
│ 日志面板(SSE)   │ ──────► │ /api/openai/...         │ ──────────► 上游
└─────────────────┘         │   └─ 官方 SDK ─┐         │
                            │                ▼         │
                            │        日志中间件(包装 fetch) │
                            │                │         │
                            │  写 logs/<sessionId>.log   │
                            │  SSE 实时推送 /api/logs/stream
                            └─────────────────────────┘
```

前端只做界面；Server 里用官方 SDK（`@anthropic-ai/sdk` 和 `openai`）真正发请求，保证协议格式正确；日志中间件包在 SDK 底层，两者互不干扰。

### 三种协议

| 协议 | Server Endpoint | SDK 调用 | 流式事件 |
| --- | --- | --- | --- |
| Anthropic Messages | `/api/anthropic/messages` | `client.messages.create()` | `content_block_delta` 事件里 `delta.type === 'text_delta'` 的 `delta.text` |
| OpenAI Chat Completions | `/api/openai/chat-completions` | `client.chat.completions.create()` | 每个 chunk 的 `choices[0].delta.content` |
| OpenAI Responses | `/api/openai/responses` | `client.responses.create()` | `response.output_text.delta` 事件的 `delta` 字段 |

模型列表获取同理：`/api/anthropic/models`、`/api/openai/chat-completions/models`、`/api/openai/responses/models` 分别调用对应 SDK 的 `models.list()`。

### 日志中间件原理（核心）

官方 SDK 都支持注入自定义 `fetch` 实现（构造参数里的 `fetch` 字段）。中间件 `src/server/middleware.ts` 做的就是这个：

1. **请求发出前**：把 method、URL、headers、body 原样收集，触发 `request` 事件
2. **收到响应头**：把 status、headers 收集，触发 `response` 事件
3. **响应体**：用 `ReadableStream.tee()` 把流拆成两路——一路交给 SDK 正常解析（聊天照常工作），另一路自己逐段读取，每收到一个分片就触发一条 `chunk` 事件。这就是流式时每个 SSE 分片（`event: xxx` + `data: {...}`）被单独记录的原因
4. **出错/中断**：请求失败或流被掐断，如实触发 `error` 事件

解码分片用的是 `TextDecoder.decode(..., { stream: true })`，保证跨分片的多字节 UTF-8 字符不乱码。

### 日志落盘与实时推送

`src/server/logger.ts` 的 `LogManager`：

- 每条日志事件追加写入 `logs/<sessionId>.log`，格式为 `=== [REQUEST] POST xxx @ 时间 ===` 这类块，区分方向、按时间顺序
- 同时以 SSE 格式（`data: {...}`）广播给所有订阅了 `/api/logs/stream` 的前端

前端页面加载时建立 `EventSource('/api/logs/stream')` 订阅实时日志；切会话（点"新会话"或刷新）时先 `GET /api/logs/:sessionId` 把该会话已有日志文件全量拉回来显示，之后靠 SSE 增量追加。日志面板固定最大高度、带滚动条，并自动滚到最新一条。

### 关键代码位置

- `src/server/middleware.ts` — 日志中间件（包装 fetch、tee 分流、逐 chunk 记录）
- `src/server/logger.ts` — 日志写文件 + SSE 广播
- `src/server/clients.ts` — 三种协议的 SDK 封装与文本提取
- `server.ts` — express 路由（聊天/模型/日志接口）
- `src/App.tsx` — 前端界面（配置区、微信式聊天、日志面板）
- `src/protocols.ts` — 三种协议与 Endpoint 的映射定义
