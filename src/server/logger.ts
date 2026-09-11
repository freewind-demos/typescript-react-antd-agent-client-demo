// 日志写入器：把中间件产生的日志事件落盘到文件，并实时广播给前端
// 每个会话（sessionId）两份文件：
//   logs/<sessionId>.log  —— verbose 原样日志（每条事件完整原始内容）
//   logs/<sessionId>.json —— 整个会话的结构化 JSON（request 的 headers/body、response 的 status/headers、提取的回复文本）
// 前端日志面板两个 Tab：默认"JSON"（会话结构），"verbose"（原样底层日志）。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LogEvent } from './middleware.js'
import type { Protocol } from './clients.js'

// 日志目录：项目根下的 logs/（已在 .gitignore 忽略）
export const LOGS_DIR = join(process.cwd(), 'logs')

// 一个订阅中的 SSE 客户端：用 send 推数据
type SseClient = { send: (text: string) => void }

// 会话里按时间顺序收集的协议原生 JSON 列表：
// 每次请求的请求体 JSON，以及响应里每个事件 JSON，原样排列（不含 HTTP headers 等）
export type ProtocolJson = unknown

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

// 从一条原始文本里提取协议原生的 JSON：请求体（整段 JSON）或响应事件（每个 data: 行的 JSON）。
// 这些就是协议本身的内容，不含任何 HTTP 层包装。
function extractProtocolJsons(raw: string): unknown[] {
  // 整段是一个 JSON（非流式响应体、请求体）
  try {
    return [JSON.parse(raw)]
  } catch {
    // 不是整段 JSON，继续按 SSE 行解析
  }
  const result: unknown[] = []
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data: ')) continue
    const payload = line.slice(6).trim()
    // SSE 结束标记不是协议内容
    if (payload === '[DONE]') continue
    try {
      result.push(JSON.parse(payload))
    } catch {
      // 无法解析的行跳过
    }
  }
  return result
}

// 日志管理器：维护会话的 verbose 文件、协议 JSON（内存 + 落盘）与 SSE 订阅者
export class LogManager {
  // 每个 sessionId 对应的 verbose 文件路径
  private filePaths: Record<string, string> = {}
  // 每个 sessionId 对应的 JSON 文件路径
  private jsonPaths: Record<string, string> = {}
  // 每个 sessionId 累积的协议原生 JSON 列表（内存态，供增量更新后整体落盘）
  private sessionProtocolJsons: Record<string, ProtocolJson[]> = {}
  // 当前在线的 SSE 订阅者
  private subscribers = new Set<SseClient>()

  constructor() {
    mkdirSync(LOGS_DIR, { recursive: true })
  }

  // 把任意 sessionId 规整成安全文件名（防止路径穿越）
  private safeName(sessionId: string): string {
    return sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
  }

  // 某个会话追加一条日志事件：更新 verbose 文件与协议 JSON，并广播给所有订阅者
  append(sessionId: string, event: LogEvent, _protocol?: Protocol): void {
    // ---- verbose 原样日志 ----
    let filePath = this.filePaths[sessionId]
    if (!filePath) {
      filePath = join(LOGS_DIR, `${this.safeName(sessionId)}.log`)
      this.filePaths[sessionId] = filePath
    }
    // writeFileSync 追加（a 标志）写入一行块
    writeFileSync(filePath, `${formatLogEvent(event)}\n\n`, { flag: 'a' })

    // ---- 收集本次事件里的协议原生 JSON ----
    // 请求事件：请求体就是协议 JSON；chunk 事件：响应里每个 data: 行是协议事件 JSON
    let newProtocolJsons: ProtocolJson[] = []
    if (event.type === 'request') {
      newProtocolJsons = extractProtocolJsons(event.bodyText)
    } else if (event.type === 'chunk') {
      newProtocolJsons = extractProtocolJsons(event.text)
    }

    // ---- 累积到会话协议 JSON 列表并落盘（覆盖写，保持与内存一致） ----
    const list = this.sessionProtocolJsons[sessionId] ?? (this.sessionProtocolJsons[sessionId] = [])
    if (newProtocolJsons.length > 0) {
      list.push(...newProtocolJsons)
      let jsonPath = this.jsonPaths[sessionId]
      if (!jsonPath) {
        jsonPath = join(LOGS_DIR, `${this.safeName(sessionId)}.json`)
        this.jsonPaths[sessionId] = jsonPath
      }
      writeFileSync(jsonPath, JSON.stringify(list, null, 2))
    }

    // ---- 广播给前端：SSE 格式 data: JSON\n\n（带本次新增的协议 JSON，前端直接追加） ----
    const payload = `data: ${JSON.stringify({ ...event, text: formatLogEvent(event), protocolJsons: newProtocolJsons, sessionId })}\n\n`
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

  // 读取某个会话累积的协议 JSON 列表
  readJsonFile(sessionId: string): ProtocolJson[] | null {
    try {
      return JSON.parse(readFileSync(join(LOGS_DIR, `${this.safeName(sessionId)}.json`), 'utf-8')) as ProtocolJson[]
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
