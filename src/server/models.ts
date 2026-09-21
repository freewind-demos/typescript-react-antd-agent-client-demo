// 模型列表（协议无关）：走对应 SDK 的 models 接口，同样经过日志中间件；带候选地址自动重试。

import type { LogEvent } from './middleware.js'
import { createClient, type Protocol } from './protocols/core.js'

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
