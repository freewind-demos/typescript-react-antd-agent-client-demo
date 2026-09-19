// 协议客户端封装：三种协议各自的 SDK 调用，统一出口
// 全部注入日志 fetch（middleware），保证 SDK 发出的每个请求都被记录。

import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { createLoggingFetch, type LogEvent } from './middleware.js'
import { BASH_TOOL_ANTHROPIC, BASH_TOOL_CHAT, BASH_TOOL_RESPONSES, BASH_TOOL_NAME, executeBash, formatBashResult, type BashResult } from './tools.js'

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

// ---- Agent loop 公共部分 ----

// agent loop 最大轮数：模型 → 工具 → 模型 … 的循环上限，防止无限调用
const MAX_AGENT_TURNS = 20

// 解析模型给出的工具入参（JSON 文本 → 对象），解析失败按空对象处理
function parseToolArgs(json: string): unknown {
  if (!json.trim()) return {}
  try {
    return JSON.parse(json)
  } catch {
    return {}
  }
}

// 按 Bash 工具约定执行命令：command 缺失/非法时直接返回错误结果，不真正执行。
// 无论成功与否都触发一条 tool 事件（用于日志面板与前端工具气泡）。
async function runBashTool(input: unknown, onEvent: (event: LogEvent) => void): Promise<BashResult> {
  const { command, timeout } = (input ?? {}) as { command?: unknown; timeout?: unknown }
  const validCommand = typeof command === 'string' && command.trim() !== ''
  const result: BashResult = validCommand
    ? await executeBash({ command: command as string, timeout: typeof timeout === 'number' ? timeout : undefined })
    : { output: 'error: the "command" argument is required and must be a non-empty string', exitCode: -1, truncated: false }
  onEvent({
    type: 'tool',
    name: BASH_TOOL_NAME,
    input: { command: typeof command === 'string' ? command : String(command ?? ''), ...(typeof timeout === 'number' ? { timeout } : {}) },
    output: result.output,
    exitCode: result.exitCode,
    timestamp: Date.now(),
  })
  return result
}

// Anthropic 流式响应里一个正在累积的 content block（按 index 归位，用于回放 assistant 消息）
type AnthropicPartialBlock =
  | { type: 'text'; index: number; text: string }
  | { type: 'thinking'; index: number; thinking: string; signature: string }
  | { type: 'tool_use'; index: number; id: string; name: string; json: string }

// 把累积的 block 转成可回放的 assistant content（按 index 排序，工具入参解析成对象）
function toAnthropicAssistantContent(blocks: AnthropicPartialBlock[]): Anthropic.ContentBlockParam[] {
  return blocks
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((block) => {
      if (block.type === 'text') return { type: 'text', text: block.text }
      // 思考块带 signature 原样回放，否则部分上游会拒绝下一轮请求
      if (block.type === 'thinking') return { type: 'thinking', thinking: block.thinking, signature: block.signature }
      return { type: 'tool_use', id: block.id, name: block.name, input: parseToolArgs(block.json) }
    })
}

// Anthropic Messages 协议聊天（带 Bash 工具循环）
async function chatWithAnthropic(req: ChatRequest): Promise<ChatResult> {
  const client = createClient('anthropic-messages', req.baseUrl, req.apiKey, req.onEvent) as Anthropic
  // 只暴露 Bash 这一个工具
  const tools: Anthropic.Tool[] = [BASH_TOOL_ANTHROPIC]
  // Anthropic 的 system prompt 是独立字段，不在 messages 数组里，需要拆出来
  const system = req.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n')
  const conversation: Anthropic.MessageParam[] = req.messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))

  // 非流式：内部跑完整 agent loop，只在最后一轮（无工具调用）返回文本
  if (!req.stream) {
    // 工具调用轮里模型可能先输出一段正文（preamble），这里累积下来与最终回答一起返回，
    // 保持与流式路径一致（流式会把 preamble 直接推给前端）
    let preamble = ''
    for (let turn = 0; turn < MAX_AGENT_TURNS; turn++) {
      const res = await client.messages.create({
        model: req.model,
        max_tokens: 4096,
        system: system || undefined,
        messages: conversation,
        tools,
      })
      const toolUses = res.content.filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use')
      // 本轮没有工具调用：即为最终回答
      if (toolUses.length === 0) {
        return { stream: false, text: preamble + extractAnthropicText(res.content) }
      }
      // 本轮是工具调用轮：保留其正文，再回放 assistant 消息（含 tool_use）并把工具结果作为 user 消息回传
      preamble += extractAnthropicText(res.content)
      conversation.push({ role: 'assistant', content: res.content })
      const toolResults: Anthropic.ToolResultBlockParam[] = []
      for (const toolUse of toolUses) {
        const result = await runBashTool(toolUse.input, req.onEvent)
        toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: formatBashResult(result) })
      }
      conversation.push({ role: 'user', content: toolResults })
    }
    throw new Error(`agent loop exceeded ${MAX_AGENT_TURNS} turns`)
  }

  // 流式：逐轮请求，边收边 yield 文本；本轮出现工具调用则执行后进入下一轮
  return {
    stream: true,
    iterator: (async function* () {
      for (let turn = 0; turn < MAX_AGENT_TURNS; turn++) {
        const stream = await client.messages.create({
          model: req.model,
          max_tokens: 4096,
          system: system || undefined,
          messages: conversation,
          tools,
          stream: true,
        })
        // 累积本轮所有 content block（文本 / 工具调用）
        const blocks = new Map<number, AnthropicPartialBlock>()
        for await (const event of stream) {
          if (event.type === 'content_block_start') {
            const cb = event.content_block
            if (cb.type === 'text') {
              blocks.set(event.index, { type: 'text', index: event.index, text: cb.text })
            } else if (cb.type === 'thinking') {
              // 思考块也要累积（含 signature），用于回放下一轮请求
              blocks.set(event.index, { type: 'thinking', index: event.index, thinking: cb.thinking, signature: cb.signature })
            } else if (cb.type === 'tool_use') {
              blocks.set(event.index, { type: 'tool_use', index: event.index, id: cb.id, name: cb.name, json: '' })
            }
          } else if (event.type === 'content_block_delta') {
            const block = blocks.get(event.index)
            if (event.delta.type === 'text_delta') {
              // 文本增量：累积用于回放，同时立即 yield 给前端（打字机效果）
              if (block && block.type === 'text') block.text += event.delta.text
              else blocks.set(event.index, { type: 'text', index: event.index, text: event.delta.text })
              yield event.delta.text
            } else if (event.delta.type === 'thinking_delta') {
              if (block && block.type === 'thinking') block.thinking += event.delta.thinking
            } else if (event.delta.type === 'signature_delta') {
              if (block && block.type === 'thinking') block.signature += event.delta.signature
            } else if (event.delta.type === 'input_json_delta') {
              // 工具入参是分片 JSON，逐段累积
              if (block && block.type === 'tool_use') block.json += event.delta.partial_json
            }
          }
        }
        const ordered = [...blocks.values()].sort((a, b) => a.index - b.index)
        const toolUses = ordered.filter((b): b is Extract<AnthropicPartialBlock, { type: 'tool_use' }> => b.type === 'tool_use')
        // 本轮无工具调用：整个 agent loop 结束
        if (toolUses.length === 0) return
        // 回放 assistant 消息并执行工具，结果作为下一轮的 user 消息
        conversation.push({ role: 'assistant', content: toAnthropicAssistantContent(ordered) })
        const toolResults: Anthropic.ToolResultBlockParam[] = []
        for (const toolUse of toolUses) {
          const result = await runBashTool(parseToolArgs(toolUse.json), req.onEvent)
          toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: formatBashResult(result) })
        }
        conversation.push({ role: 'user', content: toolResults })
      }
      throw new Error(`agent loop exceeded ${MAX_AGENT_TURNS} turns`)
    })(),
  }
}

// OpenAI Chat Completions 协议聊天（带 Bash 工具循环）
async function chatWithOpenAiChat(req: ChatRequest): Promise<ChatResult> {
  const client = createClient('openai-chat-completions', req.baseUrl, req.apiKey, req.onEvent) as OpenAI
  // 只暴露 Bash 这一个工具
  const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [BASH_TOOL_CHAT]
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = req.messages.map((m) => ({ role: m.role, content: m.content }))

  // 非流式：内部跑完整 agent loop，只在最后一轮（无工具调用）返回文本
  if (!req.stream) {
    for (let turn = 0; turn < MAX_AGENT_TURNS; turn++) {
      const res = await client.chat.completions.create({ model: req.model, messages, tools })
      const message = res.choices[0]?.message
      // 只处理标准 function 调用（本 demo 不使用 custom tool）
      const toolCalls = (message?.tool_calls ?? []).filter((call) => call.type === 'function')
      // 本轮没有工具调用：即为最终回答
      if (toolCalls.length === 0) {
        return { stream: false, text: message?.content ?? '' }
      }
      // 回放 assistant 消息（含 tool_calls），再把每个工具结果以 role:'tool' 消息回传
      messages.push({
        role: 'assistant',
        content: message?.content ?? null,
        tool_calls: toolCalls.map((call) => ({
          id: call.id,
          type: 'function' as const,
          function: { name: call.function.name, arguments: call.function.arguments },
        })),
      })
      for (const call of toolCalls) {
        const result = await runBashTool(parseToolArgs(call.function.arguments), req.onEvent)
        messages.push({ role: 'tool', tool_call_id: call.id, content: formatBashResult(result) })
      }
    }
    throw new Error(`agent loop exceeded ${MAX_AGENT_TURNS} turns`)
  }

  // 流式：逐轮请求，边收边 yield 文本；本轮出现工具调用则执行后进入下一轮
  return {
    stream: true,
    iterator: (async function* () {
      for (let turn = 0; turn < MAX_AGENT_TURNS; turn++) {
        const stream = await client.chat.completions.create({ model: req.model, messages, tools, stream: true })
        // 累积本轮：content 文本 + tool_calls（分数片，按 index 归位）
        let content = ''
        const toolCalls = new Map<number, { id: string; name: string; args: string }>()
        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta
          if (!delta) continue
          // 文本增量：累积用于回放，同时立即 yield 给前端（打字机效果）
          if (delta.content) {
            content += delta.content
            yield delta.content
          }
          // 工具调用分数片返回：id/name 只在首个分片给，arguments 需要逐片拼接
          for (const piece of delta.tool_calls ?? []) {
            const index = piece.index ?? 0
            let acc = toolCalls.get(index)
            if (!acc) {
              acc = { id: '', name: '', args: '' }
              toolCalls.set(index, acc)
            }
            if (piece.id) acc.id = piece.id
            if (piece.function?.name) acc.name = piece.function.name
            if (piece.function?.arguments) acc.args += piece.function.arguments
          }
        }
        // 本轮无工具调用：整个 agent loop 结束
        if (toolCalls.size === 0) return
        const ordered = [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, value]) => value)
        // 回放 assistant 消息（含 tool_calls），再执行工具并把结果作为 role:'tool' 消息
        messages.push({
          role: 'assistant',
          content: content || null,
          tool_calls: ordered.map((call) => ({
            id: call.id,
            type: 'function' as const,
            function: { name: call.name, arguments: call.args },
          })),
        })
        for (const call of ordered) {
          const result = await runBashTool(parseToolArgs(call.args), req.onEvent)
          messages.push({ role: 'tool', tool_call_id: call.id, content: formatBashResult(result) })
        }
      }
      throw new Error(`agent loop exceeded ${MAX_AGENT_TURNS} turns`)
    })(),
  }
}

// OpenAI Responses 协议聊天（带 Bash 工具循环）
async function chatWithOpenAiResponses(req: ChatRequest): Promise<ChatResult> {
  const client = createClient('openai-responses', req.baseUrl, req.apiKey, req.onEvent) as OpenAI
  // 只暴露 Bash 这一个工具（Responses 的工具声明是扁平结构）
  const tools: OpenAI.Responses.Tool[] = [BASH_TOOL_RESPONSES]
  // Responses API 的 input 用消息数组，content 直接传字符串；后续轮次往同一数组追加工具往返
  const input: OpenAI.Responses.ResponseInput = req.messages.map((m) => ({ role: m.role, content: m.content }))

  // 非流式：内部跑完整 agent loop，只在最后一轮（无工具调用）返回文本
  if (!req.stream) {
    for (let turn = 0; turn < MAX_AGENT_TURNS; turn++) {
      const res = await client.responses.create({ model: req.model, input, tools })
      const calls = res.output.filter((item): item is OpenAI.Responses.ResponseFunctionToolCall => item.type === 'function_call')
      // 本轮没有工具调用：即为最终回答
      if (calls.length === 0) {
        return { stream: false, text: res.output_text }
      }
      // function_call 与其 function_call_output 成对追加（保持模型返回的顺序；
      // 并行工具调用时也必须成对，不能先放全部 call 再放全部 output）
      for (const call of calls) {
        input.push({ type: 'function_call', call_id: call.call_id, name: call.name, arguments: call.arguments })
        const result = await runBashTool(parseToolArgs(call.arguments), req.onEvent)
        input.push({ type: 'function_call_output', call_id: call.call_id, output: formatBashResult(result) })
      }
    }
    throw new Error(`agent loop exceeded ${MAX_AGENT_TURNS} turns`)
  }

  // 流式：逐轮请求，边收边 yield 文本；本轮出现工具调用则执行后进入下一轮
  return {
    stream: true,
    iterator: (async function* () {
      for (let turn = 0; turn < MAX_AGENT_TURNS; turn++) {
        const stream = await client.responses.create({ model: req.model, input, tools, stream: true })
        // 本轮完成的 function_call（output_item.done 时 item 已是完整内容，含完整 arguments）
        const calls: Array<{ call_id: string; name: string; arguments: string }> = []
        for await (const event of stream) {
          if (event.type === 'response.output_text.delta') {
            // 文本增量：立即 yield 给前端（打字机效果）
            yield event.delta
          } else if (event.type === 'response.output_item.done' && event.item.type === 'function_call') {
            calls.push({ call_id: event.item.call_id, name: event.item.name, arguments: event.item.arguments })
          }
        }
        // 本轮无工具调用：整个 agent loop 结束
        if (calls.length === 0) return
        // function_call 与其 function_call_output 成对追加（保持模型返回的顺序）
        for (const call of calls) {
          input.push({ type: 'function_call', call_id: call.call_id, name: call.name, arguments: call.arguments })
          const result = await runBashTool(parseToolArgs(call.arguments), req.onEvent)
          input.push({ type: 'function_call_output', call_id: call.call_id, output: formatBashResult(result) })
        }
      }
      throw new Error(`agent loop exceeded ${MAX_AGENT_TURNS} turns`)
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

// 生成候选 baseURL：原样 → 逐级去掉末尾路径段（直到 host 根）
// 用于兼容"聊天端点与模型列表端点路径不同"的上游
// （如 https://api.deepseek.com/anthropic 聊天可用，模型列表要在 https://api.deepseek.com）
function buildBaseUrlCandidates(baseUrl: string): string[] {
  try {
    const url = new URL(baseUrl)
    const segments = url.pathname.split('/').filter(Boolean)
    const candidates: string[] = []
    for (let i = segments.length; i >= 0; i--) {
      const path = segments.slice(0, i).join('/')
      candidates.push(`${url.origin}${path ? `/${path}` : ''}`)
    }
    return [...new Set(candidates)]
  } catch {
    // baseUrl 不是合法 URL：只按原样试
    return [baseUrl]
  }
}

// 获取模型列表（带自动重试）：依次尝试候选地址，返回第一个非空的模型列表与实际使用的地址
export async function listModelsWithFallback(
  protocol: Protocol,
  baseUrl: string,
  apiKey: string,
  onEvent: (event: LogEvent) => void,
): Promise<{ models: string[]; usedBaseUrl: string }> {
  const candidates = buildBaseUrlCandidates(baseUrl)
  let lastError: unknown
  for (const candidate of candidates) {
    try {
      const models = await listModels(protocol, candidate, apiKey, onEvent)
      // 拿到非空列表即成功（空列表视为该地址没有模型，继续试下一个）
      if (models.length > 0) {
        return { models, usedBaseUrl: candidate }
      }
      lastError = new Error(`no models returned from ${candidate}`)
    } catch (error) {
      // 该地址失败，继续试下一个候选
      lastError = error
    }
  }
  // 全部候选都失败：抛出最后的错误，交给上层返回给前端
  throw lastError ?? new Error('no models available from any candidate url')
}
