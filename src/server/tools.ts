// Bash 工具：本 demo 中 Agent 唯一的工具。
// 这里提供两份东西：
//   1) 三种协议各自的工具声明（同一份 JSON Schema，只是外层包装不同）
//   2) 本地命令执行器（子进程执行、合并 stdout/stderr、退出码、超时、输出截断）

import { exec } from 'node:child_process'

// 工具名（三协议共用）
export const BASH_TOOL_NAME = 'Bash'

// 默认超时（毫秒）
const DEFAULT_TIMEOUT = 30_000
// 子进程 stdio 缓冲上限（防止超大输出把内存吃爆，超出由 Node 直接 kill）
const MAX_BUFFER = 32 * 1024 * 1024
// 返回给模型的输出字符上限（超出截断，避免撑爆上下文）
const MAX_OUTPUT_CHARS = 20_000

// 工具描述：让模型判断何时该调用
const BASH_TOOL_DESCRIPTION = [
  'Execute a shell command on the local machine (running in the project root) and return its combined stdout/stderr and exit code.',
  `Default timeout is ${DEFAULT_TIMEOUT} ms; override it with the "timeout" argument (in milliseconds).`,
].join(' ')

// 入参 JSON Schema：三协议共用
export const BASH_INPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    command: {
      type: 'string' as const,
      description: 'The shell command to run, e.g. "ls -la" or "cat package.json".',
    },
    timeout: {
      type: 'number' as const,
      description: `Optional timeout in milliseconds (default ${DEFAULT_TIMEOUT}).`,
    },
  },
  required: ['command'] as string[],
}

// ---- 三种协议各自的工具声明 ----

// Anthropic Messages：{ name, description, input_schema }
export const BASH_TOOL_ANTHROPIC = {
  name: BASH_TOOL_NAME,
  description: BASH_TOOL_DESCRIPTION,
  input_schema: BASH_INPUT_SCHEMA,
}

// OpenAI Chat Completions：{ type: 'function', function: { name, description, parameters } }
export const BASH_TOOL_CHAT = {
  type: 'function' as const,
  function: {
    name: BASH_TOOL_NAME,
    description: BASH_TOOL_DESCRIPTION,
    parameters: BASH_INPUT_SCHEMA,
  },
}

// OpenAI Responses：{ type: 'function', name, description, parameters }（扁平结构）
export const BASH_TOOL_RESPONSES = {
  type: 'function' as const,
  name: BASH_TOOL_NAME,
  description: BASH_TOOL_DESCRIPTION,
  parameters: BASH_INPUT_SCHEMA,
}

// ---- 本地执行器 ----

// 一次 Bash 调用的入参
export type BashInput = {
  command: string
  timeout?: number
}

// 一次 Bash 调用的执行结果
export type BashResult = {
  // 合并后的 stdout + stderr（可能被截断）
  output: string
  // 进程退出码；被信号/超时中断等异常结束时为 -1
  exitCode: number
  // 输出是否因超长被截断
  truncated: boolean
}

// 截断过长的输出，返回截断后的文本与实际是否发生了截断
function truncate(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_OUTPUT_CHARS) {
    return { text, truncated: false }
  }
  return {
    text: `${text.slice(0, MAX_OUTPUT_CHARS)}\n... [output truncated, ${text.length - MAX_OUTPUT_CHARS} more chars]`,
    truncated: true,
  }
}

// 执行一条 shell 命令：cwd 为项目根，合并 stdout/stderr，带超时
export function executeBash(input: BashInput): Promise<BashResult> {
  // 入参未提供（或非正数）时用默认超时
  const timeout = input.timeout && input.timeout > 0 ? input.timeout : DEFAULT_TIMEOUT
  return new Promise((resolve) => {
    exec(
      input.command,
      { cwd: process.cwd(), timeout, maxBuffer: MAX_BUFFER, windowsHide: true },
      (error, stdout, stderr) => {
        // 退出码：正常结束为 0；命令自身失败为数字退出码；被超时/信号杀掉等异常结束为 -1
        let exitCode = 0
        let extraNote = ''
        if (error) {
          exitCode = typeof error.code === 'number' ? error.code : -1
          if (error.killed) {
            extraNote = `[process killed: ${error.signal ?? 'unknown signal'}, timeout was ${timeout} ms]`
          } else if (exitCode === -1) {
            extraNote = `[failed to run command: ${error.message}]`
          }
        }
        // stdout 与 stderr 分开收集，这里按顺序拼接（先 stdout 后 stderr）
        const merged = [stdout, stderr].filter((part) => part && part.length > 0).join('\n')
        const withNote = extraNote ? (merged ? `${merged}\n${extraNote}` : extraNote) : merged
        const { text, truncated } = truncate(withNote)
        resolve({
          // 空输出给个明确提示，避免模型误以为没执行
          output: text.length > 0 ? text : '(no output)',
          exitCode,
          truncated,
        })
      },
    )
  })
}

// 把执行结果格式化成给模型的工具结果文本
export function formatBashResult(result: BashResult): string {
  return `${result.output}\n[exit code: ${result.exitCode}]`
}
