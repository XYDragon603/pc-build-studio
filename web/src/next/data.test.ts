import { describe, expect, it } from 'vitest';
import type { CatalogItem } from '../api/client';
import { buildReducer } from '../domain/build';
import { candidateById, demoBuild } from '../domain/demoData';
import { priceChanges } from './data';

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
