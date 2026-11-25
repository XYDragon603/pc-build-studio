import type { Build, PeripheralId, SlotId } from './types';

export interface SlotDef {
  id: SlotId;
  /** 步骤条与摘要里的短名 */
  label: string;
  /** “为你的主机选择____” */
  noun: string;
  /** “还差____，配置就齐了” */
  missingPhrase: string;
}

export const SLOTS: SlotDef[] = [
  { id: 'cpu', label: 'CPU', noun: 'CPU', missingPhrase: '一颗 CPU' },
  { id: 'gpu', label: '显卡', noun: '显卡', missingPhrase: '一张显卡' },
  { id: 'board', label: '主板', noun: '主板', missingPhrase: '一块主板' },
  { id: 'ram', label: '内存', noun: '内存', missingPhrase: '一套内存' },
  { id: 'ssd', label: '硬盘', noun: '硬盘', missingPhrase: '一块硬盘' },
  { id: 'psu', label: '电源', noun: '电源', missingPhrase: '一个电源' },
  { id: 'case', label: '机箱', noun: '机箱', missingPhrase: '一个机箱' },
  { id: 'cooler', label: '散热', noun: '散热器', missingPhrase: '一个散热器' },
];

export const SLOT_IDS = SLOTS.map(s => s.id);

/** 外设一栏（不在 SLOTS 里：SLOTS 只表示主机的 8 个必需配件） */
export const PERIPHERALS: (SlotDef & { id: PeripheralId })[] = [
  { id: 'monitor', label: '显示器', noun: '显示器', missingPhrase: '一台显示器' },
  { id: 'keyboard', label: '键盘', noun: '键盘', missingPhrase: '一把键盘' },
  { id: 'mouse', label: '鼠标', noun: '鼠标', missingPhrase: '一个鼠标' },
];

export const ALL_SLOTS: SlotDef[] = [...SLOTS, ...PERIPHERALS];

export const isPeripheral = (id: SlotId): id is PeripheralId => PERIPHERALS.some(p => p.id === id);

export const slotDef = (id: SlotId): SlotDef => ALL_SLOTS.find(s => s.id === id)!;

/** 全部槽位都为空 */
export const emptySlots = (): Build['slots'] =>
  Object.fromEntries(ALL_SLOTS.map(s => [s.id, { part: null, locked: false }])) as Build['slots'];

/** 旧存档没有外设槽位，读入时补上空槽位 */
export const withAllSlots = (b: Build): Build =>
  ALL_SLOTS.every(s => b.slots[s.id]) ? b : { ...b, slots: { ...emptySlots(), ...b.slots } };
