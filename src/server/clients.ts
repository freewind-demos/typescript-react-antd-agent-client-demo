// 协议客户端封装：三种协议各自的 SDK 调用，统一出口
// 全部注入日志 fetch（middleware），保证 SDK 发出的每个请求都被记录。

import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { createLoggingFetch, type LogEvent } from './middleware.js'
import type { Conversation } from './conversation.js'
import { BASH_TOOL_ANTHROPIC, BASH_TOOL_CHAT, BASH_TOOL_RESPONSES, BASH_TOOL_NAME, executeBash, formatBashResult, type BashResult } from './tools.js'

// 支持的三种协议标识（书写顺序与 protocols.ts 一致：OpenAI 在前，Anthropic 最后）
export type Protocol = 'openai-chat-completions' | 'openai-responses' | 'anthropic-messages'

// 聊天请求的统一入参（三种协议共用）
export type ChatRequest = {
  baseUrl: string
  apiKey: string
  model: string
  // 本轮用户输入
  text: string
  // 会话历史：协议原生消息序列，由服务端按 sessionId 持有（见 conversation.ts），只追加不重建
  conversation: Conversation
  stream: boolean
  // 日志事件回调：由调用方绑定到具体会话
  onEvent: (event: LogEvent) => void
}

// 聊天结果：非流式返回完整文本；流式返回文本增量迭代器
export type ChatResult =
  | { stream: false; text: string }
  | { stream: true; iterator: AsyncIterable<string> }

// 回放用的 assistant 消息类型：OpenAI SDK 的类型只覆盖官方字段，厂商扩展字段（如 DeepSeek 的
// reasoning_content）不在其中。这里放开为"官方字段 + 任意额外字段"，回放时做到"收到什么就回什么"。
type ChatCompletionAssistantMessage = OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam & Record<string, unknown>

// 把一片流式 delta 合并进累积中的 assistant message。
// 不预设字段名——delta 里出现过的键全部保留：字符串拼接、tool_calls 按 index 归并、其余非空值覆盖。
// 这是为了绕开 SDK 的 finalChatCompletion()：它只拼自己类型里的字段，不认识的字段（reasoning_content
// 等）会被后一片直接覆盖，只剩最后一片。
function mergeChatCompletionDelta(message: Record<string, unknown>, delta: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(delta)) {
    if (value == null) continue
    if (key === 'role') {
      // role 是固定值，不参与拼接
      message.role = value
    } else if (typeof value === 'string') {
      message[key] = ((message[key] as string | undefined) ?? '') + value
    } else if (key === 'tool_calls' && Array.isArray(value)) {
      mergeToolCallPieces(message, value as Array<Record<string, unknown>>)
    } else {
      message[key] = value
    }
  }
}

// 工具调用分片按 index 归并：id / type 等取非空值，function.arguments 是分片 JSON 需要拼接
function mergeToolCallPieces(message: Record<string, unknown>, pieces: Array<Record<string, unknown>>): void {
  const toolCalls = (message.tool_calls as Array<Record<string, unknown>> | undefined) ?? (message.tool_calls = [])
  for (const piece of pieces) {
    const index = typeof piece.index === 'number' ? piece.index : 0
    const slot = toolCalls[index] ?? (toolCalls[index] = { index })
    for (const [key, value] of Object.entries(piece)) {
      if (value == null || value === '') continue
      if (key === 'function' && typeof value === 'object') {
        const fn = (slot.function as Record<string, unknown> | undefined) ?? (slot.function = {})
        for (const [fnKey, fnValue] of Object.entries(value as Record<string, unknown>)) {
          if (fnValue == null || fnValue === '') continue
          // arguments 是分片 JSON，需要拼接；name 等取非空值
          fn[fnKey] = fnKey === 'arguments' && typeof fnValue === 'string' ? ((fn[fnKey] as string | undefined) ?? '') + fnValue : fnValue
        }
      } else {
        slot[key] = value
      }
    }
  }
}

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

// Anthropic Messages 协议聊天（带 Bash 工具循环）
async function chatWithAnthropic(req: ChatRequest): Promise<ChatResult> {
  const client = createClient('anthropic-messages', req.baseUrl, req.apiKey, req.onEvent) as Anthropic
  // 只暴露 Bash 这一个工具
  const tools: Anthropic.Tool[] = [BASH_TOOL_ANTHROPIC]
  // 会话历史：服务端按 sessionId 持有的协议原生消息序列，只追加不重建
  const conversation = req.conversation.messages as Anthropic.MessageParam[]
  conversation.push({ role: 'user', content: req.text })

  // 非流式：内部跑完整 agent loop，只在最后一轮（无工具调用）返回文本
  if (!req.stream) {
    // 工具调用轮里模型可能先输出一段正文（preamble），这里累积下来与最终回答一起返回，
    // 保持与流式路径一致（流式会把 preamble 直接推给前端）
    let preamble = ''
    for (let turn = 0; turn < MAX_AGENT_TURNS; turn++) {
      const res = await client.messages.create({ model: req.model, max_tokens: 4096, messages: conversation, tools })
      const toolUses = res.content.filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use')
      // 本轮没有工具调用：即为最终回答
      if (toolUses.length === 0) {
        return { stream: false, text: preamble + extractAnthropicText(res.content) }
      }
      // 本轮是工具调用轮：保留其正文，再把上游返回的 content blocks 原样放回对话
      //（含 thinking + signature；signature 不回放会被部分上游拒绝）
      preamble += extractAnthropicText(res.content)
      conversation.push({ role: 'assistant', content: res.content as Anthropic.ContentBlockParam[] })
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
        // 用 SDK 的 stream helper：既能边收边拿文本增量，又能从 finalMessage() 拿到完整消息
        //（content blocks 由 SDK 自己拼，thinking + signature 一并保留）
        const stream = client.messages.stream({ model: req.model, max_tokens: 4096, messages: conversation, tools })
        for await (const event of stream) {
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            // 文本增量：立即 yield 给前端（打字机效果）
            yield event.delta.text
          }
        }
        const message = await stream.finalMessage()
        const toolUses = message.content.filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use')
        // 本轮无工具调用：整个 agent loop 结束
        if (toolUses.length === 0) return
        // 原样放回：上游返回的 content blocks 整份进对话，不挑字段、不重建
        conversation.push({ role: 'assistant', content: message.content as Anthropic.ContentBlockParam[] })
        const toolResults: Anthropic.ToolResultBlockParam[] = []
        for (const toolUse of toolUses) {
          const result = await runBashTool(toolUse.input, req.onEvent)
          toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: formatBashResult(result) })
        }
        conversation.push({ role: 'user', content: toolResults })
      }
      throw new Error(`agent loop exceeded ${MAX_AGENT_TURNS} turns`)
    })(),
  }
}

// OpenAI Chat Completions 协议聊天（带 Bash 工具循环）// OpenAI Chat Completions 协议聊天（带 Bash 工具循环）
async function chatWithOpenAiChat(req: ChatRequest): Promise<ChatResult> {
  const client = createClient('openai-chat-completions', req.baseUrl, req.apiKey, req.onEvent) as OpenAI
  // 只暴露 Bash 这一个工具
  const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [BASH_TOOL_CHAT]
  // 会话历史：服务端按 sessionId 持有的协议原生消息序列，只追加不重建
  const messages = req.conversation.messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[]
  messages.push({ role: 'user', content: req.text })

  // 非流式：内部跑完整 agent loop，只在最后一轮（无工具调用）返回文本
  if (!req.stream) {
    for (let turn = 0; turn < MAX_AGENT_TURNS; turn++) {
      const res = await client.chat.completions.create({ model: req.model, messages, tools })
      const message = res.choices[0]?.message
      if (!message) return { stream: false, text: '' }
      // 只处理标准 function 调用（本 demo 不使用 custom tool）
      const toolCalls = (message.tool_calls ?? []).filter((call) => call.type === 'function')
      // 本轮没有工具调用：即为最终回答
      if (toolCalls.length === 0) {
        return { stream: false, text: message.content ?? '' }
      }
      // 原样放回：上游返回的 assistant message 整份追加（含 reasoning_content 等 SDK 类型外的字段），
      // 再把每个工具结果以 role:'tool' 消息按模型给出的顺序回传
      messages.push(message as ChatCompletionAssistantMessage)
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
        // 本轮累积成一条完整的 assistant message：delta 里出现过的字段全部保留
        //（content / tool_calls / reasoning_content …），不挑字段
        const message: Record<string, unknown> = {}
        let yieldedLength = 0
        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta as Record<string, unknown> | undefined
          if (!delta) continue
          mergeChatCompletionDelta(message, delta)
          // 文本增量：立即 yield 给前端（打字机效果）；从累积体里取增量部分
          const content = typeof message.content === 'string' ? message.content : ''
          if (content.length > yieldedLength) {
            yield content.slice(yieldedLength)
            yieldedLength = content.length
          }
        }
        const toolCalls = ((message.tool_calls as Array<Record<string, unknown>> | undefined) ?? []).filter((call) => call.type === 'function')
        // 本轮无工具调用：整个 agent loop 结束
        if (toolCalls.length === 0) return
        if (message.role == null) message.role = 'assistant'
        // 原样放回（message 里 tool_calls 已按 index 归并、保持模型给出的顺序）
        messages.push(message as ChatCompletionAssistantMessage)
        for (const call of toolCalls) {
          const fn = call.function as { name?: string; arguments?: string } | undefined
          const result = await runBashTool(parseToolArgs(fn?.arguments ?? ''), req.onEvent)
          messages.push({ role: 'tool', tool_call_id: call.id as string, content: formatBashResult(result) })
        }
      }
      throw new Error(`agent loop exceeded ${MAX_AGENT_TURNS} turns`)
    })(),
  }
}

// OpenAI Responses 协议聊天（带 Bash 工具循环）// OpenAI Responses 协议聊天（带 Bash 工具循环）
async function chatWithOpenAiResponses(req: ChatRequest): Promise<ChatResult> {
  const client = createClient('openai-responses', req.baseUrl, req.apiKey, req.onEvent) as OpenAI
  // 只暴露 Bash 这一个工具（Responses 的工具声明是扁平结构）
  const tools: OpenAI.Responses.Tool[] = [BASH_TOOL_RESPONSES]
  // 会话历史：服务端按 sessionId 持有的协议原生 input 序列，只追加不重建
  const input = req.conversation.messages as OpenAI.Responses.ResponseInput
  input.push({ role: 'user', content: req.text })

  // 把本轮 output 原样按顺序放回 input，并在每个 function_call 之后紧跟它的 function_call_output
  //（保持模型给出的顺序；并行工具调用时也必须成对，不能先放全部 call 再放全部 output）
  async function appendOutput(output: OpenAI.Responses.ResponseOutputItem[], onEvent: (event: LogEvent) => void): Promise<void> {
    for (const item of output) {
      input.push(item as OpenAI.Responses.ResponseInputItem)
      if (item.type === 'function_call') {
        const result = await runBashTool(parseToolArgs(item.arguments), onEvent)
        input.push({ type: 'function_call_output', call_id: item.call_id, output: formatBashResult(result) })
      }
    }
  }

  // 非流式：内部跑完整 agent loop，只在最后一轮（无工具调用）返回文本
  if (!req.stream) {
    for (let turn = 0; turn < MAX_AGENT_TURNS; turn++) {
      const res = await client.responses.create({ model: req.model, input, tools })
      // finalResponse/create 的 output 是 SDK 的 Parsed 类型，这里按协议原生条目处理
      const output = res.output as unknown as OpenAI.Responses.ResponseOutputItem[]
      const calls = output.filter((item): item is OpenAI.Responses.ResponseFunctionToolCall => item.type === 'function_call')
      // 本轮没有工具调用：即为最终回答
      if (calls.length === 0) {
        return { stream: false, text: res.output_text }
      }
      await appendOutput(output, req.onEvent)
    }
    throw new Error(`agent loop exceeded ${MAX_AGENT_TURNS} turns`)
  }

  // 流式：逐轮请求，边收边 yield 文本；本轮出现工具调用则执行后进入下一轮
  return {
    stream: true,
    iterator: (async function* () {
      for (let turn = 0; turn < MAX_AGENT_TURNS; turn++) {
        const stream = client.responses.stream({ model: req.model, input, tools })
        for await (const event of stream) {
          if (event.type === 'response.output_text.delta') {
            // 文本增量：立即 yield 给前端（打字机效果）
            yield event.delta
          }
        }
        // 用 finalResponse() 拿完整 response，output 里的条目原样放回 input
        const response = await stream.finalResponse()
        const output = response.output as unknown as OpenAI.Responses.ResponseOutputItem[]
        const calls = output.filter((item): item is OpenAI.Responses.ResponseFunctionToolCall => item.type === 'function_call')
        // 本轮无工具调用：整个 agent loop 结束
        if (calls.length === 0) return
        await appendOutput(output, req.onEvent)
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
