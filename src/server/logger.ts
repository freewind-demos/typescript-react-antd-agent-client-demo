// 日志写入器：把中间件产生的日志事件落盘到文件，并实时广播给前端
// 每个会话（sessionId）一个日志文件 logs/<sessionId>.log，
// 前端日志面板实时追加（SSE），换会话就是换一个文件。

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LogEvent } from './middleware'

// 日志目录：项目根下的 logs/（已在 .gitignore 忽略）
export const LOGS_DIR = join(process.cwd(), 'logs')

// 一个订阅中的 SSE 客户端：用 send 推数据
type SseClient = { send: (text: string) => void }

// 把一条日志事件格式化成人类可读的文本（原样展示，区分方向）
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

// 日志管理器：维护所有会话的日志文件与 SSE 订阅者
export class LogManager {
  // 每个 sessionId 对应的文件路径（静态小查找表，用 Record）
  private filePaths: Record<string, string> = {}
  // 当前在线的 SSE 订阅者（运行时动态增删，用 Set）
  private subscribers = new Set<SseClient>()

  constructor() {
    // 确保日志目录存在
    mkdirSync(LOGS_DIR, { recursive: true })
  }

  // 把任意 sessionId 规整成安全文件名（防止路径穿越）
  private safePath(sessionId: string): string {
    const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
    return join(LOGS_DIR, `${safeId}.log`)
  }

  // 某个会话追加一条日志事件：写文件 + 广播给所有订阅者
  append(sessionId: string, event: LogEvent): void {
    // 写文件：追加模式，逐条原样写入
    let filePath = this.filePaths[sessionId]
    if (!filePath) {
      filePath = this.safePath(sessionId)
      this.filePaths[sessionId] = filePath
    }
    const text = formatLogEvent(event)
    // 每条日志之间空一行，方便阅读
    appendFileSync(filePath, `${text}\n\n`)

    // 广播给前端：SSE 格式 data: JSON\n\n，附带格式化好的文本与所属会话 id
    const payload = `data: ${JSON.stringify({ ...event, text, sessionId })}\n\n`
    for (const client of this.subscribers) {
      client.send(payload)
    }
  }

  // 读取某个会话的完整日志文件内容
  readFile(sessionId: string): string | null {
    const filePath = this.safePath(sessionId)
    try {
      return readFileSync(filePath, 'utf-8')
    } catch {
      // 文件不存在：返回 null 让前端显示空状态
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
