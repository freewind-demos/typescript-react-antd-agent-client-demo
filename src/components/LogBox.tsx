// 日志面板里的一小块展示容器：黑底 + 等宽字体 + 内部滚动。
// Tab1 的两块（Request / Response）与 Tab2/3/4 的内容区共用这一个组件。

import type { ReactNode, Ref } from 'react'
import { Flex, Typography } from 'antd'

const { Text } = Typography

export default function LogBox({
  label,
  text,
  empty,
  wrap = 'pre-wrap',
  ref,
}: {
  // 容器上方的小标题（仅 Tab1 的 Request / Response 区使用）
  label?: string
  // 要展示的文本，为空时显示 empty
  text: string
  empty: ReactNode
  // pre = 不换行；pre-wrap = 保留空格并自动换行
  wrap?: 'pre' | 'pre-wrap'
  // 供调用方自动滚动到底部
  ref?: Ref<HTMLDivElement>
}) {
  // padding 落在哪一层取决于有无 label，目的是与重构前的两种布局逐像素一致：
  //   有 label（Tab1）：外层带 padding，label 固定不滚动，内层是纯滚动区
  //   无 label（Tab2/3/4）：单层等价结构，padding 属于滚动内容（滚到底时保留这段留白）
  const labeled = label !== undefined
  return (
    <Flex
      vertical
      style={{ flex: 1, minWidth: 0, minHeight: 0, background: '#111111', color: '#e6e6e6', borderRadius: 6, padding: labeled ? 10 : undefined }}
    >
      {labeled && (
        <Text type="secondary" style={{ fontSize: 11, marginBottom: 4 }}>
          {label}
        </Text>
      )}
      <Flex
        ref={ref}
        vertical
        style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'auto', padding: labeled ? undefined : 10, fontFamily: 'Menlo, Consolas, monospace', fontSize: 12, whiteSpace: wrap, wordBreak: 'break-all' }}
      >
        {text || empty}
      </Flex>
    </Flex>
  )
}
