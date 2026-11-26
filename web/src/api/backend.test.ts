import { describe, expect, it } from 'vitest';
import { buildReducer, totals } from '../domain/build';
import { boardFit, clearance, compatibility, estimatePower, gpuPowerConnector } from '../domain/compat';
import { candidateById, demoBuild } from '../domain/demoData';
import { catalogToCandidate } from '../domain/catalog';
import type { Build } from '../domain/types';
import { fromApi, sameContent, toApiInput } from './mapping';

// 直接加载后端模块，保证前端的合计 / 兼容性与服务端计算一致
const backendPath = '../../../src/builds.mjs';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const backend: any = await import(/* @vite-ignore */ backendPath);

const viaBackend = (b: Build) => backend.calculateBuild(backend.normalizeBuild(toApiInput(b)));

function variants(): Build[] {
  const base = demoBuild();
  const withGpu = buildReducer(base, { type: 'addCandidate', candidate: candidateById('gpu-galax')!, priceCents: 399900, priceSource: 'demo' });
  const unknownPrice = buildReducer(withGpu, { type: 'setPartPrice', slot: 'ssd', priceCents: null });
  let intel = buildReducer(base, { type: 'toggleLock', slot: 'cpu' });
  intel = buildReducer(intel, { type: 'addCandidate', candidate: candidateById('cpu-14600kf')!, priceCents: 129900, priceSource: 'manual' });
  const ddr4 = buildReducer(base, { type: 'addCandidate', candidate: candidateById('board-b760m')!, priceCents: 69900, priceSource: 'manual' });
  const custom = buildReducer(withGpu, { type: 'addCustom', part: { id: 'custom-fans', name: '机箱风扇', spec: '120mm × 3', priceCents: 0 } });
  return [base, withGpu, unknownPrice, intel, ddr4, custom];
}

describe('与后端 calculateBuild 一致', () => {
  it.each(variants().map((b, i) => [i, b] as const))('方案 %i：合计、未知价、插槽、内存、功耗', (_, b) => {
    const server = viaBackend(b);
    const mine = totals(b);
    expect(mine.totalCents).toBe(server.totals.totalCents);
    expect(mine.remainingCents).toBe(server.totals.remainingCents);
    expect(mine.unknownPriceCount).toBe(server.totals.unknownPriceCount);
    expect(mine.filled).toBe(server.totals.filledStandardSlots);
    const p = estimatePower(b);
    expect(p).toEqual(server.compatibility.power);
    expect(clearance(b.slots.gpu.part?.specs.lengthMm, b.slots.case.part?.specs.maxGpuLengthMm)).toEqual(server.compatibility.gpuClearance);
    expect(clearance(b.slots.cooler.part?.specs.heightMm, b.slots.case.part?.specs.maxCoolerHeightMm)).toEqual(server.compatibility.coolerClearance);
    expect(clearance(b.slots.cooler.part?.specs.radiatorSizeMm, b.slots.case.part?.specs.maxRadiatorMm)).toEqual(server.compatibility.radiatorClearance);
    expect(boardFit(b.slots.board.part?.specs.formFactor, b.slots.case.part?.specs.maxBoardFormFactor)).toEqual(server.compatibility.boardFit);
    expect(gpuPowerConnector(b.slots.gpu.part?.specs.gpuPowerConnector, b.slots.psu.part?.specs.native16Pin)).toEqual(server.compatibility.gpuPowerConnector);
  });
});

describe('前后端模型转换', () => {
  it('往返转换后内容不变，且通过后端校验', () => {
    for (const b of variants()) {
      const input = toApiInput(b);
      expect(() => backend.normalizeBuild(input)).not.toThrow();
      const back = fromApi({ ...input, totals: viaBackend(b).totals });
      expect(sameContent(back, b)).toBe(true);
    }
  });

  it('后端演示模板与前端演示方案的合计一致', () => {
    const template = backend.calculateBuild(backend.buildTemplate('demo'));
    const b = fromApi(template);
    expect(totals(b).totalCents).toBe(394400);
    expect(b.slots.cpu.locked).toBe(true);
    expect(b.slots.gpu.part).toBeNull();
    expect(b.scenarios).toEqual(['2k', 'quiet']);
    expect(b.serverId).toBeUndefined();
  });
});

describe('型号目录转候选', () => {
  const item = (category: string, specs: Record<string, number | string>) => ({
    id: 'zol-1', category, name: '影驰GeForce RTX 5060 Ti 魔刃 OC', manufacturer: 'GALAX', mpn: null, summary: 'RTX 5060 Ti · 8GB',
    aliases: [], specs, imageUrl: 'https://2d.zol-img.com.cn/x.png', sourceUrl: 'https://detail.zol.com.cn/2129/2128138/param.shtml',
    dataSource: 'zol' as const, referencePriceCents: 489900,
  });

  it('尺寸保守取整，CPU 的 TDP 不当作峰值功耗，参考价不作为价格', () => {
    const gpu = catalogToCandidate(item('GPU', { lengthMm: 316.5, tdpWatts: 180 }), 'gpu');
    expect(gpu).toMatchObject({ state: 'missing', priceCents: null, specs: { lengthMm: 317, maxPowerWatts: 180 } });
    expect(gpu.estimate).toBeUndefined();
    const priced = catalogToCandidate({ ...item('GPU', {}), estimatedPriceCents: 489900, estimateBasis: 'reference', priceObservedAt: '2026-11-24T00:00:00.000Z' }, 'gpu');
    expect(priced.estimate).toEqual({ cents: 489900, basis: 'reference', samples: 1, observedAt: '2026-11-24T00:00:00.000Z' });
    expect(priced.catalogId).toBe('zol-1');
    const box = catalogToCandidate(item('CASE', { maxGpuLengthMm: 330.8, maxCoolerHeightMm: 165.5 }), 'case');
    expect(box.specs).toEqual({ maxGpuLengthMm: 330, maxCoolerHeightMm: 165 });
    const cpu = catalogToCandidate(item('CPU', { socket: 'am5', tdpWatts: 65 }), 'cpu');
    expect(cpu.specs).toEqual({ socket: 'AM5' });
    expect(catalogToCandidate(item('CPU', { socket: 'AM5', tdpWatts: 65, maxPowerWatts: 88 }), 'cpu').specs).toEqual({ socket: 'AM5', maxPowerWatts: 88 });
  });

  it('只有显卡建议电源时按建议值判断，与后端一致', () => {
    const c = catalogToCandidate(item('GPU', { lengthMm: 316.5, recommendedPsuWatts: 750 }), 'gpu');
    const b = buildReducer(demoBuild(), { type: 'addCandidate', candidate: c, priceCents: 459900, priceSource: 'manual' });
    expect(estimatePower(b)).toEqual(viaBackend(b).compatibility.power);
    expect(estimatePower(b)).toMatchObject({ status: 'warning', recommendedWatts: 750, ratedWatts: 650, estimatedLoadWatts: null });
  });

  it('手动填价后加入的目录配件可以通过后端校验', () => {
    const c = catalogToCandidate(item('GPU', { lengthMm: 316.5, tdpWatts: 180 }), 'gpu');
    const b = buildReducer(demoBuild(), { type: 'addCandidate', candidate: c, priceCents: 459900, priceSource: 'manual' });
    expect(() => backend.normalizeBuild(toApiInput(b))).not.toThrow();
    expect(viaBackend(b).compatibility.gpuClearance).toEqual({ status: 'pass', sizeMm: 317, limitMm: 360 });
  });
});

describe('板型、冷排与 16pin（目录数据）', () => {
  const zol = (category: string, specs: Record<string, number | string | boolean>) => ({
    id: `zol-${category.toLowerCase()}`, category, name: category, manufacturer: null, mpn: null, summary: '', aliases: [], specs,
    imageUrl: null, sourceUrl: 'https://detail.zol.com.cn/1/1/param.shtml', dataSource: 'zol' as const,
  });
  const add = (b: Build, item: ReturnType<typeof zol>, slot: Parameters<typeof catalogToCandidate>[1]) =>
    buildReducer(b, { type: 'addCandidate', candidate: catalogToCandidate(item, slot), priceCents: 100, priceSource: 'manual' });

  it('ATX 主板放进 ITX 机箱、360 冷排放进只支持 240 的机箱、16pin 显卡配非原生电源：前后端一致', () => {
    let b = add(demoBuild(), zol('MOTHERBOARD', { socket: 'AM5', memoryType: 'DDR5', formFactor: 'ATX' }), 'board');
    b = add(b, zol('CASE', { maxBoardFormFactor: 'Mini-ITX', maxGpuLengthMm: 330, maxRadiatorMm: 240 }), 'case');
    b = add(b, zol('COOLER', { radiatorSizeMm: 360 }), 'cooler');
    b = add(b, zol('GPU', { powerConnectors: '16pin', lengthMm: 300 }), 'gpu');
    const server = viaBackend(b).compatibility;
    expect(server.boardFit.status).toBe('conflict');
    expect(server.radiatorClearance.status).toBe('conflict');
    expect(server.gpuPowerConnector.status).toBe('warning');
    // 统一规则：板型、冷排 FAIL；16pin 显卡 + 电源没有接口数据 → 关键项待核实；前后端结论一致
    const front = Object.fromEntries(compatibility(b).map(c => [c.id, c.status]));
    expect(front).toMatchObject({ boardFit: 'FAIL', radiator: 'FAIL', gpuPower: 'UNKNOWN', gpuLength: 'PASS' });
    const back = Object.fromEntries(server.checks.map((c: { id: string; status: string }) => [c.id, c.status]));
    for (const id of ['boardFit', 'radiator', 'gpuPower', 'gpuLength']) expect(back[id]).toBe(front[id]);
    expect(server.overall).toBe('FAIL');
    expect(sameContent(fromApi({ ...toApiInput(b), totals: viaBackend(b).totals }), b)).toBe(true);
  });

  it('BuildCores 机箱外形可推出最大板型', () => {
    const c = catalogToCandidate({ ...zol('CASE', { formFactor: 'Micro ATX Mini Tower' }), dataSource: 'buildcores' as never }, 'case');
    expect(c.specs?.maxBoardFormFactor).toBe('MICRO ATX');
  });
});

describe('保存状态判断', () => {
  it('服务端重排 specs 字段顺序不算未保存修改', () => {
    const b = buildReducer(demoBuild(), { type: 'addCandidate', candidate: { ...candidateById('gpu-galax')!, specs: { lengthMm: 300, maxPowerWatts: 180 } }, priceCents: 399900, priceSource: 'demo' });
    const server = viaBackend(b);
    const gpu = server.slots.find((s: { id: string }) => s.id === 'GPU');
    gpu.part.specs = { maxPowerWatts: 180, lengthMm: 300 };
    expect(sameContent(fromApi(server), b)).toBe(true);
  });
});

describe('外设槽位', () => {
  const monitor = { ...candidateById('gpu-galax')!, id: 'monitor-1', slot: 'monitor' as const, name: 'AOC Q27G40E', specs: {} };
  const withMonitor = buildReducer(demoBuild(), { type: 'addCandidate', candidate: monitor, priceCents: 109900, priceSource: 'estimate' });

  it('外设单独列价并计入预算余额；前后端合计一致', () => {
    const t = totals(withMonitor);
    expect([t.totalCents, t.peripheralCents, t.grandTotalCents, t.peripheralCount]).toEqual([394400, 109900, 504300, 1]);
    expect(t.missing).toEqual(['gpu']);
    expect(t.remainingCents).toBe(withMonitor.budgetCents - t.grandTotalCents);
    const server = viaBackend(withMonitor).totals;
    expect([server.totalCents, server.peripheralCents, server.grandTotalCents, server.remainingCents])
      .toEqual([t.totalCents, t.peripheralCents, t.grandTotalCents, t.remainingCents]);
  });

  it('保存后读回外设还在；没选外设时不提交外设槽位', () => {
    const input = toApiInput(withMonitor);
    expect(input.slots.map(s => s.id)).toContain('MONITOR');
    expect(input.slots.map(s => s.id)).not.toContain('KEYBOARD');
    expect(fromApi(input).slots.monitor.part?.name).toBe('AOC Q27G40E');
    expect(toApiInput(demoBuild()).slots).toHaveLength(8);
  });

  it('没有外设槽位的旧存档读入时补上空槽位', () => {
    const old = demoBuild();
    const { monitor: _m, keyboard: _k, mouse: _o, ...core } = old.slots;
    const loaded = buildReducer(old, { type: 'load', build: { ...old, slots: core as typeof old.slots } });
    expect(loaded.slots.monitor).toEqual({ part: null, locked: false });
    expect(totals(loaded).peripheralCount).toBe(0);
  });
});
