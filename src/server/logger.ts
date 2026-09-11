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

// 把一次响应的所有事件聚合成"完整响应对象"（会话 JSON 里展示用）：
// 流式响应把文本增量拼完整、补齐结束原因等；非流式响应直接就是完整对象。
function aggregateResponse(protocol: Protocol, events: unknown[]): unknown {
  if (events.length === 0) return null
  const list = events as Array<Record<string, any>>

  if (protocol === 'anthropic-messages') {
    // 流式：以 message_start 的 message 为骨架，按 content block index 聚合各块
    // （text / thinking / tool_use 等通通保留，不只取 text），再补 message_delta 的停止原因与用量
    const start = list.find((e) => e.type === 'message_start')
    if (!start) return events[0] // 非流式响应：本身就是完整对象
    const blocks: Record<number, Record<string, any>> = {}
    for (const e of list) {
      if (e.type === 'content_block_start') {
        blocks[e.index] = { ...(e.content_block ?? {}) }
      } else if (e.type === 'content_block_delta') {
        const block = blocks[e.index] ?? (blocks[e.index] = {})
        const d = e.delta ?? {}
        if (d.type === 'text_delta') {
          block.type = 'text'
          block.text = (block.text ?? '') + d.text
        } else if (d.type === 'thinking_delta') {
          block.type = 'thinking'
          block.thinking = (block.thinking ?? '') + d.thinking
        } else if (d.type === 'signature_delta') {
          block.signature = (block.signature ?? '') + d.signature
        } else if (d.type === 'input_json_delta') {
          block.type = 'tool_use'
          block.__partialJson = (block.__partialJson ?? '') + d.partial_json
        } else if (d.type === 'citations_delta') {
          const citations = block.citations ?? (block.citations = [])
          citations.push(d.citation)
        }
      } else if (e.type === 'content_block_stop') {
        // 工具调用的参数是分片 JSON，这里解析回对象
        const block = blocks[e.index]
        if (block && typeof block.__partialJson === 'string') {
          try {
            block.input = JSON.parse(block.__partialJson)
          } catch {
            block.input = block.__partialJson
          }
          delete block.__partialJson
        }
      }
    }
    const content = Object.keys(blocks)
      .map(Number)
      .sort((a, b) => a - b)
      .map((index) => blocks[index])
    const deltaEvent = list.find((e) => e.type === 'message_delta')
    return {
      ...(start.message ?? {}),
      content,
      stop_reason: deltaEvent?.delta?.stop_reason ?? null,
      stop_sequence: deltaEvent?.delta?.stop_sequence ?? null,
      ...(deltaEvent?.usage ? { usage: deltaEvent.usage } : {}),
    }
  }

  if (protocol === 'openai-chat-completions') {
    // 非流式：object 为 chat.completion
    if (list[0]?.object !== 'chat.completion.chunk') return events[0]
    // 通用合并：delta 里所有字段都保留——字符串字段（content / reasoning_content 等）拼接，
    // 其他字段取最后一个非空值，避免只挑 content 而丢掉推理内容或工具调用
    const message: Record<string, unknown> = {}
    for (const c of list) {
      const delta = c.choices?.[0]?.delta
      if (!delta) continue
      for (const [key, value] of Object.entries(delta)) {
        if (key === 'role') {
          // role 是固定值，不参与拼接（多个 chunk 都可能带上）
          message.role = value
        } else if (typeof value === 'string') {
          message[key] = ((message[key] as string) ?? '') + value
        } else if (value != null) {
          message[key] = value
        }
      }
    }
    // 协议要求 message 必须带 role
    if (message.role == null) {
      message.role = 'assistant'
    }
    const finishEvent = [...list].reverse().find((c) => c.choices?.[0]?.finish_reason)
    const usageEvent = [...list].reverse().find((c) => c.usage)
    const first = list[0]
    return {
      id: first.id,
      object: 'chat.completion',
      created: first.created,
      model: first.model,
      choices: [{ index: 0, message, finish_reason: finishEvent?.choices?.[0]?.finish_reason ?? null }],
      ...(usageEvent?.usage ? { usage: usageEvent.usage } : {}),
    }
  }

  // openai-responses：完成事件里带完整 response，直接用它
  const completed = list.find((e) => e.type === 'response.completed')
  if (completed?.response) return completed.response
  const created = list.find((e) => e.type === 'response.created')
  if (!created) return events[0] // 非流式响应
  // 流被中断（没有 response.completed）：用已完成的 output item 组装，并附上已收到的文本
  const doneItems = list.filter((e) => e.type === 'response.output_item.done').map((e) => e.item)
  const text = list.filter((e) => e.type === 'response.output_text.delta').map((e) => e.delta as string).join('')
  return { ...(created.response ?? {}), status: 'incomplete', output: doneItems, output_text: text }
}

// 会话里的一条交互记录：请求/响应各带 HTTP 元信息与协议 JSON 正文
// （元信息用于 Tab1 生成 JSONC 注释；正文是协议原生 JSON）
export type InteractionRecord = {
  request: { method: string; url: string; headers: Record<string, string>; body: unknown } | null
  response: { status: number; statusText: string; headers: Record<string, string>; body: unknown } | null
}

// 会话状态：交互列表（一个请求配一个回复）+ 当前响应的已收事件
type SessionState = {
  interactions: InteractionRecord[]
  // 当前正在累积的响应事件
  events: unknown[]
  // 当前请求使用的协议（聚合时用）
  protocol: Protocol | undefined
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
    let requestJson: unknown
    let currentResponse: unknown
    const state = this.sessionStates[sessionId] ?? (this.sessionStates[sessionId] = { interactions: [], events: [], protocol: undefined })

    if (event.type === 'request') {
      // 新的一次交互开始：记录请求元信息与请求体，重置当前响应事件
      const parsed = extractProtocolJsons(event.bodyText)
      requestJson = parsed[0] ?? null
      state.events = []
      state.protocol = _protocol
      state.interactions.push({ request: { method: event.method, url: event.url, headers: event.headers, body: requestJson }, response: null })
      this.writeJsonFile(sessionId, state)
    } else if (event.type === 'response') {
      // 收到响应头：记录状态与 headers（正文等 chunk 聚合）
      const last = state.interactions[state.interactions.length - 1]
      if (last) {
        last.response = { status: event.status, statusText: event.statusText, headers: event.headers, body: last.response?.body ?? null }
      }
      this.writeJsonFile(sessionId, state)
    } else if (event.type === 'chunk') {
      // 累积响应事件，聚合出完整响应正文
      const evs = extractProtocolJsons(event.text)
      if (evs.length > 0) {
        state.events.push(...evs)
        currentResponse = aggregateResponse(state.protocol ?? 'anthropic-messages', state.events)
        const last = state.interactions[state.interactions.length - 1]
        if (last) {
          last.response = {
            status: last.response?.status ?? 0,
            statusText: last.response?.statusText ?? '',
            headers: last.response?.headers ?? {},
            body: currentResponse,
          }
        }
        this.writeJsonFile(sessionId, state)
      }
    }

    // ---- 广播给前端：SSE 格式 data: JSON\n\n ----
    const payload = `data: ${JSON.stringify({ ...event, text: formatLogEvent(event), requestJson, currentResponse, sessionId })}\n\n`
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
