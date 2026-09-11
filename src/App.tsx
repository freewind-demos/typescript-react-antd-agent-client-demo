// 主界面：配置区（协议/API URL/API Key/Fetch Models/模型/流式开关/新会话）
// + 微信式聊天区 + 日志面板（实时原样展示当前会话的所有请求与响应）

import { useEffect, useRef, useState } from 'react'
import { AutoComplete, Button, Card, Input, Select, Space, Switch, Tabs, message } from 'antd'
import { PROTOCOLS, type Protocol } from './protocols'
import { getHistory, pushHistory } from './config'

const { TextArea } = Input

// 聊天消息结构：角色 + 内容
type ChatMessage = { role: 'user' | 'assistant'; content: string }

// 会话里的一条交互记录：请求/响应各带 HTTP 元信息与协议 JSON 正文
type InteractionRecord = {
  request: { method: string; url: string; headers: Record<string, string>; body: unknown } | null
  response: { status: number; statusText: string; headers: Record<string, string>; body: unknown } | null
}

// headers 转成若干行注释文本
function headerCommentLines(headers: Record<string, string>): string[] {
  const entries = Object.entries(headers)
  if (entries.length === 0) return ['headers: (none)']
  return ['headers:', ...entries.map(([k, v]) => `  ${k}: ${v}`)]
}

// 生成 JSONC：元信息（method/URL、status、headers）以 // 注释写在 JSON 正文之前
function buildJsonc(metaLines: string[] | null, body: unknown): string {
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
  return ['  {', '    "request": {', ...requestLines, '    },', '    "response": {', ...responseLines, '    }', '  }'].join('\n')
}

// 把整个会话渲染成 JSONC 数组：旧项在前、新项在后（持续追加）
function renderSessionJsonc(records: InteractionRecord[]): string {
  return `[\n${records.map(renderInteractionJsonc).join(',\n')}\n]`
}

export default function App() {
  // ---- 配置区状态 ----
  const [protocol, setProtocol] = useState<Protocol>('anthropic-messages')
  // API URL / Key 与协议相互独立：初始取全局历史最近一条（无则留空），切协议时保持不变
  const [baseUrl, setBaseUrl] = useState(() => getHistory('url')[0] ?? '')
  const [apiKey, setApiKey] = useState(() => getHistory('key')[0] ?? '')
  // 全局历史列表（不区分协议，驱动 AutoComplete 下拉）
  const [urlHistory, setUrlHistory] = useState<string[]>(() => getHistory('url'))
  const [keyHistory, setKeyHistory] = useState<string[]>(() => getHistory('key'))
  const [models, setModels] = useState<string[]>([])
  const [model, setModel] = useState<string | undefined>(undefined)
  const [fetching, setFetching] = useState(false)
  const [stream, setStream] = useState(true)

  // ---- 聊天区状态 ----
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)

  // ---- 日志区状态 ----
  // sessionId：每个会话一个，切换即换日志文件
  const [sessionId, setSessionId] = useState(() => crypto.randomUUID())
  // 当前会话的 verbose 原样日志文本（初始从文件全量拉取，之后实时追加）
  const [logText, setLogText] = useState('')
  // Tab2「会话」的显示数据：完整交互记录数组（一项 = 一个请求 + 一个回复）
  const [sessionJson, setSessionJson] = useState<InteractionRecord[]>([])
  // Tab1「请求/响应」的显示数据：只保留最新一次交互（与 sessionJson 独立持有，清空互不影响）
  const [currentPair, setCurrentPair] = useState<InteractionRecord | null>(null)
  const logBoxRef = useRef<HTMLDivElement>(null)
  const jsonBoxRef = useRef<HTMLDivElement>(null)

  // 当前协议对应的元数据（Endpoint 等）
  const meta = PROTOCOLS.find((p) => p.value === protocol)!

  // 切换协议：只重置模型（URL / Key 与协议无关，保持不变，历史也可跨协议复用）
  const onProtocolChange = (value: Protocol) => {
    setProtocol(value)
    setModels([])
    setModel(undefined)
  }

  // 成功使用后记录配置历史：去重置顶（重复值不新增，只置顶），并刷新下拉列表
  const recordConfigUsed = (url: string, key: string) => {
    setUrlHistory(pushHistory('url', url))
    setKeyHistory(pushHistory('key', key))
  }

  // 新会话：生成新 sessionId（新日志文件），清空聊天与日志
  const newSession = () => {
    setSessionId(crypto.randomUUID())
    setMessages([])
    setLogText('')
    setSessionJson([])
    setCurrentPair(null)
  }

  // 三个 Tab 各自的清空：只清自己的显示数据，互不影响
  const clearTab1 = () => setCurrentPair(null) // Tab1「请求/响应」
  const clearTab2 = () => setSessionJson([]) // Tab2「会话」
  const clearTab3 = () => setLogText('') // Tab3「verbose」

  // sessionId 变化时（首次进入 / 新会话）：从 Server 全量拉取该会话的 verbose 日志与交互记录
  useEffect(() => {
    fetch(`/api/logs/${sessionId}`)
      .then((res) => (res.ok ? res.text() : ''))
      .then((text) => setLogText(text))
      .catch(() => {})
    fetch(`/api/logs/${sessionId}/json`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        const list = Array.isArray(data) ? data : []
        setSessionJson(list)
        setCurrentPair(list.length > 0 ? list[list.length - 1] : null)
      })
      .catch(() => {})
  }, [sessionId])

  // 订阅实时日志流：只追加当前会话的事件（换会话后 EventSource 重建）
  useEffect(() => {
    const es = new EventSource('/api/logs/stream')
    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        // 只显示当前会话的日志，其他会话（其他标签页等）忽略
        if (data.sessionId !== sessionId) return
        if (typeof data.text === 'string') {
          setLogText((prev) => prev + data.text + '\n\n')
        }
        // 新请求：追加一条交互记录到 Tab2（带元信息与请求体），响应暂空；Tab1 同步为最新一条
        if (data.requestJson !== undefined) {
          const newItem: InteractionRecord = { request: { method: data.method, url: data.url, headers: data.headers ?? {}, body: data.requestJson }, response: null }
          setSessionJson((prev) => [...prev, newItem])
          setCurrentPair(newItem)
        }
        // 收到响应头：记录 status 与 headers（更新最后一条的 response）
        if (data.type === 'response') {
          const patch = (prev: InteractionRecord[]) => {
            if (prev.length === 0) return prev
            const next = [...prev]
            const last = next[next.length - 1]
            next[next.length - 1] = { ...last, response: { status: data.status, statusText: data.statusText, headers: data.headers ?? {}, body: last.response?.body ?? null } }
            return next
          }
          setSessionJson(patch)
          setCurrentPair((prev) => (prev ? { ...prev, response: { status: data.status, statusText: data.statusText, headers: data.headers ?? {}, body: prev.response?.body ?? null } } : prev))
        }
        // 聚合后的完整响应正文：更新最后一条交互的 response.body
        if (data.currentResponse !== undefined && data.currentResponse !== null) {
          const aggregated = data.currentResponse
          const patch = (prev: InteractionRecord[]) => {
            if (prev.length === 0) return prev
            const next = [...prev]
            const last = next[next.length - 1]
            next[next.length - 1] = {
              ...last,
              response: { status: last.response?.status ?? 0, statusText: last.response?.statusText ?? '', headers: last.response?.headers ?? {}, body: aggregated },
            }
            return next
          }
          setSessionJson(patch)
          setCurrentPair((prev) =>
            prev
              ? { ...prev, response: { status: prev.response?.status ?? 0, statusText: prev.response?.statusText ?? '', headers: prev.response?.headers ?? {}, body: aggregated } }
              : prev,
          )
        }
      } catch {
        // 心跳等无法解析的内容直接忽略
      }
    }
    return () => es.close()
  }, [sessionId])

  // 日志面板自动滚到底部：verbose 与 JSON 各自滚动
  useEffect(() => {
    const el = logBoxRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [logText])

  useEffect(() => {
    const el = jsonBoxRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [sessionJson])

  // Fetch Models：调用当前协议的模型接口，返回模型列表
  const fetchModels = async () => {
    if (!baseUrl || !apiKey) {
      message.warning('请先填写 API URL 和 API Key')
      return
    }
    setFetching(true)
    try {
      const res = await fetch(meta.modelsEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ baseUrl, apiKey, sessionId }),
      })
      const data = await res.json()
      if (!res.ok) {
        throw new Error(data.error || `HTTP ${res.status}`)
      }
      setModels(data.models ?? [])
      // 如果实际使用的地址与填写的不一致（自动上溯过），提示用户，避免困惑
      if (data.usedBaseUrl && data.usedBaseUrl !== baseUrl) {
        message.info(`模型列表来自 ${data.usedBaseUrl}`)
      }
      // 成功拉到模型后记录本次使用的配置到历史（去重置顶）
      recordConfigUsed(baseUrl, apiKey)
      // 拿到列表后默认选中第一个
      if (data.models?.length) {
        setModel(data.models[0])
      }
    } catch (err) {
      message.error(String(err))
    } finally {
      setFetching(false)
    }
  }

  // 发送消息：流式 / 非流式两条路径
  const handleSend = async () => {
    const text = input.trim()
    if (!text || sending) return
    if (!baseUrl || !apiKey || !model) {
      message.warning('请先填写 API URL / API Key 并选择模型')
      return
    }
    const userMessage: ChatMessage = { role: 'user', content: text }
    // 请求携带的消息：历史 + 新用户消息
    const requestMessages = [...messages, userMessage]
    // 先放一个空的助手气泡，流式时逐段填充（打字机效果）
    setMessages([...requestMessages, { role: 'assistant', content: '' }])
    setInput('')
    setSending(true)
    try {
      const res = await fetch(meta.chatEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ baseUrl, apiKey, model, messages: requestMessages, stream, sessionId }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => null)
        throw new Error(data?.error || `HTTP ${res.status}`)
      }

      // 更新最后一条助手消息的内容
      const appendAssistant = (delta: string) => {
        setMessages((prev) => {
          const next = [...prev]
          const last = next[next.length - 1]
          next[next.length - 1] = { role: 'assistant', content: last.content + delta }
          return next
        })
      }

      if (!stream) {
        // 非流式：一次性拿到完整文本
        const data = await res.json()
        appendAssistant(data.text ?? '')
        // 聊天成功：记录本次使用的配置到历史
        recordConfigUsed(baseUrl, apiKey)
        return
      }

      // 流式：读 SSE 响应体，按空行切分事件，逐 delta 追加
      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let idx: number
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const raw = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          for (const line of raw.split('\n')) {
            if (!line.startsWith('data: ')) continue
            const data = line.slice(6).trim()
            if (data === '[DONE]') continue
            try {
              const parsed = JSON.parse(data)
              if (typeof parsed.delta === 'string') {
                appendAssistant(parsed.delta)
              }
            } catch {
              // 无法解析的单行直接忽略
            }
          }
        }
      }
      // 流式正常读完（收到连接结束）：记录本次使用的配置到历史
      recordConfigUsed(baseUrl, apiKey)
    } catch (err) {
      message.error(String(err))
      // 失败时移除那个空的助手气泡（配置不记入历史）
      setMessages((prev) => prev.slice(0, -1))
    } finally {
      setSending(false)
    }
  }

  // Tab1 显示"最新一次"请求/响应（来自独立数据 currentPair），元信息以 // 注释写在 JSON 前（JSONC）
  const requestJsonc = currentPair?.request
    ? buildJsonc([`${currentPair.request.method} ${currentPair.request.url}`, ...headerCommentLines(currentPair.request.headers)], currentPair.request.body)
    : ''
  const responseJsonc = currentPair?.response
    ? buildJsonc([`${currentPair.response.status} ${currentPair.response.statusText}`, ...headerCommentLines(currentPair.response.headers)], currentPair.response.body)
    : ''
  // Tab2 显示整个会话：JSONC 数组，一项 = 一个请求 + 一个回复（各自的元信息以注释写在正文前）
  const sessionJsonText = sessionJson.length > 0 ? renderSessionJsonc(sessionJson) : ''

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'row', background: '#f5f5f5', boxSizing: 'border-box', padding: 12, gap: 12 }}>
      {/* ---- 左侧：配置区 + 聊天区（占 40%） ---- */}
      <div style={{ flex: '0 0 40%', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* 顶部配置区：三行布局 */}
        <Card size="small" title="Agent Client 配置">
          <Space direction="vertical" size="small" style={{ width: '100%' }}>
            {/* 第一行：协议（无标签）+ API URL + API Key，全部 small */}
            <Space wrap>
              <Select
                value={protocol}
                onChange={onProtocolChange}
                options={PROTOCOLS.map((p) => ({ value: p.value, label: p.label }))}
                size="small"
                popupMatchSelectWidth={false}
                style={{ width: 170 }}
              />
              <AutoComplete
                value={baseUrl}
                onChange={setBaseUrl}
                options={urlHistory.map((h) => ({ value: h }))}
                placeholder="API URL"
                size="small"
                popupMatchSelectWidth={false}
                style={{ width: 320 }}
              />
              <AutoComplete
                value={apiKey}
                onChange={setApiKey}
                options={keyHistory.map((h) => ({ value: h }))}
                placeholder="API Key"
                size="small"
                popupMatchSelectWidth={false}
                style={{ width: 180 }}
              />
            </Space>
            {/* 第二行：模型选择 + Fetch Models（在右） */}
            <Space wrap>
              <AutoComplete
                value={model}
                onChange={setModel}
                options={models.map((m) => ({ value: m }))}
                placeholder="选择或输入模型"
                size="small"
                popupMatchSelectWidth={false}
                style={{ width: 200 }}
              />
              <Button size="small" onClick={fetchModels} loading={fetching}>
                Fetch Models
              </Button>
            </Space>
            {/* 第三行：流式开关 */}
            <Space wrap>
              <span>流式</span>
              <Switch size="small" checked={stream} onChange={setStream} />
            </Space>
          </Space>
        </Card>

        {/* 聊天区 */}
        <Card
          size="small"
          title="聊天"
          extra={
            <Button size="small" onClick={newSession}>
              新会话
            </Button>
          }
          style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}
          styles={{ body: { flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' } }}
        >
          <div style={{ flex: 1, overflowY: 'auto', padding: 4 }}>
            {messages.length === 0 && (
              <div style={{ color: '#999', textAlign: 'center', marginTop: 40 }}>填写配置并 Fetch Models 后，开始聊天吧</div>
            )}
            {messages.map((m, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start', marginBottom: 10 }}>
                <div
                  style={{
                    maxWidth: '70%',
                    padding: '8px 12px',
                    borderRadius: 8,
                    background: m.role === 'user' ? '#1677ff' : '#ffffff',
                    color: m.role === 'user' ? '#ffffff' : '#000000',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    boxShadow: '0 1px 2px rgba(0,0,0,0.1)',
                  }}
                >
                  {m.content || (i === messages.length - 1 && sending ? '…' : '')}
                </div>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <TextArea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="输入消息，Enter 发送，Shift+Enter 换行"
              autoSize={{ minRows: 1, maxRows: 4 }}
              size="small"
              onPressEnter={(e) => {
                if (!e.shiftKey) {
                  e.preventDefault()
                  handleSend()
                }
              }}
            />
            <Button type="primary" size="small" onClick={handleSend} loading={sending}>
              发送
            </Button>
          </div>
        </Card>
      </div>

      {/* ---- 右侧：日志面板（占 60%），双 Tab：整合 / verbose ---- */}
      <Card size="small" style={{ flex: '0 0 60%', minWidth: 0, display: 'flex', flexDirection: 'column' }} styles={{ body: { flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden', padding: 0 } }}>
        {/* Tabs 撑满高度：antd Tabs 默认不撑满，用类名控制子元素 */}
        <style>{`
          .logs-tabs { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 0 12px; }
          .logs-tabs .ant-tabs-body-holder { flex: 1; min-height: 0; display: flex; flex-direction: column; }
          .logs-tabs .ant-tabs-body { flex: 1; min-height: 0; display: flex; flex-direction: column; }
          .logs-tabs .ant-tabs-content { min-height: 0; }
          .logs-tabs .ant-tabs-content-active { flex: 1; min-height: 0; display: flex; flex-direction: column; }
          .logs-tabs .ant-tabs-content-active > div { flex: 1; min-height: 0; display: flex; }
        `}</style>
        <Tabs
          className="logs-tabs"
          defaultActiveKey="current"
          size="small"
          items={[
            // Tab1（默认）：上下两个区域，各显示最新一次的 Request / Response（JSONC：元信息为注释）
            {
              key: 'current',
              label: '请求/响应',
              children: (
                <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {/* 本 Tab 自己的清空（只清 Tab1 显示，不影响其他 Tab） */}
                  <div style={{ flex: 'none', display: 'flex', justifyContent: 'flex-end' }}>
                    <Button size="small" onClick={clearTab1}>
                      清空
                    </Button>
                  </div>
                  {/* Request 区：最新一次请求 */}
                  <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: '#111111', color: '#e6e6e6', borderRadius: 6, padding: 10 }}>
                    <div style={{ flex: 'none', color: '#888888', fontSize: 11, marginBottom: 4 }}>Request（最新一次）</div>
                    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', fontFamily: 'Menlo, Consolas, monospace', fontSize: 12, whiteSpace: 'pre' }}>
                      {requestJsonc || '（暂无请求）'}
                    </div>
                  </div>
                  {/* Response 区：最新一次响应（流式已聚合为完整响应） */}
                  <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: '#111111', color: '#e6e6e6', borderRadius: 6, padding: 10 }}>
                    <div style={{ flex: 'none', color: '#888888', fontSize: 11, marginBottom: 4 }}>Response（最新一次，流式已聚合为完整响应）</div>
                    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', fontFamily: 'Menlo, Consolas, monospace', fontSize: 12, whiteSpace: 'pre' }}>
                      {responseJsonc || '（暂无响应）'}
                    </div>
                  </div>
                </div>
              ),
            },
            // Tab2：整个会话 —— JSONC 数组，一个请求配一个回复
            {
              key: 'session',
              label: '会话',
              children: (
                <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ flex: 'none', display: 'flex', justifyContent: 'flex-end' }}>
                    <Button size="small" onClick={clearTab2}>
                      清空
                    </Button>
                  </div>
                  <div
                    ref={jsonBoxRef}
                    style={{ flex: 1, minHeight: 0, overflowY: 'auto', background: '#111111', color: '#e6e6e6', borderRadius: 6, padding: 10, fontFamily: 'Menlo, Consolas, monospace', fontSize: 12, whiteSpace: 'pre', wordBreak: 'break-all' }}
                  >
                    {sessionJsonText || '（暂无会话。这里以数组形式展示整个会话：一项 = 一个请求 + 一个回复，均为协议原生的 JSON）'}
                  </div>
                </div>
              ),
            },
            // Tab3：verbose —— 最底层原样日志（完整 headers / body / 每个 SSE 分片）
            {
              key: 'verbose',
              label: 'verbose',
              children: (
                <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ flex: 'none', display: 'flex', justifyContent: 'flex-end' }}>
                    <Button size="small" onClick={clearTab3}>
                      清空
                    </Button>
                  </div>
                  <div
                    ref={logBoxRef}
                    style={{ flex: 1, minHeight: 0, overflowY: 'auto', background: '#111111', color: '#e6e6e6', borderRadius: 6, padding: 10, fontFamily: 'Menlo, Consolas, monospace', fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}
                  >
                    {logText || '（暂无日志。发送消息或 Fetch Models 后，这里会原样显示所有发出的请求与收到的响应，流式时每个 SSE 分片单独一条）'}
                  </div>
                </div>
              ),
            },
          ]}
        />
      </Card>
    </div>
  )
}
