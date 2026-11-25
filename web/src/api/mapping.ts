import { emptySlots, PERIPHERALS, SLOTS } from '../domain/slots';
import type { Build, CustomPart, Part, SlotId } from '../domain/types';
import type { ApiBuild, ApiBuildInput, ApiPart, ApiSlot } from './client';

export const SLOT_TO_API: Record<SlotId, string> = {
  monitor: 'MONITOR', keyboard: 'KEYBOARD', mouse: 'MOUSE',
  cpu: 'CPU', gpu: 'GPU', board: 'MOTHERBOARD', ram: 'RAM', ssd: 'SSD', psu: 'PSU', case: 'CASE', cooler: 'COOLER',
};
export const API_TO_SLOT = Object.fromEntries(Object.entries(SLOT_TO_API).map(([k, v]) => [v, k])) as Record<string, SlotId>;

function partToApi(p: Part): ApiPart {
  return {
    model: p.name.slice(0, 160),
    spec: p.spec.slice(0, 120),
    priceCents: p.priceCents,
    quantity: p.quantity,
    priceSource: p.priceSource,
    catalogId: p.catalogId ?? null,
    note: p.note,
    url: p.url,
    specs: { ...p.specs },
  };
}

function partFromApi(p: ApiPart): Part {
  return {
    name: p.model,
    spec: p.spec ?? '',
    priceCents: p.priceCents,
    quantity: p.quantity ?? 1,
    priceSource: p.priceSource ?? 'manual',
    catalogId: p.catalogId ?? null,
    note: p.note ?? '',
    url: p.url ?? null,
    specs: { ...(p.specs ?? {}) },
  };
}

/** 前端生成的自定义 ID 已符合后端格式；历史数据不符合时换一个合法 ID */
const customSlotId = (id: string) =>
  /^custom-[a-z0-9][a-z0-9-]{0,56}$/.test(id) ? id : `custom-${Math.random().toString(36).slice(2, 10)}`;

export function toApiInput(b: Build): ApiBuildInput {
  const slots: ApiSlot[] = SLOTS.map(({ id, label }) => ({
    id: SLOT_TO_API[id],
    label,
    locked: b.slots[id].locked && !!b.slots[id].part,
    part: b.slots[id].part ? partToApi(b.slots[id].part!) : null,
  }));
  // 外设是可选槽位，只在选了配件时提交
  for (const { id, label } of PERIPHERALS) {
    const part = b.slots[id]?.part;
    if (part) slots.push({ id: SLOT_TO_API[id], label, locked: b.slots[id].locked, part: partToApi(part) });
  }
  for (const c of b.custom) {
    slots.push({
      id: customSlotId(c.id),
      label: c.name.slice(0, 50),
      locked: false,
      part: { model: c.name.slice(0, 160), spec: c.spec.slice(0, 120), priceCents: c.priceCents, quantity: 1, priceSource: 'manual', note: '', url: null, specs: {} },
    });
  }
  return { name: b.name.trim() || '未命名方案', budgetCents: b.budgetCents, scenarios: [...b.scenarios], slots };
}

export function fromApi(a: ApiBuild | ApiBuildInput): Build {
  const slots = emptySlots();
  const custom: CustomPart[] = [];
  for (const s of a.slots) {
    const slot = API_TO_SLOT[s.id];
    if (slot) {
      slots[slot] = { part: s.part ? partFromApi(s.part) : null, locked: s.locked };
    } else if (s.part) {
      custom.push({ id: s.id, name: s.part.model || s.label, spec: s.part.spec ?? '', priceCents: s.part.priceCents });
    }
  }
  const saved = 'id' in a ? a : null;
  return {
    id: saved?.id ?? `draft-${Date.now().toString(36)}`,
    serverId: saved?.id,
    version: saved?.version,
    name: a.name,
    budgetCents: a.budgetCents,
    scenarios: a.scenarios ?? [],
    slots,
    custom,
    updatedAt: saved?.updatedAt ?? new Date().toISOString(),
  };
}

/** 判断本地方案相对于上次保存的版本是否有改动（只比较会提交给服务端的内容）。 */
export function sameContent(a: Build, b: Build): boolean {
  return canonical(toApiInput(a)) === canonical(toApiInput(b));
}

/** 按字段名排序后序列化：服务端返回的 specs 字段顺序可能与本地不同，不能算作修改 */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map(k => [k, (v as Record<string, unknown>)[k]]))
      : v);
}
