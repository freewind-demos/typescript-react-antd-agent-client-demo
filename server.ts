// Node Server 独立入口：单独起后端（端口 3001）
// 注意：dev 模式不需要跑这个 —— pnpm run dev 会把 express 作为 vite 中间件挂进 5173，
// 前端请求 /api/* 直接打到同一端口，无需这里。

import { buildApp } from './src/server/app'

const PORT = 3001

buildApp().listen(PORT, () => {
  console.log(`Agent Client server listening on http://localhost:${PORT}`)
})
