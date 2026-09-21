// 协议客户端封装：三种协议各自的 SDK 调用，统一出口
// 全部注入日志 fetch（middleware），保证 SDK 发出的每个请求都被记录。

import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { createLoggingFetch, type LogEvent } from './middleware.js'
import type { Conversation } from './conversation.js'
import { BASH_TOOL_ANTHROPIC, BASH_TOOL_CHAT, BASH_TOOL_RESPONSES, BASH_TOOL_NAME, executeBash, formatBashResult, type BashResult } from './tools.js'
import { mergeChatCompletionDelta } from './chatCompletionDelta.js'

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
  // 是否向上游发起流式请求（决定 requestTurn 走哪条路；对外统一是文本增量序列）
  stream: boolean
  // 最大生成 tokens（三协议通用；未提供时用 DEFAULT_MAX_TOKENS 兜底）
  maxTokens?: number
  // 日志事件回调：由调用方绑定到具体会话
  onEvent: (event: LogEvent) => void
}

// 回放用的 assistant 消息类型：OpenAI SDK 的类型只覆盖官方字段，厂商扩展字段（如 DeepSeek 的
// reasoning_content）不在其中。这里放开为"官方字段 + 任意额外字段"，回放时做到"收到什么就回什么"。
type ChatCompletionAssistantMessage = OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam & Record<string, unknown>

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

// 默认最大生成 tokens（16K）——Anthropic 的 max_tokens 是必填字段，故需兜底值
const DEFAULT_MAX_TOKENS = 16_384

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
// 无论成功与否都触发一条 tool 事件（用于日志面板）；规范化后的入参随返回值交给聊天事件。
async function runBashTool(input: unknown, onEvent: (event: LogEvent) => void): Promise<{ input: ToolInput; result: BashResult }> {
  const { command, timeout } = (input ?? {}) as { command?: unknown; timeout?: unknown }
  const normalized: ToolInput = { command: typeof command === 'string' ? command : String(command ?? ''), ...(typeof timeout === 'number' ? { timeout } : {}) }
  const validCommand = typeof command === 'string' && command.trim() !== ''
  const result: BashResult = validCommand
    ? await executeBash({ command: command as string, timeout: typeof timeout === 'number' ? timeout : undefined })
    : { output: 'error: the "command" argument is required and must be a non-empty string', exitCode: -1, truncated: false }
  onEvent({
    type: 'tool',
    name: BASH_TOOL_NAME,
    input: normalized,
    output: result.output,
    exitCode: result.exitCode,
    timestamp: Date.now(),
  })
  return { input: normalized, result }
}

// ---- 协议适配器：三协议各自实现这几个函数，其余全部共用 ----

// Bash 工具入参（规范化后）：命令 + 可选超时
export type ToolInput = { command: string; timeout?: number }

// 一条发给前端的聊天事件：文本增量，或一次工具调用（含本地执行结果）。
// 顺序即真实时序 —— 前端据此在正确位置续写助手气泡 / 插入工具气泡。
// 它不是日志：只描述这次 chat 交互；右侧日志面板另有通道（日志 SSE），两者互不依赖。
export type ChatEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool'; name: string; input: ToolInput; output: string; exitCode: number }

// 本轮要执行的一个工具调用。key 用于把执行结果对回原调用（各协议的字段名不同）
type ToolCall = { key: string; input: unknown }

// 工具执行结果，key 与 ToolCall.key 一一对应
type ToolResult = { key: string; output: string }

// 一轮上游请求产出的事件：文本增量若干次，最后产一次完整响应
type TurnEvent<T> = { kind: 'text'; delta: string } | { kind: 'done'; res: T }

// 协议适配器：把"发一轮请求 / 取出本轮工具 / 写回历史"三件事交给协议自己，
// agent loop（判停、执行工具、提交历史）只有一份实现
type ProtocolAdapter<T> = {
  // 发一轮上游请求：边收边产文本增量（非流式路径每轮只产一次），最后产一次完整响应
  requestTurn(messages: unknown[]): AsyncGenerator<TurnEvent<T>>
  // 本轮响应里要执行的工具调用（保持模型给出的顺序）
  extractTools(res: T): ToolCall[]
  // 把本轮响应与工具结果按协议原生形态写回历史（Responses 要求 function_call 与结果成对相邻）
  commitTurn(messages: unknown[], res: T, results: ToolResult[]): void
}

// 唯一的 agent loop（三协议共用）。
//
// 产出结构化事件流（ChatEvent）：文本增量按发生顺序、工具调用的入参与结果就地插在中间。
// 前端直接消费这条流即可还原「user → 解释 → tool call → tool result → 回答」的真实时序，
// 不需要借助日志 SSE（日志只服务右侧日志面板）。
//
// 历史改动全程发生在副本上（copy-on-write）：上游报错、工具执行抛错、轮数超限时整轮丢弃，
// 绝不把半截历史（有 user 没 assistant、有 tool_calls 没 tool 结果）留在会话里。
async function* agentLoop<T>(req: ChatRequest, adapter: ProtocolAdapter<T>): AsyncGenerator<ChatEvent> {
  const working: unknown[] = [...req.conversation.messages]
  working.push({ role: 'user', content: req.text })

  for (let turn = 0; turn < MAX_AGENT_TURNS; turn++) {
    let res: T | undefined
    for await (const event of adapter.requestTurn(working)) {
      if (event.kind === 'text') {
        // 文本增量：立即往下透传（打字机效果）
        yield { type: 'text', delta: event.delta }
      } else {
        res = event.res
      }
    }
    if (res === undefined) throw new Error('upstream returned no response')

    const tools = adapter.extractTools(res)
    if (tools.length === 0) {
      // 拿到最终回答：到这一刻才把整轮历史提交回会话
      req.conversation.messages = working
      return
    }
    // 按模型给出的顺序逐个执行（不并行），结果与调用一一对应
    const results: ToolResult[] = []
    for (const tool of tools) {
      const { input, result } = await runBashTool(tool.input, req.onEvent)
      // 工具事件就地插进事件流：前端在正确位置渲染工具气泡，并另起助手气泡接续后续文本
      yield { type: 'tool', name: BASH_TOOL_NAME, input, output: result.output, exitCode: result.exitCode }
      results.push({ key: tool.key, output: formatBashResult(result) })
    }
    adapter.commitTurn(working, res, results)
  }
  throw new Error(`agent loop exceeded ${MAX_AGENT_TURNS} turns`)
}

// ---- Anthropic Messages 协议 ----

async function* chatWithAnthropic(req: ChatRequest): AsyncGenerator<ChatEvent> {
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
      messages.push({
        role: 'user',
        content: results.map((r) => ({ type: 'tool_result', tool_use_id: r.key, content: r.output })),
      })
    },
  }

  yield* agentLoop(req, adapter)
}

// ---- OpenAI Chat Completions 协议 ----

async function* chatWithOpenAiChat(req: ChatRequest): AsyncGenerator<ChatEvent> {
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
    // 每个工具结果以 role:'tool' 消息按模型给出的顺序回传
    commitTurn(messages, res, results) {
      messages.push(res as ChatCompletionAssistantMessage)
      for (const r of results) {
        messages.push({ role: 'tool', tool_call_id: r.key, content: r.output })
      }
    },
  }

  yield* agentLoop(req, adapter)
}

// ---- OpenAI Responses 协议 ----

async function* chatWithOpenAiResponses(req: ChatRequest): AsyncGenerator<ChatEvent> {
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
