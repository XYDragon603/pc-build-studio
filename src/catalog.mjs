import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { invalid, ApiError } from './api-error.mjs';
import { peripheralTypes, slotTypes } from './builds.mjs';
import { enrichSpecs } from './specs-enrich.mjs';
import { loadPerformance } from './performance.mjs';
import { cpuKey, gpuKey } from './perfkeys.mjs';
import { catalogFitStatus, parseCatalogFit } from './catalog-fit.mjs';

const verified = JSON.parse(readFileSync(new URL('../data/catalog.json', import.meta.url), 'utf8'));
const verifiedIds = new Set(verified.map(item => item.id));
const categoryIds = new Set([...slotTypes, ...peripheralTypes].map(({ id }) => id));
const normalize = value => (value ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

function readImported(directory, file = 'buildcores-catalog.json') {
  if (directory === null) return { items: [], attribution: null };
  try {
    return JSON.parse(readFileSync(join(directory, file), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { items: [], attribution: null };
    throw error;
  }
}

function partKey(item, mpn) {
  return item.category + ':' + normalize(item.manufacturer) + ':' + normalize(mpn);
}

function mergeCatalog(imported) {
  const byPartNumber = new Map();
  for (const item of imported) {
    if (!item.manufacturer) continue;
    for (const key of new Set(item.partNumbers.map(mpn => partKey(item, mpn)))) {
      if (byPartNumber.has(key)) byPartNumber.set(key, null);
      else byPartNumber.set(key, item);
    }
  }
  const mergedIds = new Set();
  const first = verified.map(item => {
    const match = byPartNumber.get(partKey(item, item.mpn));
    if (!match || mergedIds.has(match.id)) return item;
    mergedIds.add(match.id);
    return { ...match, ...item, specs: { ...match.specs, ...item.specs } };
  });
  return [...first, ...imported.filter(item => !mergedIds.has(item.id))];
}

/**
 * 中关村在线快照（scripts/import-zol.mjs）：类目、品牌、料号唯一匹配时补充到已有记录，
 * 已有字段优先，只补缺失的规格、中文别名和图片；匹配不上的作为独立条目。
 */
function addZol(items, zolItems) {
  if (!zolItems.length) return items;
  const index = new Map();
  for (const item of items) {
    if (!item.manufacturer) continue;
    for (const key of new Set([item.mpn, ...(item.partNumbers ?? [])].filter(Boolean).map(mpn => partKey(item, mpn)))) {
      index.set(key, index.has(key) ? null : item);
    }
  }
  const enrich = new Map();
  const standalone = [];
  for (const zol of zolItems) {
    const candidate = zol.mpn && zol.manufacturer ? index.get(partKey(zol, zol.mpn)) : null;
    // 料号相同但芯片 / 型号不同（ZOL 料号填错）时不合并
    const chipOf = item => (item.category === 'GPU' ? gpuKey(item.specs?.chipset ?? item.name) : item.category === 'CPU' ? cpuKey(item.name) : null);
    const match = candidate && (!chipOf(candidate) || !chipOf(zol) || chipOf(candidate) === chipOf(zol)) ? candidate : null;
    if (match && !enrich.has(match.id)) enrich.set(match.id, zol);
    else standalone.push(zol);
  }
  const enriched = items.map(item => {
    const zol = enrich.get(item.id);
    if (!zol) return item;
    return {
      ...item,
      aliases: [...new Set([...item.aliases, zol.name, ...zol.aliases])],
      specs: { ...zol.specs, ...item.specs },
      imageUrl: item.imageUrl ?? zol.imageUrl,
      imageSourceUrl: item.imageUrl ? item.imageSourceUrl : zol.imageSourceUrl,
      referencePriceCents: zol.referencePriceCents,
      priceObservedAt: zol.priceObservedAt ?? null,
      zolId: zol.id,
      zolUrl: zol.sourceUrl,
      rawParams: zol.rawParams,
    };
  });
  return [...enriched, ...standalone];
}

const brief = ({ rawParams, ...item }) => item;

/** 读取 ZOL 参考价历史（import-zol.mjs --prices 追加），按目录 ID 分组 */
function readPriceHistory(directory) {
  const byId = new Map();
  if (directory === null) return byId;
  let text = '';
  try { text = readFileSync(join(directory, 'zol-price-history.jsonl'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return byId; throw error; }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (typeof entry.id === 'string' && Number.isSafeInteger(entry.cents)) byId.set(entry.id, [...(byId.get(entry.id) ?? []), entry]);
    } catch { /* 跳过损坏的行 */ }
  }
  return byId;
}

/** 价格走势：最近一次变价（之前的价格与时间）和记录到的最低价 */
function addTrends(items, history) {
  if (!history.size) return items;
  return items.map(item => {
    const entries = history.get(item.zolId ?? item.id);
    if (!entries?.length || !item.referencePriceCents) return item;
    const sorted = [...entries].sort((a, b) => String(a.at).localeCompare(String(b.at)));
    const change = [...sorted].reverse().find(e => Number.isSafeInteger(e.previousCents) && e.previousCents !== e.cents);
    const lowestCents = Math.min(item.referencePriceCents, ...sorted.map(e => e.cents));
    return {
      ...item,
      priceTrend: {
        previousCents: change?.previousCents ?? null,
        changedAt: change?.at ?? null,
        lowestCents,
        since: sorted[0].at,
        points: sorted.length,
      },
    };
  });
}

/**
 * 补充商品图：data/part-images.json 为 { 目录 ID: 图片 }。
 * 值为 https 网址，或 data/images/ 下的相对路径（经 /api/v1/images/ 提供）。只补没有图的条目。
 */
function readPartImages(file = new URL('../data/part-images.json', import.meta.url)) {
  let map = {};
  try { map = JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const out = new Map();
  for (const [id, value] of Object.entries(map ?? {})) {
    if (typeof value !== 'string' || !value.trim()) continue;
    const v = value.trim();
    if (/^https:\/\//i.test(v)) out.set(id, v);
    else if (/^images\/[\w.\-]+\.(jpe?g|png|webp|gif)$/i.test(v)) out.set(id, `/api/v1/${v}`);
  }
  return out;
}

function addImages(items, images) {
  if (!images.size) return items;
  return items.map(item => {
    if (item.imageUrl) return item;
    const url = images.get(item.id) ?? (item.zolId ? images.get(item.zolId) : undefined);
    return url ? { ...item, imageUrl: url, imageSourceUrl: item.imageSourceUrl ?? null } : item;
  });
}

const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
};

/**
 * 估算价：有 ZOL 参考价就用参考价；显卡没有时，用同芯片、同显存的参考价中位数（至少 3 个样本）。
 * 估算价只作参考，不是报价。
 */
function addReferenceAndChipEstimates(items) {
  const chipKey = item => item.category === 'GPU' && item.specs.chipset && item.specs.capacityGB
    ? `${normalize(String(item.specs.chipset).replace(/^(geforce|radeon)\s*/i, ''))}:${item.specs.capacityGB}` : null;
  const groups = new Map();
  for (const item of items) {
    const key = chipKey(item);
    if (key && item.referencePriceCents) groups.set(key, [...(groups.get(key) ?? []), item.referencePriceCents]);
  }
  return items.map(item => {
    if (item.estimatedPriceCents > 0) return item;
    const samples = groups.get(chipKey(item)) ?? [];
    if (item.referencePriceCents) {
      // 显卡参考价比同芯片中位价低 40% 以上，多半是数据错误，不作估算价
      const chipMedian = samples.length >= 3 ? median(samples) : null;
      if (chipMedian && item.referencePriceCents < chipMedian * 0.6) return { ...item, possiblyStale: true };
      return { ...item, estimatedPriceCents: item.referencePriceCents, estimateBasis: 'reference', estimateSamples: 1 };
    }
    if (samples.length >= 3) {
      return { ...item, estimatedPriceCents: median(samples), estimateBasis: 'chip-median', estimateSamples: samples.length };
    }
    return item;
  });
}

function efficiencyTier(value) {
  const tier = normalize(value);
  if (/titanium|钛金/.test(tier)) return 'titanium';
  if (/platinum|白金|铂金/.test(tier)) return 'platinum';
  if (/gold|金牌/.test(tier)) return 'gold';
  if (/silver|银牌/.test(tier)) return 'silver';
  if (/bronze|铜牌/.test(tier)) return 'bronze';
  if (/white|白牌|standard/.test(tier) || tier === '80plus' || tier === '80') return 'white';
  return 'unknown';
}

function ssdKey({ capacityGB, interface: connection }) {
  // 同一标称容量可能以 1000/1024 GB（或 500/512 GB）记录。
  const tier = [128, 256, 500, 1000, 2000, 4000].find(gb => Math.abs(capacityGB - gb) <= gb * 0.07);
  if (!tier) return null;
  const bus = (connection ?? '').normalize('NFKC');
  const gen = bus.match(/\bPCI[\s-]*E(?:XPRESS)?\s*(?:GEN\s*)?([345])(?:\.0)?(?![\d.])/i)?.[1];
  return `${tier}:${/\bSATA/i.test(bus) ? 'sata' : gen ? 'pcie' + gen : 'unknown'}`;
}

/**
 * 内存频率档：DDR5 4800 与 6000 价格差得多，同规格估价 / 旧价判断要分开。
 * DDR4：≤2666 / 2933–3200 / ≥3466；DDR5：≤5200 / 5600 / 6000–6400 / ≥6800；不认识的类型或缺频率归 'any'
 */
function ramSpeedTier(memoryType, speed) {
  const type = normalize(memoryType);
  if (!(speed > 0)) return 'any';
  if (type === 'ddr4') return speed <= 2666 ? 'low' : speed <= 3200 ? '3200' : '3600+';
  if (type === 'ddr5') return speed <= 5200 ? '4800' : speed < 6000 ? '5600' : speed <= 6400 ? '6000' : '6800+';
  return 'any';
}

function estimateGroup(item) {
  const specs = item.specs ?? {};
  switch (item.category) {
    case 'CPU': return cpuKey(item.name);
    case 'RAM': return specs.memoryType && specs.capacityGB > 0 && specs.modules > 0
      ? `${normalize(specs.memoryType)}:${specs.capacityGB}:${specs.modules}:${ramSpeedTier(specs.memoryType, specs.speedMTs)}` : null;
    case 'PSU': return specs.ratedWatts > 0
      ? `${Math.round(specs.ratedWatts / 50) * 50}:${efficiencyTier(specs.efficiency)}` : null;
    case 'SSD': return ssdKey(specs);
    default: return null;
  }
}

function addEstimates(items) {
  const base = addReferenceAndChipEstimates(items);
  const groups = new Map();
  const keys = base.map(item => {
    const group = estimateGroup(item);
    if (group === null) return null;
    const key = item.category + ':' + group;
    if (item.estimatedPriceCents > 0) {
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item.estimatedPriceCents);
    }
    return key;
  });
  const estimates = new Map();
  for (const [key, samples] of groups) {
    const cpu = key.startsWith('CPU:');
    const estimateBasis = cpu ? 'model' : 'spec-median';
    if (cpu && samples.length === 1) {
      estimates.set(key, { estimatedPriceCents: samples[0], estimateBasis, estimateSamples: 1 });
    } else if (samples.length >= 3) {
      const threshold = median(samples) * 0.6;
      const usable = samples.filter(price => price >= threshold);
      if (usable.length < 3) continue;
      const estimatedPriceCents = Math.round(median(usable) / 1000) * 1000;
      if (estimatedPriceCents > 0) {
        estimates.set(key, { estimatedPriceCents, estimateBasis, estimateSamples: usable.length });
      }
    }
  }
  // ZOL 有些参考价多年没改（内存涨价前的旧价）：同规格至少 4 个样本、低于中位价 60% 的，
  // 标记为“可能是旧价”，估算价改用同规格中位价，自动方案不选它
  const medians = new Map([...groups].filter(([, samples]) => samples.length >= 4).map(([key, samples]) => [key, median(samples)]));
  return base.map((item, index) => {
    const estimate = estimates.get(keys[index]);
    if (item.estimatedPriceCents > 0) {
      const groupMedian = medians.get(keys[index]);
      if (item.estimateBasis !== 'reference' || !groupMedian || item.estimatedPriceCents >= groupMedian * 0.6) return item;
      return estimate && estimate.estimateBasis === 'spec-median'
        ? { ...item, ...estimate, possiblyStale: true }
        : { ...item, possiblyStale: true };
    }
    return estimate ? { ...item, ...estimate } : item;
  });
}

/** 板型 / 机箱尺寸归类 */
function sizeClass(value) {
  const v = normalize(value);
  if (!v) return null;
  if (/eatx|fulltower|全塔|xlatx/.test(v)) return 'eatx';
  if (/itx|sff/.test(v)) return 'itx';
  if (/micro|matx|microatx/.test(v)) return 'matx';
  if (/atx|midtower|中塔/.test(v)) return 'atx';
  return null;
}

/**
 * 同类粗估的分组键，由细到粗；只用真实参考价做样本。
 * 返回 [键, 依据] 列表：细的叫 spec-median，粗的叫 class-median。
 */
function classGroups(item) {
  const s = item.specs ?? {};
  switch (item.category) {
    case 'GPU': {
      // 海外数据的芯片名常带显存（“GeForce RTX 3080 10 GB”），去掉后按芯片归组
      const chip = s.chipset ? normalize(String(s.chipset).replace(/^(geforce|radeon|intel)\s*/i, '').replace(/\s*\d+\s*gb$/i, '')) : null;
      return chip ? [[`chip:${chip}`, 'chip-median']] : [];
    }
    case 'MOTHERBOARD': {
      const chip = s.chipset ? normalize(String(s.chipset).replace(/^(amd|intel)\s*/i, '')) : null;
      if (!chip) return [];
      const size = sizeClass(s.formFactor);
      return [...(size ? [[`${chip}:${size}`, 'spec-median']] : []), [chip, 'class-median']];
    }
    case 'CASE': {
      const size = sizeClass(s.formFactor ?? s.maxBoardFormFactor);
      return size ? [[size, 'class-median']] : [];
    }
    case 'COOLER': {
      const liquid = s.radiatorSizeMm > 0 || /水冷|liquid|aio/i.test(String(s.coolingType ?? '') + item.name);
      if (liquid) {
        const r = [120, 240, 280, 360, 420].find(mm => Math.abs((s.radiatorSizeMm ?? 0) - mm) <= 10);
        return [...(r ? [[`aio:${r}`, 'spec-median']] : []), ['aio', 'class-median']];
      }
      const h = s.heightMm > 0 ? (s.heightMm < 120 ? 'low' : s.heightMm < 150 ? 'mid' : 'tower') : null;
      return [...(h ? [[`air:${h}`, 'spec-median']] : []), ['air', 'class-median']];
    }
    case 'CPU': {
      // 同接口、同核心数的中位价（如 AM5 6 核）
      return s.socket && s.cores > 0 ? [[`${normalize(s.socket)}:${s.cores}`, 'class-median']] : [];
    }
    case 'PSU': {
      const w = s.ratedWatts > 0 ? Math.round(s.ratedWatts / 50) * 50 : null;
      return w ? [[`w:${w}`, 'class-median']] : [];
    }
    case 'RAM': {
      return s.memoryType && s.capacityGB > 0 ? [[`${normalize(s.memoryType)}:${s.capacityGB}`, 'class-median']] : [];
    }
    case 'SSD': {
      const key = ssdKey(s);
      const tier = key?.split(':')[0];
      return [...(key && !key.endsWith('unknown') ? [[key, 'spec-median']] : []), ...(tier ? [[`cap:${tier}`, 'class-median']] : [])];
    }
    default: return [];
  }
}

/** 仍没有估算价的条目：按同类真实参考价的中位数粗估（至少 3 个样本） */
function addClassEstimates(items) {
  const pools = new Map();
  for (const item of items) {
    if (!(item.referencePriceCents > 0) || item.estimateBasis !== 'reference') continue;
    for (const [key] of classGroups(item)) {
      const k = item.category + ':' + key;
      if (!pools.has(k)) pools.set(k, []);
      pools.get(k).push(item.referencePriceCents);
    }
  }
  return items.map(item => {
    if (item.estimatedPriceCents > 0) return item;
    // ZOL 系列价格区间：只给起价，界面显示“起”，不参与自动配置
    if (Array.isArray(item.priceRangeCents) && item.priceRangeCents[0] > 0) {
      return { ...item, estimatedPriceCents: item.priceRangeCents[0], estimateBasis: 'series-low', estimateSamples: 1 };
    }
    for (const [key, basis] of classGroups(item)) {
      const samples = pools.get(item.category + ':' + key) ?? [];
      // 同芯片显卡 1 个真实参考价就可用；其他粗分组至少 3 个样本
      if (samples.length < (basis === 'chip-median' ? 1 : 3)) continue;
      return { ...item, estimatedPriceCents: Math.round(median(samples) / 1000) * 1000, estimateBasis: basis, estimateSamples: samples.length };
    }
    return item;
  });
}

/**
 * 补功耗：缺字段时估算，并在 estimatedSpecs 里注明，界面显示“估算”。
 * - 显卡 tdpWatts（整卡功耗）：同芯片其他型号的中位数（海外数据几乎每个芯片都有）
 * - AMD CPU maxPowerWatts：PPT = TDP × 1.35（65→88、105→142、120→162、170→230，与 AMD 规格一致）
 * - Intel CPU maxPowerWatts：同 TDP 的其他 Intel 型号峰值功耗中位数
 */
function addPowerEstimates(items) {
  const gpuChip = item => item.specs?.chipset
    ? normalize(String(item.specs.chipset).replace(/^(geforce|radeon|intel)\s*/i, '').replace(/\s*\d+\s*gb$/i, '')) : null;
  const isAmd = item => /amd|锐龙|ryzen|athlon|速龙/i.test(`${item.manufacturer ?? ''} ${item.name}`);
  const chipTdp = new Map();
  const intelPeak = new Map();
  for (const item of items) {
    const s = item.specs ?? {};
    if (item.category === 'GPU' && s.tdpWatts > 0 && gpuChip(item)) {
      if (!chipTdp.has(gpuChip(item))) chipTdp.set(gpuChip(item), []);
      chipTdp.get(gpuChip(item)).push(s.tdpWatts);
    }
    if (item.category === 'CPU' && !isAmd(item) && s.tdpWatts > 0 && s.maxPowerWatts > 0) {
      if (!intelPeak.has(s.tdpWatts)) intelPeak.set(s.tdpWatts, []);
      intelPeak.get(s.tdpWatts).push(s.maxPowerWatts);
    }
  }
  return items.map(item => {
    const s = item.specs ?? {};
    // 厂商标注的整卡最大功耗是实测规格，优先于同芯片估算
    if (item.category === 'GPU' && !(s.tdpWatts > 0) && s.boardPowerWatts > 0) {
      return { ...item, specs: { ...s, tdpWatts: s.boardPowerWatts } };
    }
    if (item.category === 'GPU' && !(s.tdpWatts > 0)) {
      // 名称写法不统一：先精确匹配，再去掉国内特供的 D / v2 后缀（功耗与标准版相近），再补上漏写的 RTX 前缀
      const exact = gpuChip(item);
      const base = exact?.replace(/(d|dv2|v2)$/, '');
      const candidates = [exact, base, base && /^\d{4}/.test(base) ? 'rtx' + base : null].filter(Boolean);
      const samples = candidates.map(key => chipTdp.get(key)).find(list => list?.length);
      if (samples?.length) return { ...item, specs: { ...s, tdpWatts: median(samples) }, estimatedSpecs: ['tdpWatts'] };
    }
    if (item.category === 'CPU' && !(s.maxPowerWatts > 0) && s.tdpWatts > 0) {
      const samples = isAmd(item) ? null : intelPeak.get(s.tdpWatts);
      const peak = isAmd(item) ? Math.round(s.tdpWatts * 1.35) : samples?.length >= 2 ? median(samples) : null;
      if (peak) return { ...item, specs: { ...s, maxPowerWatts: peak }, estimatedSpecs: ['maxPowerWatts'] };
    }
    return item;
  });
}

/** 装不到台式机上的条目：笔记本 CPU（H / HK / HX / U / P 等后缀）、手机 / 嵌入式存储（UFS、eMMC） */
export function notForDesktop(item) {
  const name = String(item.name ?? '').normalize('NFKC');
  if (item.category === 'CPU') {
    // P 后缀只认 12/13 代笔记本的“1260P / 1360P”这种 4 位 1 开头型号；老台式机 i5-6402P 是核显缩水版，不是笔记本
    return /\bi[3579][\s-]*(\d{4,5}(H|HK|HX|HS|U)|1\d{3}P)\b/i.test(name)
      || /(ryzen|锐龙)\s*[3579]\s*(pro\s*)?\d{4}(H|HS|HX|U)\b/i.test(name)
      || /ultra\s*[3579]\s*\d{3}(H|HX|U|V)\b/i.test(name);
  }
  if (item.category === 'SSD') return /\b(UFS|eMMC)/i.test(`${item.specs?.interface ?? ''} ${name}`);
  return false;
}

/** 服务器 / 工作站 / 龙芯 CPU：能搜到，但自动方案不选，界面标注 */
const WORKSTATION_CPU = /xeon|至强|threadripper|epyc|霄龙|龙芯|loongson/i;

/** 中英文品牌名互通：搜“华硕”能找到 ASUS，反之亦然 */
const BRAND_ALIASES = [
  ['asus', '华硕'], ['msi', '微星'], ['gigabyte', '技嘉'], ['asrock', '华擎'], ['colorful', '七彩虹'], ['galax', '影驰'], ['zotac', '索泰'],
  ['maxsun', '铭瑄'], ['sapphire', '蓝宝石'], ['powercolor', '撼讯'], ['xfx', '讯景'], ['vastarmor', '瀚铠'], ['gainward', '耕升'], ['inno3d', '映众'],
  ['palit', '同德'], ['yeston', '盈通'], ['intel', '英特尔'], ['amd', '超威'], ['nvidia', '英伟达'], ['kingston', '金士顿'], ['samsung', '三星'],
  ['westerndigital', '西部数据', '西数', 'wd'], ['crucial', '英睿达'], ['corsair', '海盗船'], ['gskill', '芝奇'], ['kingbank', '金百达'], ['teamgroup', '十铨'],
  ['adata', '威刚'], ['zhitai', '致态'], ['kioxia', '铠侠'], ['seagate', '希捷'], ['sandisk', '闪迪'], ['lexar', '雷克沙'], ['hikvision', '海康威视'],
  ['thermalright', '利民'], ['deepcool', '九州风神'], ['coolermaster', '酷冷至尊'], ['noctua', '猫头鹰'], ['arctic', '北极'], ['idcooling', '酷凛'],
  ['greatwall', '长城'], ['huntkey', '航嘉'], ['seasonic', '海韵'], ['superflower', '振华'], ['segotep', '鑫谷'], ['sama', '先马'], ['aigo', '爱国者'],
  ['lianli', '联力'], ['phanteks', '追风者'], ['nzxt', '恩杰'], ['jonsbo', '乔思伯'], ['fractaldesign', '分形工艺'], ['thermaltake', '曜越', 'tt'],
  ['bequiet', '德商必酷'], ['montech', '君主'], ['antec', '安钛克'], ['silverstone', '银欣'], ['tforce', '十铨'],
].map(group => group.map(normalize));

function aliasTerms(text) {
  const t = normalize(text);
  const out = [];
  for (const group of BRAND_ALIASES) {
    // 2 个字符以内的英文简称（wd、tt）只在开头匹配，避免误伤
    if (group.some(a => a.length > 2 ? t.includes(a) : t.startsWith(a))) out.push(...group);
  }
  return out;
}

/**
 * 模糊匹配分数（0 = 不匹配）。query 与 terms 都已 normalize。
 * 完全相等 > 前缀 > 包含 > 多词都命中 > 按顺序出现的字符（容忍漏字、多字）
 */
function matchScore(terms, compact, tokens) {
  if (!compact) return 1;
  let best = 0;
  for (const term of terms) {
    if (!term) continue;
    if (term === compact) return 100;
    if (term.startsWith(compact)) best = Math.max(best, 85);
    else if (term.includes(compact)) best = Math.max(best, 70);
  }
  if (best) return best;
  if (tokens.length > 1 && tokens.every(token => terms.some(term => term.includes(token)))) return 60;
  if (compact.length < 3) return 0;
  // 子序列：query 的字符按顺序出现在名称里，跨度越小分越高
  const name = terms[0] ?? '';
  let pos = -1; let first = -1;
  for (const ch of compact) {
    pos = name.indexOf(ch, pos + 1);
    if (pos < 0) return 0;
    if (first < 0) first = pos;
  }
  const span = pos - first + 1;
  const density = compact.length / span;
  return density >= 0.5 ? Math.round(20 + 30 * density) : 0;
}

/** 搜索词切分：空格分词，并在中文与字母数字之间断开（“4060七彩虹” → 4060 / 七彩虹） */
function queryTokens(query) {
  return query.split(/\s+|(?<=\p{Script=Han})(?=[^\p{Script=Han}])|(?<=[^\p{Script=Han}\s])(?=\p{Script=Han})/u).map(normalize).filter(Boolean);
}

function pagination(value, fallback, min, max, field) {
  if (value === null) return fallback;
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < min || number > max) {
    throw invalid(field + ' 必须为 ' + min + ' 到 ' + max + ' 之间的整数');
  }
  return number;
}

export function createCatalog(directory = '.runtime') {
  const imported = readImported(directory);
  const zol = readImported(directory, 'zol-catalog.json');
  const performance = loadPerformance(directory);
  const items = addImages(addTrends(addClassEstimates(addEstimates(addPowerEstimates(addZol(mergeCatalog(imported.items), zol.items)
    // 从参数表补全接口数量、尺寸、12V 输出等字段（只补缺的，不覆盖）
    .map(item => (item.rawParams ? { ...item, specs: enrichSpecs(item) } : item))
    .filter(item => !notForDesktop(item))
    .map(item => item.category === 'CPU' && WORKSTATION_CPU.test(item.name) ? { ...item, workstation: true } : item)))), readPriceHistory(directory))
    .map(item => ({
      ...performance.attach(item),
      market: item.dataSource === 'zol' || item.zolId || verifiedIds.has(item.id) ? 'cn' : 'global',
    })), readPartImages());
  const attributions = [imported.attribution, zol.attribution].filter(Boolean);
  const byId = new Map(items.map(item => [item.id, item]));
  const searchIndex = items.map(item => ({ item,
    terms: [item.name, item.manufacturer, item.mpn, item.summary, ...item.aliases, ...(item.partNumbers ?? [])].map(normalize)
      .concat(aliasTerms(`${item.manufacturer ?? ''} ${item.name}`)),
  }));

  return {
    /** 全部条目（不含原始参数表），供自动配置使用 */
    all() {
      return items.map(brief);
    },
    list(params) {
      const query = (params.get('q') ?? '').trim();
      if (query.length > 120) throw invalid('q 最长 120 个字符');
      const category = (params.get('category') ?? '').trim().toUpperCase();
      if (category && !categoryIds.has(category)) throw invalid('category 必须为标准槽位 ID');
      const limit = pagination(params.get('limit'), 24, 1, 100, 'limit');
      const offset = pagination(params.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER, 'offset');
      const tokens = queryTokens(query);
      const compactQuery = normalize(query);
      const hasPrice = params.get('hasPrice') === '1';
      const hasImage = params.get('hasImage') === '1';
      const sort = params.get('sort') ?? '';
      if (sort && !['price', '-price', 'perf', 'value'].includes(sort)) throw invalid('sort 只能是 price、-price、perf 或 value');
      const market = params.get('market') ?? 'all';
      if (!['cn', 'global', 'all'].includes(market)) throw invalid('market 只能是 cn、global 或 all');
      const fit = parseCatalogFit(params.get('fit'), category);
      const showConflicts = params.get('showConflicts') === '1';
      let matches = searchIndex.filter(({ item }) =>
        (!category || item.category === category)
        && (market === 'all' || item.market === market)
        && (!hasPrice || item.estimatedPriceCents > 0)
        && (!hasImage || !!item.imageUrl));
      if (compactQuery) {
        const scored = matches.map(entry => ({ ...entry, score: matchScore(entry.terms, compactQuery, tokens) })).filter(entry => entry.score > 0);
        // 有精确命中（包含 / 多词）时不混入按字符顺序的模糊结果
        const strict = scored.filter(entry => entry.score >= 60);
        matches = (strict.length ? strict : scored).sort((a, b) => b.score - a.score);
      }
      if (fit) {
        matches = matches.map(entry => ({ ...entry, compatibility: catalogFitStatus(entry.item.specs, fit) }));
        if (!showConflicts) matches = matches.filter(entry => entry.compatibility !== 'conflict');
      }
      if (sort) {
        // 性能 / 性价比：没有游戏指数的排在后面
        // 只按游戏指数排：Blender 渲染分与游戏指数口径不同，显卡还偏向 NVIDIA
        const perf = item => item.performance?.gaming?.index ?? null;
        const priceOf = item => item.estimatedPriceCents ?? Infinity;
        const key = {
          price: item => priceOf(item),
          '-price': item => -(item.estimatedPriceCents ?? -Infinity),
          perf: item => -(perf(item) ?? -Infinity),
          value: item => (perf(item) && item.estimatedPriceCents ? -perf(item) / item.estimatedPriceCents : Infinity),
        }[sort];
        matches = [...matches].sort((a, b) => key(a.item) - key(b.item));
      }
      return { items: matches.slice(offset, offset + limit).map(({ item, compatibility }) =>
        compatibility ? { ...brief(item), compatibility } : brief(item)),
        total: matches.length, limit, offset, attribution: imported.attribution, attributions, performanceSources: performance.meta };
    },
    /** 输入框联想：按匹配度排，同分时有价、有性能数据、名称短的靠前 */
    suggest(params) {
      const query = (params.get('q') ?? '').trim();
      if (query.length > 120) throw invalid('q 最长 120 个字符');
      const category = (params.get('category') ?? '').trim().toUpperCase();
      if (category && !categoryIds.has(category)) throw invalid('category 必须为标准槽位 ID');
      const market = params.get('market') ?? 'all';
      if (!['cn', 'global', 'all'].includes(market)) throw invalid('market 只能是 cn、global 或 all');
      const limit = pagination(params.get('limit'), 8, 1, 20, 'limit');
      const compact = normalize(query);
      if (!compact) return { items: [] };
      const tokens = queryTokens(query);
      const ranked = [];
      for (const entry of searchIndex) {
        const { item } = entry;
        if ((category && item.category !== category) || (market !== 'all' && item.market !== market)) continue;
        const score = matchScore(entry.terms, compact, tokens);
        if (score) ranked.push({ item, score: score + (item.estimatedPriceCents > 0 ? 3 : 0) + (item.performance?.gaming ? 2 : 0) });
      }
      ranked.sort((a, b) => b.score - a.score || a.item.name.length - b.item.name.length);
      return { items: ranked.slice(0, limit).map(({ item, score }) => ({ ...brief(item), matchScore: score })) };
    },
    get(id) {
      const item = byId.get(id);
      if (!item) throw new ApiError(404, 'CATALOG_ITEM_NOT_FOUND', '未找到该硬件型号');
      const extra = {};
      if (item.dataSource === 'buildcores') extra.attribution = imported.attribution;
      if (item.dataSource === 'zol' || item.zolId) extra.zolAttribution = zol.attribution;
      return { ...item, ...extra };
    },
  };
}
