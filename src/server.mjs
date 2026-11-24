import { createApiServer } from './api.mjs';

const port = Number(process.env.PORT ?? 4310);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须为 1 到 65535 的整数');

const server = createApiServer();
server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用，请设置其他 PORT。` : error.message);
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => {
  console.log(`装机工作台 API  http://127.0.0.1:${port}/api/v1`);
});
