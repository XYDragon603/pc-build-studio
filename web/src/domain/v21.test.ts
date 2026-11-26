import { expect, it } from 'vitest';
import { emptyBuild, fitsBuild, planToBuild, buildChecks } from './plan';
import { catalogSpecs } from './catalog';
import { toApiInput } from '../api/mapping';
import { buildMarkdown } from './exportList';
import { totals } from './build';
import type { PlanResult, CatalogItem } from '../api/client';
import type { Part } from './types';

const part = (name: string, specs: Part['specs']): Part => ({ name, specs, spec: '', priceCents: 0, quantity: 1, priceSource: 'manual', note: '', url: null });
it('更换主板与机箱时用明确支持集合，显式集合优先于错误的最大板型', () => {
  const b = emptyBuild(500000, ['2k'], '测试');
  b.slots.case.part = part('测试机箱', catalogSpecs('case', { maxBoardFormFactor: 'ATX', supportedBoardFormats: ['MICRO ATX'] }));
  expect(fitsBuild('board', { formFactor: 'ATX' }, b)).toBe(false);
  b.slots.board.part = part('ATX', { formFactor: 'ATX' });
  expect(buildChecks(b).find(c => c.id === 'boardFit')?.status).toBe('FAIL');
});
it('新散热证据与 PCIe 通道字段可以经过真实前端转换并保存', () => {
  const specs = { socket: 'AM5', sustainedPowerWatts: 180, pcieLink: { gen: 4, lanes: 16 }, workload: { task: 'llm' } };
  const saved = toApiInput({ ...emptyBuild(800000, ['ai'], '测试'), slots: { ...emptyBuild(800000, ['ai'], '').slots, cpu: { locked: false, part: part('CPU', catalogSpecs('cpu', specs)) } } });
  expect(saved.slots.find(s => s.id === 'CPU')?.part?.specs).toMatchObject(specs);
});
it('导出保留已核实报价类型、来源日期和 UNKNOWN，不变成估算或通过', () => {
  const gpu = { id: 'synthetic', name: '测试显卡', category: 'GPU', estimatedPriceCents: 100000, summary: '', sourceUrl: 'https://example.com/card', specs: { boardPowerWatts: 450 }, priceRecord: { priceType: 'verified', sourceName: '测试商城', sourceUrl: 'https://example.com/quote', observedAt: '2026-11-25T00:00:00Z', condition: 'new', stockStatus: 'in_stock' } } as unknown as CatalogItem;
  const b = planToBuild({ label: '推荐版', picks: [{ slot: 'GPU', item: gpu, reason: '合成测试' }], igpu: false, stockCooler: false } as PlanResult, 200000, ['ai']);
  expect(b.slots.gpu.part?.priceSource).toBe('verified');
  expect(b.slots.gpu.part?.note).toContain('2026-11-25');
  expect(buildMarkdown(b, false)).toContain('已核实市场报价');
});
it('风扇额外费用进入预算且自定义槽位 ID 保存稳定', () => {
  const b = planToBuild({ label: '推荐版', picks: [], igpu: false, stockCooler: false, additionalCosts: [{ id: 'case-fans', name: '机箱额外风扇', priceCents: 12000 }] } as unknown as PlanResult, 200000, ['2k']);
  expect(totals(b).grandTotalCents).toBe(12000);
  expect(toApiInput(b).slots.at(-1)?.id).toBe('custom-case-fans');
  expect(toApiInput(b)).toEqual(toApiInput(b));
});
