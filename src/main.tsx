// React 应用入口：挂载 App 并配置 antd 中文语言包

import React from 'react'
import ReactDOM from 'react-dom/client'
import { ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import App from './App'

// 挂载到 index.html 里的 #root 节点
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {/* antd 全局配置：中文文案 */}
    <ConfigProvider locale={zhCN}>
      <App />
    </ConfigProvider>
  </React.StrictMode>,
)
