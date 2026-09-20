// Delta 日志的纯逻辑（前端与服务端共用）。
// 把流式响应按"SSE 事件"为单位整理成条目，再渲染为可展示文本。
// 前端 delta Tab 与服务端落盘的 <sessionId>.delta.log 都走这里，保证两者内容逐字一致。
//
// 单位是"一个完整的 SSE 事件"（event: 名 + data: 载荷，以空行结束），
// 而不是"一行"：event:/data: 同属一个事件，必须显示在同一个块里。
// 网络 read 边界可能切在事件中间，因此未凑齐的尾巴留在 pending，与下次文本拼接。

// ---- 把"结构完全一致"的连续事件合并成一条 ----
// 内容类字段（跨三种协议的流式增量字段）：值不同就拼接续写
const ACCUMULATING_KEYS = new Set(['content', 'reasoning_content', 'arguments', 'text', 'thinking', 'signature', 'partial_json', 'delta', 'output_text', 'refusal'])
// 比较时忽略的"会变的元数据"（合并时取第一条的值）：
//   sequence_number / timestamp / created 是序号或时间；obfuscation 是 OpenAI 每次随机生成的噪音串
const IGNORED_KEYS = new Set(['created', 'sequence_number', 'timestamp', 'obfuscation'])

// delta 的一条：
//   chunk = 一个完整的 SSE 事件，其 data 载荷是可解析 JSON（结构完全相同的连续事件会合并）
//           event 为该事件的 event: 名（如 Responses 的 response.output_text.delta），无则省略
//   line  = 一个 SSE 事件但 data 不是可解析 JSON、或含额外行（如 data: [DONE]），原样一行
//   raw   = 其余事件（REQUEST / RESPONSE / ERROR）原样块
export type DeltaEntry =
  | { kind: 'chunk'; ts: number; event?: string; json: unknown }
  | { kind: 'line'; ts: number; payload: string }
  | { kind: 'raw'; text: string }

// delta 累积状态：已展示的条目 + 尚未凑成完整 SSE 事件的尾巴
export type DeltaState = { entries: DeltaEntry[]; pending: string }

export function emptyDelta(): DeltaState {
  return { entries: [], pending: '' }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

// 两条分片能否合并：忽略 created 等元数据后，结构（键集合）完全一致，且非内容类字段值相等
function canMergeChunks(a: unknown, b: unknown, key?: string): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => canMergeChunks(item, b[i]))
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keysA = Object.keys(a).filter((k) => !IGNORED_KEYS.has(k))
    const keysB = Object.keys(b).filter((k) => !IGNORED_KEYS.has(k))
    if (keysA.length !== keysB.length) return false
    return keysA.every((k) => k in b && canMergeChunks(a[k], b[k], k))
  }
  if (typeof a === 'string' && typeof b === 'string') {
    // 内容类字段允许不同（会被拼接）；其余字符串（枚举/标识）必须相等
    return key !== undefined && ACCUMULATING_KEYS.has(key) ? true : a === b
  }
  return a === b
}

// 合并两条分片（仅在 canMergeChunks 为真时调用）：内容类字符串拼接，其余取第一条
function mergeChunks(a: unknown, b: unknown, key?: string): unknown {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.map((item, i) => mergeChunks(item, b[i]))
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const out: Record<string, unknown> = {}
    for (const k of Array.from(new Set([...Object.keys(a), ...Object.keys(b)]))) {
      if (IGNORED_KEYS.has(k)) {
        if (k in a) out[k] = a[k] // 取第一条的值
        continue
      }
      out[k] = mergeChunks(a[k], b[k], k)
    }
    return out
  }
  if (typeof a === 'string' && typeof b === 'string') {
    return key !== undefined && ACCUMULATING_KEYS.has(key) ? a + b : a
  }
  return a
}

// 按 SSE 事件边界（空行）切分：返回已完整的事件块与尚未收完的尾巴
function splitSseEvents(buffer: string): { events: string[]; rest: string } {
  const parts = buffer.replace(/\r\n/g, '\n').split('\n\n')
  const rest = parts.pop() ?? ''
  return { events: parts.map((part) => part.replace(/^\n+|\n+$/g, '')).filter((part) => part !== ''), rest }
}

// 把一个完整的 SSE 事件块转成条目：
// 只含可选的一行 event: 与一行 data:，且 data 能解析成 JSON —— 这是协议分片，参与合并；
// 其余（data: [DONE]、非 JSON 载荷、含 id: 等额外行、多行 data 拼不成 JSON）整体原样保留，不参与合并。
function eventToEntry(ts: number, eventText: string): DeltaEntry {
  const lines = eventText.split('\n')
  const eventLine = lines.find((line) => line.startsWith('event:'))
  const dataLines = lines.filter((line) => line.startsWith('data:'))
  const otherLines = lines.filter((line) => line.trim() !== '' && !line.startsWith('event:') && !line.startsWith('data:'))
  if (otherLines.length > 0 || lines.filter((line) => line.startsWith('event:')).length > 1 || dataLines.length !== 1) {
    return { kind: 'line', ts, payload: eventText }
  }
  const payload = dataLines[0].slice('data:'.length).trimStart()
  let json: unknown
  try {
    json = JSON.parse(payload)
  } catch {
    return { kind: 'line', ts, payload: eventText }
  }
  const event = eventLine ? eventLine.slice('event:'.length).trim() : undefined
  return event ? { kind: 'chunk', ts, event, json } : { kind: 'chunk', ts, json }
}

// 把一条新条目并入条目列表：与末尾 chunk 事件名相同且结构完全一致时合并，否则追加
function appendEntry(entries: DeltaEntry[], entry: DeltaEntry): DeltaEntry[] {
  const last = entries[entries.length - 1]
  if (entry.kind === 'chunk' && last && last.kind === 'chunk' && last.event === entry.event && canMergeChunks(last.json, entry.json)) {
    const next = entries.slice()
    next[next.length - 1] = { kind: 'chunk', ts: last.ts, event: last.event, json: mergeChunks(last.json, entry.json) }
    return next
  }
  return [...entries, entry]
}

// 追加一段新收到的原始响应文本：按 SSE 事件边界切分并入，未收完的尾巴留在 pending
export function appendChunkText(state: DeltaState, ts: number, text: string): DeltaState {
  const { events, rest } = splitSseEvents(state.pending + text)
  let entries = state.entries
  for (const eventText of events) {
    entries = appendEntry(entries, eventToEntry(ts, eventText))
  }
  return { entries, pending: rest }
}

// 流结束 / 中断：把没凑成完整事件的尾巴原样显示出来，保证真实收到的内容不丢
export function flushDeltaPending(state: DeltaState, ts: number): DeltaState {
  const tail = state.pending.trim()
  return { entries: tail === '' ? state.entries : [...state.entries, { kind: 'line', ts, payload: tail }], pending: '' }
}

// 追加一条非 chunk 的协议事件（REQUEST / RESPONSE / ERROR 等）：原样成块
export function appendRawEvent(state: DeltaState, text: string): DeltaState {
  return { entries: [...state.entries, { kind: 'raw', text }], pending: state.pending }
}

// delta 的展示文本：chunk 补回 `event:` / `data: ` 行（与 wire 一致）；line 原样一行；其余事件原样块
export function renderDeltaText(state: DeltaState): string {
  return state.entries
    .map((e) => {
      if (e.kind === 'raw') return e.text
      const head = `=== [CHUNK] @ ${new Date(e.ts).toISOString()} ===`
      if (e.kind === 'line') return `${head}\n${e.payload}`
      const body = e.event === undefined ? `data: ${JSON.stringify(e.json)}` : `event: ${e.event}\ndata: ${JSON.stringify(e.json)}`
      return `${head}\n${body}`
    })
    .join('\n\n')
}
