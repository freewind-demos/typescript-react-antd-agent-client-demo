// 主界面：配置区（协议/API URL/API Key/Fetch Models/模型/流式开关/新会话）
// + 微信式聊天区 + 日志面板（实时原样展示当前会话的所有请求与响应）

import { useEffect, useRef, useState } from 'react'
import { Button, Card, Input, Select, Space, Switch, message } from 'antd'
import { PROTOCOLS, type Protocol } from './protocols'

const { TextArea } = Input

// 聊天消息结构：角色 + 内容
type ChatMessage = { role: 'user' | 'assistant'; content: string }

export default function App() {
  // ---- 配置区状态 ----
  const [protocol, setProtocol] = useState<Protocol>('anthropic-messages')
  const [baseUrl, setBaseUrl] = useState(PROTOCOLS[0].defaultBaseUrl)
  const [apiKey, setApiKey] = useState('')
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
  // 当前会话的完整日志文本（初始从文件全量拉取，之后实时追加）
  const [logText, setLogText] = useState('')
  const logBoxRef = useRef<HTMLDivElement>(null)

  // 当前协议对应的元数据（Endpoint 等）
  const meta = PROTOCOLS.find((p) => p.value === protocol)!

  // 切换协议：重置 API URL 与模型
  const onProtocolChange = (value: Protocol) => {
    setProtocol(value)
    setBaseUrl(PROTOCOLS.find((p) => p.value === value)!.defaultBaseUrl)
    setModels([])
    setModel(undefined)
  }

  // 新会话：生成新 sessionId（新日志文件），清空聊天与日志
  const newSession = () => {
    setSessionId(crypto.randomUUID())
    setMessages([])
    setLogText('')
  }

  // sessionId 变化时（首次进入 / 新会话）：从 Server 全量拉取该会话的日志文件
  useEffect(() => {
    fetch(`/api/logs/${sessionId}`)
      .then((res) => (res.ok ? res.text() : ''))
      .then((text) => setLogText(text))
      .catch(() => {})
  }, [sessionId])

  // 订阅实时日志流：只追加当前会话的事件（换会话后 EventSource 重建）
  useEffect(() => {
    const es = new EventSource('/api/logs/stream')
    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        // 只显示当前会话的日志，其他会话（其他标签页等）忽略
        if (data.sessionId === sessionId && typeof data.text === 'string') {
          setLogText((prev) => prev + data.text + '\n\n')
        }
      } catch {
        // 心跳等无法解析的内容直接忽略
      }
    }
    return () => es.close()
  }, [sessionId])

  // 日志面板自动滚到底部，始终展示最新日志
  useEffect(() => {
    const el = logBoxRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [logText])

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
    } catch (err) {
      message.error(String(err))
      // 失败时移除那个空的助手气泡
      setMessages((prev) => prev.slice(0, -1))
    } finally {
      setSending(false)
    }
  }

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', padding: 12, gap: 12, background: '#f5f5f5', boxSizing: 'border-box' }}>
      {/* ---- 顶部配置区 ---- */}
      <Card size="small" title="Agent Client 配置">
        <Space wrap>
          <span>协议</span>
          <Select
            value={protocol}
            onChange={onProtocolChange}
            options={PROTOCOLS.map((p) => ({ value: p.value, label: p.label }))}
            style={{ width: 220 }}
          />
          <Input placeholder="API URL" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} style={{ width: 320 }} />
          <Input.Password placeholder="API Key" value={apiKey} onChange={(e) => setApiKey(e.target.value)} style={{ width: 260 }} />
          <Button onClick={fetchModels} loading={fetching}>
            Fetch Models
          </Button>
          <Select
            placeholder="选择模型"
            value={model}
            onChange={setModel}
            options={models.map((m) => ({ value: m, label: m }))}
            style={{ width: 260 }}
            showSearch
          />
          <span>流式</span>
          <Switch checked={stream} onChange={setStream} />
          <Button onClick={newSession}>新会话</Button>
        </Space>
      </Card>

      {/* ---- 中间聊天区 ---- */}
      <Card
        size="small"
        title="聊天"
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
            onPressEnter={(e) => {
              if (!e.shiftKey) {
                e.preventDefault()
                handleSend()
              }
            }}
          />
          <Button type="primary" onClick={handleSend} loading={sending}>
            发送
          </Button>
        </div>
      </Card>

      {/* ---- 底部日志面板：max-height + 滚动条，原样展示 ---- */}
      <Card size="small" title="日志（从 Client 视角原样记录 Request / Response / SSE 分片）">
        <div
          ref={logBoxRef}
          style={{
            maxHeight: 260,
            overflowY: 'auto',
            background: '#111111',
            color: '#e6e6e6',
            borderRadius: 6,
            padding: 10,
            fontFamily: 'Menlo, Consolas, monospace',
            fontSize: 12,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
          }}
        >
          {logText || '（暂无日志。发送消息或 Fetch Models 后，这里会原样显示所有发出的请求与收到的响应，流式时每个 SSE 分片单独一条）'}
        </div>
      </Card>
    </div>
  )
}
