import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { buildApp } from './src/server/app.js'

// 把 express 后端挂进 vite dev server 的中间件链：
// 前后端同端口（5173），单命令启动，不再需要 proxy 转发到独立端口
function agentServerPlugin(): Plugin {
  return {
    name: 'agent-server',
    configureServer(server) {
      // /api/* 请求由 express 处理，其余（静态资源/HMR）继续走 vite
      server.middlewares.use(buildApp())
    },
  }
}

// Vite 开发服务器配置
export default defineConfig({
  // React 插件，提供 JSX 转换与 HMR；agentServerPlugin 提供后端接口
  plugins: [react(), agentServerPlugin()],
  server: {
    port: 5173,
  },
})
