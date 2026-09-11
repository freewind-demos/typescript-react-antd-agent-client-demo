// LocalStorage 配置历史：记录最近填过的 API URL / API Key
// 注意：历史是全局的，不按协议区分（协议与 URL/Key 相互独立，切协议时保留并可复用历史）
// 只在"成功使用后"写入（Fetch Models 成功 / 聊天发送成功），避免错值污染历史。

// 历史条目上限
const MAX_HISTORY = 10
// LocalStorage key 前缀，避免与其他应用冲突
const KEY_PREFIX = 'agent-client-demo:'

// 可记录历史的配置字段
export type ConfigField = 'url' | 'key'

// 拼接完整的 LocalStorage key：agent-client-demo:<字段>
function storageKey(field: ConfigField): string {
  return `${KEY_PREFIX}${field}`
}

// 读取某字段的历史列表（最新的在最前）
export function getHistory(field: ConfigField): string[] {
  try {
    const raw = localStorage.getItem(storageKey(field))
    const parsed = raw ? JSON.parse(raw) : []
    // 只保留字符串项，防御脏数据
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

// 记录一次成功使用的配置：去重置顶（重复值移到最前，不新增），返回新列表并写入 LocalStorage
export function pushHistory(field: ConfigField, value: string): string[] {
  if (!value) {
    return getHistory(field)
  }
  // 过滤掉与本次相同的旧条目（去重），新值放最前，截断到上限
  const next = [value, ...getHistory(field).filter((x) => x !== value)].slice(0, MAX_HISTORY)
  try {
    localStorage.setItem(storageKey(field), JSON.stringify(next))
  } catch {
    // LocalStorage 不可用（隐私模式等）时静默失败，不影响主流程
  }
  return next
}
