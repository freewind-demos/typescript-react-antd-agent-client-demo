// 日志面板 JSONC 渲染的纯逻辑（与 React 无关）：把一条交互 / 整个会话渲染成
// 带 HTTP 元信息注释的 JSONC 文本。原先内联在 App.tsx 顶部，与 delta.ts 属于同一类。

// 会话里的一条交互记录：请求/响应各带 HTTP 元信息与协议 JSON 正文
export type InteractionRecord = {
  request: { method: string; url: string; headers: Record<string, string>; body: unknown } | null
  response: { status: number; statusText: string; headers: Record<string, string>; body: unknown } | null
}

// headers 转成若干行注释文本
export function headerCommentLines(headers: Record<string, string>): string[] {
  const entries = Object.entries(headers)
  if (entries.length === 0) return ['headers: (none)']
  return ['headers:', ...entries.map(([k, v]) => `  ${k}: ${v}`)]
}

// 生成 JSONC：元信息（method/URL、status、headers）以 // 注释写在 JSON 正文之前
export function buildJsonc(metaLines: string[] | null, body: unknown): string {
  if (metaLines === null) return ''
  const comments = metaLines.map((line) => (line.startsWith('  ') ? `//${line}` : `// ${line}`))
  return [...comments, body == null ? 'null' : JSON.stringify(body, null, 2)].join('\n')
}

// 把多行文本统一缩进 N 个空格
function indentLines(text: string, size: number): string[] {
  const pad = ' '.repeat(size)
  return text.split('\n').map((line) => pad + line)
}

// 渲染 JSON 正文：对象时字段直接平铺（去掉最外层大括号，缩进对齐注释层），
// 非对象（null / 数组 / 字符串）作为单个值整体缩进展示
function renderBodyFieldLines(body: unknown): string[] {
  if (body == null) return ['      null']
  if (typeof body === 'object' && !Array.isArray(body)) {
    // 平铺：取 stringify 的中间行，缩进从 2 层对齐到 6 层
    const lines = JSON.stringify(body, null, 2).split('\n').slice(1, -1)
    return lines.length > 0 ? lines.map((line) => ' '.repeat(4) + line) : ['      {}']
  }
  return indentLines(JSON.stringify(body, null, 2), 6)
}

// 渲染一条交互为 JSONC：request / response 对象内，元信息（method+URL / status、headers）以 // 注释写在正文前
function renderInteractionJsonc(item: InteractionRecord): string {
  const requestLines = item.request
    ? [
        `      // ${item.request.method} ${item.request.url}`,
        '      // headers:',
        ...Object.entries(item.request.headers).map(([k, v]) => `      //   ${k}: ${v}`),
        '      //',
        ...renderBodyFieldLines(item.request.body),
      ]
    : ['      null']
  const responseLines = item.response
    ? [
        `      // ${item.response.status} ${item.response.statusText}`,
        '      // headers:',
        ...Object.entries(item.response.headers).map(([k, v]) => `      //   ${k}: ${v}`),
        '      //',
        ...renderBodyFieldLines(item.response.body),
      ]
    : ['      null']
  const lines = ['  {', '    "request": {', ...requestLines, '    },', '    "response": {', ...responseLines, '    }']
  lines.push('  }')
  return lines.join('\n')
}

// 把整个会话渲染成 JSONC 数组：旧项在前、新项在后（持续追加）
export function renderSessionJsonc(records: InteractionRecord[]): string {
  return `[\n${records.map(renderInteractionJsonc).join(',\n')}\n]`
}
