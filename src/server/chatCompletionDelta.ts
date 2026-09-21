// Chat Completions 的流式 delta 合并：唯一一份实现。
//
// 为什么单独一个文件：业务侧（clients.ts 回放历史）与日志侧（logger.ts 聚合出完整响应）
// 需要同一条合并规则。以前各写一份，改了一处漏了另一处 —— 工具调用分片（tool_calls）在
// 客户端侧能正确归并，日志侧却整体覆盖、只剩最后一片，日志里显示成残缺的 JSON。

// 把一片流式 delta 合并进累积中的 assistant message。
// 不预设字段名——delta 里出现过的键全部保留：字符串拼接、tool_calls 按 index 归并、其余非空值覆盖。
// 这是为了绕开 SDK 的 finalChatCompletion()：它只拼自己类型里的字段，不认识的字段（reasoning_content
// 等）会被后一片直接覆盖，只剩最后一片。
export function mergeChatCompletionDelta(message: Record<string, unknown>, delta: Record<string, unknown>): void {
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
export function mergeToolCallPieces(message: Record<string, unknown>, pieces: Array<Record<string, unknown>>): void {
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
