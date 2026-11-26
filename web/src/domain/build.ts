import { partFromCandidate } from './demoData';
import { PERIPHERALS, SLOTS, withAllSlots } from './slots';
import type { Build, Candidate, CustomPart, Part, PartSpecs, SlotId } from './types';

export type BuildAction =
  | { type: 'setBudget'; cents: number }
  | { type: 'toggleScenario'; key: string }
  | { type: 'rename'; name: string }
  | { type: 'addCandidate'; candidate: Candidate; priceCents: number | null; priceSource: Part['priceSource']; note?: string }
  | { type: 'removePart'; slot: SlotId }
  | { type: 'toggleLock'; slot: SlotId }
  | { type: 'setPartPrice'; slot: SlotId; priceCents: number | null }
  /** 刷新估算价：只改仍为估算价、未锁定的配件 */
  | { type: 'setEstimate'; slot: SlotId; priceCents: number; note: string }
  /** 用配件库最新规格补全 / 更新存档里的规格（如后来补的功耗）；没有新值的字段保留原值 */
  | { type: 'refreshSpecs'; slot: SlotId; specs: PartSpecs }
  | { type: 'addCustom'; part: CustomPart }
  | { type: 'removeCustom'; id: string }
  | { type: 'markSaved'; serverId: string; version: number; updatedAt: string }
  | { type: 'load'; build: Build };

export const BUDGET_MIN = 300000;
export const BUDGET_MAX = 3000000;

const touch = (b: Build): Build => ({ ...b, updatedAt: new Date().toISOString() });

function updateSlot(b: Build, slot: SlotId, fn: (s: Build['slots'][SlotId]) => Build['slots'][SlotId]): Build {
  const current = b.slots[slot];
  const next = fn(current);
  if (next === current) return b;
  return touch({ ...b, slots: { ...b.slots, [slot]: next } });
}

/** 锁定的槽位不会被加入、移出或改价覆盖；手动价格只能由用户显式编辑。 */
export function buildReducer(b: Build, a: BuildAction): Build {
  switch (a.type) {
    case 'setBudget':
      return touch({ ...b, budgetCents: Math.min(BUDGET_MAX, Math.max(BUDGET_MIN, Math.round(a.cents))) });
    case 'toggleScenario': {
      const has = b.scenarios.includes(a.key);
      return touch({ ...b, scenarios: has ? b.scenarios.filter(k => k !== a.key) : [...b.scenarios, a.key] });
    }
    case 'rename':
      return touch({ ...b, name: a.name });
    case 'addCandidate':
      // 未知价格用 null 记录，等待用户填价。
      return updateSlot(b, a.candidate.slot, s =>
        s.locked ? s : { ...s, part: partFromCandidate(a.candidate, a.priceCents, a.priceSource, a.note) });
    case 'removePart':
      return updateSlot(b, a.slot, s => (s.locked || !s.part ? s : { ...s, part: null }));
    case 'toggleLock':
      return updateSlot(b, a.slot, s => (!s.part && !s.locked ? s : { ...s, locked: !s.locked }));
    case 'setPartPrice':
      return updateSlot(b, a.slot, s =>
        s.locked || !s.part ? s : { ...s, part: { ...s.part, priceCents: a.priceCents, priceSource: 'manual' } });
    case 'setEstimate':
      return updateSlot(b, a.slot, s =>
        s.locked || s.part?.priceSource !== 'estimate' || s.part.priceCents === a.priceCents
          ? s : { ...s, part: { ...s.part, priceCents: a.priceCents, note: a.note } });
    case 'refreshSpecs':
      return updateSlot(b, a.slot, s => {
        if (!s.part) return s;
        const specs = { ...s.part.specs, ...a.specs };
        const same = Object.keys(specs).every(k => specs[k as keyof PartSpecs] === s.part!.specs[k as keyof PartSpecs]);
        return same ? s : { ...s, part: { ...s.part, specs } };
      });
    case 'addCustom':
      return touch({ ...b, custom: [...b.custom, a.part] });
    case 'removeCustom':
      return touch({ ...b, custom: b.custom.filter(p => p.id !== a.id) });
    case 'markSaved':
      return { ...b, id: a.serverId, serverId: a.serverId, version: a.version, updatedAt: a.updatedAt };
    case 'load':
      // 旧存档没有外设槽位，读入时补上
      return withAllSlots(a.build);
  }
}

export interface BuildTotals {
  filled: number;
  slotCount: number;
  missing: SlotId[];
  /** 主机合计（8 个配件 + 自定义项），与预算比较 */
  totalCents: number;
  remainingCents: number;
  /** 外设（显示器、键盘、鼠标）单独计价，计入整机总预算 */
  peripheralCents: number;
  peripheralCount: number;
  /** 主机 + 外设 */
  grandTotalCents: number;
  /** 已选但价格未知的项目数量（不计入合计） */
  unknownPriceCount: number;
  /** 已选配件中仍是演示价格的数量 */
  demoPriceCount: number;
  /** 按目录参考价估算的配件数量（计入合计） */
  estimateCount: number;
  ratio: number;
}

/** 与后端 calculateBuild 的合计规则一致：数量 × 单价，只累加已知价格。 */
export function totals(b: Build): BuildTotals {
  let totalCents = 0;
  let unknownPriceCount = 0;
  let demoPriceCount = 0;
  let estimateCount = 0;
  const missing: SlotId[] = [];
  for (const { id } of SLOTS) {
    const part = b.slots[id].part;
    if (!part) { missing.push(id); continue; }
    if (part.priceSource === 'demo') demoPriceCount++;
    if (part.priceSource === 'estimate') estimateCount++;
    if (part.priceCents == null) unknownPriceCount++;
    else totalCents += part.priceCents * part.quantity;
  }
  for (const c of b.custom) {
    if (c.priceCents == null) unknownPriceCount++;
    else totalCents += c.priceCents;
  }
  let peripheralCents = 0;
  let peripheralCount = 0;
  for (const { id } of PERIPHERALS) {
    const part = b.slots[id]?.part;
    if (!part) continue;
    peripheralCount++;
    if (part.priceSource === 'estimate') estimateCount++;
    if (part.priceCents == null) unknownPriceCount++;
    else peripheralCents += part.priceCents * part.quantity;
  }
  return {
    filled: SLOTS.length - missing.length,
    slotCount: SLOTS.length,
    missing,
    totalCents,
    remainingCents: b.budgetCents - totalCents - peripheralCents,
    peripheralCents,
    peripheralCount,
    grandTotalCents: totalCents + peripheralCents,
    unknownPriceCount,
    demoPriceCount,
    estimateCount,
    ratio: b.budgetCents > 0 ? totalCents / b.budgetCents : 0,
  };
}
