import test from 'node:test';
import assert from 'node:assert/strict';
import { monitorTarget, recommendPeripherals } from '../src/peripherals.mjs';

const monitor = (id, sizeInch, widthPx, heightPx, refreshHz, yuan, extra = {}) => ({
  id, category: 'MONITOR', market: 'cn', estimatedPriceCents: yuan * 100, estimateBasis: 'reference', imageUrl: 'x',
  specs: { sizeInch, widthPx, heightPx, refreshHz, ...extra.specs }, ...extra,
});
const items = [
  monitor('m24', 23.8, 1920, 1080, 100, 599), monitor('m24-cheap', 24, 1920, 1080, 75, 449), monitor('m24-fast', 24.5, 1920, 1080, 180, 799),
  monitor('m27-1080', 27, 1920, 1080, 165, 899), monitor('m27-2k', 27, 2560, 1440, 180, 1099), monitor('m27-2k-b', 27, 2560, 1440, 165, 1399),
  monitor('m27-2k-60', 27, 2560, 1440, 60, 999), monitor('m34', 34, 3440, 1440, 165, 2199, { specs: { curved: true } }),
  monitor('m27-2k-stale', 27, 2560, 1440, 170, 399, { possiblyStale: true }),
  ...['k1', 'k2', 'k3'].map((id, i) => ({ id, category: 'KEYBOARD', market: 'cn', estimatedPriceCents: (199 + i * 100) * 100, estimateBasis: 'reference', specs: { mechanical: true, wireless: i === 2 } })),
  ...['w1', 'w2', 'w3'].map((id, i) => ({ id, category: 'KEYBOARD', market: 'cn', estimatedPriceCents: (99 + i * 50) * 100, estimateBasis: 'reference', specs: { mechanical: false, wireless: true } })),
  { id: 'numpad', category: 'KEYBOARD', market: 'cn', estimatedPriceCents: 5900, estimateBasis: 'reference', specs: { mechanical: false, wireless: true, keys: 18 } },
  ...['g1', 'g2', 'g3'].map((id, i) => ({ id, category: 'MOUSE', market: 'cn', estimatedPriceCents: (99 + i * 100) * 100, estimateBasis: 'reference', specs: { dpi: 26000, wireless: i > 0 } })),
  ...['o1', 'o2', 'o3'].map((id, i) => ({ id, category: 'MOUSE', market: 'cn', estimatedPriceCents: (49 + i * 30) * 100, estimateBasis: 'reference', specs: { dpi: 1600, wireless: true } })),
];
const pick = (r, slot) => r.picks.find(p => p.slot === slot)?.item;

test('显示器跟着显卡走：强显卡 2K 高刷，弱显卡 1080p 高刷，核显 / 办公 24 寸 1080p', () => {
  assert.equal(monitorTarget({ office: false, tier: 'balanced', gpuIndex: 50 }).height, 1440);
  assert.equal(monitorTarget({ office: false, tier: 'balanced', gpuIndex: 21 }).height, 1080);
  assert.deepEqual(monitorTarget({ office: false, tier: 'plus', igpu: true }).size, [23.5, 24.5]);
  // 办公方案都是核显，进阶版仍配 27 寸 2K
  assert.equal(monitorTarget({ office: true, tier: 'plus', igpu: true }).height, 1440);
  const strong = pick(recommendPeripherals(items, { scenarios: ['2k'], gpuIndex: 50 }), 'MONITOR');
  assert.ok(['m27-2k', 'm27-2k-b'].includes(strong.id), strong.id);
  const weak = pick(recommendPeripherals(items, { scenarios: ['2k'], gpuIndex: 21 }), 'MONITOR');
  assert.ok(['m24-fast', 'm27-1080'].includes(weak.id), weak.id);
  const office = pick(recommendPeripherals(items, { scenarios: ['office'], igpu: true }), 'MONITOR');
  assert.ok(['m24', 'm24-cheap'].includes(office.id), office.id);
});

test('不选疑似旧价、60Hz 的 2K 屏（游戏）、带鱼屏；档位越高越贵', () => {
  for (const tier of ['save', 'balanced', 'plus']) {
    const m = pick(recommendPeripherals(items, { scenarios: ['2k'], gpuIndex: 60, tier }), 'MONITOR');
    assert.ok(!['m27-2k-stale', 'm27-2k-60', 'm34'].includes(m.id), m.id);
  }
  const price = tier => recommendPeripherals(items, { scenarios: ['2k'], gpuIndex: 60, tier }).totalCents;
  assert.ok(price('save') <= price('balanced') && price('balanced') <= price('plus'));
});

test('键鼠：游戏要机械键盘和高 DPI 鼠标，办公要无线；可以只要其中几样', () => {
  const game = recommendPeripherals(items, { scenarios: ['2k'], gpuIndex: 50 });
  assert.equal(pick(game, 'KEYBOARD').specs.mechanical, true);
  assert.ok(pick(game, 'MOUSE').specs.dpi >= 8000);
  const office = recommendPeripherals(items, { scenarios: ['office'], slots: ['KEYBOARD', 'MOUSE'] });
  assert.deepEqual(office.picks.map(p => p.slot), ['KEYBOARD', 'MOUSE']);
  assert.ok(office.picks.every(p => p.item.specs.wireless));
  // 办公不配机械键盘、游戏鼠标
  assert.equal(pick(office, 'KEYBOARD').specs.mechanical, false);
  // 数字小键盘（18 键）不算键盘
  for (const tier of ['save', 'balanced', 'plus']) assert.notEqual(pick(recommendPeripherals(items, { scenarios: ['office'], tier }), 'KEYBOARD').id, 'numpad');
  assert.ok(pick(office, 'MOUSE').specs.dpi < 8000);
  assert.equal(office.totalCents, office.picks.reduce((s, p) => s + p.item.estimatedPriceCents, 0));
});

test('按用途挑显示器：AI / 剪辑 27 寸 2K，4K 游戏要强显卡，电竞 1080p ≥165Hz', () => {
  assert.deepEqual([monitorTarget({ work: true, tier: 'balanced' }).height, monitorTarget({ work: true, tier: 'balanced' }).minHz], [1440, 60]);
  assert.equal(monitorTarget({ work: true, tier: 'save' }).height, 1080);
  assert.equal(monitorTarget({ uhd: true, tier: 'balanced', gpuIndex: 81 }).height, 2160);
  // 显卡不够强的 4K 方案退回 2K
  assert.equal(monitorTarget({ uhd: true, tier: 'balanced', gpuIndex: 45 }).height, 1440);
  assert.deepEqual([monitorTarget({ esports: true, tier: 'balanced', gpuIndex: 50 }).height, monitorTarget({ esports: true, tier: 'balanced', gpuIndex: 50 }).minHz], [1080, 165]);
  const ai = recommendPeripherals(items, { scenarios: ['ai'], gpuIndex: 50 });
  assert.ok(['m27-2k', 'm27-2k-b', 'm27-2k-60'].includes(pick(ai, 'MONITOR').id));
  assert.ok(pick(ai, 'MOUSE').specs.dpi < 8000);
});
