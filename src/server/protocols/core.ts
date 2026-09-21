// 协议无关内核：三种协议共用的类型、SDK 客户端工厂、工具执行与唯一的 agent loop。
// 协议差异全部由 ProtocolAdapter 抽象，具体实现见同目录 anthropic.ts / openaiChat.ts / openaiResponses.ts。

import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { createLoggingFetch, type LogEvent } from '../middleware.js'
import type { Conversation } from '../conversation.js'
import { BASH_TOOL_NAME, executeBash, formatBashResult, type BashResult } from '../tools.js'

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

// 按协议创建 SDK 客户端，注入日志 fetch
export function createClient(protocol: Protocol, baseUrl: string, apiKey: string, onEvent: (event: LogEvent) => void): Anthropic | OpenAI {
  // 包装全局 fetch：所有经 SDK 发出的 HTTP 请求都会先经过日志中间件
  const loggingFetch = createLoggingFetch(fetch, onEvent)
  if (protocol === 'anthropic-messages') {
    // Anthropic SDK：baseURL 传 API 根地址，SDK 内部拼 /v1/messages
    return new Anthropic({ apiKey, baseURL: baseUrl, fetch: loggingFetch })
  }
  // OpenAI 两个协议共用同一个 SDK，只是调用的资源不同
  return new OpenAI({ apiKey, baseURL: baseUrl, fetch: loggingFetch })
}

// ---- Agent loop 公共部分 ----

// agent loop 最大轮数：模型 → 工具 → 模型 … 的循环上限，防止无限调用
const MAX_AGENT_TURNS = 20

// 默认最大生成 tokens（16K）——Anthropic 的 max_tokens 是必填字段，故需兜底值
export const DEFAULT_MAX_TOKENS = 16_384

// 解析模型给出的工具入参（JSON 文本 → 对象），解析失败按空对象处理
export function parseToolArgs(json: string): unknown {
  if (!json.trim()) return {}
  try {
    return JSON.parse(json)
  } catch {
    return {}
  }
}

// 按 Bash 工具约定执行命令：command 缺失/非法时直接返回错误结果，不真正执行。
// 规范化后的入参随返回值交给聊天事件（工具气泡由 chat 事件流驱动，不再走日志）。
async function runBashTool(input: unknown): Promise<{ input: ToolInput; result: BashResult }> {
  const { command, timeout } = (input ?? {}) as { command?: unknown; timeout?: unknown }
  const normalized: ToolInput = { command: typeof command === 'string' ? command : String(command ?? ''), ...(typeof timeout === 'number' ? { timeout } : {}) }
  const validCommand = typeof command === 'string' && command.trim() !== ''
  const result: BashResult = validCommand
    ? await executeBash({ command: command as string, timeout: typeof timeout === 'number' ? timeout : undefined })
    : { output: 'error: the "command" argument is required and must be a non-empty string', exitCode: -1, truncated: false }
  return { input: normalized, result }
}

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
export type ProtocolAdapter<T> = {
  // 发一轮上游请求：边收边产文本增量（非流式路径每轮只产一次），最后产一次完整响应
  requestTurn(messages: unknown[]): AsyncGenerator<TurnEvent<T>>
  // 本轮响应里要执行的工具调用（保持模型给出的顺序）
  extractTools(res: T): ToolCall[]
  // 把本轮响应（以及工具结果，如果有）按协议原生形态写回历史（Responses 要求 function_call 与结果成对相邻）。
  // results 为空表示这是本轮 Agent 循环的最终响应：此时只写 assistant 消息。
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
export async function* agentLoop<T>(req: ChatRequest, adapter: ProtocolAdapter<T>): AsyncGenerator<ChatEvent> {
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

    // SDK 解析出的完整响应：作为这次 HTTP 交互的真实响应正文交给日志层
    //（非流式即上游完整对象；流式为 SDK 恢复出的完整消息）
    req.onEvent({ type: 'sdk-response', body: res, timestamp: Date.now() })

    const tools = adapter.extractTools(res)
    if (tools.length === 0) {
      // 拿到最终回答：到这一刻才把整轮历史提交回会话。
      // 最终响应同样必须按协议原生格式写回历史（工具结果为空 → 只写 assistant 消息），
      // 否则多轮对话里模型看不到自己上一轮的回答。
      adapter.commitTurn(working, res, [])
      req.conversation.messages = working
      return
    }
    // 按模型给出的顺序逐个执行（不并行），结果与调用一一对应
    const results: ToolResult[] = []
    for (const tool of tools) {
      const { input, result } = await runBashTool(tool.input)
      // 工具事件就地插进事件流：前端在正确位置渲染工具气泡，并另起助手气泡接续后续文本
      yield { type: 'tool', name: BASH_TOOL_NAME, input, output: result.output, exitCode: result.exitCode }
      results.push({ key: tool.key, output: formatBashResult(result) })
    }
    adapter.commitTurn(working, res, results)
  }
  throw new Error(`agent loop exceeded ${MAX_AGENT_TURNS} turns`)
}
