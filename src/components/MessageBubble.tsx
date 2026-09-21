// 聊天区的一条气泡：user / assistant / tool（call、result）/ error 四种形态。
// 结构与样式从 App.tsx 迁出，行为与外观不变；key 由调用方在列表上给出。

import { Flex, Typography } from 'antd'

const { Text } = Typography

// 一次 Bash 工具调用的展示信息
export type ToolCallInfo = { name: string; input: { command: string; timeout?: number }; output: string; exitCode: number }

// 聊天消息结构：角色 + 内容；tool 类型用于展示工具调用（content 为空，细节在 toolInfo）
// toolPhase 区分两条独立气泡：call = 模型发起的命令，result = 命令的执行结果
// error：Chat 过程中（请求 / 流式）失败时插入的错误条目，按时间顺序排在聊天流里（不再用 Toast）
export type ChatMessage = { role: 'user' | 'assistant' | 'tool' | 'error'; content: string; toolInfo?: ToolCallInfo; toolPhase?: 'call' | 'result' }

export default function MessageBubble({
  message: m,
  // 是否为“正在等待后续输出”的那一条（列表最后一条且正在发送）：内容还空着时显示省略号
  pending = false,
}: {
  message: ChatMessage
  pending?: boolean
}) {
  // 工具相关气泡：call = 模型发起的命令，result = 执行结果，两条独立气泡、样式区分
  if (m.role === 'tool') {
    const isCall = m.toolPhase === 'call'
    const failed = !isCall && (m.toolInfo?.exitCode ?? 0) !== 0
    const background = isCall ? '#f0f0f0' : failed ? '#fff1f0' : '#f6ffed'
    const borderColor = isCall ? '#d9d9d9' : failed ? '#ffa39e' : '#b7eb8f'
    return (
      // 方向对齐：tool call 靠左（模型发起），tool result 靠右（会被作为下一轮 request 发回模型）
      <Flex justify={isCall ? 'flex-start' : 'flex-end'} style={{ marginBottom: 10 }}>
        <Flex
          vertical
          style={{
            maxWidth: '85%',
            padding: '8px 12px',
            borderRadius: 8,
            background,
            border: `1px solid ${borderColor}`,
            fontFamily: 'Menlo, Consolas, monospace',
            fontSize: 12,
          }}
        >
          <Text type="secondary" style={{ fontSize: 11 }}>
            {isCall ? `🔧 tool call — ${m.toolInfo?.name}` : '↩ tool result'}
          </Text>
          {isCall ? (
            <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>$ {m.toolInfo?.input.command}</div>
          ) : (
            <>
              <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{m.toolInfo?.output}</div>
              <Text type="secondary" style={{ fontSize: 11, marginTop: 4 }}>
                exit code: {m.toolInfo?.exitCode}
              </Text>
            </>
          )}
        </Flex>
      </Flex>
    )
  }
  // 错误条目：Chat 过程中（请求 / 流式）失败时插入，按时间顺序排在聊天流里
  if (m.role === 'error') {
    return (
      <Flex justify="center" style={{ marginBottom: 10 }}>
        <Flex
          vertical
          gap={2}
          style={{
            maxWidth: '85%',
            padding: '8px 12px',
            borderRadius: 8,
            background: '#fff1f0',
            border: '1px solid #ffa39e',
            color: '#a8071a',
            fontSize: 12,
          }}
        >
          <Text style={{ fontSize: 11, color: '#a8071a' }}>✕ error</Text>
          <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.content}</div>
        </Flex>
      </Flex>
    )
  }
  return (
    <Flex justify={m.role === 'user' ? 'flex-end' : 'flex-start'} style={{ marginBottom: 10 }}>
      <Flex
        style={{
          maxWidth: '70%',
          padding: '8px 12px',
          borderRadius: 8,
          background: m.role === 'user' ? '#1677ff' : '#ffffff',
          color: m.role === 'user' ? '#ffffff' : '#000000',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          boxShadow: '0 1px 2px rgba(0,0,0,0.1)',
        }}
      >
        {m.content || (pending ? '…' : '')}
      </Flex>
    </Flex>
  )
}
