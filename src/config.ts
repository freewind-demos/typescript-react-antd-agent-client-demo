// LocalStorage 持久化：只保存"最终结果"——Provider 列表 + 当前选中的 Provider。
//（早期按 URL / Key / 模型分别记历史下拉的做法已废弃，不再保留。）
// 注意：API Key 是明文存在浏览器 LocalStorage 里（本 demo 为本地调试工具，接受此风险）。

import type { Protocol } from './protocols'

// 一个 Provider = 一套可复用的接入配置（协议 + API 地址 + Key + 模型）
export type Provider = {
  id: string
  protocol: Protocol
  baseUrl: string
  apiKey: string
  model: string
}

const PROVIDERS_KEY = 'agent-client-demo:providers'
const SELECTED_KEY = 'agent-client-demo:selected-provider'

// 读取 Provider 列表（容错：LocalStorage 不可用 / 解析失败 / 结构不符时返回空数组）
export function getProviders(): Provider[] {
  try {
    const raw = localStorage.getItem(PROVIDERS_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (p): p is Provider =>
        !!p &&
        typeof p === 'object' &&
        typeof p.id === 'string' &&
        typeof p.baseUrl === 'string' &&
        typeof p.apiKey === 'string' &&
        typeof p.model === 'string',
    )
  } catch {
    return []
  }
}

// 写入 Provider 列表
export function saveProviders(list: Provider[]): void {
  try {
    localStorage.setItem(PROVIDERS_KEY, JSON.stringify(list))
  } catch {
    // LocalStorage 不可用（隐私模式等）时静默失败，不影响主流程
  }
}

// 读取当前选中的 Provider id
export function getSelectedProviderId(): string | null {
  try {
    return localStorage.getItem(SELECTED_KEY)
  } catch {
    return null
  }
}

// 写入当前选中的 Provider id（传 null 表示清除）
export function saveSelectedProviderId(id: string | null): void {
  try {
    if (id) localStorage.setItem(SELECTED_KEY, id)
    else localStorage.removeItem(SELECTED_KEY)
  } catch {
    // 静默失败
  }
}
