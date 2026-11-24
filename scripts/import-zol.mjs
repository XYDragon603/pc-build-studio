// 从中关村在线（ZOL）产品库导入国内市场的硬件型号与参数，供个人非商业使用。
//
//   node scripts/import-zol.mjs --category GPU --limit 50
//   node scripts/import-zol.mjs --prices                    # 只重抓已抓过的列表页，刷新全部类目的参考价
//   node scripts/import-zol.mjs --prices --category GPU
//   node scripts/import-zol.mjs --category GPU --limit 300 --chips "RTX 50|RTX 40|RX 9|RX 7"
//
// 约束：
// - 只访问 robots.txt 允许的列表页（/vga/N.html）和参数页（/xxxx/id/param.shtml）。
// - 每次联网请求之间至少间隔 --delay 毫秒（默认 2500），原始 HTML 缓存在 .runtime/zol-cache，重跑不重复请求。
// - 遇到 403 / 429 / 验证页立即停止，不重试、不绕过。
// - 输出 .runtime/zol-catalog.json，记录格式与 BuildCores 导入一致；多次运行按 id 累积。
import { appendFile, mkdir, open, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { LocalStore } from '../src/store.mjs';

const ORIGIN = 'https://detail.zol.com.cn';
const USER_AGENT = 'pc-builder-personal-catalog/0.1 (+local; personal use)';
const CACHE_DIR = path.resolve('.runtime/zol-cache');

/** ZOL 栏目与参数解析；每个类目的字段名都对照过实际参数页 */
const CATEGORIES = {
  GPU: { slug: 'vga', suffix: '显卡', specs: gpuSpecs, summary: gpuSummary },
  CASE: { slug: 'case', suffix: '机箱', specs: caseSpecs, summary: caseSummary },
  MOTHERBOARD: { slug: 'motherboard', suffix: '主板', specs: boardSpecs, summary: boardSummary },
  // 只收台式机内存 / 台式机电源
  RAM: { slug: 'memory', suffix: '内存', specs: ramSpecs, summary: ramSummary,
    accept: p => !p['适用类型'] || p['适用类型'].includes('台式') },
  PSU: { slug: 'power', suffix: '电源', specs: psuSpecs, summary: psuSummary,
    accept: p => !p['电源类型'] || p['电源类型'].includes('台式') },
  // 只收台式机 CPU
  CPU: { slug: 'cpu', suffix: 'CPU', specs: cpuSpecs, summary: cpuSummary,
    accept: p => !p['适用类型'] || p['适用类型'].includes('台式') },
  SSD: { slug: 'solid_state_drive', suffix: '固态硬盘', specs: ssdSpecs, summary: ssdSummary },
  // 只收 CPU 散热器（栏目里也有显卡散热器等）
  COOLER: { slug: 'cooling_product', suffix: '散热器', specs: coolerSpecs, summary: coolerSummary,
    accept: p => !p['散热器类型'] || p['散热器类型'].includes('CPU') },
};

/** 中文品牌 → BuildCores 使用的英文品牌名，用于按“品牌 + 料号”合并 */
const BRANDS = {
  华硕: 'ASUS', 微星: 'MSI', msi微星: 'MSI', 技嘉: 'Gigabyte', 索泰: 'Zotac', 蓝宝石: 'Sapphire', 撼讯: 'PowerColor',
  映众: 'Inno3D', 华擎: 'ASRock', 影驰: 'GALAX', 耕升: 'Gainward', 七彩虹: 'Colorful', 盈通: 'Yeston',
  XFX讯景: 'XFX', 讯景: 'XFX', 铭瑄: 'Maxsun', 丽台: 'Leadtek', 英特尔: 'Intel', NVIDIA: 'NVIDIA', AMD: 'AMD',
  // 机箱 / 散热器
  航嘉: 'HuntKey', 先马: 'SAMA', 乔思伯: 'Jonsbo', 利民: 'Thermalright', 九州风神: 'DeepCool', 酷冷至尊: 'Cooler Master',
  追风者: 'Phanteks', 联力: 'Lian Li', 恩杰: 'NZXT', 海盗船: 'Corsair', 美商海盗船: 'Corsair', 爱国者: 'aigo', 鑫谷: 'Segotep',
  安钛克: 'Antec', 猫头鹰: 'Noctua', 超频三: 'PCCooler', 分形工艺: 'Fractal Design', 瓦尔基里: 'Valkyrie', 君主: 'MONTECH',
  创氪星系: 'TRYX', 德商必酷: 'be quiet!', 安耐美: 'Enermax',
  // 主板 / 内存 / 电源
  映泰: 'Biostar', 金士顿: 'Kingston', 金百达: 'KINGBANK', 光威: 'Gloway', 芝奇: 'G.SKILL', 威刚: 'ADATA', 英睿达: 'Crucial',
  宏碁掠夺者: 'Predator', 科赋: 'Klevv', 雷克沙: 'Lexar', 朗科: 'Netac', 十铨: 'TEAMGROUP', 宇瞻: 'Apacer',
  // 固态硬盘
  三星: 'Samsung', 西部数据: 'Western Digital', 铠侠: 'Kioxia', 希捷: 'Seagate', 闪迪: 'SanDisk', 致态: 'ZhiTai',
  长江存储: 'ZhiTai', 海康威视: 'Hikvision', 梵想: 'Fanxiang', 爱国者存储: 'aigo', 英特尔存储: 'Intel', 美光: 'Crucial',
  振华: 'Super Flower', 海韵: 'SeaSonic', 全汉: 'FSP Group', 长城: 'Great Wall', 长城机电: 'Great Wall',
};

const cli = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
const { values: args } = parseArgs({ args: cli ? process.argv.slice(2) : [], options: {
  category: { type: 'string', default: 'GPU' },
  limit: { type: 'string', default: '50' },
  delay: { type: 'string', default: '2500' },
  chips: { type: 'string' },
  // 默认排除服务器 / 专业卡，装机目录用不到
  exclude: { type: 'string', default: String.raw`Tesla|服务器|\bRTX A\d|RTX ?PRO|RTX \d{4} Ada|Quadro|\b[AH]\d{3}\b|Instinct|Radeon Pro` },
  'max-pages': { type: 'string', default: '20' },
  // 刷新参考价：不读缓存，重抓已抓过的列表页，只更新价格并记录历史
  prices: { type: 'boolean', default: false },
} });

const pricesMode = args.prices;
const category = (pricesMode && !process.argv.includes('--category') ? 'ALL' : args.category).toUpperCase();
const config = CATEGORIES[category];
if (!config && !(pricesMode && category === 'ALL')) throw new Error(`暂只支持：${Object.keys(CATEGORIES).join('、')}`);
const limit = positive(args.limit, 'limit');
const delayMs = Math.max(1000, positive(args.delay, 'delay'));
const maxPages = positive(args['max-pages'], 'max-pages');
const chipFilter = args.chips ? new RegExp(args.chips, 'i') : null;
const excludeFilter = args.exclude && category === 'GPU' ? new RegExp(args.exclude, 'i') : null;

function positive(value, name) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`--${name} 必须为正整数`);
  return n;
}

// ---------- 抓取（带缓存与限速） ----------

class Blocked extends Error {}
/** 断网、DNS 失败、超时：停止本次抓取，但保留已解析的结果（原始页面有缓存，重跑很快） */
class NetworkError extends Error {}
let lastRequestAt = 0;
let networkRequests = 0;

async function fetchPage(url, cacheName, { refresh = false } = {}) {
  const cacheFile = path.join(CACHE_DIR, cacheName);
  if (!refresh) {
    try {
      const [body, info] = await Promise.all([readFile(cacheFile), stat(cacheFile)]);
      return { html: decode(body), cached: true, fetchedAt: info.mtime.toISOString() };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const wait = lastRequestAt + delayMs - Date.now();
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
  lastRequestAt = Date.now();
  networkRequests++;
  let response;
  try {
    response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    throw new NetworkError(`网络请求失败（${error.cause?.code ?? error.name}）：${url}`);
  }
  if ([403, 429].includes(response.status)) throw new Blocked(`ZOL 返回 HTTP ${response.status}，已停止`);
  if (response.status !== 200) return { html: null, status: response.status };
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > 3 * 1024 * 1024) throw new Error(`页面过大：${url}`);
  const html = decode(body);
  if (/验证码|访问过于频繁|安全验证/.test(html) && html.length < 20000) throw new Blocked('ZOL 返回验证页，已停止');
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(cacheFile, body);
  return { html, cached: false, fetchedAt: new Date().toISOString() };
}

function decode(buffer) {
  const head = buffer.subarray(0, 4096).toString('latin1');
  const charset = head.match(/charset\s*=\s*["']?([\w-]+)/i)?.[1] ?? 'gbk';
  return new TextDecoder(/^(gbk|gb2312|gb18030)$/i.test(charset) ? 'gb18030' : 'utf-8').decode(buffer);
}

// ---------- 解析 ----------

const text = html => html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

/** 列表页：编号、名称（去掉卖点副标题）、参考价、缩略图 */
export function parseList(html) {
  const items = [];
  for (const m of html.matchAll(/<li[^>]*data-follow-id="p(\d+)"[^>]*>([\s\S]*?)<\/li>/g)) {
    const block = m[2];
    const nameHtml = block.match(/<h3>\s*<a[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? '';
    const name = text(nameHtml.replace(/<span[\s\S]*?<\/span>/g, ''));
    const price = Number(block.match(/class="price-type">\s*([\d.]+)\s*</)?.[1]);
    const image = block.match(/\.src="(https:\/\/[^"]+)"/)?.[1] ?? block.match(/<img[^>]*src="(https:\/\/[^"]+)"/)?.[1] ?? null;
    if (name) items.push({ zolId: m[1], name, referencePriceCents: Number.isFinite(price) && price > 0 ? Math.round(price * 100) : null, imageUrl: image });
  }
  return items;
}

/** 参数页：参数表、英文全名（取自标题）、中文品牌（取自面包屑） */
export function parseParams(html, suffix) {
  // 名称与值分别按编号收集再配对：带说明的参数名是 <span class="param-explain" id="newPmName_4" …>
  const collect = kind => new Map([...html.matchAll(new RegExp(`<span[^>]*\\bid="newPm${kind}_(\\d+)"[^>]*>([\\s\\S]*?)</span>`, 'g'))]
    .map(m => [m[1], text(m[2])]));
  const names = collect('Name');
  const vals = collect('Val');
  const params = {};
  for (const [index, key] of names) {
    if (key && vals.has(index) && !(key in params)) params[key] = vals.get(index);
  }
  const title = html.match(/<title>([^<]*)<\/title>/)?.[1] ?? '';
  const englishName = title.match(/】(.+?)(?:显卡|处理器|主板|内存|硬盘|电源|机箱|散热器)?参数_/)?.[1]?.trim() ?? null;
  const crumb = text(html.match(/class="breadcrumb"[\s\S]*?<\/div>/)?.[0] ?? '');
  const brand = crumb.split('>').map(s => s.trim()).find(s => s.endsWith(suffix) && s !== suffix)?.slice(0, -suffix.length).trim() || null;
  return { params, englishName, brand };
}

const num = value => {
  const n = Number(String(value ?? '').match(/\d+(?:\.\d+)?/)?.[0]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

function gpuSpecs(p) {
  // 产品尺寸如 “281×119×40mm”：第一项为长度；只在数值合理时采用
  const dims = (p['产品尺寸'] ?? '').match(/\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  const lengthMm = dims.length >= 2 && dims[0] >= 100 && dims[0] <= 450 ? dims[0] : undefined;
  return {
    chipset: p['显卡芯片'] || undefined,
    capacityGB: num(p['显存容量']),
    memoryType: p['显存类型'] || undefined,
    lengthMm,
    recommendedPsuWatts: num(p['建议电源']),
    powerConnectors: p['电源接口'] || undefined,
    busInterface: p['接口类型'] || undefined,
  };
}

const nums = value => (String(value ?? '').match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
/** 限值类字段（如“装前置风扇 330mm，无风扇 360mm”）取最小值，结论偏保守 */
const minWithin = (value, lo, hi) => {
  const list = nums(value).filter(n => n >= lo && n <= hi);
  return list.length ? Math.min(...list) : undefined;
};

function gpuSummary(specs) {
  return [specs.chipset?.replace(/^GeForce |^Radeon /, ''), specs.capacityGB && `${specs.capacityGB}GB`,
    specs.memoryType, specs.lengthMm && `${specs.lengthMm}mm`].filter(Boolean).join(' · ');
}

/** 板型统一为 BuildCores 主板的写法：EATX / ATX / Micro ATX / Mini-ITX */
export function boardFormFactor(value) {
  const t = String(value ?? '').toUpperCase().replace(/[\s-]/g, '');
  if (/^(E|扩展)ATX/.test(t) || t.startsWith('EATX')) return 'EATX';
  if (/^(MATX|MICROATX|MICRO-ATX|M-ATX)/.test(t)) return 'Micro ATX';
  if (/^(MINIITX|ITX)/.test(t)) return 'Mini-ITX';
  if (t.startsWith('ATX')) return 'ATX';
  return undefined;
}

function caseSpecs(p) {
  return {
    maxBoardFormFactor: boardFormFactor(p['机箱结构']),
    supportedBoards: p['适用主板'] || undefined,
    maxGpuLengthMm: minWithin(p['显卡限长'], 100, 600),
    maxCoolerHeightMm: minWithin(p['CPU散热器限高'] ?? p['散热器限高'], 30, 250),
    radiatorSupport: p['支持水冷'] || undefined,
    maxRadiatorMm: maxRadiator(p['支持水冷']),
  };
}

const RADIATOR_SIZES = [120, 140, 240, 280, 360, 420];

/** “顶置：360冷排（长度在395mm以内）” → 360：只认标准冷排尺寸，避免把长度限制当成冷排 */
export function maxRadiator(value) {
  const sizes = nums(value).filter(n => RADIATOR_SIZES.includes(n));
  return sizes.length ? Math.max(...sizes) : undefined;
}

function caseSummary(specs) {
  return [specs.maxBoardFormFactor, specs.maxGpuLengthMm && `显卡限长 ${specs.maxGpuLengthMm}mm`,
    specs.maxCoolerHeightMm && `散热限高 ${specs.maxCoolerHeightMm}mm`, specs.maxRadiatorMm && `冷排 ≤${specs.maxRadiatorMm}mm`]
    .filter(Boolean).join(' · ');
}

/** “Intel：LGA 115X/1200/1700 AMD：AM4/AM5” → ['LGA115X', 'LGA1200', 'LGA1700', 'AM4', 'AM5'] */
export function parseSockets(value) {
  const text = String(value ?? '').toUpperCase().replace(/\s+/g, '');
  const out = new Set();
  for (const m of text.matchAll(/LGA([\dX]+(?:\/[\dX]+)*)/g)) for (const n of m[1].split('/')) out.add('LGA' + n);
  for (const m of text.matchAll(/AM\d/g)) out.add(m[0]);
  return out.size ? [...out] : undefined;
}

function coolerSpecs(p) {
  const liquid = /水冷/.test(`${p['散热方式'] ?? ''} ${p['散热器类型'] ?? ''}`);
  const air = !liquid && (p['散热方式'] ?? '').includes('风冷');
  // ZOL 的“产品尺寸”三项顺序不固定（如 NH-U12S 记作 158x125x71mm），下压式的尺寸常不含风扇。
  // 塔式风冷的高度一定是最大的一项，因此只在最大项 ≥ 130mm 时取作高度；更矮的下压式记为未知，交给用户核对。
  const dims = nums(p['产品尺寸']).filter(n => n > 0 && n <= 250);
  const tallest = dims.length >= 3 ? Math.max(...dims) : undefined;
  return {
    coolingType: liquid ? '水冷' : air ? '风冷' : (p['散热方式'] || undefined),
    heightMm: air && tallest && tallest >= 130 && tallest <= 200 ? tallest : undefined,
    radiatorSizeMm: liquid ? nums(p['水冷排类型']).find(n => RADIATOR_SIZES.includes(n)) : undefined,
    sockets: parseSockets(p['适用范围']),
    fanSizeMm: nums(p['风扇尺寸'])[0] || undefined,
  };
}

function coolerSummary(specs) {
  return [specs.coolingType, specs.radiatorSizeMm && `${specs.radiatorSizeMm}mm 冷排`, specs.heightMm && `高 ${specs.heightMm}mm`, specs.fanSizeMm && `${specs.fanSizeMm}mm 风扇`]
    .filter(Boolean).join(' · ');
}

/** “LGA 1700” / “Socket AM5” → LGA1700 / AM5 */
const socketOf = value => {
  const t = String(value ?? '').toUpperCase().replace(/SOCKET|\s+/g, '');
  return t.match(/LGA\d{3,4}|AM\d|TR\d|STR\d|SP\d/)?.[0];
};

function boardSpecs(p) {
  const memory = p['内存类型'] ?? '';
  return {
    socket: socketOf(p['CPU插槽']),
    chipset: p['主芯片组'] || undefined,
    memoryType: memory.match(/DDR\d/i)?.[0].toUpperCase(),
    memorySlots: Number(memory.match(/(\d+)\s*[×xX*]/)?.[1]) || undefined,
    maxMemoryGB: num(p['最大内存容量']),
    formFactor: boardFormFactor(p['主板板型']),
    m2Slots: Number((p['存储接口'] ?? '').match(/(\d+)\s*[×xX*]\s*M\.2/i)?.[1]) || undefined,
  };
}

function boardSummary(specs) {
  return [specs.socket, specs.chipset, specs.memoryType, specs.formFactor].filter(Boolean).join(' · ');
}

/** “套装（2×16GB）” → { capacityGB: 32, modules: 2 }；“16GB” → { 16, 1 } */
export function parseRamCapacity(value) {
  const t = String(value ?? '');
  const kit = t.match(/(\d+)\s*[×xX*]\s*(\d+)\s*G/);
  if (kit) return { modules: Number(kit[1]), capacityGB: Number(kit[1]) * Number(kit[2]) };
  const single = t.match(/(\d+)\s*G/);
  return single ? { modules: 1, capacityGB: Number(single[1]) } : {};
}

function ramSpecs(p) {
  const { modules, capacityGB } = parseRamCapacity(p['容量描述'] ?? p['内存容量']);
  return {
    memoryType: (p['内存类型'] ?? '').match(/DDR\d/i)?.[0].toUpperCase(),
    capacityGB,
    modules,
    speedMTs: num(p['内存带宽']) ?? num(p['内存主频']),
    casLatency: num(p['CL延迟']),
  };
}

function ramSummary(specs) {
  return [specs.memoryType, specs.capacityGB && `${specs.capacityGB}GB${specs.modules > 1 ? `（${specs.modules} 条）` : ''}`,
    specs.speedMTs && `${specs.speedMTs} MT/s`, specs.casLatency && `CL${specs.casLatency}`].filter(Boolean).join(' · ');
}

function psuSpecs(p) {
  // 按外形尺寸判断规格：ATX 为 150×86，SFX 高约 63.5mm
  const dims = nums(p['电源尺寸']);
  const formFactor = dims.includes(150) && dims.includes(86) ? 'ATX'
    : dims.some(d => d >= 63 && d <= 64) && Math.max(...dims) <= 130 ? 'SFX' : undefined;
  const text = Object.values(p).join(' ');
  return {
    ratedWatts: num(p['额定功率']),
    efficiency: p['80PLUS认证'] || undefined,
    modular: p['电源模组'] || undefined,
    formFactor,
    // 原生 16pin（12VHPWR / 12V-2x6）显卡供电口
    native16Pin: /12VHPWR|12V-?2X6|16\s*PIN/i.test(text) || undefined,
  };
}

function psuSummary(specs) {
  return [specs.ratedWatts && `${specs.ratedWatts}W`, specs.efficiency, specs.modular, specs.native16Pin && '原生 16pin']
    .filter(Boolean).join(' · ');
}

/**
 * AMD 锐龙桌面处理器的封装功耗上限 PPT = TDP × 1.35（65W → 88W，105W → 142W，170W → 230W）。
 * Intel 没有固定换算，只在页面写明最大功耗（PL2 / 最大睿频功耗）时采用。
 */
function cpuPeakWatts(p, socket, tdp) {
  const explicit = num(p['最大加速功耗（MTP）'] ?? p['最大加速功耗(MTP)'] ?? p['最大睿频功耗'] ?? p['最大功耗'] ?? p['PL2']);
  if (explicit) return explicit;
  if (tdp && /^AM\d$/.test(socket ?? '') && /AMD|锐龙|Ryzen/i.test(`${p['CPU系列'] ?? ''} ${p['产品型号'] ?? ''}`)) return Math.round(tdp * 1.35);
  return undefined;
}

const CN_DIGITS = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** “二十四核心(8P+16E)” → 24；“六核心” → 6；“8核心” → 8 */
export function countOf(value) {
  const text = String(value ?? '');
  // 以中文数字开头时按中文解析（避免取到括号里的 “8P+16E”）
  const arabic = /^[一二两三四五六七八九十]/.test(text.trim()) ? null : text.match(/\d+/);
  if (arabic) return Number(arabic[0]);
  const m = text.match(/([一二两三四五六七八九]?)(十?)([一二三四五六七八九]?)/);
  if (!m || !m[0]) return undefined;
  const [, a, ten, b] = m;
  const n = ten ? (a ? CN_DIGITS[a] : 1) * 10 + (b ? CN_DIGITS[b] : 0) : CN_DIGITS[a];
  return n || undefined;
}

function cpuSpecs(p) {
  const socket = socketOf(p['插槽类型'] ?? p['CPU插槽']);
  const tdpWatts = num(p['热设计功耗(TDP)'] ?? p['热设计功耗']);
  return {
    socket,
    cores: countOf(p['核心数量']),
    threads: countOf(p['线程数量']),
    tdpWatts,
    maxPowerWatts: cpuPeakWatts(p, socket, tdpWatts),
    memoryType: (p['内存类型'] ?? '').match(/DDR\d/i)?.[0].toUpperCase(),
    packaging: p['包装形式'] || undefined,
    integratedGraphics: p['集成显卡'] && !/无/.test(p['集成显卡']) ? p['集成显卡'] : undefined,
  };
}

function cpuSummary(specs) {
  return [specs.socket, specs.cores && `${specs.cores} 核`, specs.threads && `${specs.threads} 线程`,
    specs.tdpWatts && `${specs.tdpWatts}W`, specs.packaging].filter(Boolean).join(' · ');
}

function ssdSpecs(p) {
  const iface = p['接口类型'] ?? '';
  const gen = (p['通道'] ?? '').match(/Gen\s*(\d)/i)?.[1];
  const capacity = String(p['存储容量'] ?? '');
  const tb = capacity.match(/(\d+(?:\.\d+)?)\s*TB/i);
  return {
    capacityGB: tb ? Math.round(Number(tb[1]) * 1000) : num(capacity),
    interface: /M\.2/i.test(iface) ? `M.2 ${/PCIe|NVMe/i.test(iface) ? `PCIe${gen ? ` ${gen}.0` : ''}` : 'SATA'}` : iface || undefined,
    readMBs: num(p['读取速度']),
    writeMBs: num(p['写入速度']),
    tbw: num((p['其它性能'] ?? '').match(/(\d+)\s*TBW/i)?.[1]),
  };
}

function ssdSummary(specs) {
  const cap = specs.capacityGB && (specs.capacityGB >= 1000 ? `${specs.capacityGB / 1000}TB` : `${specs.capacityGB}GB`);
  return [cap, specs.interface, specs.readMBs && `读 ${specs.readMBs}MB/s`].filter(Boolean).join(' · ');
}

const paramUrl = id => `${ORIGIN}/${Math.ceil(Number(id) / 1000)}/${id}/param.shtml`;
const normalize = value => (value ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

function toRecord(listing, parsed) {
  const { params, englishName, brand } = parsed;
  const specs = Object.fromEntries(Object.entries(config.specs(params)).filter(([, v]) => v !== undefined));
  const mpn = params['产品型号']?.trim() || null;
  const manufacturer = brand ? (BRANDS[brand] ?? brand) : null;
  const summary = config.summary(specs);
  return {
    id: `zol-${listing.zolId}`,
    category,
    name: listing.name,
    manufacturer,
    mpn,
    partNumbers: mpn ? [mpn] : [],
    summary,
    aliases: [englishName, brand && manufacturer !== brand ? brand : null].filter(Boolean),
    specs,
    imageUrl: listing.imageUrl,
    imageSourceUrl: listing.imageUrl ? `${ORIGIN}/${config.slug}/index${listing.zolId}.shtml` : undefined,
    sourceUrl: paramUrl(listing.zolId),
    referencePriceCents: listing.referencePriceCents,
    priceObservedAt: listing.referencePriceCents ? listing.fetchedAt : null,
    dataSource: 'zol',
    rawParams: params,
  };
}

// ---------- 主流程 ----------

const HISTORY_FILE = path.resolve('.runtime/zol-price-history.jsonl');

/** 已抓过的列表页数（按缓存文件），刷新时只抓这些页 */
async function cachedListPages(slug) {
  let files = [];
  try { files = await readdir(CACHE_DIR); } catch { return 0; }
  return Math.max(0, ...files.map(f => f.match(new RegExp(`^list-${slug}-(\\d+)\\.html$`))?.[1]).filter(Boolean).map(Number));
}

async function refreshPrices() {
  const store = new LocalStore();
  const snapshot = await store.read('zol-catalog.json', { items: [] });
  const byId = new Map(snapshot.items.map(item => [item.id, item]));
  const categories = category === 'ALL' ? Object.keys(CATEGORIES) : [category];
  const report = {};
  const history = [];
  let stopped = null;
  outer: for (const cat of categories) {
    const { slug } = CATEGORIES[cat];
    const pages = await cachedListPages(slug);
    const r = report[cat] = { pages, seen: 0, changed: 0, notSeen: 0 };
    const seen = new Set();
    for (let page = 1; page <= pages; page++) {
      const url = page === 1 ? `${ORIGIN}/${slug}/` : `${ORIGIN}/${slug}/${page}.html`;
      let result;
      try {
        result = await fetchPage(url, `list-${slug}-${page}.html`, { refresh: true });
      } catch (error) {
        if (!(error instanceof NetworkError || error instanceof Blocked)) throw error;
        stopped = error.message;
        break outer;
      }
      if (!result.html) continue;
      for (const listing of parseList(result.html)) {
        const item = byId.get(`zol-${listing.zolId}`);
        if (!item || seen.has(item.id)) continue;
        seen.add(item.id);
        r.seen++;
        if (listing.referencePriceCents == null) continue;
        if (item.referencePriceCents !== listing.referencePriceCents) r.changed++;
        history.push({ id: item.id, cents: listing.referencePriceCents, previousCents: item.referencePriceCents ?? null, at: result.fetchedAt });
        item.referencePriceCents = listing.referencePriceCents;
        item.priceObservedAt = result.fetchedAt;
      }
    }
    // 列表页按热度排序，掉出前几页的型号保留原价格和原时间
    r.notSeen = snapshot.items.filter(i => i.category === cat && !seen.has(i.id)).length;
  }
  if (history.length) {
    await mkdir(path.dirname(HISTORY_FILE), { recursive: true });
    await appendFile(HISTORY_FILE, history.map(h => JSON.stringify(h)).join('\n') + '\n');
  }
  await store.write('zol-catalog.json', { ...snapshot, items: [...byId.values()], pricesUpdatedAt: new Date().toISOString() });
  if (stopped) process.exitCode = 2;
  console.log(JSON.stringify({ stopped, networkRequests, historyRecords: history.length, report }, null, 2));
}

async function main() {
  if (pricesMode) return refreshPrices();
  const store = new LocalStore();
  const previous = await store.read('zol-catalog.json', { items: [] });
  const byId = new Map(previous.items.filter(item => item.category !== category || !excludeFilter?.test(item.name)).map(item => [item.id, item]));
  const fetchedAt = new Date().toISOString();
  const report = { listPages: 0, candidates: 0, imported: 0, skippedByChip: 0, excluded: 0, notApplicable: 0, missingParams: [] };

  const queue = [];
  for (let page = 1; page <= maxPages && queue.length < limit; page++) {
    const url = page === 1 ? `${ORIGIN}/${config.slug}/` : `${ORIGIN}/${config.slug}/${page}.html`;
    let listPage;
    try {
      listPage = await fetchPage(url, `list-${config.slug}-${page}.html`);
    } catch (error) {
      if (!(error instanceof NetworkError)) throw error;
      console.error(error.message);
      break;
    }
    const { html } = listPage;
    if (!html) break;
    report.listPages++;
    const listings = parseList(html).map(l => ({ ...l, fetchedAt: listPage.fetchedAt }));
    if (!listings.length) break;
    for (const listing of listings) {
      if (queue.length >= limit) break;
      if (excludeFilter?.test(listing.name)) { report.excluded++; continue; }
      if (chipFilter && !chipFilter.test(listing.name)) { report.skippedByChip++; continue; }
      queue.push(listing);
    }
  }
  report.candidates = queue.length;

  let stopped = null;
  for (const [index, listing] of queue.entries()) {
    let page;
    try {
      page = await fetchPage(paramUrl(listing.zolId), `param-${listing.zolId}.html`);
    } catch (error) {
      if (!(error instanceof NetworkError || error instanceof Blocked)) throw error;
      stopped = error.message;
      break;
    }
    const { html, cached, status } = page;
    if (!html) { report.missingParams.push(`${listing.zolId} HTTP ${status}`); continue; }
    const parsed = parseParams(html, config.suffix);
    if (!Object.keys(parsed.params).length) { report.missingParams.push(`${listing.zolId} 无参数表`); continue; }
    if (config.accept && !config.accept(parsed.params)) { report.notApplicable++; continue; }
    const record = toRecord(listing, parsed);
    record.observedAt = cached ? (byId.get(record.id)?.observedAt ?? fetchedAt) : fetchedAt;
    byId.set(record.id, record);
    report.imported++;
    process.stdout.write(`\r${index + 1}/${queue.length} ${listing.name.slice(0, 40).padEnd(40)}`);
  }
  process.stdout.write('\n');

  const items = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  await store.write('zol-catalog.json', {
    attribution: {
      name: '中关村在线产品库', url: ORIGIN, use: '个人非商业使用，不对外分发',
      notes: '参数为站点众包维护，可能有误；参考价不是实时价格，不能作为报价。',
    },
    updatedAt: fetchedAt,
    items,
  });

  // 与 BuildCores 快照按“类目 + 品牌 + 料号”对照，评估可合并的比例
  const buildcores = await store.read('buildcores-catalog.json', { items: [] });
  const keys = new Set(buildcores.items.flatMap(i => i.partNumbers.map(mpn => `${i.category}:${normalize(i.manufacturer)}:${normalize(mpn)}`)));
  const thisRun = items.filter(i => queue.some(l => `zol-${l.zolId}` === i.id));
  const matched = thisRun.filter(i => i.mpn && keys.has(`${i.category}:${normalize(i.manufacturer)}:${normalize(i.mpn)}`));
  const brands = {};
  for (const i of thisRun) brands[i.manufacturer ?? '未知'] = (brands[i.manufacturer ?? '未知'] ?? 0) + 1;
  const coverage = field => thisRun.filter(i => i.specs[field] !== undefined).length;

  if (stopped) process.exitCode = 2;
  console.log(JSON.stringify({
    ...report,
    stopped,
    networkRequests,
    totalInSnapshot: items.length,
    withMpn: thisRun.filter(i => i.mpn).length,
    matchedBuildCores: matched.length,
    fieldCoverage: Object.fromEntries([...new Set(thisRun.flatMap(i => Object.keys(i.specs)))].map(k => [k, coverage(k)])),
    brands,
  }, null, 2));
}

/**
 * 同一时间只允许一个 ZOL 任务（导入或刷新价格）：两者都会整体改写快照，并发会互相覆盖。
 * 超过 3 小时的锁视为上次异常退出残留，自动清除。
 */
async function withLock(run) {
  const lockFile = path.resolve('.runtime/zol.lock');
  await mkdir(path.dirname(lockFile), { recursive: true });
  let handle;
  try {
    handle = await open(lockFile, 'wx');
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const age = Date.now() - (await stat(lockFile)).mtimeMs;
    if (age < 3 * 3600 * 1000) {
      console.error('另一个 ZOL 任务正在运行（.runtime/zol.lock），本次跳过。确认没有任务在跑后可删除该文件。');
      process.exitCode = 3;
      return;
    }
    await unlink(lockFile);
    handle = await open(lockFile, 'wx');
  }
  try {
    await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`);
    await run();
  } finally {
    await handle.close();
    await unlink(lockFile).catch(() => {});
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  withLock(main).catch(error => {
    console.error(error instanceof Blocked ? error.message : error);
    process.exitCode = 1;
  });
}
