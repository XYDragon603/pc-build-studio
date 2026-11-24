// 打包桌面程序：写入项目路径，生成 out/PCBuilder-win32-x64/PCBuilder.exe。
// 程序运行时读取项目目录的代码与数据，所以项目更新后无需重新打包（前端改动需先 npm --prefix web run build）。
import { packager } from '@electron/packager';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectRoot = path.resolve(root, '..');
writeFileSync(path.join(root, 'app-config.json'), JSON.stringify({ projectRoot }, null, 2));

const [appPath] = await packager({
  dir: root,
  name: 'PCBuilder',
  executableName: 'PCBuilder',
  out: path.join(root, 'out'),
  overwrite: true,
  platform: 'win32',
  arch: 'x64',
  icon: path.join(root, 'icon.ico'),
  asar: false,
  ignore: [/^\/out($|\/)/, /^\/scripts($|\/)/, /^\/icon\.png$/],
  win32metadata: { ProductName: '装机工作台', FileDescription: '装机工作台', InternalName: 'PCBuilder', OriginalFilename: 'PCBuilder.exe' },
});
console.log(`已打包：${path.join(appPath, 'PCBuilder.exe')}`);
console.log(`项目目录：${projectRoot}`);
