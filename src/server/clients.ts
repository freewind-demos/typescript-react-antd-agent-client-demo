// 协议客户端封装：三种协议各自的 SDK 调用，统一出口
// 全部注入日志 fetch（middleware），保证 SDK 发出的每个请求都被记录。

import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { createLoggingFetch, type LogEvent } from './middleware'

// 支持的三种协议标识
export type Protocol = 'anthropic-messages' | 'openai-chat-completions' | 'openai-responses'

// 聊天请求的统一入参（三种协议共用）
export type ChatRequest = {
  baseUrl: string
  apiKey: string
  model: string
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>
  stream: boolean
  // 日志事件回调：由调用方绑定到具体会话
  onEvent: (event: LogEvent) => void
}

// 聊天结果：非流式返回完整文本；流式返回文本增量迭代器
export type ChatResult =
  | { stream: false; text: string }
  | { stream: true; iterator: AsyncIterable<string> }

// 按协议创建 SDK 客户端，注入日志 fetch
function createClient(protocol: Protocol, baseUrl: string, apiKey: string, onEvent: (event: LogEvent) => void): Anthropic | OpenAI {
  // 包装全局 fetch：所有经 SDK 发出的 HTTP 请求都会先经过日志中间件
  const loggingFetch = createLoggingFetch(fetch, onEvent)
  if (protocol === 'anthropic-messages') {
    // Anthropic SDK：baseURL 传 API 根地址，SDK 内部拼 /v1/messages
    return new Anthropic({ apiKey, baseURL: baseUrl, fetch: loggingFetch })
  }
  // OpenAI 两个协议共用同一个 SDK，只是调用的资源不同
  return new OpenAI({ apiKey, baseURL: baseUrl, fetch: loggingFetch })
}

// 从 Anthropic 响应里提取纯文本：content 是 block 数组，只拼 text block
function extractAnthropicText(content: Anthropic.Message['content']): string {
  let text = ''
  for (const block of content) {
    if (block.type === 'text') {
      text += block.text
    }
  }
  return text
}

// Anthropic Messages 协议聊天
async function chatWithAnthropic(req: ChatRequest): Promise<ChatResult> {
  const client = createClient('anthropic-messages', req.baseUrl, req.apiKey, req.onEvent) as Anthropic
  // Anthropic 的 system prompt 是独立字段，不在 messages 数组里，需要拆出来
  const system = req.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n')
  const conversation = req.messages.filter((m) => m.role !== 'system').map((m) => ({
    role: m.role as 'user' | 'assistant',
    content: m.content,
  }))

  if (!req.stream) {
    // 非流式：一次拿完整响应
    const res = await client.messages.create({
      model: req.model,
      max_tokens: 4096,
      system: system || undefined,
      messages: conversation,
    })
    return { stream: false, text: extractAnthropicText(res.content) }
  }

  // 流式：SDK 返回事件流（APIPromise 包装，需要先 await），逐事件提取文本增量
  const stream = await client.messages.create({
    model: req.model,
    max_tokens: 4096,
    system: system || undefined,
    messages: conversation,
    stream: true,
  })
  return {
    stream: true,
    iterator: (async function* () {
      for await (const event of stream) {
        // content_block_delta 且 delta 是 text_delta 类型时才有文本增量（0.117 版 SDK 的事件类型）
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          yield event.delta.text
        }
      }
    })(),
  }
}

// OpenAI Chat Completions 协议聊天
async function chatWithOpenAiChat(req: ChatRequest): Promise<ChatResult> {
  const client = createClient('openai-chat-completions', req.baseUrl, req.apiKey, req.onEvent) as OpenAI
  const messages = req.messages.map((m) => ({ role: m.role, content: m.content }))

  if (!req.stream) {
    const res = await client.chat.completions.create({ model: req.model, messages })
    return { stream: false, text: res.choices[0]?.message?.content ?? '' }
  }

  const stream = await client.chat.completions.create({ model: req.model, messages, stream: true })
  return {
    stream: true,
    iterator: (async function* () {
      for await (const chunk of stream) {
        // 每个 chunk 的 choices[0].delta.content 是文本增量，可能为 null
        const delta = chunk.choices[0]?.delta?.content
        if (delta) {
          yield delta
        }
      }
    })(),
  }
}

// OpenAI Responses 协议聊天
async function chatWithOpenAiResponses(req: ChatRequest): Promise<ChatResult> {
  const client = createClient('openai-responses', req.baseUrl, req.apiKey, req.onEvent) as OpenAI
  // Responses API 的 input 用消息数组，content 直接传字符串
  const input = req.messages.map((m) => ({ role: m.role, content: m.content }))

  if (!req.stream) {
    const res = await client.responses.create({ model: req.model, input })
    return { stream: false, text: res.output_text }
  }

  const stream = await client.responses.create({ model: req.model, input, stream: true })
  return {
    stream: true,
    iterator: (async function* () {
      for await (const event of stream) {
        // 文本增量事件：response.output_text.delta
        if (event.type === 'response.output_text.delta') {
          yield event.delta
        }
      }
    })(),
  }
}

// 统一聊天入口：按协议分发到对应实现
export function chatWithProtocol(protocol: Protocol, req: ChatRequest): Promise<ChatResult> {
  switch (protocol) {
    case 'anthropic-messages':
      return chatWithAnthropic(req)
    case 'openai-chat-completions':
      return chatWithOpenAiChat(req)
    case 'openai-responses':
      return chatWithOpenAiResponses(req)
  }
}

// 获取模型列表：走对应 SDK 的 models 接口，同样经过日志中间件
export async function listModels(protocol: Protocol, baseUrl: string, apiKey: string, onEvent: (event: LogEvent) => void): Promise<string[]> {
  const client = createClient(protocol, baseUrl, apiKey, onEvent)
  const page = await client.models.list()
  const ids: string[] = []
  // Page 对象是可异步迭代的，会自己翻页
  for await (const model of page) {
    ids.push(model.id)
  }
  return ids
}
