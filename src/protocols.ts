// 三种协议的定义：标签、对应的 Server Endpoint（聊天 / 模型列表）
// 前端只认协议标识，具体请求走哪个 Endpoint 由这里映射

// 协议枚举：书写顺序与 PROTOCOLS 列表一致（OpenAI 在前，Anthropic 最后）
export type Protocol = 'openai-chat-completions' | 'openai-responses' | 'anthropic-messages'

export type ProtocolMeta = {
  value: Protocol
  label: string
  // 聊天接口
  chatEndpoint: string
  // 模型列表接口
  modelsEndpoint: string
}

// 顺序即下拉展示顺序：OpenAI 两个在前，Anthropic 放在最后
export const PROTOCOLS: ProtocolMeta[] = [
  {
    value: 'openai-chat-completions',
    label: 'OpenAI Chat Completions',
    chatEndpoint: '/api/openai/chat-completions',
    modelsEndpoint: '/api/openai/chat-completions/models',
  },
  {
    value: 'openai-responses',
    label: 'OpenAI Responses',
    chatEndpoint: '/api/openai/responses',
    modelsEndpoint: '/api/openai/responses/models',
  },
  {
    value: 'anthropic-messages',
    label: 'Anthropic Messages',
    chatEndpoint: '/api/anthropic/messages',
    modelsEndpoint: '/api/anthropic/models',
  },
]
