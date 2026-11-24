import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { invalid, ApiError } from './api-error.mjs';
import { slotTypes } from './builds.mjs';
import { loadPerformance } from './performance.mjs';

const verified = JSON.parse(readFileSync(new URL('../data/catalog.json', import.meta.url), 'utf8'));
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
    const match = zol.mpn && zol.manufacturer ? index.get(partKey(zol, zol.mpn)) : null;
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

const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
};

/**
 * 估算价：有 ZOL 参考价就用参考价；显卡没有时，用同芯片、同显存的参考价中位数（至少 3 个样本）。
 * 估算价只作参考，不是报价。
 */
function addEstimates(items) {
  const chipKey = item => item.category === 'GPU' && item.specs.chipset && item.specs.capacityGB
    ? `${normalize(String(item.specs.chipset).replace(/^(geforce|radeon)\s*/i, ''))}:${item.specs.capacityGB}` : null;
  const groups = new Map();
  for (const item of items) {
    const key = chipKey(item);
    if (key && item.referencePriceCents) groups.set(key, [...(groups.get(key) ?? []), item.referencePriceCents]);
  }
  return items.map(item => {
    if (item.referencePriceCents) {
      return { ...item, estimatedPriceCents: item.referencePriceCents, estimateBasis: 'reference', estimateSamples: 1 };
    }
    const samples = groups.get(chipKey(item)) ?? [];
    if (samples.length >= 3) {
      return { ...item, estimatedPriceCents: median(samples), estimateBasis: 'chip-median', estimateSamples: samples.length };
    }
    return item;
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
  const items = addTrends(addEstimates(addZol(mergeCatalog(imported.items), zol.items)), readPriceHistory(directory))
    .map(performance.attach);
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
      const matches = searchIndex.filter(({ item, terms }) =>
        (!category || item.category === category)
        && (!compactQuery || terms.some(term => term.includes(compactQuery))
          || tokens.every(token => terms.some(term => term.includes(token)))));
      return { items: matches.slice(offset, offset + limit).map(entry => brief(entry.item)),
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
