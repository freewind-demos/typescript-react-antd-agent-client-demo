// 会话状态：每个 sessionId 一份「协议原生消息序列」。
//
// 为什么要放服务端：这个 Client 的原则是"历史只追加、不重建"，而历史必须是协议原生的
// 报文结构（assistant 消息要带 tool_calls / reasoning_content，Anthropic 的 content 是
// block 数组……）。让前端保管历史，前端就得懂三种协议的报文；放在服务端，协议知识集中在
// 一处，前端只管发「用户刚说的这句」。
//
// 上游是无状态的，它每次只收到一份完整的消息数组——所以"记忆"只能由本地这侧保管。

import type { Protocol } from './clients.js'

export type Conversation = {
  protocol: Protocol
  // 协议原生的消息序列（Chat Completions 的 messages / Anthropic 的 messages / Responses 的 input）
  messages: unknown[]
}

export class ConversationStore {
  // 进程内保存，不落盘：服务重启即清空
  private conversations = new Map<string, Conversation>()

  // 取会话；协议不一致时视为新会话（清空重来），避免把 A 协议的报文发给 B 协议
  get(sessionId: string, protocol: Protocol): Conversation {
    const existing = this.conversations.get(sessionId)
    if (existing && existing.protocol === protocol) return existing
    const created: Conversation = { protocol, messages: [] }
    this.conversations.set(sessionId, created)
    return created
  }
}
