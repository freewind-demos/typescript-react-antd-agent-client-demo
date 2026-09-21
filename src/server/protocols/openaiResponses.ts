// OpenAI Responses 协议实现：只负责"发一轮请求 / 取出工具 / 写回历史"，循环交给 core 的 agentLoop。

import OpenAI from 'openai'
import { BASH_TOOL_RESPONSES } from '../tools.js'
import { agentLoop, createClient, parseToolArgs, type ChatEvent, type ChatRequest, type ProtocolAdapter } from './core.js'

export async function* chatWithOpenAiResponses(req: ChatRequest): AsyncGenerator<ChatEvent> {
  const client = createClient('openai-responses', req.baseUrl, req.apiKey, req.onEvent) as OpenAI
  // 只暴露 Bash 这一个工具（Responses 的工具声明是扁平结构）
  const tools: OpenAI.Responses.Tool[] = [BASH_TOOL_RESPONSES]

  const adapter: ProtocolAdapter<OpenAI.Responses.Response> = {
    async *requestTurn(messages) {
      const params = { model: req.model, input: messages as OpenAI.Responses.ResponseInput, tools, ...(req.maxTokens ? { max_output_tokens: req.maxTokens } : {}) }
      if (!req.stream) {
        const res = await client.responses.create(params)
        if (res.output_text) yield { kind: 'text', delta: res.output_text }
        yield { kind: 'done', res }
        return
      }
      const stream = client.responses.stream(params)
      for await (const event of stream) {
        if (event.type === 'response.output_text.delta') {
          yield { kind: 'text', delta: event.delta }
        }
      }
      // 用 finalResponse() 拿完整 response，output 里的条目原样放回 input
      yield { kind: 'done', res: await stream.finalResponse() }
    },
    extractTools(res) {
      const output = res.output as unknown as OpenAI.Responses.ResponseOutputItem[]
      return output
        .filter((item): item is OpenAI.Responses.ResponseFunctionToolCall => item.type === 'function_call')
        .map((item) => ({ key: item.call_id, input: parseToolArgs(item.arguments) }))
    },
    // 本轮 output 按原顺序整体放回，并在每个 function_call 之后紧跟它的 function_call_output
    //（并行工具调用时也必须成对，不能先放全部 call 再放全部 output）
    // 无工具结果（最终响应）时 output 里没有 function_call 条目，这里只把 output 整份放回
    commitTurn(messages, res, results) {
      const byKey = new Map(results.map((r) => [r.key, r.output]))
      const output = res.output as unknown as OpenAI.Responses.ResponseOutputItem[]
      for (const item of output) {
        // finalResponse() 会给 function_call 条目补上 parsed_arguments（SDK Parsed 类型的产物），
        // 它不是协议字段、上游不认（实测 400: Unknown parameter 'input[2].parsed_arguments'），
        // 回放前剥掉。其余字段（含上游自己加的 metadata 之类）一律原样保留。
        const clean = { ...(item as unknown as Record<string, unknown>) }
        delete clean.parsed_arguments
        messages.push(clean as unknown as OpenAI.Responses.ResponseInputItem)
        if (item.type === 'function_call') {
          messages.push({ type: 'function_call_output', call_id: item.call_id, output: byKey.get(item.call_id) ?? '' })
        }
      }
    },
  }

  yield* agentLoop(req, adapter)
}
