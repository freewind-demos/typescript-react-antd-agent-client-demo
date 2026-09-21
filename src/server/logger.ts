// 日志写入器：把中间件产生的日志事件落盘到文件，并实时广播给前端
// 每个会话（sessionId）三份文件：
//   logs/<sessionId>.log       —— 协议真实收发的原样日志（request / response / chunk / error；
//                                 [TOOL] / [END] 等本地信息不写入）
//   logs/<sessionId>.json      —— 整个会话的结构化 JSON（request 的 headers/body、response 的 status/headers、SDK 真实响应对象）
//   logs/<sessionId>.delta.log —— 会话的 delta 日志（内容与前端 delta Tab 逐字一致，随事件整份重写）
// 前端日志面板四个 Tab：请求/响应、会话、delta（与 raw 同源，但以完整 SSE 事件为单位、合并结构一致的连续事件）、raw（原样底层日志）。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LogEvent } from './middleware.js'
import type { Protocol } from './clients.js'
import { appendChunkText, appendRawEvent, emptyDelta, flushDeltaPending, renderDeltaText, type DeltaState } from '../delta.js'

// 日志目录：项目根下的 logs/（已在 .gitignore 忽略）
export const LOGS_DIR = join(process.cwd(), 'logs')

// 一个订阅中的 SSE 客户端：用 send 推数据
type SseClient = { send: (text: string) => void }

// 协议真实收发的事件：request / response / chunk / error / end（HTTP 层）。
// SDK 响应对象（sdk-response）不属于 HTTP 层，不进 verbose 日志。
export type ProtocolLogEvent = Extract<LogEvent, { type: 'request' | 'response' | 'chunk' | 'error' | 'end' }>

// 判断一条日志事件是否属于协议真实收发（verbose 日志只记录这些）
function isProtocolEvent(event: LogEvent): event is ProtocolLogEvent {
  return event.type === 'request' || event.type === 'response' || event.type === 'chunk' || event.type === 'error'
}

// 把一条协议日志事件格式化成 verbose 文本（原样展示，区分方向）
export function formatLogEvent(event: ProtocolLogEvent): string {
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

// 会话里的一条交互记录：请求/响应各带 HTTP 元信息与协议 JSON 正文
// （元信息用于 Tab1 生成 JSONC 注释；正文是协议原生 JSON）
export type InteractionRecord = {
  request: { method: string; url: string; headers: Record<string, string>; body: unknown } | null
  response: { status: number; statusText: string; headers: Record<string, string>; body: unknown } | null
}

// 会话状态：交互列表（一个请求配一个回复）+ delta 累积
type SessionState = {
  interactions: InteractionRecord[]
  // 会话的 delta 状态（与前端 delta Tab 同规则累积，落盘到 <sessionId>.delta.log）
  delta: DeltaState
}

// 日志管理器：维护会话的 verbose 文件、协议 JSON（内存 + 落盘）与 SSE 订阅者
export class LogManager {
  // 每个 sessionId 对应的 verbose 文件路径
  private filePaths: Record<string, string> = {}
  // 每个 sessionId 对应的 JSON 文件路径
  private jsonPaths: Record<string, string> = {}
  // 每个 sessionId 的会话状态（协议 JSON：交互列表 + 当前响应事件累积）
  private sessionStates: Record<string, SessionState> = {}
  // 当前在线的 SSE 订阅者
  private subscribers = new Set<SseClient>()

  constructor() {
    mkdirSync(LOGS_DIR, { recursive: true })
  }

  // 把任意 sessionId 规整成安全文件名（防止路径穿越）
  private safeName(sessionId: string): string {
    return sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
  }

  // 某个会话追加一条日志事件：更新原样日志文件与协议 JSON，并广播给所有订阅者
  append(sessionId: string, event: LogEvent, _protocol?: Protocol): void {
    // ---- 原样日志（仅协议真实收发的事件；[TOOL] / [END] 是本地信息，不写入）----
    if (isProtocolEvent(event)) {
      let filePath = this.filePaths[sessionId]
      if (!filePath) {
        filePath = join(LOGS_DIR, `${this.safeName(sessionId)}.log`)
        this.filePaths[sessionId] = filePath
      }
      // writeFileSync 追加（a 标志）写入一行块
      writeFileSync(filePath, `${formatLogEvent(event)}\n\n`, { flag: 'a' })
    }

    // ---- 收集本次事件里的协议原生信息 ----
    // 请求事件：请求体就是协议 JSON；sdk-response 事件：SDK 解析出的完整响应对象
    let requestJson: unknown
    let responseBody: unknown
    const state = this.sessionStates[sessionId] ?? (this.sessionStates[sessionId] = { interactions: [], delta: emptyDelta() })

    if (event.type === 'request') {
      // 新的一次交互开始：记录请求元信息与请求体（协议 JSON）
      const parsed = extractProtocolJsons(event.bodyText)
      requestJson = parsed[0] ?? null
      state.interactions.push({ request: { method: event.method, url: event.url, headers: event.headers, body: requestJson }, response: null })
      this.writeJsonFile(sessionId, state)
    } else if (event.type === 'response') {
      // 收到响应头：记录状态与 headers（正文等 SDK 响应对象）
      const last = state.interactions[state.interactions.length - 1]
      if (last) {
        last.response = { status: event.status, statusText: event.statusText, headers: event.headers, body: last.response?.body ?? null }
      }
      this.writeJsonFile(sessionId, state)
    } else if (event.type === 'sdk-response') {
      // SDK 解析出的完整响应：作为这次交互的真实响应正文
      const last = state.interactions[state.interactions.length - 1]
      if (last) {
        last.response = {
          status: last.response?.status ?? 0,
          statusText: last.response?.statusText ?? '',
          headers: last.response?.headers ?? {},
          body: event.body,
        }
      }
      responseBody = event.body
      this.writeJsonFile(sessionId, state)
    }

    // ---- 同步 Delta 日志：内容与前端 delta Tab 完全一致 ----
    // chunk：按 SSE 事件边界并入（未收完的尾巴留待下次拼接）；request/response 原样成块；
    // end / error 表示这一轮流结束或中断，把没收完的尾巴冲出来，保证真实收到的内容不丢。
    if (event.type === 'chunk') {
      state.delta = appendChunkText(state.delta, event.timestamp, event.text)
      this.writeDeltaFile(sessionId, state)
    } else if (event.type === 'end' || event.type === 'error') {
      state.delta = flushDeltaPending(state.delta, event.timestamp)
      if (isProtocolEvent(event)) state.delta = appendRawEvent(state.delta, formatLogEvent(event))
      this.writeDeltaFile(sessionId, state)
    } else if (isProtocolEvent(event)) {
      state.delta = appendRawEvent(state.delta, formatLogEvent(event))
      this.writeDeltaFile(sessionId, state)
    }

    // ---- 广播给前端：SSE 格式 data: JSON\n\n ----
    // text 只给协议事件（前端据此追加日志视图）；requestJson / responseBody 用于更新日志面板的交互记录；
    // chunkText 只给 chunk 事件，供前端 delta Tab 按 SSE 事件边界自行累积
    const payload = `data: ${JSON.stringify({ ...event, text: isProtocolEvent(event) ? formatLogEvent(event) : undefined, requestJson, responseBody, chunkText: event.type === 'chunk' ? event.text : undefined, sessionId })}\n\n`
    for (const client of this.subscribers) {
      client.send(payload)
    }
  }

  // 把会话的交互列表写入 JSON 文件（覆盖写，保持与内存一致）
  private writeJsonFile(sessionId: string, state: SessionState): void {
    let jsonPath = this.jsonPaths[sessionId]
    if (!jsonPath) {
      jsonPath = join(LOGS_DIR, `${this.safeName(sessionId)}.json`)
      this.jsonPaths[sessionId] = jsonPath
    }
    writeFileSync(jsonPath, JSON.stringify(state.interactions, null, 2))
  }

  // 把会话的 delta 条目渲染后整份写入 Delta 日志文件（覆盖写，保持与前端 delta Tab 一致）
  private writeDeltaFile(sessionId: string, state: SessionState): void {
    writeFileSync(join(LOGS_DIR, `${this.safeName(sessionId)}.delta.log`), renderDeltaText(state.delta))
  }

  // 读取某个会话的完整 verbose 日志文件内容
  readFile(sessionId: string): string | null {
    try {
      return readFileSync(join(LOGS_DIR, `${this.safeName(sessionId)}.log`), 'utf-8')
    } catch {
      return null
    }
  }

  // 读取某个会话的交互列表 JSON（一个请求配一个回复）
  readJsonFile(sessionId: string): SessionState['interactions'] | null {
    try {
      return JSON.parse(readFileSync(join(LOGS_DIR, `${this.safeName(sessionId)}.json`), 'utf-8')) as SessionState['interactions']
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
