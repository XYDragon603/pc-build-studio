import type { CatalogItem, PlanResult } from '../api/client';
import { API_TO_SLOT } from '../api/mapping';
import { catalogToCandidate } from './catalog';
import { boardFit, clearance, compatibility, estimatePower, type Check } from './compat';
import { partFromCandidate } from './demoData';
import { emptySlots } from './slots';
import type { Build, Part, PartSpecs, SlotId } from './types';

/** 核显方案里“显卡”一栏的占位配件 */
export const INTEGRATED_GPU_NAME = '使用 CPU 核显';
/** 盒装 CPU 自带散热器时“散热”一栏的占位配件 */
export const STOCK_COOLER_NAME = 'CPU 原装散热器';

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
  const b = emptyBuild(budgetCents, scenarios, `${plan.label} · 约 ¥${Math.round(plan.totalCents / 100).toLocaleString('zh-CN')}`);
  for (const pick of plan.picks) {
    const slot = API_TO_SLOT[pick.slot];
    if (!slot || !pick.item.estimatedPriceCents) continue;
    b.slots[slot] = { locked: false, part: partFromCandidate(catalogToCandidate(pick.item, slot), pick.item.estimatedPriceCents, 'estimate', `自动配置：${pick.reason}`) };
  }
  if (plan.igpu) b.slots.gpu = { locked: false, part: placeholder(INTEGRATED_GPU_NAME, '不配独立显卡') };
  if (plan.stockCooler) b.slots.cooler = { locked: false, part: placeholder(STOCK_COOLER_NAME, '盒装自带，无需另买') };
  return b;
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
export function compatSummary(checks: Check[]): { level: 'ok' | 'warn' | 'error'; text: string } {
  const errors = checks.filter(c => c.level === 'error');
  const warns = checks.filter(c => c.level === 'warn' && c.id !== 'bios');
  if (errors.length) return { level: 'error', text: `${errors.length} 处不兼容：${errors.map(e => e.label).join('、')}` };
  if (warns.length) return { level: 'warn', text: `${warns.length} 处需要核对：${warns.map(w => w.label).join('、')}` };
  return { level: 'ok', text: '已检查的项目都兼容' };
}

/** 核显 / 原装散热这类占位配件不参与尺寸、供电检查 */
export function buildChecks(b: Build): Check[] {
  const igpu = isIntegratedGpu(b.slots.gpu.part);
  return compatibility(b).filter(c => !(igpu && ['gpuFit', 'gpu16pin', 'power'].includes(c.id))
    && !(b.slots.cooler.part?.name === STOCK_COOLER_NAME && c.id === 'coolerFit'));
}

const BOARD_RANK: Record<string, number> = { 'MINI-ITX': 1, 'MICRO ATX': 2, ATX: 3, EATX: 4 };

/** 换配件时的兼容过滤：只在双方都有数据时判断，数据缺失视为可用 */
export function fitsBuild(slot: SlotId, specs: PartSpecs, b: Build): boolean {
  const s = (id: SlotId) => b.slots[id].part?.specs ?? {};
  const eq = (x?: string, y?: string) => !x || !y || x.toUpperCase() === y.toUpperCase();
  switch (slot) {
    case 'cpu': return eq(specs.socket, s('board').socket);
    case 'board': {
      const max = BOARD_RANK[s('case').maxBoardFormFactor ?? ''];
      const size = BOARD_RANK[specs.formFactor ?? ''];
      return eq(specs.socket, s('cpu').socket) && eq(specs.memoryType, s('ram').memoryType) && (!max || !size || size <= max);
    }
    case 'ram': return eq(specs.memoryType, s('board').memoryType);
    case 'gpu': return clearance(specs.lengthMm, s('case').maxGpuLengthMm).status !== 'conflict';
    case 'case': return clearance(s('gpu').lengthMm, specs.maxGpuLengthMm).status !== 'conflict'
      && clearance(s('cooler').heightMm, specs.maxCoolerHeightMm).status !== 'conflict'
      && clearance(s('cooler').radiatorSizeMm, specs.maxRadiatorMm).status !== 'conflict'
      && boardFit(s('board').formFactor, specs.maxBoardFormFactor).status !== 'conflict';
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
