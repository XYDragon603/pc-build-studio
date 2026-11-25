import { describe, expect, it } from 'vitest';
import { buildReducer, totals } from './build';
import { compatibility } from './compat';
import { candidateById, demoBuild } from './demoData';
import { formatYuan, parseYuan } from './money';

describe('演示方案与设计稿数字一致', () => {
  it('7/8 件、合计 ¥3,944、剩余 ¥4,056', () => {
    const t = totals(demoBuild());
    expect(t.filled).toBe(7);
    expect(t.missing).toEqual(['gpu']);
    expect(formatYuan(t.totalCents)).toBe('¥3,944');
    expect(formatYuan(t.remainingCents)).toBe('¥4,056');
  });
});

describe('配置操作', () => {
  it('加入已确认显卡后计入合计', () => {
    const b = buildReducer(demoBuild(), { type: 'addCandidate', candidate: candidateById('gpu-galax')!, priceCents: 399900, priceSource: 'demo' });
    expect(totals(b).totalCents).toBe(394400 + 399900);
    expect(totals(b).filled).toBe(8);
  });

  it('锁定的槽位不会被替换、移出或改价', () => {
    let b = demoBuild();
    const before = b.slots.cpu;
    b = buildReducer(b, { type: 'addCandidate', candidate: candidateById('cpu-14600kf')!, priceCents: 129900, priceSource: 'manual' });
    b = buildReducer(b, { type: 'removePart', slot: 'cpu' });
    b = buildReducer(b, { type: 'setPartPrice', slot: 'cpu', priceCents: 1 });
    expect(b.slots.cpu).toBe(before);
  });

  it('价格未知与 0 元分开：未知不计入合计但计数', () => {
    let b = buildReducer(demoBuild(), { type: 'setPartPrice', slot: 'ssd', priceCents: null });
    expect(totals(b).unknownPriceCount).toBe(1);
    expect(totals(b).totalCents).toBe(394400 - 39900);
    b = buildReducer(b, { type: 'setPartPrice', slot: 'ssd', priceCents: 0 });
    expect(totals(b).unknownPriceCount).toBe(0);
  });

  it('预算限制在合理区间', () => {
    expect(buildReducer(demoBuild(), { type: 'setBudget', cents: -5 }).budgetCents).toBe(300000);
  });
});

describe('估算价', () => {
  const est = { ...candidateById('gpu-galax')!, id: 'catalog:zol-1', source: 'catalog' as const, catalogId: 'zol-1', url: 'https://detail.zol.com.cn/1/1/param.shtml',
    estimate: { cents: 438900, basis: 'reference' as const, samples: 1, observedAt: null } };

  it('按估算价加入计入合计，并单独计数', () => {
    const b = buildReducer(demoBuild(), { type: 'addCandidate', candidate: est, priceCents: 438900, priceSource: 'estimate', note: 'x' });
    expect(totals(b)).toMatchObject({ totalCents: 394400 + 438900, estimateCount: 1 });
    expect(b.slots.gpu.part).toMatchObject({ priceSource: 'estimate', catalogId: 'zol-1' });
  });

  it('刷新只改估算价；改成手动价或锁定后不再被刷新', () => {
    let b = buildReducer(demoBuild(), { type: 'addCandidate', candidate: est, priceCents: 438900, priceSource: 'estimate', note: 'x' });
    b = buildReducer(b, { type: 'setEstimate', slot: 'gpu', priceCents: 419900, note: 'y' });
    expect(b.slots.gpu.part?.priceCents).toBe(419900);
    const manual = buildReducer(b, { type: 'setPartPrice', slot: 'gpu', priceCents: 400000 });
    expect(buildReducer(manual, { type: 'setEstimate', slot: 'gpu', priceCents: 1, note: '' }).slots.gpu.part?.priceCents).toBe(400000);
    const locked = buildReducer(b, { type: 'toggleLock', slot: 'gpu' });
    expect(buildReducer(locked, { type: 'setEstimate', slot: 'gpu', priceCents: 1, note: '' }).slots.gpu.part?.priceCents).toBe(419900);
  });
});

describe('兼容性', () => {
  it('缺显卡时功耗保留未知；BIOS 数据不足为待核实，不算通过', () => {
    const checks = compatibility(demoBuild());
    expect(checks.find(c => c.id === 'socket')).toMatchObject({ status: 'PASS', level: 'ok' });
    // 演示数据没有主板芯片组，BIOS 支持关系无法判断
    expect(checks.find(c => c.id === 'bios')).toMatchObject({ status: 'UNKNOWN', level: 'warn' });
    expect(checks.find(c => c.id === 'power')?.label).toBe('功耗待补齐显卡后估算');
    expect(checks.some(c => c.status === 'FAIL')).toBe(false);
  });
  it('显卡超过机箱限长时报错，装得下时给出余量', () => {
    const ok = buildReducer(demoBuild(), { type: 'addCandidate', candidate: candidateById('gpu-galax')!, priceCents: 399900, priceSource: 'demo' });
    expect(compatibility(ok).find(c => c.id === 'gpuLength')).toMatchObject({ level: 'ok', status: 'PASS' });
    expect(compatibility(ok).find(c => c.id === 'coolerHeight')).toMatchObject({ level: 'ok' });
    const long = { ...candidateById('gpu-galax')!, id: 'long', url: 'https://example.com/long', specs: { lengthMm: 361 } };
    const bad = buildReducer(ok, { type: 'addCandidate', candidate: long, priceCents: 1, priceSource: 'manual' });
    expect(compatibility(bad).find(c => c.id === 'gpuLength')).toMatchObject({ level: 'error', status: 'FAIL', label: '显卡长度不兼容' });
  });
  it('插槽不一致报错', () => {
    let b = buildReducer(demoBuild(), { type: 'toggleLock', slot: 'cpu' });
    b = buildReducer(b, { type: 'addCandidate', candidate: candidateById('cpu-14600kf')!, priceCents: 129900, priceSource: 'manual' });
    expect(compatibility(b).find(c => c.id === 'socket')).toMatchObject({ level: 'error', status: 'FAIL', label: 'CPU 插槽不兼容' });
  });
});

describe('金额解析', () => {
  it.each([['3999', 399900], ['3,999.5', 399950], ['0', 0], ['¥ 12', 1200], ['abc', null], ['1.234', null]])('%s → %s', (input, out) => {
    expect(parseYuan(input)).toBe(out);
  });
});

describe('导出清单', () => {
  it('包含价格来源列、非实时说明和兼容性状态图例', async () => {
    const { buildMarkdown } = await import('./exportList');
    const md = buildMarkdown(demoBuild(), true);
    expect(md).toContain('| 价格来源 |');
    expect(md).toContain('不是实时价格');
    expect(md).toContain('图例：✓ 通过');
    expect(md).toMatch(/^- [✓!?✗–] /m);
  });
});
