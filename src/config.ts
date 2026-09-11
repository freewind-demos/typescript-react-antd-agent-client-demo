// LocalStorage 配置历史：
//   - API URL 历史：全局一份（与协议无关，可跨协议复用）
//   - API Key 历史：按 URL 分组（Key 跟随 URL，各自记住；与协议无关）
// 只在"成功使用后"写入（Fetch Models 成功 / 聊天发送成功），避免错值污染历史。
// 注意：API Key 是明文存在浏览器 LocalStorage 里（本 demo 为本地调试工具，接受此风险）。

// 历史条目上限
const MAX_HISTORY = 10
// URL 历史与 Key 历史的 storage key 前缀
const URL_HISTORY_KEY = 'agent-client-demo:url'
const KEY_HISTORY_PREFIX = 'agent-client-demo:key:'

// 某个 URL 的 Key 历史 storage key（URL 编码避免特殊字符）
function keyHistoryKey(url: string): string {
  return `${KEY_HISTORY_PREFIX}${encodeURIComponent(url)}`
}

// 读取一个字符串列表（容错）
function readList(storageKey: string): string[] {
  try {
    const raw = localStorage.getItem(storageKey)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

// 去重置顶后写回，返回新列表
function pushToList(storageKey: string, value: string): string[] {
  if (!value) {
    return readList(storageKey)
  }
  const next = [value, ...readList(storageKey).filter((x) => x !== value)].slice(0, MAX_HISTORY)
  try {
    localStorage.setItem(storageKey, JSON.stringify(next))
  } catch {
    // LocalStorage 不可用（隐私模式等）时静默失败，不影响主流程
  }
  return next
}

// 读取全局 URL 历史（最新的在最前）
export function getUrlHistory(): string[] {
  return readList(URL_HISTORY_KEY)
}

// 读取某个 URL 对应的 Key 历史（最新的在最前）
export function getKeyHistoryForUrl(url: string): string[] {
  return url ? readList(keyHistoryKey(url)) : []
}

// 某个 URL 最近一次成功使用的 Key（用于从下拉选中 URL 时自动带出）
export function getLatestKeyForUrl(url: string): string | undefined {
  return getKeyHistoryForUrl(url)[0]
}

// 记录一次成功使用的配置：URL 进全局历史，Key 进该 URL 的专属历史；返回更新后的两个列表
export function recordConfigUsed(url: string, key: string): { urlHistory: string[]; keyHistory: string[] } {
  const urlHistory = pushToList(URL_HISTORY_KEY, url)
  const keyHistory = url && key ? pushToList(keyHistoryKey(url), key) : getKeyHistoryForUrl(url)
  return { urlHistory, keyHistory }
}
