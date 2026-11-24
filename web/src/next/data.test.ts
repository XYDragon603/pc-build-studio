import { describe, expect, it } from 'vitest';
import type { CatalogItem } from '../api/client';
import { buildReducer } from '../domain/build';
import { candidateById, demoBuild } from '../domain/demoData';
import { priceChanges, staleSpecs } from './data';

const gpu = { ...candidateById('gpu-galax')!, catalogId: 'zol-1' };
const item = (cents: number) => ({ id: 'zol-1', estimatedPriceCents: cents }) as CatalogItem;

describe('打开存档时的参考价变动', () => {
  const withEstimate = buildReducer(demoBuild(), { type: 'addCandidate', candidate: gpu, priceCents: 399900, priceSource: 'estimate' });

  it('参考价变了才提示，并给出新旧价格', () => {
    expect(priceChanges(withEstimate, { 'zol-1': item(399900) })).toEqual([]);
    expect(priceChanges(withEstimate, { 'zol-1': item(429900) })).toEqual([
      { slot: 'gpu', label: '显卡', name: gpu.name, fromCents: 399900, toCents: 429900 },
    ]);
  });

  it('手填的实付价、锁定的配件、配件库没有价格的都不提示', () => {
    const manual = buildReducer(withEstimate, { type: 'setPartPrice', slot: 'gpu', priceCents: 380000 });
    expect(priceChanges(manual, { 'zol-1': item(429900) })).toEqual([]);
    const locked = buildReducer(withEstimate, { type: 'toggleLock', slot: 'gpu' });
    expect(priceChanges(locked, { 'zol-1': item(429900) })).toEqual([]);
    expect(priceChanges(withEstimate, { 'zol-1': null })).toEqual([]);
  });

  it('一键更新后不再提示', () => {
    const [change] = priceChanges(withEstimate, { 'zol-1': item(429900) });
    const updated = buildReducer(withEstimate, { type: 'setEstimate', slot: change.slot, priceCents: change.toCents, note: '' });
    expect(updated.slots.gpu.part?.priceCents).toBe(429900);
    expect(priceChanges(updated, { 'zol-1': item(429900) })).toEqual([]);
  });
});

describe('打开存档时补全规格', () => {
  const saved = buildReducer(demoBuild(), { type: 'addCandidate', candidate: { ...gpu, specs: { lengthMm: 300 } }, priceCents: 399900, priceSource: 'estimate' });
  const latest = { id: 'zol-1', specs: { lengthMm: 300, tdpWatts: 180, recommendedPsuWatts: 650 } } as unknown as CatalogItem;

  it('配件库有新规格（如后来补的功耗）时合并进存档，原有字段保留', () => {
    const stale = staleSpecs(saved, { 'zol-1': latest });
    expect(stale).toEqual([{ slot: 'gpu', specs: { lengthMm: 300, maxPowerWatts: 180, recommendedPsuWatts: 650 } }]);
    const withOld = { ...saved, slots: { ...saved.slots, gpu: { ...saved.slots.gpu, part: { ...saved.slots.gpu.part!, specs: { lengthMm: 300, gpuPowerConnector: '8PIN' } } } } };
    const merged = buildReducer(withOld, { type: 'refreshSpecs', slot: 'gpu', specs: stale[0].specs });
    expect(merged.slots.gpu.part?.specs).toEqual({ lengthMm: 300, gpuPowerConnector: '8PIN', maxPowerWatts: 180, recommendedPsuWatts: 650 });
    // 合并后不再提示，避免反复更新
    expect(staleSpecs(merged, { 'zol-1': latest })).toEqual([]);
  });

  it('规格一致或配件库里没有这款时不动', () => {
    expect(staleSpecs(saved, {})).toEqual([]);
    const same = buildReducer(saved, { type: 'refreshSpecs', slot: 'gpu', specs: { lengthMm: 300 } });
    expect(same).toBe(saved);
  });
});
