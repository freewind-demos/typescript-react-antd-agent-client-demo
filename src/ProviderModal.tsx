// 添加 / 编辑一个 Provider 的弹窗表单：
// 协议 + API URL + API Key + 模型（模型可用 Fetch Models 拉取后下拉选择，也可手填）。
// 校验通过后把草稿交给父组件保存并关闭；校验不过时提示并保持打开。

import { useEffect, useState } from 'react'
import { AutoComplete, Button, Flex, Input, Modal, Select, Space, message } from 'antd'
import { PROTOCOLS, type Protocol } from './protocols'
import type { Provider } from './config'

// 表单产出的草稿（不含 id，由调用方补）
export type ProviderDraft = Omit<Provider, 'id'>

export default function ProviderModal({
  open,
  initial,
  sessionId,
  onCancel,
  onSubmit,
}: {
  open: boolean
  initial: Provider | null
  sessionId: string
  onCancel: () => void
  onSubmit: (draft: ProviderDraft) => void
}) {
  // 默认选中协议列表的第一个（协议顺序：OpenAI 两个在前，Anthropic 在最后，见 protocols.ts）
  const [protocol, setProtocol] = useState<Protocol>(PROTOCOLS[0]!.value)
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('')
  const [models, setModels] = useState<string[]>([])
  const [fetching, setFetching] = useState(false)

  // 每次打开时按 initial 重置表单（添加模式为空的表单）
  useEffect(() => {
    if (!open) return
    setProtocol(initial?.protocol ?? PROTOCOLS[0]!.value)
    setBaseUrl(initial?.baseUrl ?? '')
    setApiKey(initial?.apiKey ?? '')
    setModel(initial?.model ?? '')
    setModels([])
  }, [open, initial])

  const meta = PROTOCOLS.find((p) => p.value === protocol)!

  // Fetch Models：用当前填写的 URL + Key 走该协议的模型接口拉取列表
  const fetchModels = async () => {
    if (!baseUrl || !apiKey) {
      message.warning('请先填写 API URL 和 API Key')
      return
    }
    setFetching(true)
    try {
      const res = await fetch(meta.modelsEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ baseUrl, apiKey, sessionId }),
      })
      const data = await res.json()
      if (!res.ok) {
        throw new Error(data.error || `HTTP ${res.status}`)
      }
      setModels(data.models ?? [])
      // 实际使用的地址与填写的不一致（自动上溯过）时提示，避免困惑
      if (data.usedBaseUrl && data.usedBaseUrl !== baseUrl) {
        message.info(`模型列表来自 ${data.usedBaseUrl}`)
      }
      // 拿到列表后默认选中第一个
      if (data.models?.length) {
        setModel(data.models[0])
      }
    } catch (err) {
      message.error(String(err))
    } finally {
      setFetching(false)
    }
  }

  // 保存：必填校验通过才交给父组件
  const submit = () => {
    if (!baseUrl || !apiKey || !model) {
      message.warning('请填写完整：API URL / API Key / 模型')
      return
    }
    onSubmit({ protocol, baseUrl, apiKey, model })
  }

  return (
    <Modal open={open} title={initial ? '编辑 Provider' : '添加 Provider'} okText="保存" cancelText="取消" onOk={submit} onCancel={onCancel}>
      <Space direction="vertical" size="small" style={{ width: '100%', marginTop: 8 }}>
        {/* 协议：切换后清空已拉取的模型（不同协议模型不通用） */}
        <Select
          value={protocol}
          onChange={(v) => {
            setProtocol(v)
            setModels([])
            setModel('')
          }}
          options={PROTOCOLS.map((p) => ({ value: p.value, label: p.label }))}
          style={{ width: '100%' }}
        />
        <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="API URL" />
        {/* 【已知取舍 · Demo 不修】API Key 用普通文本框明文显示（Provider 列表里也明文）。
            原因：本地调试工具，方便核对；要修可改 type="password"。 */}
        <Input value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="API Key" />
        <Flex gap={8}>
          <AutoComplete
            value={model}
            onChange={setModel}
            options={models.map((m) => ({ value: m }))}
            placeholder="选择或输入模型"
            style={{ flex: 1 }}
            popupMatchSelectWidth={false}
          />
          <Button onClick={fetchModels} loading={fetching}>
            Fetch Models
          </Button>
        </Flex>
      </Space>
    </Modal>
  )
}
