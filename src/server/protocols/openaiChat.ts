// OpenAI Chat Completions 协议实现：只负责"发一轮请求 / 取出工具 / 写回历史"，循环交给 core 的 agentLoop。

import OpenAI from 'openai'
import { mergeChatCompletionDelta } from '../chatCompletionDelta.js'
import { BASH_TOOL_CHAT } from '../tools.js'
import { agentLoop, createClient, parseToolArgs, type ChatEvent, type ChatRequest, type ProtocolAdapter } from './core.js'

// 回放用的 assistant 消息类型：OpenAI SDK 的类型只覆盖官方字段，厂商扩展字段（如 DeepSeek 的
// reasoning_content）不在其中。这里放开为"官方字段 + 任意额外字段"，回放时做到"收到什么就回什么"。
type ChatCompletionAssistantMessage = OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam & Record<string, unknown>

export async function* chatWithOpenAiChat(req: ChatRequest): AsyncGenerator<ChatEvent> {
  const client = createClient('openai-chat-completions', req.baseUrl, req.apiKey, req.onEvent) as OpenAI
  // 只暴露 Bash 这一个工具
  const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [BASH_TOOL_CHAT]

  const adapter: ProtocolAdapter<Record<string, unknown>> = {
    // 流式刻意不用 SDK 的 stream helper：finalChatCompletion() 只拼它类型里的字段，
    // reasoning_content 这类厂商扩展会被后一片覆盖、只剩最后一片。这里自己通用合并。
    async *requestTurn(messages) {
      const params = { model: req.model, messages: messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[], tools, ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}) }
      if (!req.stream) {
        const res = await client.chat.completions.create(params)
        const message = res.choices[0]?.message as unknown as Record<string, unknown> | undefined
        if (!message) throw new Error('upstream returned no message')
        const content = typeof message.content === 'string' ? message.content : ''
        if (content) yield { kind: 'text', delta: content }
        yield { kind: 'done', res: message }
        return
      }
      const stream = await client.chat.completions.create({ ...params, stream: true })
      // 本轮累积成一条完整的 assistant message：delta 里出现过的字段全部保留
      //（content / tool_calls / reasoning_content …），不挑字段
      const message: Record<string, unknown> = {}
      let yieldedLength = 0
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta as Record<string, unknown> | undefined
        if (!delta) continue
        mergeChatCompletionDelta(message, delta)
        // 文本增量：立即 yield 给下游（打字机效果）；从累积体里取还没吐出去的部分
        const content = typeof message.content === 'string' ? message.content : ''
        if (content.length > yieldedLength) {
          yield { kind: 'text', delta: content.slice(yieldedLength) }
          yieldedLength = content.length
        }
      }
      if (message.role == null) message.role = 'assistant'
      yield { kind: 'done', res: message }
    },
    extractTools(res) {
      const calls = (res.tool_calls as Array<Record<string, unknown>> | undefined) ?? []
      // 只处理标准 function 调用（本 demo 不使用 custom tool）
      return calls
        .filter((call) => call.type === 'function')
        .map((call) => ({ key: call.id as string, input: parseToolArgs((call.function as { arguments?: string } | undefined)?.arguments ?? '') }))
    },
    // 原样放回：上游返回的 assistant message 整份追加（含 reasoning_content 等 SDK 类型外的字段），
    // 每个工具结果以 role:'tool' 消息按模型给出的顺序回传（无工具结果时只追加 assistant message）
    commitTurn(messages, res, results) {
      messages.push(res as ChatCompletionAssistantMessage)
      for (const r of results) {
        messages.push({ role: 'tool', tool_call_id: r.key, content: r.output })
      }
    },
  }

  yield* agentLoop(req, adapter)
}
