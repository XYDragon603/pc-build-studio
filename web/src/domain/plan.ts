import type { CatalogItem, PlanResult } from '../api/client';
import { API_TO_SLOT } from '../api/mapping';
import { catalogToCandidate } from './catalog';
import { clearance, compatibility, estimatePower, type Check } from './compat';
import { partFromCandidate } from './demoData';
import { purposeOfScenarios } from './purposes';
import { emptySlots } from './slots';
import type { Build, Part, PartSpecs, SlotId } from './types';
import { boardCaseStatus } from '../../../src/hardware-specs.mjs';

import { INTEGRATED_GPU_NAME, STOCK_COOLER_NAME } from './placeholders';

export { INTEGRATED_GPU_NAME, STOCK_COOLER_NAME };

const placeholder = (name: string, spec: string): Part => ({
  name, spec, priceCents: 0, quantity: 1, priceSource: 'manual', catalogId: null, note: spec, url: null, specs: {},
});

export const isIntegratedGpu = (part: Part | null | undefined) => part?.name === INTEGRATED_GPU_NAME;

export function emptyBuild(budgetCents: number, scenarios: string[], name: string): Build {
  return {
    id: `draft-${Date.now().toString(36)}`,
    name,
    budgetCents,
    scenarios,
    slots: emptySlots(),
    custom: [],
    updatedAt: new Date().toISOString(),
  };
}

/** 把服务端的推荐方案转成可编辑的配置（价格均为估算） */
export function planToBuild(plan: PlanResult, budgetCents: number, scenarios: string[]): Build {
  const b = emptyBuild(budgetCents, scenarios, planName(plan.label, scenarios));
  const selectedPart = (item: CatalogItem, slot: SlotId, reason: string) => {
    const record = item.priceRecord;
    const priceSource: Part['priceSource'] = record ? record.priceType === 'verified' ? 'verified' : record.priceType === 'manual' ? 'manual' : 'historical' : 'estimate';
    const provenance = record ? `；价格来源 ${record.sourceName}，${record.observedAt}，${record.condition}，库存 ${record.stockStatus}${record.sourceUrl ? `，${record.sourceUrl}` : ''}` : `；目录估算，价格观察时间 ${item.priceObservedAt ?? '未知'}`;
    return partFromCandidate(catalogToCandidate(item, slot), item.estimatedPriceCents!, priceSource, `自动配置：${reason}${provenance}`.slice(0, 1000));
  };
  for (const pick of plan.picks) {
    const slot = API_TO_SLOT[pick.slot];
    if (!slot || !pick.item.estimatedPriceCents) continue;
    b.slots[slot] = { locked: false, part: selectedPart(pick.item, slot, pick.reason) };
  }
  for (const pick of plan.peripherals?.picks ?? []) {
    const slot = API_TO_SLOT[pick.slot];
    if (!slot || !pick.item.estimatedPriceCents) continue;
    b.slots[slot] = { locked: false, part: selectedPart(pick.item, slot, pick.reason) };
  }
  if (plan.igpu) b.slots.gpu = { locked: false, part: placeholder(INTEGRATED_GPU_NAME, '不配独立显卡') };
  if (plan.stockCooler) b.slots.cooler = { locked: false, part: placeholder(STOCK_COOLER_NAME, '盒装自带，无需另买') };
  for (const cost of plan.additionalCosts ?? []) b.custom.push({ id: cost.id.startsWith('custom-') ? cost.id : `custom-${cost.id}`, name: cost.name, spec: '机箱配置记录中的额外采购费用', priceCents: cost.priceCents });
  return b;
}

/**
 * 新方案的默认名：档位 · 用途 · 日期（如“推荐版 · AI / 机器学习 · 11/25”）。
 * 不放价格：之后改价、换件、参考价更新，名字里的价格就对不上了；实际合计另外显示。
 */
export function planName(label: string, scenarios: string[], now = new Date()): string {
  const purpose = purposeOfScenarios(scenarios)?.label;
  return [label, purpose, `${now.getMonth() + 1}/${now.getDate()}`].filter(Boolean).join(' · ');
}

/** 显卡游戏指数（PNY RTX 5080 Slim OC = 100）对应的大致档次 */
export function gpuTier(index: number | null | undefined, igpu = false): string {
  if (igpu) return '核显 · 办公、网课、轻度网游';
  if (index == null) return '显卡档次未知';
  if (index >= 85) return '旗舰 · 2K / 4K 高画质';
  if (index >= 65) return '高端 · 2K 高画质';
  if (index >= 45) return '主流 · 2K 中高画质';
  if (index >= 30) return '入门 · 1080p 高画质';
  return '入门 · 1080p 中低画质';
}

/** 兼容性一句话：错误优先，其次需要核对的项（BIOS 只在细节里出现，不算进概括） */
/**
 * 兼容性一句话：不兼容 > 关键项待核实 > 需满足条件。
 * 条件项（更新 BIOS、开 XMP、用转接线）是“满足条件即可用”，不当成问题，但要说出来。
 */
export function compatSummary(checks: Check[]): { level: 'ok' | 'warn' | 'error'; text: string } {
  const errors = checks.filter(c => c.level === 'error');
  const unknownCritical = checks.filter(c => c.status === 'UNKNOWN' && c.critical);
  const unknown = checks.filter(c => c.status === 'UNKNOWN' && !c.critical && c.id !== 'power');
  const conditional = checks.filter(c => c.status === 'CONDITIONAL');
  if (errors.length) return { level: 'error', text: `${errors.length} 项不兼容：${errors.map(e => e.label).join('、')}` };
  if (unknownCritical.length) return { level: 'warn', text: `${unknownCritical.length} 项关键数据待核实：${unknownCritical.map(w => w.label).join('、')}` };
  const pending = checks.filter(c => c.id === 'power' && c.level === 'warn');
  if (pending.length) return { level: 'warn', text: pending[0].label };
  if (conditional.length || unknown.length) {
    return { level: 'warn', text: [conditional.length && `${conditional.length} 项需满足条件`, unknown.length && `${unknown.length} 项数据待核实`].filter(Boolean).join('，') + '（其余已确认兼容）' };
  }
  return { level: 'ok', text: '已检查的项目都兼容' };
}

/** 核显 / 原装散热这类占位配件由统一规则按“不适用”处理 */
export function buildChecks(b: Build): Check[] {
  return compatibility(b);
}

/** 换配件时的兼容过滤：只在双方都有数据时判断，数据缺失视为可用 */
export function fitsBuild(slot: SlotId, specs: PartSpecs, b: Build): boolean {
  const s = (id: SlotId) => b.slots[id].part?.specs ?? {};
  const eq = (x?: string, y?: string) => !x || !y || x.toUpperCase() === y.toUpperCase();
  switch (slot) {
    case 'cpu': return eq(specs.socket, s('board').socket);
    case 'board': {
      return eq(specs.socket, s('cpu').socket) && eq(specs.memoryType, s('ram').memoryType) && boardCaseStatus(specs as Record<string, unknown>, s('case') as Record<string, unknown>) !== 'FAIL';
    }
    case 'ram': return eq(specs.memoryType, s('board').memoryType);
    case 'gpu': return clearance(specs.lengthMm, s('case').maxGpuLengthMm).status !== 'conflict';
    case 'case': return clearance(s('gpu').lengthMm, specs.maxGpuLengthMm).status !== 'conflict'
      && clearance(s('cooler').heightMm, specs.maxCoolerHeightMm).status !== 'conflict'
      && clearance(s('cooler').radiatorSizeMm, specs.maxRadiatorMm).status !== 'conflict'
      && boardCaseStatus(s('board') as Record<string, unknown>, specs as Record<string, unknown>) !== 'FAIL';
    case 'cooler': return clearance(specs.heightMm, s('case').maxCoolerHeightMm).status !== 'conflict'
      && clearance(specs.radiatorSizeMm, s('case').maxRadiatorMm).status !== 'conflict';
    case 'psu': {
      const need = estimatePower(b).recommendedWatts;
      return !need || !specs.ratedWatts || specs.ratedWatts >= need;
    }
    default: return true;
  }
}

export const itemImage = (item: CatalogItem) => item.imageUrl;
