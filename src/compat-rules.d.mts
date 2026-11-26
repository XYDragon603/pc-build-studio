// compat-rules.mjs 的类型声明（前端 TypeScript 直接引用这份规则）

export type CompatStatus = 'PASS' | 'FAIL' | 'CONDITIONAL' | 'UNKNOWN' | 'NOT_APPLICABLE';

export interface CompatCheck {
  id: string;
  label: string;
  status: CompatStatus;
  detail: string;
  /** 供电等安全相关检查：UNKNOWN 时整机只能是“待核实” */
  critical: boolean;
  check_id: string;
  severity: 'physical' | 'safety' | 'installation' | 'performance' | 'measurement' | 'data';
  blocking: boolean;
  evidence: Record<string, unknown>;
  confidence: 'high' | 'medium' | 'low';
  required_action: string | null;
}

export type CompatSlot = 'CPU' | 'GPU' | 'MOTHERBOARD' | 'RAM' | 'SSD' | 'PSU' | 'CASE' | 'COOLER';
export type CompatParts = Partial<Record<CompatSlot, { name?: string; specs: Record<string, unknown> } | null>>;

export const PASS: 'PASS';
export const FAIL: 'FAIL';
export const CONDITIONAL: 'CONDITIONAL';
export const UNKNOWN: 'UNKNOWN';
export const NOT_APPLICABLE: 'NOT_APPLICABLE';

export function evaluateBuild(parts: CompatParts, opts?: { igpu?: boolean; stockCooler?: boolean; workload?: Record<string, unknown> }): CompatCheck[];
export function overallStatus(checks: CompatCheck[]): Exclude<CompatStatus, 'NOT_APPLICABLE'>;
export function powerEstimate(cpu: Record<string, unknown> | null | undefined, gpu: Record<string, unknown> | null | undefined, opts?: { igpu?: boolean }):
  { cpuW: number | null; gpuW: number | null; load: number | null; recommended: number | null; calculated: number | null; manufacturer: number | null; policyFloor: number; selectionMinimum: number };
export function cpuHasIgpu(name: string, specs?: Record<string, unknown>): boolean;
export function biosSupport(cpuName: string, boardChipset: string, boardSpecs?: Record<string, unknown>): { status: CompatStatus; detail: string };
export function gpuPowerCheck(gpu: Record<string, unknown> | null | undefined, psu: Record<string, unknown> | null | undefined): { status: CompatStatus; detail: string };
export const severity: (status: CompatStatus) => number;
