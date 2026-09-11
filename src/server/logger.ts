// 日志写入器：把中间件产生的日志事件落盘到文件，并实时广播给前端
// 每个会话（sessionId）一份日志：
//   logs/<sessionId>.log         —— verbose 原样日志（每条事件完整原始内容）
//   logs/<sessionId>.summary.log —— 整合摘要（协议层可读内容，不含底层细节）
// 前端日志面板分两个 Tab 展示：默认"整合"（summary），可选"verbose"（原样）。

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LogEvent } from './middleware.js'
import type { Protocol } from './clients.js'

// 日志目录：项目根下的 logs/（已在 .gitignore 忽略）
export const LOGS_DIR = join(process.cwd(), 'logs')

// 一个订阅中的 SSE 客户端：用 send 推数据
type SseClient = { send: (text: string) => void }

// 把一条日志事件格式化成 verbose 文本（原样展示，区分方向）
export function formatLogEvent(event: LogEvent): string {
  const time = new Date(event.timestamp).toISOString()
  switch (event.type) {
    case 'request': {
      const headerLines = Object.entries(event.headers).map(([k, v]) => `  ${k}: ${v}`).join('\n')
      return `=== [REQUEST] ${event.method} ${event.url} @ ${time} ===\nHeaders:\n${headerLines || '  (none)'}\nBody:\n${event.bodyText || '  (empty)'}`
    }
    case 'response': {
      const headerLines = Object.entries(event.headers).map(([k, v]) => `  ${k}: ${v}`).join('\n')
      return `=== [RESPONSE] ${event.status} ${event.statusText} @ ${time} ===\nHeaders:\n${headerLines || '  (none)'}`
    }
    case 'chunk':
      return `=== [CHUNK] @ ${time} ===\n${event.text}`
    case 'error':
      return `=== [ERROR] @ ${time} ===\n${event.message}`
    case 'end':
      return `=== [END] @ ${time} ===`
  }
}

// 尝试把请求体里的 model 和 messages 提取成一行摘要（解析失败返回空）
function extractRequestSummary(bodyText: string): string {
  try {
    const body = JSON.parse(bodyText) as { model?: string; messages?: Array<{ role?: string; content?: unknown }> }
    const parts: string[] = []
    if (body.model) {
      parts.push(`model: ${body.model}`)
    }
    if (Array.isArray(body.messages)) {
      const brief = body.messages.map((m) => `${m.role ?? '?'}: ${String(m.content ?? '').slice(0, 60)}`).join(' | ')
      parts.push(brief)
    }
    return parts.join('\n  ')
  } catch {
    return ''
  }
}

// 从一条原始 chunk（可能是 SSE 分片，也可能是非流式的整段 JSON）里提取协议文本。
// 提取不到（如 event: message_start 之类的元事件）返回 null，摘要里就不展示。
function extractChunkText(protocol: Protocol, raw: string): string | null {
  // 尝试整体解析：非流式响应（整段 JSON）或单行 JSON
  try {
    const parsed = JSON.parse(raw)
    if (protocol === 'anthropic-messages') {
      const content = parsed.content
      if (Array.isArray(content)) {
        return content.filter((b: { type?: string; text?: string }) => b.type === 'text' && typeof b.text === 'string').map((b: { text: string }) => b.text).join('')
      }
    } else if (protocol === 'openai-chat-completions') {
      const msg = parsed.choices?.[0]?.message?.content
      if (typeof msg === 'string') return msg
    } else if (protocol === 'openai-responses') {
      if (typeof parsed.output_text === 'string') return parsed.output_text
    }
  } catch {
    // 不是单块 JSON，继续按 SSE 逐行解析
  }
  // SSE 分片：逐行找 data: 开头的 JSON
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data: ')) continue
    try {
      const d = JSON.parse(line.slice(6))
      if (protocol === 'anthropic-messages') {
        if (d.type === 'content_block_delta' && d.delta?.type === 'text_delta' && typeof d.delta.text === 'string') {
          return d.delta.text
        }
      } else if (protocol === 'openai-chat-completions') {
        const content = d.choices?.[0]?.delta?.content
        if (typeof content === 'string' && content) return content
      } else if (protocol === 'openai-responses') {
        if (d.type === 'response.output_text.delta' && typeof d.delta === 'string') return d.delta
      }
    } catch {
      // 单行解析失败，跳过
    }
  }
  return null
}

// 把一条日志事件生成一行整合摘要（协议层可读；非文本事件返回空串不展示）
function summarizeEvent(event: LogEvent, protocol: Protocol): string {
  const time = new Date(event.timestamp).toLocaleTimeString('zh-CN', { hour12: false })
  switch (event.type) {
    case 'request': {
      const brief = extractRequestSummary(event.bodyText)
      const head = `[${time}] → ${event.method} ${event.url}`
      return brief ? `${head}\n  ${brief}` : head
    }
    case 'response': {
      const ctype = event.headers['content-type'] ?? ''
      return `[${time}] ← ${event.status}${ctype ? ` ${ctype.split(';')[0]}` : ''}`
    }
    case 'chunk': {
      const text = extractChunkText(protocol, event.text)
      return text ? `[${time}] 文本: ${text}` : ''
    }
    case 'error':
      return `[${time}] ✗ ${event.message}`
    case 'end':
      return `[${time}] ✓ 完成`
  }
}

// 日志管理器：维护所有会话的 verbose 日志文件、摘要文件与 SSE 订阅者
export class LogManager {
  // 每个 sessionId 对应的 verbose 文件路径（静态小查找表）
  private filePaths: Record<string, string> = {}
  // 每个 sessionId 对应的摘要文件路径
  private summaryPaths: Record<string, string> = {}
  // 当前在线的 SSE 订阅者（运行时动态增删，用 Set）
  private subscribers = new Set<SseClient>()

  constructor() {
    // 确保日志目录存在
    mkdirSync(LOGS_DIR, { recursive: true })
  }

  // 把任意 sessionId 规整成安全文件名（防止路径穿越）
  private safeName(sessionId: string): string {
    return sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
  }

  // 某个会话追加一条日志事件：写 verbose 文件 + 写摘要文件 + 广播给所有订阅者
  append(sessionId: string, event: LogEvent, protocol?: Protocol): void {
    // ---- verbose 原样日志 ----
    let filePath = this.filePaths[sessionId]
    if (!filePath) {
      filePath = join(LOGS_DIR, `${this.safeName(sessionId)}.log`)
      this.filePaths[sessionId] = filePath
    }
    appendFileSync(filePath, `${formatLogEvent(event)}\n\n`)

    // ---- 整合摘要（需要协议才能从 chunk 里提取文本）----
    let summaryText = ''
    if (protocol) {
      summaryText = summarizeEvent(event, protocol)
      if (summaryText) {
        let summaryPath = this.summaryPaths[sessionId]
        if (!summaryPath) {
          summaryPath = join(LOGS_DIR, `${this.safeName(sessionId)}.summary.log`)
          this.summaryPaths[sessionId] = summaryPath
        }
        appendFileSync(summaryPath, `${summaryText}\n`)
      }
    }

    // ---- 广播给前端：SSE 格式 data: JSON\n\n ----
    const payload = `data: ${JSON.stringify({ ...event, text: formatLogEvent(event), summary: summaryText, sessionId })}\n\n`
    for (const client of this.subscribers) {
      client.send(payload)
    }
  }

  // 读取某个会话的完整 verbose 日志文件内容
  readFile(sessionId: string): string | null {
    try {
      return readFileSync(join(LOGS_DIR, `${this.safeName(sessionId)}.log`), 'utf-8')
    } catch {
      return null
    }
  }

  // 读取某个会话的整合摘要文件内容
  readSummaryFile(sessionId: string): string | null {
    try {
      return readFileSync(join(LOGS_DIR, `${this.safeName(sessionId)}.summary.log`), 'utf-8')
    } catch {
      return null
    }
  }

  // 注册一个 SSE 订阅者，返回取消订阅函数
  subscribe(client: SseClient): () => void {
    this.subscribers.add(client)
    return () => {
      this.subscribers.delete(client)
    }
  }
}
