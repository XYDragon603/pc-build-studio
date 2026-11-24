import type { Build } from './types';

export type CheckLevel = 'ok' | 'warn' | 'error';

export interface Check {
  id: string;
  level: CheckLevel;
  label: string;
  detail: string;
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

const norm = (v?: string) => v?.trim().toUpperCase() || undefined;

/**
 * 只做规则可判断的检查，结论保守：缺少信息时显示“待补齐/待确认”，
 * 不宣称整机兼容。判定与后端 compatibility 字段一一对应。
 */
export function compatibility(b: Build): Check[] {
  const cpu = b.slots.cpu.part?.specs;
  const board = b.slots.board.part?.specs;
  const ram = b.slots.ram.part?.specs;
  const checks: Check[] = [];

  const cpuSocket = norm(cpu?.socket);
  const boardSocket = norm(board?.socket);
  if (!cpuSocket || !boardSocket) {
    checks.push({ id: 'socket', level: 'warn', label: '接口待补齐', detail: 'CPU 与主板都有插槽信息后才能检查是否一致。' });
  } else if (cpuSocket === boardSocket) {
    checks.push({ id: 'socket', level: 'ok', label: '接口一致', detail: `CPU 与主板均为 ${cpuSocket} 插槽。` });
  } else {
    checks.push({ id: 'socket', level: 'error', label: '接口不一致', detail: `CPU 为 ${cpuSocket}，主板为 ${boardSocket}，无法安装。` });
  }

  const boardMem = norm(board?.memoryType);
  const ramMem = norm(ram?.memoryType);
  if (boardMem && ramMem && boardMem !== ramMem) {
    checks.push({ id: 'mem', level: 'error', label: '内存代际不符', detail: `主板支持 ${boardMem}，所选内存为 ${ramMem}。` });
  }

  checks.push({ id: 'bios', level: 'warn', label: 'BIOS 待确认', detail: '尚未核对主板出厂 BIOS 是否支持所选 CPU，请向商家确认。' });

  // 尺寸检查只在两件配件都已选择时出现，避免提示栏堆满“待补齐”
  const caseSpecs = b.slots.case.part?.specs;
  const cooler = b.slots.cooler.part;
  const liquid = !!cooler?.specs.radiatorSizeMm;
  const sizeChecks: [string, string, { specs: { lengthMm?: number; heightMm?: number; radiatorSizeMm?: number } } | null | undefined, 'lengthMm' | 'heightMm' | 'radiatorSizeMm', number | undefined][] = [
    ['gpuFit', '显卡', b.slots.gpu.part, 'lengthMm', caseSpecs?.maxGpuLengthMm],
    // 水冷检查冷排位，风冷检查限高
    liquid
      ? ['radiatorFit', '冷排', cooler, 'radiatorSizeMm', caseSpecs?.maxRadiatorMm]
      : ['coolerFit', '散热器', cooler, 'heightMm', caseSpecs?.maxCoolerHeightMm],
  ];
  for (const [id, noun, part, field, limit] of sizeChecks) {
    if (!part || !b.slots.case.part) continue;
    const c = clearance(part.specs[field], limit);
    const what = field === 'lengthMm' ? '长度' : field === 'heightMm' ? '高度' : '尺寸';
    const limitName = field === 'lengthMm' ? '显卡限长' : field === 'heightMm' ? '散热器限高' : '最大冷排';
    if (c.status === 'unknown') {
      checks.push({ id, level: 'warn', label: `${noun}${what}待核对`, detail: `${noun}${what}或机箱${limitName}缺少数据，请对照商品参数确认能否装下。` });
    } else if (c.status === 'pass') {
      checks.push({ id, level: 'ok', label: `${noun}可装入`, detail: `${noun}${what} ${c.sizeMm}mm，机箱${limitName} ${c.limitMm}mm，余量 ${c.limitMm - c.sizeMm}mm。` });
    } else {
      checks.push({ id, level: 'error', label: `${noun}装不下`, detail: `${noun}${what} ${c.sizeMm}mm 超过机箱${limitName} ${c.limitMm}mm。` });
    }
  }

  const boardPart = b.slots.board.part;
  if (boardPart && b.slots.case.part) {
    const f = boardFit(boardPart.specs.formFactor, caseSpecs?.maxBoardFormFactor);
    if (f.status === 'pass') checks.push({ id: 'boardFit', level: 'ok', label: '主板可装入', detail: `主板 ${f.formFactor}，机箱最大支持 ${f.maxFormFactor}。` });
    else if (f.status === 'conflict') checks.push({ id: 'boardFit', level: 'error', label: '主板装不下', detail: `主板 ${f.formFactor} 大于机箱支持的 ${f.maxFormFactor}。` });
    else checks.push({ id: 'boardFit', level: 'warn', label: '主板板型待核对', detail: '主板板型或机箱支持的板型缺少数据。' });
  }

  const gpuPart = b.slots.gpu.part;
  if (gpuPart && b.slots.psu.part) {
    const g = gpuPowerConnector(gpuPart.specs.gpuPowerConnector, b.slots.psu.part.specs.native16Pin);
    if (g.status === 'pass') checks.push({ id: 'gpu16pin', level: 'ok', label: '电源原生 16pin', detail: '显卡使用 16pin 供电，所选电源带原生 16pin 线。' });
    else if (g.status === 'warning') checks.push({ id: 'gpu16pin', level: 'warn', label: '16pin 供电待核对', detail: '显卡使用 16pin 供电，所选电源未标注原生 16pin，需要转接线或向商家确认。' });
  }

  const p = estimatePower(b);
  if (!b.slots.gpu.part) {
    checks.push({ id: 'power', level: 'warn', label: '功耗待补齐显卡后估算', detail: '显卡是整机功耗的主要部分，选定后再估算电源余量。' });
  } else if (p.recommendedWatts === null) {
    checks.push({ id: 'power', level: 'warn', label: '功耗数据不足', detail: 'CPU 或显卡缺少峰值功耗数据，显卡也没有建议电源，暂不估算电源余量。' });
  } else if (p.estimatedLoadWatts === null) {
    // 只有显卡厂商的建议电源
    if (p.ratedWatts === null) {
      checks.push({ id: 'power', level: 'warn', label: `建议电源 ≥ ${p.recommendedWatts}W`, detail: `显卡厂商建议 ${p.recommendedWatts}W；所选电源缺少额定功率。` });
    } else {
      const ok = p.status === 'pass';
      checks.push({
        id: 'power', level: ok ? 'ok' : 'warn',
        label: ok ? '电源满足显卡建议' : `电源低于显卡建议 ${p.recommendedWatts}W`,
        detail: `显卡厂商建议电源 ${p.recommendedWatts}W，当前电源 ${p.ratedWatts}W。缺少 CPU 或显卡功耗数据，未做整机估算。`,
      });
    }
  } else if (p.ratedWatts === null) {
    checks.push({ id: 'power', level: 'warn', label: `建议电源 ≥ ${p.recommendedWatts}W`, detail: `估算负载约 ${p.estimatedLoadWatts}W；所选电源缺少额定功率。` });
  } else {
    const ok = p.status === 'pass';
    checks.push({
      id: 'power',
      level: ok ? 'ok' : 'warn',
      label: ok ? `约 ${p.estimatedLoadWatts}W · 电源余量充足` : `约 ${p.estimatedLoadWatts}W · 电源偏小`,
      detail: `估算：CPU 与显卡峰值合计 + 75W，建议电源 ≥ ${p.recommendedWatts}W；当前电源 ${p.ratedWatts}W。不代表实测功耗。`,
    });
  }
  return checks;
}
