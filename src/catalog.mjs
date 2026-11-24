import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { invalid, ApiError } from './api-error.mjs';
import { slotTypes } from './builds.mjs';
import { loadPerformance } from './performance.mjs';
import { cpuKey, gpuKey } from './perfkeys.mjs';
import { catalogFitStatus, parseCatalogFit } from './catalog-fit.mjs';

const verified = JSON.parse(readFileSync(new URL('../data/catalog.json', import.meta.url), 'utf8'));
const verifiedIds = new Set(verified.map(item => item.id));
const categoryIds = new Set(slotTypes.map(({ id }) => id));
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
      if (chipMedian && item.referencePriceCents < chipMedian * 0.6) return item;
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
  const tier = [500, 1000, 2000, 4000].find(gb => Math.abs(capacityGB - gb) <= gb * 0.05);
  if (!tier) return null;
  const bus = (connection ?? '').normalize('NFKC');
  const gen = bus.match(/\bPCI[\s-]*E(?:XPRESS)?\s*(?:GEN\s*)?([345])(?:\.0)?(?![\d.])/i)?.[1];
  return `${tier}:${/\bSATA/i.test(bus) ? 'sata' : gen ? 'pcie' + gen : 'unknown'}`;
}

function estimateGroup(item) {
  const specs = item.specs ?? {};
  switch (item.category) {
    case 'CPU': return cpuKey(item.name);
    case 'RAM': return specs.memoryType && specs.capacityGB > 0 && specs.modules > 0
      ? `${normalize(specs.memoryType)}:${specs.capacityGB}:${specs.modules}` : null;
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
  return base.map((item, index) => {
    if (item.estimatedPriceCents > 0) return item;
    const estimate = estimates.get(keys[index]);
    return estimate ? { ...item, ...estimate } : item;
  });
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
  const items = addImages(addTrends(addEstimates(addZol(mergeCatalog(imported.items), zol.items)), readPriceHistory(directory))
    .map(item => ({
      ...performance.attach(item),
      market: item.dataSource === 'zol' || item.zolId || verifiedIds.has(item.id) ? 'cn' : 'global',
    })), readPartImages());
  const attributions = [imported.attribution, zol.attribution].filter(Boolean);
  const byId = new Map(items.map(item => [item.id, item]));
  const searchIndex = items.map(item => ({ item,
    terms: [item.name, item.manufacturer, item.mpn, item.summary, ...item.aliases, ...(item.partNumbers ?? [])].map(normalize),
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
      const tokens = query.split(/\s+/u).map(normalize).filter(Boolean);
      const compactQuery = normalize(query);
      const hasPrice = params.get('hasPrice') === '1';
      const hasImage = params.get('hasImage') === '1';
      const sort = params.get('sort') ?? '';
      if (sort && !['price', '-price', 'perf', 'value'].includes(sort)) throw invalid('sort 只能是 price、-price、perf 或 value');
      const market = params.get('market') ?? 'all';
      if (!['cn', 'global', 'all'].includes(market)) throw invalid('market 只能是 cn、global 或 all');
      const fit = parseCatalogFit(params.get('fit'), category);
      const showConflicts = params.get('showConflicts') === '1';
      let matches = searchIndex.filter(({ item, terms }) =>
        (!category || item.category === category)
        && (market === 'all' || item.market === market)
        && (!hasPrice || item.estimatedPriceCents > 0)
        && (!hasImage || !!item.imageUrl)
        && (!compactQuery || terms.some(term => term.includes(compactQuery))
          || tokens.every(token => terms.some(term => term.includes(token)))));
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
