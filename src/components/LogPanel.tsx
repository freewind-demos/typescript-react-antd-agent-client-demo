// 右侧日志面板：4 个 Tab（请求/响应、会话、delta、raw）+ 右上角 Copy / 清空。
// 父组件只提供原始数据，JSONC / delta 文本的渲染与自动滚动都在这里完成。

import { useEffect, useRef, useState } from 'react'
import { Button, Card, Flex, Space, Tabs, message } from 'antd'
import LogBox from './LogBox'
import { buildJsonc, headerCommentLines, renderSessionJsonc, type InteractionRecord } from '../jsonc'
import { renderDeltaText, type DeltaState } from '../delta'

// 日志面板的 Tab 标识（清空按钮据此告知父组件清哪一份数据）
export type LogTab = 'current' | 'session' | 'delta' | 'raw'

export default function LogPanel({
  currentPair,
  sessionJson,
  deltaState,
  logText,
  onClear,
}: {
  // Tab1「请求/响应」：最新一次交互
  currentPair: InteractionRecord | null
  // Tab2「会话」：整个会话的交互记录数组
  sessionJson: InteractionRecord[]
  // Tab3「delta」：按 SSE 事件累积的状态
  deltaState: DeltaState
  // Tab4「raw」：verbose 原样日志文本
  logText: string
  // 清空指定 Tab 的数据（数据归父组件持有）
  onClear: (tab: LogTab) => void
}) {
  // 日志面板当前选中的 Tab（清空按钮据此清对应的数据）
  const [activeLogTab, setActiveLogTab] = useState<LogTab>('current')
  const logBoxRef = useRef<HTMLDivElement>(null)
  const deltaBoxRef = useRef<HTMLDivElement>(null)
  const jsonBoxRef = useRef<HTMLDivElement>(null)

  // Tab1 显示"最新一次"请求/响应（来自独立数据 currentPair），元信息以 // 注释写在 JSON 前（JSONC）
  const requestJsonc = currentPair?.request
    ? buildJsonc([`${currentPair.request.method} ${currentPair.request.url}`, ...headerCommentLines(currentPair.request.headers)], currentPair.request.body)
    : ''
  const responseJsonc = currentPair?.response
    ? buildJsonc([`${currentPair.response.status} ${currentPair.response.statusText}`, ...headerCommentLines(currentPair.response.headers)], currentPair.response.body)
    : ''
  // Tab2 显示整个会话：JSONC 数组，一项 = 一个请求 + 一个回复（各自的元信息以注释写在正文前）
  const sessionJsonText = sessionJson.length > 0 ? renderSessionJsonc(sessionJson) : ''
  // Tab3 显示 delta 视图（与 raw 同内容，但以完整 SSE 事件为单位、结构一致的连续事件已合并）
  const deltaText = renderDeltaText(deltaState)

  // 日志面板自动滚到底部：verbose 与 JSON 各自滚动
  useEffect(() => {
    const el = logBoxRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [logText])

  useEffect(() => {
    const el = deltaBoxRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [deltaState])

  useEffect(() => {
    const el = jsonBoxRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [sessionJson])

  // 清空当前选中的 Tab（按钮在 Tab 标题行最右侧）
  const clearCurrentTab = () => onClear(activeLogTab)

  // 复制当前选中 Tab 正在显示的内容（与"清空"按钮一样常驻显示）
  const copyCurrentTab = async () => {
    let text = ''
    if (activeLogTab === 'current') {
      // Tab1：上下两段一起复制，各自加一行注释标明来源
      const sections: string[] = []
      if (requestJsonc) sections.push(`// ===== Request =====\n${requestJsonc}`)
      if (responseJsonc) sections.push(`// ===== Response =====\n${responseJsonc}`)
      text = sections.join('\n\n')
    } else if (activeLogTab === 'session') {
      text = sessionJsonText
    } else if (activeLogTab === 'delta') {
      text = deltaText
    } else {
      text = logText
    }
    if (!text) {
      message.warning('暂无内容可复制')
      return
    }
    try {
      await navigator.clipboard.writeText(text)
      message.success('已复制')
    } catch (err) {
      message.error(`复制失败：${String(err)}`)
    }
  }

  return (
    <Card size="small" style={{ height: '100%', display: 'flex', flexDirection: 'column', marginLeft: 6 }} styles={{ body: { flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden', padding: 0 } }}>
      {/* Tabs 撑满高度：antd Tabs 默认不撑满，用类名控制子元素 */}
      <style>{`
        /* min-width: 0 逐级加：防止日志里的超长行（不换行文本）把 Tabs 容器撑宽，
           否则右上角 Copy/清空 会被挤出可视区（前两个 Tab 内容含长 JSON 时最明显） */
        .logs-tabs { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; padding: 0 12px; }
        .logs-tabs .ant-tabs-nav { min-width: 0; }
        .logs-tabs .ant-tabs-nav-extra { flex: none; }
        .logs-tabs .ant-tabs-body-holder { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
        .logs-tabs .ant-tabs-body { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
        .logs-tabs .ant-tabs-content { min-width: 0; min-height: 0; }
        .logs-tabs .ant-tabs-content-active { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
        .logs-tabs .ant-tabs-content-active > div { flex: 1; min-width: 0; min-height: 0; display: flex; }
      `}</style>
      <Tabs
        className="logs-tabs"
        size="small"
        activeKey={activeLogTab}
        onChange={(key) => setActiveLogTab(key as LogTab)}
        tabBarExtraContent={{
          right: (
            <Space size="small">
              <Button size="small" onClick={copyCurrentTab}>
                Copy
              </Button>
              <Button size="small" onClick={clearCurrentTab}>
                清空
              </Button>
            </Space>
          ),
        }}
        items={[
          // Tab1（默认）：上下两个区域，各显示最新一次的 Request / Response（JSONC：元信息为注释）
          {
            key: 'current',
            label: '请求/响应',
            children: (
              <Flex vertical gap={8} style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
                {/* Request 区：最新一次请求 */}
                <LogBox label="Request（最新一次）" text={requestJsonc} empty="（暂无请求）" wrap="pre" />
                {/* Response 区：最新一次响应（流式已聚合为完整响应） */}
                <LogBox label="Response（最新一次，流式已聚合为完整响应）" text={responseJsonc} empty="（暂无响应）" wrap="pre" />
              </Flex>
            ),
          },
          // Tab2：整个会话 —— JSONC 数组，一个请求配一个回复
          {
            key: 'session',
            label: '会话',
            children: (
              <Flex vertical gap={8} style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
                <LogBox ref={jsonBoxRef} text={sessionJsonText} empty="（暂无会话。这里以数组形式展示整个会话：一项 = 一个请求 + 一个回复，均为协议原生的 JSON）" wrap="pre" />
              </Flex>
            ),
          },
          // Tab3：delta —— 与 raw 同内容，但按完整 SSE 事件展示（event: / data: 同一个块），
          // 并把"结构完全一致"的连续事件合并成一条（便于一眼看清真正有变化的事件）
          //（REQUEST/RESPONSE 等其余块原样）
          {
            key: 'delta',
            label: 'delta',
            children: (
              <Flex vertical gap={8} style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
                <LogBox ref={deltaBoxRef} text={deltaText} empty="（暂无日志。与 raw 相同的内容，但以完整 SSE 事件（event: / data:）为单位展示，结构完全一致的连续事件合并成一条）" />
              </Flex>
            ),
          },
          // Tab4：raw —— 最底层原样日志（完整 headers / body / 每个 SSE 分片）
          {
            key: 'raw',
            label: 'raw',
            children: (
              <Flex vertical gap={8} style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
                <LogBox ref={logBoxRef} text={logText} empty="（暂无日志。发送消息或 Fetch Models 后，这里会原样显示所有发出的请求与收到的响应，流式时每个 SSE 分片单独一条）" />
              </Flex>
            ),
          },
        ]}
      />
    </Card>
  )
}
