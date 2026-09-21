// 主界面：配置区（协议/API URL/API Key/Fetch Models/模型/流式开关/新会话）
// + 微信式聊天区 + 日志面板（实时原样展示当前会话的所有请求与响应）

import { useEffect, useRef, useState } from 'react'
import { Button, Card, Flex, Input, InputNumber, Popconfirm, Space, Splitter, Switch, Tabs, Typography, message } from 'antd'
import { PROTOCOLS } from './protocols'
import { appendChunkText, appendRawEvent, emptyDelta, flushDeltaPending, renderDeltaText, type DeltaState } from './delta'
import { getProviders, getSelectedProviderId, saveProviders, saveSelectedProviderId, type Provider } from './config'
import ProviderModal, { type ProviderDraft } from './ProviderModal'
import LogBox from './components/LogBox'
import MessageBubble, { type ChatMessage, type ToolCallInfo } from './components/MessageBubble'

const { TextArea } = Input
const { Text } = Typography

// 最大生成 tokens 的默认值（16K）
const DEFAULT_MAX_TOKENS = 16_384

// 一条来自 chat 响应的结构化事件（与 Server 的 ChatEvent 对齐）：
// text = 文本增量；tool = 一次工具调用（含本地执行结果）
type ChatEvent = { type: 'text'; delta: string } | { type: 'tool'; name: string; input: { command: string; timeout?: number }; output: string; exitCode: number }

// 会话里的一条交互记录：请求/响应各带 HTTP 元信息与协议 JSON 正文
type InteractionRecord = {
  request: { method: string; url: string; headers: Record<string, string>; body: unknown } | null
  response: { status: number; statusText: string; headers: Record<string, string>; body: unknown } | null
}

// 会话与 Provider 的绑定指纹：id + 协议 + API URL + 模型，任一变化都视为“换了 Provider”
function providerFingerprint(provider: Provider): string {
  return `${provider.id}|${provider.protocol}|${provider.baseUrl}|${provider.model}`
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
  const lines = ['  {', '    "request": {', ...requestLines, '    },', '    "response": {', ...responseLines, '    }']
  lines.push('  }')
  return lines.join('\n')
}

// 把整个会话渲染成 JSONC 数组：旧项在前、新项在后（持续追加）
function renderSessionJsonc(records: InteractionRecord[]): string {
  return `[\n${records.map(renderInteractionJsonc).join(',\n')}\n]`
}

export default function App() {
  // ---- 配置区状态：Provider 列表（持久化）+ 当前选中 + 添加/编辑弹窗 ----
  const [providers, setProviders] = useState<Provider[]>(() => getProviders())
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(() => getSelectedProviderId())
  const [modalOpen, setModalOpen] = useState(false)
  const [editingProvider, setEditingProvider] = useState<Provider | null>(null)
  // 全局流式开关（与具体 Provider 无关）
  const [stream, setStream] = useState(true)
  // 全局最大生成 tokens（与具体 Provider 无关；界面可见、可改）
  const [maxTokens, setMaxTokens] = useState(DEFAULT_MAX_TOKENS)
  // 当前会话绑定的 Provider 指纹：会话历史是协议原生报文（见 server/conversation.ts），
  // 换协议、换 Provider、或改掉它的 URL/模型，历史都不再通用，必须开新会话
  const [sessionProviderKey, setSessionProviderKey] = useState<string | null>(null)

  // ---- 聊天区状态 ----
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)

  // ---- 日志区状态 ----
  // sessionId：每个会话一个，切换即换日志文件
  const [sessionId, setSessionId] = useState<string>(() => crypto.randomUUID())
  // 当前会话的 verbose 原样日志文本（初始从文件全量拉取，之后实时追加）
  const [logText, setLogText] = useState('')
  // Tab3「delta」的状态：chunk 按 SSE 事件边界累积合并，其余事件为原样块
  const [deltaState, setDeltaState] = useState<DeltaState>(() => emptyDelta())
  // Tab2「会话」的显示数据：完整交互记录数组（一项 = 一个请求 + 一个回复）
  const [sessionJson, setSessionJson] = useState<InteractionRecord[]>([])
  // Tab1「请求/响应」的显示数据：只保留最新一次交互（与 sessionJson 独立持有，清空互不影响）
  const [currentPair, setCurrentPair] = useState<InteractionRecord | null>(null)
  const logBoxRef = useRef<HTMLDivElement>(null)
  const deltaBoxRef = useRef<HTMLDivElement>(null)
  const jsonBoxRef = useRef<HTMLDivElement>(null)

  // 日志面板当前选中的 Tab（右侧清空按钮据此清对应的数据）
  const [activeLogTab, setActiveLogTab] = useState('current')

  // 当前选中的 Provider（选中项不存在时回退到第一条）
  const selectedProvider = providers.find((p) => p.id === selectedProviderId) ?? providers[0] ?? null
  // 对应协议的元数据（Endpoint 等）
  const selectedMeta = selectedProvider ? PROTOCOLS.find((p) => p.value === selectedProvider.protocol)! : null

  // 持久化：更新 Provider 列表
  const updateProviders = (next: Provider[]) => {
    setProviders(next)
    saveProviders(next)
  }
  // 持久化：切换选中的 Provider。
  // 切换 Provider 即换会话：历史是协议原生报文，不同 Provider（哪怕同协议）的上游与模型都不同，
  // 直接复用会把 A 的完整对话发给 B，既会串线也可能泄露内容。
  const selectProvider = (id: string | null) => {
    if (id === selectedProviderId) return
    setSelectedProviderId(id)
    saveSelectedProviderId(id)
    newSession()
  }
  // 打开"添加"弹窗
  const openAddProvider = () => {
    setEditingProvider(null)
    setModalOpen(true)
  }
  // 打开"编辑"弹窗
  const openEditProvider = (p: Provider) => {
    setEditingProvider(p)
    setModalOpen(true)
  }
  // 弹窗保存：新增或更新（新增后自动选中）
  const submitProvider = (draft: ProviderDraft) => {
    if (editingProvider) {
      updateProviders(providers.map((p) => (p.id === editingProvider.id ? { ...p, ...draft } : p)))
    } else {
      const created: Provider = { id: crypto.randomUUID(), ...draft }
      updateProviders([...providers, created])
      selectProvider(created.id)
    }
    setModalOpen(false)
  }
  // 删除 Provider（若删的是当前选中项，选中回退到剩下第一条）
  const deleteProvider = (p: Provider) => {
    const next = providers.filter((x) => x.id !== p.id)
    updateProviders(next)
    if (selectedProvider?.id === p.id) selectProvider(next[0]?.id ?? null)
  }

  // 清空本地展示并与指定 sessionId 对齐（新建会话 / 换协议时用）
  const resetConversation = (nextSessionId: string) => {
    setSessionId(nextSessionId)
    setMessages([])
    setLogText('')
    setDeltaState(emptyDelta())
    setSessionJson([])
    setCurrentPair(null)
    setSessionProviderKey(null)
  }

  // 新会话：生成新 sessionId（新日志文件），清空聊天与日志
  const newSession = () => resetConversation(crypto.randomUUID())

  // 四个 Tab 各自的清空：只清自己的显示数据，互不影响
  const clearTab1 = () => setCurrentPair(null) // Tab1「请求/响应」
  const clearTab2 = () => setSessionJson([]) // Tab2「会话」
  const clearTabDelta = () => setDeltaState(emptyDelta()) // Tab3「delta」
  const clearTabRaw = () => setLogText('') // Tab4「raw」

  // 清空当前选中的 Tab（按钮在 Tab 标题行最右侧）
  const clearCurrentTab = () => {
    if (activeLogTab === 'current') clearTab1()
    else if (activeLogTab === 'session') clearTab2()
    else if (activeLogTab === 'delta') clearTabDelta()
    else clearTabRaw()
  }

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
  // 【已知取舍 · Demo 不修】服务端是广播全量会话事件的，这里才按 sessionId 过滤；
  // 所以本页也会收到（并丢弃）其他会话的完整请求头与响应，浪费流量且扩大敏感信息暴露面。
  // 原因：Demo 通常只开一个页面；要修需订阅时把 sessionId 带给服务端，由服务端只推对应会话。
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
        // delta Tab：chunk 的原始文本按 SSE 事件边界累积（未收完的尾巴留到下次拼接，保证 event:/data: 同块）；
        // 一轮流结束或中断时把尾巴冲出；其余协议事件原样成块
        if (data.type === 'chunk' && typeof data.chunkText === 'string') {
          setDeltaState((prev) => appendChunkText(prev, data.timestamp, data.chunkText))
        } else if (data.type === 'end' || data.type === 'error') {
          setDeltaState((prev) => {
            const flushed = flushDeltaPending(prev, data.timestamp)
            return typeof data.text === 'string' ? appendRawEvent(flushed, data.text) : flushed
          })
        } else if (typeof data.text === 'string') {
          setDeltaState((prev) => appendRawEvent(prev, data.text))
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
        // SDK 真实响应正文：更新最后一条交互的 response.body
        if (data.responseBody !== undefined && data.responseBody !== null) {
          const aggregated = data.responseBody
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
    const el = deltaBoxRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [deltaState])

  useEffect(() => {
    const el = jsonBoxRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [sessionJson])

  // 消费一条 chat 事件，按真实时序构建聊天区气泡：
  //   text → 续写到当前助手气泡（没有则新起）
  //   tool → 在此处插入「tool call + tool result」两段气泡，并新起一个助手气泡接续后续文本
  // 流式（逐条到达）与非流式（一次性回放 events）共用这一个函数。
  const applyChatEvent = (ev: ChatEvent) => {
    if (ev.type === 'text') {
      setMessages((prev) => {
        const next = [...prev]
        const last = next[next.length - 1]
        if (last && last.role === 'assistant') {
          next[next.length - 1] = { role: 'assistant', content: last.content + ev.delta }
        } else {
          next.push({ role: 'assistant', content: ev.delta })
        }
        return next
      })
      return
    }
    const toolCall: ToolCallInfo = { name: ev.name, input: ev.input, output: ev.output, exitCode: ev.exitCode }
    setMessages((prev) => {
      const next = [...prev]
      const toolMessages: ChatMessage[] = [
        { role: 'tool', toolPhase: 'call', content: '', toolInfo: toolCall },
        { role: 'tool', toolPhase: 'result', content: '', toolInfo: toolCall },
      ]
      const newAssistant: ChatMessage = { role: 'assistant', content: '' }
      const lastIndex = next.length - 1
      const last = lastIndex >= 0 ? next[lastIndex] : undefined
      if (last?.role === 'assistant' && last.content !== '') {
        // 本轮有 preamble：保留其独立气泡（位于工具之前），其后插入工具 + 新空助手气泡
        next.splice(lastIndex + 1, 0, ...toolMessages, newAssistant)
      } else if (last?.role === 'assistant') {
        // 空助手占位（本轮无 preamble）：原地替换为 工具 + 新空助手气泡
        next.splice(lastIndex, 1, ...toolMessages, newAssistant)
      } else {
        // 兜底：尾部不是助手气泡时直接追加
        next.push(...toolMessages, newAssistant)
      }
      return next
    })
  }

  // 发送消息：流式 / 非流式两条路径
  const handleSend = async () => {
    const text = input.trim()
    if (!text || sending) return
    const provider = selectedProvider
    const meta = selectedMeta
    if (!provider || !meta) {
      message.warning('请先添加并选择一个 Provider')
      return
    }
    // 会话与 Provider 绑定：指纹不一致（换了 Provider，或改了它的协议/URL/模型）就开新会话，
    // 避免把上一个 Provider 的协议原生历史发给新的上游。
    //（服务端也有同样的协议保护：协议不一致时视为新会话，见 server/conversation.ts）
    let activeSessionId = sessionId
    const fingerprint = providerFingerprint(provider)
    if (sessionProviderKey !== null && sessionProviderKey !== fingerprint) {
      activeSessionId = crypto.randomUUID()
      resetConversation(activeSessionId)
    }
    setSessionProviderKey(fingerprint)

    const userMessage: ChatMessage = { role: 'user', content: text }
    // 只把「这一句」发给 Server：会话历史由 Server 按 sessionId 持有、只追加不重建，
    // 前端不再自己拼接/合并历史（那样会改写报文，丢掉 tool_calls / thinking 等字段）。
    // 聊天区追加用户消息与空的助手气泡（流式时逐段填充；工具气泡会在调用点按真实时序插入，
    // 并在其后新起助手气泡接续后续回答）
    setMessages((prev) => [...prev, userMessage, { role: 'assistant', content: '' }])
    setInput('')
    setSending(true)
    try {
      const res = await fetch(meta.chatEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ baseUrl: provider.baseUrl, apiKey: provider.apiKey, model: provider.model, text, stream, sessionId: activeSessionId, maxTokens }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => null)
        throw new Error(data?.error || `HTTP ${res.status}`)
      }

      if (!stream) {
        // 非流式：一次性拿到完整事件序列，按顺序回放成气泡
        const data = await res.json()
        const events: ChatEvent[] = Array.isArray(data.events) ? data.events : []
        for (const ev of events) applyChatEvent(ev)
        return
      }

      // 流式：读 SSE 响应体，按空行切分事件，逐 delta 追加
      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      // Server 在流中途失败时会补发一条 { error } 事件，这里收集起来、流读完后抛出提示
      let streamError: string | null = null
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
              if (parsed.type === 'text' || parsed.type === 'tool') {
                applyChatEvent(parsed)
              } else if (typeof parsed.error === 'string') {
                streamError = parsed.error
              }
            } catch {
              // 无法解析的单行直接忽略
            }
          }
        }
      }
      // 流中途失败：抛出，由外层 catch 弹出错误提示（不记入配置历史）
      if (streamError) {
        throw new Error(streamError)
      }
    } catch (err) {
      const errorText = err instanceof Error ? err.message : String(err)
      // 失败不再弹 Toast，而是作为一条错误条目按时间顺序写进聊天流；
      // 请求阶段就失败时顺手去掉那个空的助手气泡（流式已输出过内容则保留，避免抹掉已看到的内容）
      setMessages((prev) => {
        const next = [...prev]
        const last = next[next.length - 1]
        if (last && last.role === 'assistant' && last.content === '') next.pop()
        next.push({ role: 'error', content: errorText })
        return next
      })
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
  // Tab3 显示 delta 视图（与 raw 同内容，但以完整 SSE 事件为单位、结构一致的连续事件已合并）
  const deltaText = renderDeltaText(deltaState)

  // 复制当前选中 Tab 正在显示的内容（与"清空"按钮一样常驻显示）
  const copyCurrentTab = async () => {
    let text = ''
    if (activeLogTab === 'current') {
      // Tab1：上下两段一起复制，各自加一行注释标明来源
      const sections: string[] = []
      if (requestJsonc) sections.push(`// ===== Request =====\n${requestJsonc}`)
      if (responseJsonc) sections.push(`// ===== Response =====\n${responseJsonc}`)
      text = sections.join('\n\n')
    } else if (activeLogTab === 'session') {
      text = sessionJsonText
    } else if (activeLogTab === 'delta') {
      text = deltaText
    } else {
      text = logText
    }
    if (!text) {
      message.warning('暂无内容可复制')
      return
    }
    try {
      await navigator.clipboard.writeText(text)
      message.success('已复制')
    } catch (err) {
      message.error(`复制失败：${String(err)}`)
    }
  }

  return (
    <Flex style={{ height: '100vh', background: '#f5f5f5', boxSizing: 'border-box', padding: 12, overflow: 'hidden' }}>
      {/* 左右分栏：可拖动调整宽度（左侧默认 40%） */}
      <Splitter style={{ height: '100%' }}>
        {/* ---- 左侧面板：配置区 + 聊天区 ---- */}
        <Splitter.Panel defaultSize="40%" min="25%" max="70%">
          <Flex vertical gap={12} style={{ height: '100%', minWidth: 0, paddingRight: 6 }}>
        {/* 全局开关（与具体 Provider 无关，放在最外层） */}
        <Flex align="center" gap={16}>
          <Flex align="center" gap={8}>
            <Text>流式</Text>
            <Switch size="small" checked={stream} onChange={setStream} />
          </Flex>
          <Flex align="center" gap={8}>
            <Text>最大 Tokens</Text>
            <InputNumber size="small" min={1} step={1024} value={maxTokens} onChange={(v) => setMaxTokens(v ?? DEFAULT_MAX_TOKENS)} style={{ width: 110 }} />
          </Flex>
        </Flex>

        {/* Providers：可添加 / 编辑 / 删除 / 选择的接入配置列表 */}
        <Card
          size="small"
          title="Providers"
          extra={
            <Button size="small" onClick={openAddProvider}>
              添加
            </Button>
          }
        >
          {providers.length === 0 ? (
            <Text type="secondary">还没有 Provider，点右上角“添加”新建一个</Text>
          ) : (
            <Flex vertical gap={6}>
              {providers.map((p) => {
                const selected = selectedProvider?.id === p.id
                const protocolLabel = PROTOCOLS.find((x) => x.value === p.protocol)?.label ?? p.protocol
                return (
                  // 发送期间禁止切换 Provider：旧请求返回后仍会把它的内容写进已经清空的会话界面
                  <Flex
                    key={p.id}
                    align="center"
                    gap={8}
                    onClick={() => {
                      if (!sending) selectProvider(p.id)
                    }}
                    style={{
                      cursor: sending ? 'not-allowed' : 'pointer',
                      opacity: sending ? 0.6 : 1,
                      padding: '6px 8px',
                      borderRadius: 6,
                      border: `1px solid ${selected ? '#1677ff' : '#f0f0f0'}`,
                      background: selected ? '#e6f4ff' : '#fafafa',
                    }}
                  >
                    <span style={{ color: selected ? '#1677ff' : '#bfbfbf' }}>{selected ? '●' : '○'}</span>
                    <Flex vertical style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.model || '（未填模型）'}</span>
                      {/* 【已知取舍 · Demo 不修】这里明文显示完整 API Key（编辑弹窗也是普通文本框）。
                          原因：本地调试工具，方便一眼核对；要修可掩码显示 + 密码框。 */}
                      <span style={{ fontSize: 11, color: '#8c8c8c', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {protocolLabel} · {p.baseUrl} · {p.apiKey}
                      </span>
                    </Flex>
                    {/* 操作按钮：阻止冒泡，避免点它们时触发整行的"选中" */}
                    <Flex gap={4} align="center" onClick={(e) => e.stopPropagation()}>
                      <Button size="small" type="link" onClick={() => openEditProvider(p)}>
                        编辑
                      </Button>
                      <Popconfirm title="确定删除该 Provider？" okText="删除" cancelText="取消" onConfirm={() => deleteProvider(p)}>
                        <Button size="small" type="link" danger>
                          删除
                        </Button>
                      </Popconfirm>
                    </Flex>
                  </Flex>
                )
              })}
            </Flex>
          )}
        </Card>

        {/* 添加 / 编辑 Provider 弹窗 */}
        <ProviderModal open={modalOpen} initial={editingProvider} sessionId={sessionId} onCancel={() => setModalOpen(false)} onSubmit={submitProvider} />

        {/* 聊天区 */}
        <Card
          size="small"
          title="聊天"
          extra={
            // 发送期间禁用：旧请求返回后仍会把内容写进已经清空的新会话界面
            <Button size="small" disabled={sending} onClick={newSession}>
              新会话
            </Button>
          }
          style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}
          styles={{ body: { flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' } }}
        >
          <Flex vertical style={{ flex: 1, overflowY: 'auto', padding: 4 }}>
            {messages.length === 0 && (
              <Flex justify="center" style={{ marginTop: 40 }}>
                <Text type="secondary">添加并选择一个 Provider 后，开始聊天吧</Text>
              </Flex>
            )}
            {messages.map((m, i) => (
              // pending：列表最后一条且正在发送时，内容还空着就显示省略号
              <MessageBubble key={i} message={m} pending={i === messages.length - 1 && sending} />
            ))}
          </Flex>
          <Flex gap={8} style={{ marginTop: 8 }}>
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
          </Flex>
        </Card>
          </Flex>
        </Splitter.Panel>

        {/* ---- 右侧面板：日志（双 Tab）---- */}
        <Splitter.Panel min="25%">
          <Card size="small" style={{ height: '100%', display: 'flex', flexDirection: 'column', marginLeft: 6 }} styles={{ body: { flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden', padding: 0 } }}>
            {/* Tabs 撑满高度：antd Tabs 默认不撑满，用类名控制子元素 */}
            <style>{`
              /* min-width: 0 逐级加：防止日志里的超长行（不换行文本）把 Tabs 容器撑宽，
                 否则右上角 Copy/清空 会被挤出可视区（前两个 Tab 内容含长 JSON 时最明显） */
              .logs-tabs { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; padding: 0 12px; }
              .logs-tabs .ant-tabs-nav { min-width: 0; }
              .logs-tabs .ant-tabs-nav-extra { flex: none; }
              .logs-tabs .ant-tabs-body-holder { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
              .logs-tabs .ant-tabs-body { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
              .logs-tabs .ant-tabs-content { min-width: 0; min-height: 0; }
              .logs-tabs .ant-tabs-content-active { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
              .logs-tabs .ant-tabs-content-active > div { flex: 1; min-width: 0; min-height: 0; display: flex; }
            `}</style>
            <Tabs
              className="logs-tabs"
              size="small"
              activeKey={activeLogTab}
              onChange={setActiveLogTab}
              tabBarExtraContent={{
                right: (
                  <Space size="small">
                    <Button size="small" onClick={copyCurrentTab}>
                      Copy
                    </Button>
                    <Button size="small" onClick={clearCurrentTab}>
                      清空
                    </Button>
                  </Space>
                ),
              }}
              items={[
                // Tab1（默认）：上下两个区域，各显示最新一次的 Request / Response（JSONC：元信息为注释）
                {
                  key: 'current',
                  label: '请求/响应',
                  children: (
                    <Flex vertical gap={8} style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
                      {/* Request 区：最新一次请求 */}
                      <LogBox label="Request（最新一次）" text={requestJsonc} empty="（暂无请求）" wrap="pre" />
                      {/* Response 区：最新一次响应（流式已聚合为完整响应） */}
                      <LogBox label="Response（最新一次，流式已聚合为完整响应）" text={responseJsonc} empty="（暂无响应）" wrap="pre" />
                    </Flex>
                  ),
                },
                // Tab2：整个会话 —— JSONC 数组，一个请求配一个回复
                {
                  key: 'session',
                  label: '会话',
                  children: (
                    <Flex vertical gap={8} style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
                      <LogBox ref={jsonBoxRef} text={sessionJsonText} empty="（暂无会话。这里以数组形式展示整个会话：一项 = 一个请求 + 一个回复，均为协议原生的 JSON）" wrap="pre" />
                    </Flex>
                  ),
                },
                // Tab3：delta —— 与 raw 同内容，但按完整 SSE 事件展示（event: / data: 同一个块），
                // 并把"结构完全一致"的连续事件合并成一条（便于一眼看清真正有变化的事件）
                //（REQUEST/RESPONSE 等其余块原样）
                {
                  key: 'delta',
                  label: 'delta',
                  children: (
                    <Flex vertical gap={8} style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
                      <LogBox ref={deltaBoxRef} text={deltaText} empty="（暂无日志。与 raw 相同的内容，但以完整 SSE 事件（event: / data:）为单位展示，结构完全一致的连续事件合并成一条）" />
                    </Flex>
                  ),
                },
                // Tab4：raw —— 最底层原样日志（完整 headers / body / 每个 SSE 分片）
                {
                  key: 'raw',
                  label: 'raw',
                  children: (
                    <Flex vertical gap={8} style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
                      <LogBox ref={logBoxRef} text={logText} empty="（暂无日志。发送消息或 Fetch Models 后，这里会原样显示所有发出的请求与收到的响应，流式时每个 SSE 分片单独一条）" />
                    </Flex>
                  ),
                },
              ]}
              />
          </Card>
        </Splitter.Panel>
      </Splitter>
    </Flex>
  )
}
