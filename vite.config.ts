import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Vite 开发服务器配置
export default defineConfig({
  // React 插件，提供 JSX 转换与 HMR
  plugins: [react()],
  server: {
    port: 5173,
    // 把 /api 开头的请求代理到本机 Node Server（端口 3001），前端代码里不需要处理跨域
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
})
