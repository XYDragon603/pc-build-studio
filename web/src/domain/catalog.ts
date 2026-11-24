import type { CatalogItem } from '../api/client';
import type { Candidate, PartSpecs, SlotId } from './types';

const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);
const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const up = (v: unknown) => { const x = n(v); return x === undefined ? undefined : Math.ceil(x); };
const down = (v: unknown) => { const x = n(v); return x === undefined ? undefined : Math.floor(x); };

/** BuildCores 机箱的 formFactor 是外形（如 “Micro ATX Mini Tower”），取其中的主板板型 */
export function boardFromCaseType(value: unknown): string | undefined {
  const t = s(value)?.toUpperCase();
  if (!t) return undefined;
  if (t.startsWith('EATX') || t.startsWith('E-ATX')) return 'EATX';
  if (t.startsWith('MICRO ATX')) return 'MICRO ATX';
  if (t.startsWith('MINI ITX') || t.startsWith('MINI-ITX')) return 'MINI-ITX';
  if (t.startsWith('ATX')) return 'ATX';
  return undefined;
}

/**
 * 目录规格 → 兼容性字段（后端要求整数毫米 / 瓦）。
 * 取整方向偏保守：配件尺寸向上取整，机箱限值向下取整。
 * CPU 的 TDP 不是峰值功耗（如 9700X TDP 65W、PPT 88W），不映射为 maxPowerWatts；显卡 TDP 即整卡功耗，可以用。
 */
export function catalogSpecs(slot: SlotId, specs: CatalogItem['specs']): PartSpecs {
  const out: PartSpecs = {};
  const socket = s(specs.socket);
  const memoryType = s(specs.memoryType);
  if (socket && (slot === 'cpu' || slot === 'board')) out.socket = socket.toUpperCase();
  // CPU 只用明确的峰值功耗（ZOL 导入时按 AMD PPT 规则或页面最大功耗算出），不把 TDP 当峰值
  if (slot === 'cpu') out.maxPowerWatts = up(specs.maxPowerWatts);
  if (memoryType && (slot === 'board' || slot === 'ram')) out.memoryType = memoryType.toUpperCase();
  if (slot === 'gpu') {
    out.lengthMm = up(specs.lengthMm);
    out.maxPowerWatts = up(specs.tdpWatts);
    out.recommendedPsuWatts = up(specs.recommendedPsuWatts);
    out.gpuPowerConnector = s(specs.powerConnectors)?.toUpperCase().replace(/\s+/g, '');
  }
  if (slot === 'board') out.formFactor = s(specs.formFactor)?.toUpperCase();
  if (slot === 'psu') {
    out.ratedWatts = down(specs.ratedWatts);
    if (specs.native16Pin === true) out.native16Pin = true;
  }
  if (slot === 'case') {
    out.maxGpuLengthMm = down(specs.maxGpuLengthMm);
    out.maxCoolerHeightMm = down(specs.maxCoolerHeightMm);
    out.maxRadiatorMm = down(specs.maxRadiatorMm);
    out.maxBoardFormFactor = s(specs.maxBoardFormFactor)?.toUpperCase() ?? boardFromCaseType(specs.formFactor);
  }
  if (slot === 'cooler') { out.heightMm = up(specs.heightMm); out.radiatorSizeMm = up(specs.radiatorSizeMm); }
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined)) as PartSpecs;
}

export function catalogToCandidate(item: CatalogItem, slot: SlotId): Candidate {
  const url = /^https:\/\//.test(item.sourceUrl) ? item.sourceUrl : null;
  return {
    id: `catalog:${item.id}`,
    slot,
    source: 'catalog',
    name: item.name,
    spec: item.summary || [item.manufacturer, item.mpn].filter(Boolean).join(' · '),
    summarySpec: item.summary.split(' · ').slice(0, 2).join(' · '),
    store: 'other',
    storeLabel: item.dataSource === 'zol' ? '中关村在线' : item.dataSource === 'buildcores' ? 'BuildCores' : '厂商官网',
    condition: 'new',
    capacityGB: n(item.specs.capacityGB),
    priceCents: null,
    referenceCents: null,
    catalogId: item.id,
    estimate: item.estimatedPriceCents && item.estimateBasis
      ? { cents: item.estimatedPriceCents, basis: item.estimateBasis, samples: item.estimateSamples ?? 1, observedAt: item.priceObservedAt ?? null }
      : undefined,
    priceTrend: item.priceTrend,
    state: 'missing',
    url,
    imageUrl: item.imageUrl,
    specs: catalogSpecs(slot, item.specs),
  };
}
