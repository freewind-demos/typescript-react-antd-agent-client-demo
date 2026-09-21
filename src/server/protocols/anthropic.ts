// Anthropic Messages 协议实现：只负责"发一轮请求 / 取出工具 / 写回历史"，循环交给 core 的 agentLoop。

import Anthropic from '@anthropic-ai/sdk'
import { BASH_TOOL_ANTHROPIC } from '../tools.js'
import { agentLoop, createClient, DEFAULT_MAX_TOKENS, type ChatEvent, type ChatRequest, type ProtocolAdapter } from './core.js'

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

export async function* chatWithAnthropic(req: ChatRequest): AsyncGenerator<ChatEvent> {
  const client = createClient('anthropic-messages', req.baseUrl, req.apiKey, req.onEvent) as Anthropic
  // 只暴露 Bash 这一个工具
  const tools: Anthropic.Tool[] = [BASH_TOOL_ANTHROPIC]

  const adapter: ProtocolAdapter<Anthropic.Message> = {
    // 流式用 SDK 的 stream helper：content blocks 由它自己拼，thinking + signature 一并保留
    async *requestTurn(messages) {
      const params = { model: req.model, max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS, messages: messages as Anthropic.MessageParam[], tools }
      if (!req.stream) {
        const res = await client.messages.create(params)
        const text = extractAnthropicText(res.content)
        if (text) yield { kind: 'text', delta: text }
        yield { kind: 'done', res }
        return
      }
      const stream = client.messages.stream(params)
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          yield { kind: 'text', delta: event.delta.text }
        }
      }
      yield { kind: 'done', res: await stream.finalMessage() }
    },
    extractTools(res) {
      return res.content
        .filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use')
        .map((block) => ({ key: block.id, input: block.input }))
    },
    // 原样放回：上游返回的 content blocks 整份进对话（含 thinking + signature）；
    // 工具结果合并成一条 user 消息（Anthropic 的 tool_result 就是 user 侧内容）
    commitTurn(messages, res, results) {
      messages.push({ role: 'assistant', content: res.content as Anthropic.ContentBlockParam[] })
      // 最终响应（无工具结果）只写 assistant 消息：空的 tool_result 数组是非法内容
      if (results.length === 0) return
      messages.push({
        role: 'user',
        content: results.map((r) => ({ type: 'tool_result', tool_use_id: r.key, content: r.output })),
      })
    },
  }

  yield* agentLoop(req, adapter)
}
