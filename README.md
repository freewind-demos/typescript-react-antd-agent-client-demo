# Agent Client Demo（三协议原始日志调试器）

## 简介

这个 Demo 演示一个 **Agent Client 调试工具**：在一个微信式聊天界面里，通过三种不同的 AI 协议（Anthropic Messages、OpenAI Chat Completions、OpenAI Responses）与模型对话，并在右侧日志面板从 Client 视角记录每一次交互。它同时是一个 **Agent 客户端**：只给模型提供一个 `Bash` 工具，模型可以真的在本地执行 shell 命令，并根据执行结果继续对话（工具循环在 Server 端完成，前端在聊天区展示工具调用气泡）。日志面板分四个 Tab：

- **请求/响应**（默认）：上下两个区域，各只显示最新 1 条。Request 区显示协议原生的请求 JSON，Response 区显示 **SDK 解析出的完整响应**（非流式即上游返回的完整对象，流式为 SDK 恢复出的完整消息）；两者的 HTTP 元信息（method/URL、status/headers）以 `//` 注释标注在正文前
- **会话**：整个会话的数组，一项 = 一个请求 + 一个回复（request 为协议原生 JSON，response 为 SDK 解析出的完整响应），HTTP 元信息同样以 `//` 注释标注（JSONC）
- **delta**：与 raw 同内容，但以完整 SSE 事件（event: / data:）为单位展示，结构完全一致的连续事件合并成一条
- **raw**：最底层的原样记录——请求的 method、URL、全部 headers、body，响应的状态码、全部 headers、body，流式响应时每一个 SSE 分片单独一条、绝不合并

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

# 一条命令同时启动前端和后端（后端作为 Vite 中间件挂在同一端口，共用一个 5173）
pnpm run dev
```

浏览器打开 `http://localhost:5173`。

（可选）也可以单独只跑后端：`pnpm start`（独立端口 3001，供需要前后端分离的场景使用；正常开发不需要）。

使用步骤：

1. 点 Providers 卡片的“添加”，在弹窗里选协议、填 API URL 与 API Key（Anthropic 填根地址如 `https://api.anthropic.com`；OpenAI 填到 `/v1` 如 `https://api.openai.com/v1`；中转服务按其要求填）
2. 点弹窗里的 Fetch Models 拉取模型列表，从下拉里选一个（也可手填）
3. 保存后即为当前 Provider（列表可增删改，存 localStorage）
4. 在配置区顶部设置“流式”开关与“最大 Tokens”，在聊天框输入消息回车发送
5. 看右侧日志面板：默认“请求/响应”Tab 显示最新一次的请求/响应，“会话”Tab 看整个会话，“delta”Tab 看合并后的流式事件，“raw”Tab 看最底层原样日志

## 注意事项

- **Bash 工具会真的在你本机执行 shell 命令，且没有任何安全限制（不拦截、不确认、不限目录）**。工作目录是项目根，默认 30s 超时。这是"看看 Agent 工具循环长什么样"的调试 Demo，请只在你信任的模型与上游上使用，不要在放有敏感数据的目录里跑，也不要把这个服务暴露到公网。
- **API Key 会被原样记录进日志文件**。这是"原样展示"需求的一部分（你看到的 headers 就是真实发出的 headers，包含鉴权头）。Demo 是本地工具，日志文件在 `logs/` 目录（已被 .gitignore 忽略），请勿把日志文件提交到仓库或外发。
- **必须走本地 Server，不能浏览器直连**。Anthropic API 对浏览器跨域直连有 CORS 限制，本 Demo 的所有请求都由 Node Server 里的 SDK 发出，前端只与本地 Server 通信。
- 非流式模式下，响应体（JSON）也会作为一条 CHUNK 日志展示——它同样是你"收到的原始内容"。
- 换协议时模型列表不会自动复用，需要重新 Fetch Models。
- **会话历史保存在本地 Server 的内存里**（按 sessionId）。Server 重启后内存里的历史清空，需要开新会话重新聊；日志文件不受影响。
- **换 Provider 协议会自动开新会话**（Completions / Responses / Anthropic 之间互切）。因为历史是协议原生的报文，跨协议复用会把上一种协议的结构发进新协议。
- 日志文件按会话隔离：点"新会话"会生成新的 sessionId 和新的日志文件，同一会话内多轮聊天累积在同一文件里。

## 教程

### 架构

```
前端 (React + antd)                真实 AI API
┌──────────────────────────┐    ┌────────────┐
│ 左侧：配置区 + 聊天区     │    │            │
│ 右侧：日志面板           │──► │  上游服务   │
└─────────────┬────────────┘    └────────────┘
              │ 同端口 /api/*
              ▼
┌──────────────────────────────────────────┐
│ Vite dev server (5173，单端口)            │
│   └─ express 中间件                      │
│       └─ 官方 SDK ──► 日志中间件 ──► 上游  │
│   └─ 写 logs/<sessionId>.log             │
│   └─ SSE 实时推送 /api/logs/stream       │
└──────────────────────────────────────────┘
```

前端与后端**共用同一个端口**：`pnpm run dev` 时 Vite 启动后，通过自定义插件把 express 应用挂进 Vite 的中间件链（`server.middlewares.use(app)`），`/api/*` 请求由 express 处理，其余请求（静态资源、HMR）继续走 Vite——所以单端口、单命令即可开发调试。

### 三种协议

| 协议 | Server Endpoint | 非流式 / 流式 的 SDK 调用 | 流式事件 |
| --- | --- | --- | --- |
| Anthropic Messages | `/api/anthropic/messages` | `client.messages.create()` / `client.messages.stream()` + `await finalMessage()` | `content_block_delta` 事件里 `delta.type === 'text_delta'` 的 `delta.text` |
| OpenAI Chat Completions | `/api/openai/chat-completions` | `client.chat.completions.create()`（流式同样用 `create({ stream: true })`，刻意不用 `.stream()` helper，原因见下文「会话状态与历史回放」） | 每个 chunk 的 `choices[0].delta.content` |
| OpenAI Responses | `/api/openai/responses` | `client.responses.create()` / `client.responses.stream()` + `await finalResponse()` | `response.output_text.delta` 事件的 `delta` 字段 |

模型列表获取同理：`/api/anthropic/models`、`/api/openai/chat-completions/models`、`/api/openai/responses/models` 分别调用对应 SDK 的 `models.list()`。

### Bash 工具与 Agent 循环

Demo 只给模型提供**一个**工具 `Bash`（`command` 必填，`timeout` 可选），三种协议用同一份 JSON Schema，只是外层声明格式不同：

| 协议 | 工具声明 | 模型返回 | 回传方式 |
| --- | --- | --- | --- |
| Anthropic Messages | `{ name, description, input_schema }` | `tool_use` content block | `tool_result` block（放在 user 消息 content 里） |
| OpenAI Chat Completions | `{ type: 'function', function: { name, description, parameters } }` | `message.tool_calls` | `role: 'tool'` 消息（带 `tool_call_id`） |
| OpenAI Responses | `{ type: 'function', name, description, parameters, strict }` | `function_call` output item | `function_call_output` item（带 `call_id`） |

**工具执行**：`src/server/tools.ts` 的 `executeBash()` 用 Node 的 `child_process` 在 Server 上执行命令，工作目录为项目根，返回退出码；输出在命令结束后拼接为一段——先全部 stdout、再全部 stderr，**不保留两者真实的交错顺序**；默认 30s 超时（可被 `timeout` 参数覆盖），输出超过 20000 字符自动截断。

**Agent 循环**：三种协议的 chat 函数（`src/server/clients.ts`）内部都跑同一个循环——请求模型 → 若模型要调用工具就执行 Bash 并把结果回传 → 再请求模型，直到模型不再调用工具（最多 20 轮）。循环产出统一的**结构化事件流**（`text` / `tool`）：流式逐条推给前端，非流式收集完整后一次性返回（`{ events: [...] }`）——两者同一套事件语义。

**展示**：每次工具执行会在事件流里就地插一条 `tool` 事件（入参、输出、退出码）。前端据此在聊天区按真实时序渲染“tool call + tool result”两条气泡，并在其后新起一个助手气泡接续后续文字——**聊天区完全由 chat 响应的事件流驱动，不依赖日志 SSE**（日志 SSE 只服务右侧日志面板）。

### 会话状态与历史回放（关键）

Client 的原则是 **「历史只追加、不重建；收到什么就回放什么」**。上游是无状态的，它每次只收到一份完整的消息数组，所以「记忆」只能由本地这侧保管。

**历史存在哪儿**：`src/server/conversation.ts` 的 `ConversationStore`，按 `sessionId` 存一份**协议原生消息序列**。前端只发本轮输入（`{ baseUrl, apiKey, model, text, stream, sessionId, maxTokens }`），不再自己拼历史——否则前端就得懂三种协议的报文结构；而且把聊天记录「压平成纯文本」等于把 `tool_calls`、`reasoning_content`、Anthropic 的 content block 统统改写掉。

**怎么回放**：每轮把上游返回的消息**原样**追加进序列，构造下一轮请求时整份发出。

- **Chat Completions 非流式**：直接把上游 `message` 对象 push 回 `messages`（字段一个不挑）
- **Chat Completions 流式**：把 delta 里**出现过的所有键**通用合并成一条 message（字符串拼接、`tool_calls` 按 `index` 归并、其余非空值覆盖）。`index` 只用于归并定位、**不写进回放的历史**（它不属于 assistant 消息字段，严格的上游会报 `Unknown parameter: tool_calls[0].index`）。**这里刻意不用 SDK 的 `finalChatCompletion()`**——它只拼自己类型里的字段，不认识的字段（如 DeepSeek 的 `reasoning_content`）会被后一片直接覆盖，只剩最后一片，而且静默不报错
- **Anthropic**：用 `client.messages.stream()` 的 `finalMessage()` 拿完整消息，原始 content blocks 整份放回（含 `thinking` + `signature`，以及白名单外的未知块）
- **Responses**：用 `responses.stream()` 的 `finalResponse()`，把本轮 `output` 条目**按原顺序**整体放回 `input`，并在每个 `function_call` 之后紧跟它的 `function_call_output`
- **工具结果**：按模型给出的顺序、成对回传，不要按「命令跑完的先后」排

**为什么 `reasoning_content` 这类字段要专门照顾**：它不是 OpenAI 官方 Chat Completions 协议的东西，是上游（DeepSeek 系）自己加的扩展，SDK 类型里没有。类型层用交叉类型 `& Record<string, unknown>` 放开，运行时 SDK 不会剥掉它不认识的字段。另外 **DeepSeek 官方要求工具调用轮必须把 `reasoning_content` 传回去**（不带直接 400：`The reasoning_content in the thinking mode must be passed back to the API.`；实测带 `""` 空串也能过）。

**换 Provider**：会话历史是协议原生的，既不能跨协议复用、也不能跨 Provider 复用。前端记住当前会话绑定的 Provider 指纹（id + 协议 + API URL + 模型）：选中别的 Provider 立即开新会话，发送时发现指纹变了也开新会话；服务端 `ConversationStore` 另有协议层保护（协议不一致时视为新会话）。

**已知限制**：会话只存在服务端内存里，服务重启即清空（`logs/` 下的日志文件仍在）。

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
- 同时维护会话交互列表（一项 = 一个请求 + 一个回复）：请求体来自 request body（协议原生 JSON），响应正文由 `agentLoop` 每轮触发的 `sdk-response` 事件提供——即 SDK 解析出的完整响应对象（不做本地聚合）；该列表覆盖写入 `logs/<sessionId>.json`
- 每次事件以 SSE 格式（`data: {...}`）广播给所有订阅了 `/api/logs/stream` 的前端，广播里带上本次的请求 JSON 与 SDK 真实响应对象（`responseBody`），前端直接更新

前端页面加载时建立 `EventSource('/api/logs/stream')` 订阅实时日志；切会话（点"新会话"或刷新）时先 `GET /api/logs/:sessionId` 拉该会话的 verbose 日志、`GET /api/logs/:sessionId/json` 拉交互列表，之后靠 SSE 增量更新。右侧日志区撑满页面高度、各自滚动，并自动滚到最新一条。

### 关键代码位置

- `src/server/middleware.ts` — 日志中间件（包装 fetch、tee 分流、逐 chunk 记录）
- `src/server/logger.ts` — 日志写文件 + SSE 广播
- `src/server/conversation.ts` — 会话状态：按 sessionId 持有协议原生消息序列（历史只追加不重建）
- `src/server/tools.ts` — Bash 工具的三协议声明与本地命令执行器
- `src/server/clients.ts` — 三种协议的 SDK 封装、Agent 工具循环与文本提取
- `src/server/app.ts` — express 应用（聊天/模型/日志接口），dev 时作为 Vite 中间件挂载
- `server.ts` — 可选独立后端入口（`pnpm start`，端口 3001）
- `vite.config.ts` — Vite 配置，含把 express 挂进 dev server 中间件的插件
- `src/App.tsx` — 前端界面（左侧配置区 + 微信式聊天，右侧日志面板）
- `src/protocols.ts` — 三种协议与 Endpoint 的映射定义
- `src/delta.ts` — delta 视图的纯逻辑（按 SSE 事件切分 / 合并），前端与服务端共用
- `src/server/chatCompletionDelta.ts` — Chat Completions 流式 delta 的唯一合并实现（回放历史与日志共用）
