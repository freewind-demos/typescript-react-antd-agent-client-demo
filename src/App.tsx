// 主界面：配置区（协议/API URL/API Key/Fetch Models/模型/流式开关/新会话）
// + 微信式聊天区 + 日志面板（实时原样展示当前会话的所有请求与响应）

import { useEffect, useRef, useState } from 'react'
import { AutoComplete, Button, Card, Input, Select, Space, Switch, Tabs, message } from 'antd'
import { PROTOCOLS, type Protocol } from './protocols'
import { getHistory, pushHistory } from './config'

const { TextArea } = Input

// 聊天消息结构：角色 + 内容
type ChatMessage = { role: 'user' | 'assistant'; content: string }

export default function App() {
  // ---- 配置区状态 ----
  const [protocol, setProtocol] = useState<Protocol>('anthropic-messages')
  // 初始值取该协议最近一次成功使用的历史（无历史则留空，不预填厂商默认地址）
  const [baseUrl, setBaseUrl] = useState(() => getHistory('anthropic-messages', 'url')[0] ?? '')
  const [apiKey, setApiKey] = useState(() => getHistory('anthropic-messages', 'key')[0] ?? '')
  // 该协议下已记录的历史列表（驱动 AutoComplete 下拉）
  const [urlHistory, setUrlHistory] = useState<string[]>(() => getHistory('anthropic-messages', 'url'))
  const [keyHistory, setKeyHistory] = useState<string[]>(() => getHistory('anthropic-messages', 'key'))
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
  // 当前会话累积的协议原生 JSON 列表（请求体 + 响应事件，日志面板"JSON"Tab 展示）
  const [sessionJson, setSessionJson] = useState<unknown[]>([])
  const logBoxRef = useRef<HTMLDivElement>(null)
  const jsonBoxRef = useRef<HTMLDivElement>(null)

  // 当前协议对应的元数据（Endpoint 等）
  const meta = PROTOCOLS.find((p) => p.value === protocol)!

  // 切换协议：加载该协议的历史配置（无历史则留空），重置模型；聊天与日志不受影响
  const onProtocolChange = (value: Protocol) => {
    setProtocol(value)
    setBaseUrl(getHistory(value, 'url')[0] ?? '')
    setApiKey(getHistory(value, 'key')[0] ?? '')
    setUrlHistory(getHistory(value, 'url'))
    setKeyHistory(getHistory(value, 'key'))
    setModels([])
    setModel(undefined)
  }

  // 成功使用后记录配置历史：去重置顶（重复值不新增，只置顶），并刷新下拉列表
  const recordConfigUsed = (p: Protocol, url: string, key: string) => {
    setUrlHistory(pushHistory(p, 'url', url))
    setKeyHistory(pushHistory(p, 'key', key))
  }

  // 新会话：生成新 sessionId（新日志文件），清空聊天与日志
  const newSession = () => {
    setSessionId(crypto.randomUUID())
    setMessages([])
    setLogText('')
    setSessionJson([])
  }

  // 清空当前会话的日志显示：之后只显示新产生的日志
  const clearLogs = () => {
    setLogText('')
    setSessionJson([])
  }

  // sessionId 变化时（首次进入 / 新会话）：从 Server 全量拉取该会话的 verbose 日志与结构化 JSON
  useEffect(() => {
    fetch(`/api/logs/${sessionId}`)
      .then((res) => (res.ok ? res.text() : ''))
      .then((text) => setLogText(text))
      .catch(() => {})
    fetch(`/api/logs/${sessionId}/json`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setSessionJson(Array.isArray(data) ? data : []))
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
        // 追加本次事件里的协议原生 JSON（Server 已解析好）
        if (Array.isArray(data.protocolJsons) && data.protocolJsons.length > 0) {
          setSessionJson((prev) => [...prev, ...data.protocolJsons])
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
      // 成功拉到模型后记录本次使用的配置到历史（去重置顶）
      recordConfigUsed(protocol, baseUrl, apiKey)
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
        recordConfigUsed(protocol, baseUrl, apiKey)
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
      recordConfigUsed(protocol, baseUrl, apiKey)
    } catch (err) {
      message.error(String(err))
      // 失败时移除那个空的助手气泡（配置不记入历史）
      setMessages((prev) => prev.slice(0, -1))
    } finally {
      setSending(false)
    }
  }

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'row', background: '#f5f5f5', boxSizing: 'border-box', padding: 12, gap: 12 }}>
      {/* ---- 左侧：配置区 + 聊天区（占 40%） ---- */}
      <div style={{ flex: '0 0 40%', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* 顶部配置区 */}
        <Card size="small" title="Agent Client 配置">
          <Space wrap>
            <span>协议</span>
            <Select
              value={protocol}
              onChange={onProtocolChange}
              options={PROTOCOLS.map((p) => ({ value: p.value, label: p.label }))}
              style={{ width: 220 }}
            />
            <AutoComplete
              value={baseUrl}
              onChange={setBaseUrl}
              options={urlHistory.map((h) => ({ value: h }))}
              placeholder="API URL"
              style={{ width: 320 }}
            />
            <AutoComplete
              value={apiKey}
              onChange={setApiKey}
              options={keyHistory.map((h) => ({ value: h }))}
              placeholder="API Key"
              style={{ width: 260 }}
            />
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

        {/* 聊天区 */}
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
          defaultActiveKey="json"
          tabBarExtraContent={{ right: <Button size="small" onClick={clearLogs}>清空</Button> }}
          items={[
            // JSON Tab（默认）：整个会话的结构化 JSON（请求 headers/body、响应 status/headers、完整回复文本）
            {
              key: 'json',
              label: 'JSON',
              children: (
                <div
                  ref={jsonBoxRef}
                  style={{ flex: 1, minHeight: 0, overflowY: 'auto', background: '#111111', color: '#e6e6e6', borderRadius: 6, padding: 10, fontFamily: 'Menlo, Consolas, monospace', fontSize: 12, whiteSpace: 'pre', wordBreak: 'break-all' }}
                >
                  {sessionJson.length > 0
                    ? JSON.stringify(sessionJson, null, 2)
                    : '（暂无协议 JSON。发送消息或 Fetch Models 后，这里按顺序展示整个会话里协议原生的 JSON：每次请求的请求体、响应的每个事件，不含 HTTP headers 等杂项）'}
                </div>
              ),
            },
            // verbose Tab：最底层原样日志（完整 headers / body / 每个 SSE 分片）
            {
              key: 'verbose',
              label: 'verbose',
              children: (
                <div
                  ref={logBoxRef}
                  style={{ flex: 1, minHeight: 0, overflowY: 'auto', background: '#111111', color: '#e6e6e6', borderRadius: 6, padding: 10, fontFamily: 'Menlo, Consolas, monospace', fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}
                >
                  {logText || '（暂无日志。发送消息或 Fetch Models 后，这里会原样显示所有发出的请求与收到的响应，流式时每个 SSE 分片单独一条）'}
                </div>
              ),
            },
          ]}
        />
      </Card>
    </div>
  )
}
