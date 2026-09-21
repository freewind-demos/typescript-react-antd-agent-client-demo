// 日志中间件：包装 fetch，把发出的请求和收到的响应（含流式分片）原样记录
// 它是整个 demo 的核心 —— SDK 内部最终调用 fetch 发 HTTP 请求，
// 我们在这里包一层，就能拿到最原始的 request/response 信息。

// 一条日志事件：所有事件都带时间戳（毫秒），方向与内容区分类型
export type LogEvent =
  // 请求发出前：method / URL / headers / body
  | { type: 'request'; method: string; url: string; headers: Record<string, string>; bodyText: string; timestamp: number }
  // 响应头到达：status / statusText / headers
  | { type: 'response'; status: number; statusText: string; headers: Record<string, string>; timestamp: number }
  // 流式响应体分片：每个原始 chunk 一条，绝不合并
  | { type: 'chunk'; text: string; timestamp: number }
  // 请求失败（网络错误、超时、被中断）
  | { type: 'error'; message: string; timestamp: number }
  // 响应体读取完毕
  | { type: 'end'; timestamp: number }
  // SDK 解析出的完整响应对象：不属于 HTTP 层，而是本次交互的「真实响应正文」
  //（非流式即上游返回的完整对象；流式为 SDK 恢复出的完整消息，如 Anthropic 的 finalMessage）
  | { type: 'sdk-response'; body: unknown; timestamp: number }

// 我们自己用的 fetch 函数签名（与 SDK 内部 Fetch 类型一致）
export type LoggingFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

// 把各种形态的 headers 统一序列化成普通对象，方便原样打印
function toPlainHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const result: Record<string, string> = {}
  if (!headers) return result
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      result[key] = value
    })
  } else if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      result[key] = value
    }
  } else {
    for (const [key, value] of Object.entries(headers)) {
      result[key] = value
    }
  }
  return result
}

// 把请求体序列化成文本：字符串直接用，其他类型给出描述
function toBodyText(body: BodyInit | null | undefined): string {
  if (body == null) return ''
  if (typeof body === 'string') return body
  if (body instanceof URLSearchParams) return body.toString()
  // FormData / Blob / ArrayBuffer 等无法无损转文本，给个说明
  return `[non-text body: ${body.constructor?.name ?? typeof body}]`
}

// 把 URL 统一转成字符串
function toUrlString(input: string | URL | Request): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

// 创建日志 fetch：把原始 fetch 包一层，在请求前/响应后触发 onEvent 回调
export function createLoggingFetch(originalFetch: typeof fetch, onEvent: (event: LogEvent) => void): LoggingFetch {
  return async (input, init) => {
    // ---- 记录请求 ----
    const method = (init?.method ?? 'GET').toUpperCase()
    const url = toUrlString(input)
    const headers = toPlainHeaders(init?.headers)
    const bodyText = toBodyText(init?.body)
    onEvent({ type: 'request', method, url, headers, bodyText, timestamp: Date.now() })

    try {
      const response = await originalFetch(input, init)

      // ---- 记录响应头 ----
      const responseHeaders = toPlainHeaders(response.headers)
      onEvent({ type: 'response', status: response.status, statusText: response.statusText, headers: responseHeaders, timestamp: Date.now() })

      // 有响应体（流式或 JSON）：拆成两路，一路给 SDK 解析，一路自己收集原始文本
      if (response.body) {
        const [logStream, sdkStream] = response.body.tee()
        // TextDecoder 的 decode 必须传 { stream: true }，否则跨 chunk 的多字节 UTF-8 字符会乱码
        const decoder = new TextDecoder('utf-8')

        // 后台异步收集原始分片，逐段触发 chunk 事件
        void (async () => {
          try {
            const reader = logStream.getReader()
            for (;;) {
              const { done, value } = await reader.read()
              if (done) break
              const text = decoder.decode(value, { stream: true })
              if (text) {
                onEvent({ type: 'chunk', text, timestamp: Date.now() })
              }
            }
            // 冲刷解码器里可能残留的半个字符
            const rest = decoder.decode()
            if (rest) {
              onEvent({ type: 'chunk', text: rest, timestamp: Date.now() })
            }
            onEvent({ type: 'end', timestamp: Date.now() })
          } catch (error) {
            // 读取中断（例如客户端断开）：也要如实记录，这正好是"中间打断"的日志
            onEvent({ type: 'error', message: `stream interrupted: ${String(error)}`, timestamp: Date.now() })
          }
        })()

        // 把另一路流包成新的 Response 还给 SDK（SDK 只认标准的 Response 结构）
        return new Response(sdkStream, { status: response.status, statusText: response.statusText, headers: response.headers })
      }

      // 无响应体（如 204）：直接返回原响应
      return response
    } catch (error) {
      // 请求本身失败：记录错误事件后继续抛给 SDK 处理
      onEvent({ type: 'error', message: String(error), timestamp: Date.now() })
      throw error
    }
  }
}
