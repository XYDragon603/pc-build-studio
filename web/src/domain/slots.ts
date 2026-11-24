import type { SlotId } from './types';

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

export const slotDef = (id: SlotId): SlotDef => SLOTS.find(s => s.id === id)!;
