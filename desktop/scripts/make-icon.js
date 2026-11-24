// 生成图标：Chrome 把 icon.svg 渲染成 512×512 PNG（无头模式窗口最窄 500px，小尺寸直接渲染会错位），
// 再用 Electron 的 nativeImage 缩放成 256/48/32/16，打包成 icon.ico（ICO 内嵌 PNG）。
// 运行：npm run icon
const { app, nativeImage } = require('electron');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const chrome = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

app.whenReady().then(() => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pcb-icon-'));
  const svg = fs.readFileSync(path.join(root, 'icon.svg'), 'utf8').replace('<svg ', '<svg width="512" height="512" style="display:block" ');
  const html = path.join(tmp, 'icon.html');
  fs.writeFileSync(html, `<!doctype html><html><body style="margin:0;background:transparent">${svg}</body></html>`);
  const big = path.join(tmp, 'icon-512.png');
  execFileSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--default-background-color=00000000',
    `--user-data-dir=${path.join(tmp, 'profile')}`, '--window-size=640,640', '--force-device-scale-factor=1', `--screenshot=${big}`, pathToFileURL(html).href], { stdio: 'ignore' });
  // 窗口留出余量，再裁出左上角 512×512，避免可视区域略小导致边缘被切
  const source = nativeImage.createFromPath(big).crop({ x: 0, y: 0, width: 512, height: 512 });
  const sizes = [256, 48, 32, 16];
  const pngs = sizes.map(size => ({ size, data: source.resize({ width: size, height: size, quality: 'best' }).toPNG() }));

  const header = Buffer.alloc(6 + 16 * pngs.length);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach(({ size, data }, i) => {
    const e = 6 + i * 16;
    header.writeUInt8(size >= 256 ? 0 : size, e);
    header.writeUInt8(size >= 256 ? 0 : size, e + 1);
    header.writeUInt16LE(1, e + 4); header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(data.length, e + 8); header.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  fs.writeFileSync(path.join(root, 'icon.ico'), Buffer.concat([header, ...pngs.map(p => p.data)]));
  fs.writeFileSync(path.join(root, 'icon.png'), pngs[0].data);
  console.log('已生成 icon.ico（' + sizes.join(' / ') + 'px）与 icon.png');
  app.quit();
});
