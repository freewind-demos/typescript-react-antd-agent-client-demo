// 协议分发门面：按协议标识把聊天请求交给对应协议的实现。
// 依赖方向单向：core ← 三个协议实现 ← 本文件。

import { chatWithAnthropic } from './anthropic.js'
import { chatWithOpenAiChat } from './openaiChat.js'
import { chatWithOpenAiResponses } from './openaiResponses.js'
import type { ChatEvent, ChatRequest, Protocol } from './core.js'

// 统一聊天入口：按协议分发。返回结构化事件序列（ChatEvent）——
// 流式就逐条转发给前端；非流式把整条序列收集后一次性返回（上游仍是非流式请求）。
// 生成器是惰性的：调用它不发起任何请求，首次迭代才开始。
export function chatWithProtocol(protocol: Protocol, req: ChatRequest): AsyncGenerator<ChatEvent> {
  switch (protocol) {
    case 'anthropic-messages':
      return chatWithAnthropic(req)
    case 'openai-chat-completions':
      return chatWithOpenAiChat(req)
    case 'openai-responses':
      return chatWithOpenAiResponses(req)
  }
}
