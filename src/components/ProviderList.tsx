// Providers 卡片：接入配置列表（可添加 / 编辑 / 删除 / 选择）。
// 数据与增删改操作都归父组件，这里只负责渲染与交互转发。

import { Button, Card, Flex, Popconfirm, Typography } from 'antd'
import { PROTOCOLS } from '../protocols'
import type { Provider } from '../config'

const { Text } = Typography

export default function ProviderList({
  providers,
  selectedProviderId,
  sending,
  onAdd,
  onSelect,
  onEdit,
  onDelete,
}: {
  providers: Provider[]
  // 当前选中的 Provider id（无效或为空时按第一条高亮，与父组件的回退规则一致）
  selectedProviderId: string | null
  // 是否正在发送（发送期间禁止切换 Provider）
  sending: boolean
  onAdd: () => void
  onSelect: (id: string) => void
  onEdit: (provider: Provider) => void
  onDelete: (provider: Provider) => void
}) {
  // 选中项不存在时回退到第一条
  const selectedProvider = providers.find((p) => p.id === selectedProviderId) ?? providers[0] ?? null

  return (
    <Card
      size="small"
      title="Providers"
      extra={
        <Button size="small" onClick={onAdd}>
          添加
        </Button>
      }
    >
      {providers.length === 0 ? (
        <Text type="secondary">还没有 Provider，点右上角“添加”新建一个</Text>
      ) : (
        <Flex vertical gap={6}>
          {providers.map((p) => {
            const selected = selectedProvider?.id === p.id
            const protocolLabel = PROTOCOLS.find((x) => x.value === p.protocol)?.label ?? p.protocol
            return (
              // 发送期间禁止切换 Provider：旧请求返回后仍会把它的内容写进已经清空的会话界面
              <Flex
                key={p.id}
                align="center"
                gap={8}
                onClick={() => {
                  if (!sending) onSelect(p.id)
                }}
                style={{
                  cursor: sending ? 'not-allowed' : 'pointer',
                  opacity: sending ? 0.6 : 1,
                  padding: '6px 8px',
                  borderRadius: 6,
                  border: `1px solid ${selected ? '#1677ff' : '#f0f0f0'}`,
                  background: selected ? '#e6f4ff' : '#fafafa',
                }}
              >
                <span style={{ color: selected ? '#1677ff' : '#bfbfbf' }}>{selected ? '●' : '○'}</span>
                <Flex vertical style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.model || '（未填模型）'}</span>
                  {/* 【已知取舍 · Demo 不修】这里明文显示完整 API Key（编辑弹窗也是普通文本框）。
                      原因：本地调试工具，方便一眼核对；要修可掩码显示 + 密码框。 */}
                  <span style={{ fontSize: 11, color: '#8c8c8c', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {protocolLabel} · {p.baseUrl} · {p.apiKey}
                  </span>
                </Flex>
                {/* 操作按钮：阻止冒泡，避免点它们时触发整行的"选中" */}
                <Flex gap={4} align="center" onClick={(e) => e.stopPropagation()}>
                  <Button size="small" type="link" onClick={() => onEdit(p)}>
                    编辑
                  </Button>
                  <Popconfirm title="确定删除该 Provider？" okText="删除" cancelText="取消" onConfirm={() => onDelete(p)}>
                    <Button size="small" type="link" danger>
                      删除
                    </Button>
                  </Popconfirm>
                </Flex>
              </Flex>
            )
          })}
        </Flex>
      )}
    </Card>
  )
}
