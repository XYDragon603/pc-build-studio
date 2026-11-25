// 新界面用的目录查询：支持排序、筛选与国内 / 海外分组；按 ID 取条目并缓存（配件图片、性能都从这里来）。
import { useEffect, useState } from 'react';
import { api, type CatalogItem, type EstimateBasis } from '../api/client';
import { estimatePower } from '../domain/compat';
import { isIntegratedGpu, STOCK_COOLER_NAME } from '../domain/plan';
import { catalogSpecs } from '../domain/catalog';
import { ALL_SLOTS } from '../domain/slots';
import type { Build, PartSpecs, SlotId } from '../domain/types';

export type SortKey = 'value' | 'price' | '-price' | 'perf';
export type Market = 'cn' | 'global';
export const ESTIMATE_LABELS: Record<EstimateBasis, string> = {
  reference: 'ZOL 参考价（非实时）', model: '同型号 ZOL 参考价（非实时）', 'chip-median': '同芯片中位价', 'spec-median': '同规格中位价',
  'class-median': '同类配件粗估，误差较大', 'series-low': 'ZOL 系列起价（最小容量），实际容量可能更贵',
  manual: '我的价格（手动录入）', verified: '我的价格（已核实商城报价）',
};

export const PRICE_NOTE = '参考价来自中关村在线，不是实时价格；内存、固态近期涨价快，下单前以电商实际售价为准，填进“实付价”后合计按实付计算。';
export const STALE_NOTE = '这款的 ZOL 参考价明显低于同规格其他型号，可能是涨价前的旧价，已按同规格中位价估算，自动方案不会选它';

export interface PriceChange { slot: SlotId; label: string; name: string; fromCents: number; toCents: number }

/**
 * 存档里按参考价记的配件，与配件库当前估算价不一致的（参考价每周更新两次）。
 * 手动填的实付价、锁定的配件不算，和 setEstimate 的规则一致。
 */
export function priceChanges(build: Build, items: Record<string, CatalogItem | null | undefined>): PriceChange[] {
  return ALL_SLOTS.flatMap(({ id, label }) => {
    if (!build.slots[id]) return [];
    const { part, locked } = build.slots[id];
    const item = part?.catalogId ? items[part.catalogId] : null;
    const toCents = item?.estimatedPriceCents;
    if (locked || !part || part.priceSource !== 'estimate' || part.priceCents == null || !toCents || toCents === part.priceCents) return [];
    return [{ slot: id, label, name: part.name, fromCents: part.priceCents, toCents }];
  });
}

/** 存档里规格落后于配件库的配件（如后来补的功耗、尺寸），返回要合并进去的新规格 */
export function staleSpecs(build: Build, items: Record<string, CatalogItem | null | undefined>): { slot: SlotId; specs: PartSpecs }[] {
  return ALL_SLOTS.flatMap(({ id }) => {
    const part = build.slots[id]?.part;
    const item = part?.catalogId ? items[part.catalogId] : null;
    if (!part || !item) return [];
    const fresh = catalogSpecs(id, item.specs);
    const changed = (Object.keys(fresh) as (keyof PartSpecs)[]).some(k => fresh[k] !== part.specs[k]);
    return changed ? [{ slot: id, specs: fresh }] : [];
  });
}

/** 列表里的价格文字：粗估加“≈”，系列起价加“起” */
export function estimateText(item: Pick<CatalogItem, 'estimatedPriceCents' | 'estimateBasis'>, format: (c: number) => string): string {
  if (item.estimatedPriceCents == null) return '暂无估算价';
  const text = format(item.estimatedPriceCents);
  if (item.estimateBasis === 'series-low') return `${text} 起`;
  if (item.estimateBasis === 'class-median') return `≈${text}`;
  return text;
}

/** 输入框联想 */
export function suggestCatalog({ category, q, market }: { category: string; q: string; market: Market }, signal?: AbortSignal) {
  return api.catalogSuggest(new URLSearchParams({ category, q: q.trim().slice(0, 120), market, limit: '8' }), signal);
}

export interface CatalogQuery {
  category: string;
  q?: string;
  sort?: SortKey;
  market?: Market;
  limit?: number;
  offset?: number;
  fit?: Record<string, string | number | null>;
  onlyFit?: boolean;
}

export function queryCatalog({ category, q = '', sort = 'value', market = 'cn', limit = 30, offset = 0, fit = {}, onlyFit = true }: CatalogQuery, signal?: AbortSignal) {
  const params = new URLSearchParams({ category, q: q.trim().slice(0, 120), sort, market, limit: String(limit),
    offset: String(offset), fit: JSON.stringify(fit), showConflicts: onlyFit ? '0' : '1' });
  return api.catalogPage(params, signal);
}

export function fitForSlot(slot: SlotId, build: Build): Record<string, string | number | null> {
  const { cpu, gpu, board, ram, case: chassis, cooler } = build.slots;
  const fit: Record<string, string | number | null> = {};
  const discreteGpu = gpu.part && !isIntegratedGpu(gpu.part) ? gpu.part : null;
  switch (slot) {
    case 'cpu':
      if (board.part) fit.socket = board.part.specs.socket ?? null;
      break;
    case 'board':
      if (cpu.part) fit.socket = cpu.part.specs.socket ?? null;
      if (ram.part) fit.memoryType = ram.part.specs.memoryType ?? null;
      if (chassis.part) fit.maxBoardFormFactor = chassis.part.specs.maxBoardFormFactor ?? null;
      break;
    case 'ram':
      if (board.part) fit.memoryType = board.part.specs.memoryType ?? null;
      break;
    case 'gpu':
      if (chassis.part) fit.maxGpuLengthMm = chassis.part.specs.maxGpuLengthMm ?? null;
      break;
    case 'psu':
      if (cpu.part || discreteGpu) fit.minPsuWatts = estimatePower(build).recommendedWatts;
      break;
    case 'case':
      if (discreteGpu) fit.gpuLengthMm = discreteGpu.specs.lengthMm ?? null;
      if (board.part) fit.boardFormFactor = board.part.specs.formFactor ?? null;
      if (cooler.part && cooler.part.name !== STOCK_COOLER_NAME) {
        const { heightMm, radiatorSizeMm } = cooler.part.specs;
        if (heightMm || !radiatorSizeMm) fit.coolerHeightMm = heightMm ?? null;
        if (radiatorSizeMm) fit.radiatorSizeMm = radiatorSizeMm;
      }
      break;
    case 'cooler':
      if (chassis.part) {
        fit.maxCoolerHeightMm = chassis.part.specs.maxCoolerHeightMm ?? null;
        fit.maxRadiatorMm = chassis.part.specs.maxRadiatorMm ?? null;
      }
      break;
  }
  return fit;
}

const itemCache = new Map<string, Promise<CatalogItem | null>>();

export function getCatalogItem(id: string): Promise<CatalogItem | null> {
  if (!itemCache.has(id)) {
    itemCache.set(id, api.catalogItem(id).catch(() => {
      itemCache.delete(id);
      return null;
    }));
  }
  return itemCache.get(id)!;
}

/** 按目录 ID 批量取条目（缺图、无 ID 的返回 undefined） */
export function useCatalogItems(ids: (string | null | undefined)[]): Record<string, CatalogItem | null> {
  const key = ids.filter(Boolean).join('|');
  const [items, setItems] = useState<Record<string, CatalogItem | null>>({});
  useEffect(() => {
    let alive = true;
    const list = ids.filter((id): id is string => !!id);
    Promise.all(list.map(async id => [id, await getCatalogItem(id)] as const)).then(pairs => {
      if (alive) setItems(Object.fromEntries(pairs));
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return items;
}
