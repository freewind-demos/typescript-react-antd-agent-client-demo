// Delta 日志的纯逻辑（前端与服务端共用）。
// 把流式响应按"结构完全一致的连续分片可合并"的规则整理成条目，再渲染为可展示文本。
// 前端 delta Tab 与服务端落盘的 <sessionId>.delta.log 都走这里，保证两者内容逐字一致。

// ---- 把"结构完全一致"的连续分片合并成一条 ----
// 内容类字段（跨三种协议的流式增量字段）：值不同就拼接续写
const ACCUMULATING_KEYS = new Set(['content', 'reasoning_content', 'arguments', 'text', 'thinking', 'signature', 'partial_json', 'delta', 'output_text', 'refusal'])
// 比较时忽略的"会变的元数据"（合并时取第一条的值）
const IGNORED_KEYS = new Set(['created', 'sequence_number', 'timestamp'])

// delta 的一条：
//   chunk = 可解析的协议 JSON 分片（结构完全相同的连续分片会合并）
//   line  = 原样一行（如 data: [DONE]，不是 JSON，不参与合并）
//   raw   = 其余事件（REQUEST / RESPONSE / ERROR）原样块
export type DeltaEntry =
  | { kind: 'chunk'; ts: number; json: unknown }
  | { kind: 'line'; ts: number; payload: string }
  | { kind: 'raw'; text: string }

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

// 把一条新分片行并入 delta 条目：
// 行形如 `data: <x>` 时取 <x> 尝试 JSON 解析，能解析则按分片规则处理（与末尾 chunk 同结构才合并）；
// 解析不出来的行（如 data: [DONE]、非 JSON 行）原样作为 line 条目展示，且不参与合并
export function appendChunkLine(entries: DeltaEntry[], ts: number, line: string): DeltaEntry[] {
  const m = /^data:\s?(.*)$/s.exec(line)
  let json: unknown
  try {
    json = JSON.parse(m ? m[1] : line)
  } catch {
    return [...entries, { kind: 'line', ts, payload: line }]
  }
  const last = entries[entries.length - 1]
  if (last && last.kind === 'chunk' && canMergeChunks(last.json, json)) {
    const next = entries.slice()
    next[next.length - 1] = { kind: 'chunk', ts: last.ts, json: mergeChunks(last.json, json) }
    return next
  }
  return [...entries, { kind: 'chunk', ts, json }]
}

// delta 的展示文本：chunk 补回一条 `data: ` 行（与 wire 一致）；line 原样一行；其余事件原样块
export function renderDeltaText(entries: DeltaEntry[]): string {
  return entries
    .map((e) => {
      if (e.kind === 'raw') return e.text
      const head = `=== [CHUNK] @ ${new Date(e.ts).toISOString()} ===`
      const body = e.kind === 'line' ? e.payload : `data: ${JSON.stringify(e.json)}`
      return `${head}\n${body}`
    })
    .join('\n\n')
}
