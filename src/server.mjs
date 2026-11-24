import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApiServer } from './api.mjs';

const port = Number(process.env.PORT ?? 4310);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须为 1 到 65535 的整数');

// 已构建前端（web/dist）时，同一端口直接提供页面
const dist = fileURLToPath(new URL('../web/dist/', import.meta.url));
const server = createApiServer({ staticDir: existsSync(dist) ? dist : null });
server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用，请设置其他 PORT。` : error.message);
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => {
  console.log(`装机工作台  http://127.0.0.1:${port}/`);
});
