// express 应用构建：三种协议的聊天/模型接口 + 日志接口
// 这个 app 有两种挂载方式：
//   1. dev 模式：作为 vite 中间件挂进 dev server（与前端同端口，单端口启动）
//   2. 独立模式：server.ts 里 app.listen(3001) 单独起后端
// 两种方式路由完全一致（都带 /api 前缀）。

import express from 'express'
import { chatWithProtocol, listModelsWithFallback, type ChatRequest, type ChatResult, type Protocol } from './clients.js'
import { LogManager } from './logger.js'
import type { LogEvent } from './middleware.js'

// 全局日志管理器：所有会话的日志文件与 SSE 订阅都在这里
const logManager = new LogManager()

// 通用聊天 handler：按协议分发，日志事件绑定到请求里的 sessionId
function handleChat(protocol: Protocol) {
  return async (req: express.Request, res: express.Response) => {
    const { baseUrl, apiKey, model, messages, stream, sessionId } = req.body as {
      baseUrl?: string
      apiKey?: string
      model?: string
      messages?: ChatRequest['messages']
      stream?: boolean
      sessionId?: string
    }
    // 校验必填字段
    if (!baseUrl || !apiKey || !model || !messages || !sessionId) {
      res.status(400).json({ error: 'missing required fields: baseUrl/apiKey/model/messages/sessionId' })
      return
    }
    // 是否已进入流式响应：一旦进入就按 SSE 收尾（不能再用 res.status(...).json(...)）
    let streaming = false
    try {
      // 日志回调：写文件 + 广播给订阅的 SSE 客户端（带协议用于生成整合摘要）
      const onEvent = (event: LogEvent) => logManager.append(sessionId, event, protocol)
      const result: ChatResult = await chatWithProtocol(protocol, { baseUrl, apiKey, model, messages, stream: !!stream, onEvent })

      if (!result.stream) {
        // 非流式：直接返回完整文本
        res.json({ text: result.text })
        return
      }

      // 流式：以 SSE 形式把文本增量转发给前端，每个增量一条 data
      streaming = true
      res.setHeader('content-type', 'text/event-stream')
      res.setHeader('cache-control', 'no-cache')
      res.setHeader('connection', 'keep-alive')
      for await (const delta of result.iterator) {
        res.write(`data: ${JSON.stringify({ delta })}\n\n`)
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

  // 读取某个会话的结构化 JSON（日志面板"JSON"Tab 全量恢复用）
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
