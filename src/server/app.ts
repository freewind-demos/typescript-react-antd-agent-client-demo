// express 应用构建：三种协议的聊天/模型接口 + 日志接口
// 这个 app 有两种挂载方式：
//   1. dev 模式：作为 vite 中间件挂进 dev server（与前端同端口，单端口启动）
//   2. 独立模式：server.ts 里 app.listen(3001) 单独起后端
// 两种方式路由完全一致（都带 /api 前缀）。

import express from 'express'
import { chatWithProtocol } from './protocols/index.js'
import { listModelsWithFallback } from './models.js'
import type { ChatEvent, ChatRequest, Protocol } from './protocols/core.js'
import { LogManager } from './logger.js'
import { ConversationStore } from './conversation.js'
import type { LogEvent } from './middleware.js'

// 全局日志管理器：所有会话的日志文件与 SSE 订阅都在这里
const logManager = new LogManager()

// 全局会话状态：每个 sessionId 一份协议原生消息序列（历史只追加不重建）
const conversationStore = new ConversationStore()

// 通用聊天 handler：按协议分发，日志事件绑定到请求里的 sessionId
// 【已知取舍 · Demo 不修】没有监听连接关闭（req.on('close')），也没有把取消信号透传给 SDK 请求与 Bash 子进程：
// 浏览器刷新 / 关闭页面后，上游生成与后续工具仍会继续跑，直到自然结束或 20 轮上限。
// 原因：要修需要把 AbortSignal 贯穿 SDK 调用与子进程树，改动远大于本 Demo 的收益。
function handleChat(protocol: Protocol) {
  return async (req: express.Request, res: express.Response) => {
    const { baseUrl, apiKey, model, text, stream, sessionId, maxTokens } = req.body as {
      baseUrl?: string
      apiKey?: string
      model?: string
      text?: string
      stream?: boolean
      sessionId?: string
      maxTokens?: number
    }
    // 校验必填字段
    // 【已知取舍 · Demo 不修】maxTokens 只判「有没有值」，不校验正整数与合理上限：
    // 直接调接口传负数 / NaN / 极大值，最终由 SDK 或上游报错。
    // 原因：正常 UI 的 InputNumber 已限制 min=1，只有手工构造请求才会触发。
    if (!baseUrl || !apiKey || !model || !text || !sessionId) {
      res.status(400).json({ error: 'missing required fields: baseUrl/apiKey/model/text/sessionId' })
      return
    }
    // 会话历史由服务端持有：拿到（或新建）这个 sessionId 对应的协议原生消息序列
    const conversation = conversationStore.get(sessionId, protocol)
    // 是否已进入流式响应：一旦进入就按 SSE 收尾（不能再用 res.status(...).json(...)）
    let streaming = false
    try {
      // 日志回调：写文件 + 广播给订阅的 SSE 客户端（带协议用于生成整合摘要）
      const onEvent = (event: LogEvent) => logManager.append(sessionId, event, protocol)
      // 事件序列：流式与非流式消费的是同一条 agent loop（结构化事件，含文本与工具调用）
      const events = chatWithProtocol(protocol, { baseUrl, apiKey, model, text, conversation, stream: !!stream, onEvent, maxTokens })

      if (!stream) {
        // 非流式：把事件收集完整后一次性返回 { events }（此刻还没写过响应头，
        // 所以中途出错仍能走下面的 500 分支）
        const collected: ChatEvent[] = []
        for await (const event of events) collected.push(event)
        res.json({ events: collected })
        return
      }

      // 流式：以 SSE 形式把每个事件原样转发给前端（text / tool），前端据此建气泡
      streaming = true
      res.setHeader('content-type', 'text/event-stream')
      res.setHeader('cache-control', 'no-cache')
      res.setHeader('connection', 'keep-alive')
      for await (const event of events) {
        res.write(`data: ${JSON.stringify(event)}\n\n`)
      }
      res.write('data: [DONE]\n\n')
      res.end()
    } catch (error) {
      // 上游 API 报错（错误本身也会被中间件记录到日志）
      if (streaming) {
        // 流式响应已开始（headers 已发出）：不能再返回 500，改为往流里补一条 error 事件 +
        // 结束标记，让前端能提示用户（否则前端只会看到流被静默截断，不知道发生了什么）
        res.write(`data: ${JSON.stringify({ error: String(error) })}\n\n`)
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }
      res.status(500).json({ error: String(error) })
    }
  }
}

// 通用 models handler：获取某协议的模型列表
function handleModels(protocol: Protocol) {
  return async (req: express.Request, res: express.Response) => {
    const { baseUrl, apiKey, sessionId } = req.body as { baseUrl?: string; apiKey?: string; sessionId?: string }
    if (!baseUrl || !apiKey) {
      res.status(400).json({ error: 'missing required fields: baseUrl/apiKey' })
      return
    }
    try {
      // Fetch Models 请求同样记录日志（有 sessionId 时），方便看到模型接口的原始交互
      const onEvent = sessionId ? (event: LogEvent) => logManager.append(sessionId, event, protocol) : () => {}
      // 自动重试：依次尝试从 baseUrl 上溯的几个候选地址，兼容"模型列表与聊天端点路径不同"的上游
      const { models, usedBaseUrl } = await listModelsWithFallback(protocol, baseUrl, apiKey, onEvent)
      res.json({ models, usedBaseUrl })
    } catch (error) {
      res.status(500).json({ error: String(error) })
    }
  }
}

// 构建 express 应用
export function buildApp(): express.Express {
  const app = express()
  // 解析 JSON 请求体
  app.use(express.json())

  // ---- 三个聊天 Endpoint ----
  app.post('/api/anthropic/messages', handleChat('anthropic-messages'))
  app.post('/api/openai/chat-completions', handleChat('openai-chat-completions'))
  app.post('/api/openai/responses', handleChat('openai-responses'))

  // ---- 三个 models Endpoint ----
  app.post('/api/anthropic/models', handleModels('anthropic-messages'))
  app.post('/api/openai/chat-completions/models', handleModels('openai-chat-completions'))
  app.post('/api/openai/responses/models', handleModels('openai-responses'))

  // ---- 日志接口 ----
  // SSE 长连接：实时推送日志增量（所有会话的事件都推，前端自己过滤 sessionId）
  // 【已知取舍 · Demo 不修】广播给所有订阅者，payload 里带完整请求头（含 API Key）与响应正文；
  // 多标签页时每页都会收到其他会话的敏感内容，再由前端按 sessionId 丢弃。
  // 原因：Demo 通常只开一个页面；要修可让订阅时带上 sessionId，由服务端只推该会话。
  // 注意：必须注册在 /api/logs/:sessionId 之前，否则 "stream" 会被当成 sessionId 参数
  app.get('/api/logs/stream', (req, res) => {
    res.setHeader('content-type', 'text/event-stream')
    res.setHeader('cache-control', 'no-cache')
    res.setHeader('connection', 'keep-alive')
    // 心跳，防止空闲连接被中间代理断开
    const heartbeat = setInterval(() => {
      res.write(': heartbeat\n\n')
    }, 15000)
    const unsubscribe = logManager.subscribe({ send: (text) => res.write(text) })
    // 客户端断开时清理
    req.on('close', () => {
      clearInterval(heartbeat)
      unsubscribe()
    })
  })

  // 读取某个会话的结构化 JSON（日志面板「会话」Tab 全量恢复用）
  app.get('/api/logs/:sessionId/json', (req, res) => {
    const data = logManager.readJsonFile(req.params.sessionId)
    if (data === null) {
      res.status(404).json({ error: 'json log not found' })
      return
    }
    res.json(data)
  })

  // 读取某个会话的完整日志文件内容（换会话即换 sessionId）
  app.get('/api/logs/:sessionId', (req, res) => {
    const content = logManager.readFile(req.params.sessionId)
    if (content === null) {
      res.status(404).json({ error: 'log file not found' })
      return
    }
    res.type('text/plain').send(content)
  })

  // 兜底放行：未匹配到 express 路由的请求继续往下走（交给 vite 处理静态资源/HMR）。
  // 独立 listen 模式下这个中间件没有实际作用。
  app.use((_req, _res, next) => {
    next()
  })

  return app
}
