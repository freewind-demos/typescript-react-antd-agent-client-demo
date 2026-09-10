// 三种协议的定义：标签、默认 API 地址、对应的 Server Endpoint
// 前端只认协议标识，具体请求走哪个 Endpoint 由这里映射

export type Protocol = 'anthropic-messages' | 'openai-chat-completions' | 'openai-responses'

export type ProtocolMeta = {
  value: Protocol
  label: string
  // API 根地址的默认值（用户可改）
  defaultBaseUrl: string
  // 聊天接口
  chatEndpoint: string
  // 模型列表接口
  modelsEndpoint: string
}

export const PROTOCOLS: ProtocolMeta[] = [
  {
    value: 'anthropic-messages',
    label: 'Anthropic Messages',
    defaultBaseUrl: 'https://api.anthropic.com',
    chatEndpoint: '/api/anthropic/messages',
    modelsEndpoint: '/api/anthropic/models',
  },
  {
    value: 'openai-chat-completions',
    label: 'OpenAI Chat Completions',
    defaultBaseUrl: 'https://api.openai.com/v1',
    chatEndpoint: '/api/openai/chat-completions',
    modelsEndpoint: '/api/openai/chat-completions/models',
  },
  {
    value: 'openai-responses',
    label: 'OpenAI Responses',
    defaultBaseUrl: 'https://api.openai.com/v1',
    chatEndpoint: '/api/openai/responses',
    modelsEndpoint: '/api/openai/responses/models',
  },
]

// 一条前端展示用的日志：类型 + 格式化好的文本 + 时间戳
export type LogEntry = {
  type: 'request' | 'response' | 'chunk' | 'error' | 'end'
  text: string
  timestamp: number
}
