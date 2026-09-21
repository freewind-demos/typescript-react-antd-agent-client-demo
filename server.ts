// Node Server 独立入口：单独起后端（端口 3001）
// 注意：dev 模式不需要跑这个 —— pnpm run dev 会把 express 作为 vite 中间件挂进 5173，
// 前端请求 /api/* 直接打到同一端口，无需这里。

import { buildApp } from './src/server/app'

const PORT = 3001

// 【已知取舍 · Demo 不修】没有显式绑定 127.0.0.1，也没有鉴权与 Origin 校验：
// 同网段的其他设备能访问 /api/*，而该接口可以通过模型间接在本机执行 Bash。
// 原因：这是本地 Demo，只在本机短时运行；要加固需绑定回环 + Origin 校验 + 本地令牌。
buildApp().listen(PORT, () => {
  console.log(`Agent Client server listening on http://localhost:${PORT}`)
})
