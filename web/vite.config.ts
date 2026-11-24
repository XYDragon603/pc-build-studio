import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

declare const process: { env: Record<string, string | undefined> };
const api = `http://127.0.0.1:${process.env.API_PORT || 4310}`;

export default defineConfig({
  plugins: [react()],
  // 本地 API（项目根目录 npm start）默认监听 127.0.0.1:4310；API_PORT 可改
  server: { port: 5173, proxy: { '/api': api } },
  preview: { proxy: { '/api': api } },
});
