import { evaluateBuild, type CompatCheck, type CompatParts, type CompatSlot, type CompatStatus } from '../../../src/compat-rules.mjs';
import { INTEGRATED_GPU_NAME, STOCK_COOLER_NAME } from './placeholders';
import type { Build } from './types';

export type CheckLevel = 'ok' | 'warn' | 'error';

export interface Check {
  id: string;
  level: CheckLevel;
  label: string;
  detail: string;
  /** 统一规则的五种状态（PASS / FAIL / CONDITIONAL / UNKNOWN） */
  status?: CompatStatus;
  /** 供电等安全相关检查 */
  critical?: boolean;
}

/** 与后端 calculateBuild 相同的功耗规则：CPU 与显卡峰值合计 + 75W，建议电源留 25% 余量。 */
export function estimatePower(b: Build) {
  const cpu = b.slots.cpu.part;
  const gpu = b.slots.gpu.part;
  const cpuW = cpu?.specs.maxPowerWatts;
  const gpuW = gpu?.specs.maxPowerWatts;
  const estimatedLoadWatts = cpuW && gpuW ? cpuW * cpu!.quantity + gpuW * gpu!.quantity + 75 : null;
  // 估算值与显卡厂商建议电源都有时取较大者（与后端一致）
  const gpuRecommendedWatts = gpu?.specs.recommendedPsuWatts ?? null;
  const options = [estimatedLoadWatts === null ? null : Math.ceil(estimatedLoadWatts * 1.25), gpuRecommendedWatts].filter((v): v is number => v !== null);
  const recommendedWatts = options.length ? Math.max(...options) : null;
  const ratedWatts = b.slots.psu.part?.specs.ratedWatts ?? null;
  const status = recommendedWatts !== null && ratedWatts !== null ? (ratedWatts >= recommendedWatts ? 'pass' : 'warning') : 'unknown';
  return { status, estimatedLoadWatts, recommendedWatts, ratedWatts, gpuRecommendedWatts } as const;
}

/** 与后端 clearance 相同：配件尺寸不超过机箱限值即通过，任一缺失为 unknown */
export function clearance(sizeMm?: number, limitMm?: number) {
  if (!sizeMm || !limitMm) return { status: 'unknown', sizeMm: sizeMm ?? null, limitMm: limitMm ?? null } as const;
  return { status: sizeMm <= limitMm ? 'pass' : 'conflict', sizeMm, limitMm } as const;
}

const BOARD_RANK: Record<string, number> = { 'MINI-ITX': 1, 'MICRO ATX': 2, ATX: 3, EATX: 4 };

/** 与后端 boardFit 相同：主板板型不大于机箱支持的最大板型即可安装 */
export function boardFit(board?: string, maxBoard?: string) {
  const size = board ? BOARD_RANK[board] : undefined;
  const limit = maxBoard ? BOARD_RANK[maxBoard] : undefined;
  if (!size || !limit) return { status: 'unknown', formFactor: board ?? null, maxFormFactor: maxBoard ?? null } as const;
  return { status: size <= limit ? 'pass' : 'conflict', formFactor: board!, maxFormFactor: maxBoard! } as const;
}

/** 与后端 gpuPowerConnector 相同：只检查 16pin 显卡 */
export function gpuPowerConnector(connector?: string, native16Pin?: boolean) {
  if (!connector || !/16\s*PIN/.test(connector)) return { status: 'unknown', required: connector ?? null } as const;
  return { status: native16Pin ? 'pass' : 'warning', required: connector } as const;
}

/** 整机兼容性：直接用前后端共用的规则（src/compat-rules.mjs），五种状态映射到界面的三种颜色 */
const SLOT_MAP: Record<string, CompatSlot> = { cpu: 'CPU', gpu: 'GPU', board: 'MOTHERBOARD', ram: 'RAM', ssd: 'SSD', psu: 'PSU', case: 'CASE', cooler: 'COOLER' };

const LEVEL: Record<CompatStatus, CheckLevel> = { PASS: 'ok', FAIL: 'error', CONDITIONAL: 'warn', UNKNOWN: 'warn', NOT_APPLICABLE: 'ok' };

function labelOf(c: CompatCheck): string {
  if (c.status === 'FAIL') return `${c.label}不兼容`;
  if (c.status === 'UNKNOWN') return `${c.label}待核实`;
  if (c.status === 'CONDITIONAL') return `${c.label}（需满足条件）`;
  return c.label;
}

export function compatibility(b: Build): Check[] {
  const igpu = b.slots.gpu.part?.name === INTEGRATED_GPU_NAME;
  const stockCooler = b.slots.cooler.part?.name === STOCK_COOLER_NAME;
  const parts: CompatParts = {};
  for (const [slot, key] of Object.entries(SLOT_MAP)) {
    const part = b.slots[slot as keyof typeof SLOT_MAP & keyof Build['slots']]?.part;
    if (!part || (slot === 'gpu' && igpu) || (slot === 'cooler' && stockCooler)) continue;
    parts[key] = { name: part.name, specs: part.specs as Record<string, unknown> };
  }
  const checks: Check[] = evaluateBuild(parts, { igpu, stockCooler })
    .filter(c => c.status !== 'NOT_APPLICABLE')
    // 还没选显卡时，“电源功率”没法估算，换成更明确的提示
    .filter(c => !(c.id === 'psuWatts' && !b.slots.gpu.part && !igpu))
    .map(c => ({ id: c.id, level: LEVEL[c.status], status: c.status, critical: c.critical, label: labelOf(c), detail: c.detail }));
  if (!b.slots.gpu.part) {
    checks.push({ id: 'power', level: 'warn', status: 'UNKNOWN', critical: false, label: '功耗待补齐显卡后估算', detail: '显卡是整机功耗的主要部分，选定后再估算电源余量。' });
  }
  return checks;
}
