// 装机工作台桌面程序：在程序内启动本地服务（随机端口，只监听本机），用独立窗口打开界面。
// 代码与数据直接读取项目目录（打包时把项目路径写进 app-config.json），项目更新后无需重新打包。
const { app, BrowserWindow, dialog, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

/** 项目根目录：优先 app-config.json 里的路径，其次本文件所在目录的上一级 */
function projectRoot() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'app-config.json'), 'utf8'));
    if (cfg.projectRoot && fs.existsSync(path.join(cfg.projectRoot, 'src', 'api.mjs'))) return cfg.projectRoot;
  } catch { /* 开发模式没有配置文件 */ }
  return path.resolve(__dirname, '..');
}

let server = null;

async function startServer(root) {
  const dist = path.join(root, 'web', 'dist');
  if (!fs.existsSync(path.join(dist, 'index.html'))) {
    throw new Error(`没有找到前端页面：${dist}\n请先在项目目录运行：npm --prefix web run build`);
  }
  // 服务使用相对路径 .runtime 读写数据，切到项目目录
  process.chdir(root);
  const envFile = path.join(root, '.env');
  if (fs.existsSync(envFile) && typeof process.loadEnvFile === 'function') process.loadEnvFile(envFile);
  const { createApiServer } = await import(pathToFileURL(path.join(root, 'src', 'api.mjs')).href);
  server = createApiServer({ staticDir: dist, onError: error => console.error(error) });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

function createWindow(port) {
  const origin = `http://127.0.0.1:${port}`;
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 720,
    title: '装机工作台',
    backgroundColor: '#e6f2ff',
    autoHideMenuBar: true,
    show: false,
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.once('ready-to-show', () => win.show());
  // 外部链接（商品来源页等）用系统浏览器打开，窗口内只显示本程序页面
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(origin)) {
      event.preventDefault();
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
    }
  });
  win.loadURL(`${origin}/`);
  return win;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(async () => {
    try {
      const port = await startServer(projectRoot());
      createWindow(port);
    } catch (error) {
      dialog.showErrorBox('装机工作台无法启动', String(error?.message ?? error));
      app.quit();
    }
  });

  app.on('window-all-closed', () => {
    if (server) server.close();
    app.quit();
  });
}
