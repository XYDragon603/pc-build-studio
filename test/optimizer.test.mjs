import test from 'node:test';
import assert from 'node:assert/strict';
import { enumerateBuilds, optimizePlans, psuQuality } from '../src/optimizer.mjs';
import { TIER_RATIOS } from '../src/recommend.mjs';

// 合成目录：规格与价格都是测试数据，只用来检验算法性质，不代表真实行情
let n = 0;
const item = (category, yuan, name, specs, extra = {}) => ({
  id: `t-${++n}`, category, name, estimatedPriceCents: yuan * 100, estimateBasis: 'reference', priceConfidence: 'high', market: 'cn', imageUrl: 'x', specs, ...extra,
});
const cpu = (yuan, name, socket, gaming, blender, maxPowerWatts, extra = {}) =>
  item('CPU', yuan, name, { socket, maxPowerWatts, ...extra }, { performance: { gaming: { index: gaming }, blender: { score: blender } } });
const gpu = (yuan, chip, gb, gaming, blender, watts, pins, len = 280) =>
  item('GPU', yuan, `${chip} ${gb}G`, { chipset: chip, capacityGB: gb, lengthMm: len, tdpWatts: watts, recommendedPsuWatts: watts > 300 ? 850 : watts > 200 ? 650 : 550, powerPins: pins },
    { performance: { gaming: { index: gaming }, blender: { score: blender } } });
const p8 = k => ({ pin6: 0, pin8: k, pin16: 0 });
const p16 = { pin6: 0, pin8: 0, pin16: 1 };

const catalog = [
  cpu(900, 'AMD Ryzen 5 5600GT', 'AM4', 50, 150, 88, { integratedGraphics: 'Radeon Graphics' }),
  cpu(1100, 'AMD Ryzen 5 5500X3D', 'AM4', 62, 140, 88),
  cpu(1300, 'AMD Ryzen 5 7500F', 'AM5', 68, 190, 88),
  cpu(1600, 'AMD Ryzen 5 8600G', 'AM5', 60, 200, 88, { integratedGraphics: 'Radeon 760M' }),
  cpu(2300, 'AMD Ryzen 7 7700X3D', 'AM5', 82, 230, 162),
  cpu(3300, 'AMD Ryzen 7 9850X3D', 'AM5', 100, 300, 162),
  cpu(4200, 'AMD Ryzen 9 9950X', 'AM5', 77, 600, 230),
  cpu(1500, 'Intel 酷睿 i5 13400F', 'LGA1700', 58, 210, 148),
  cpu(2600, 'Intel 酷睿 i7 14700KF', 'LGA1700', 79, 420, 253),
  ...[
    [1300, 'GeForce RTX 3050', 8, 21, 900, 130, p8(1)], [1500, 'GeForce RTX 3050', 8, 21, 900, 130, p8(1)],
    [2300, 'GeForce RTX 5060', 8, 44, 2500, 145, p8(1)], [2400, 'GeForce RTX 5060', 8, 44, 2500, 145, p8(1)],
    [2800, 'GeForce RTX 3060', 12, 30, 1800, 170, p8(1)], [2900, 'GeForce RTX 3060', 12, 30, 1800, 170, p8(1)],
    [3600, 'GeForce RTX 5060 Ti', 16, 50, 3200, 180, p8(1)], [3700, 'GeForce RTX 5060 Ti', 16, 50, 3200, 180, p8(1)],
    [4300, 'Radeon RX 9070 GRE', 12, 64, 1500, 220, p8(2)], [4400, 'Radeon RX 9070 GRE', 12, 64, 1500, 220, p8(2)],
    [5000, 'Radeon RX 9070 XT', 16, 81, 1900, 304, p8(2)], [5100, 'Radeon RX 9070 XT', 16, 81, 1900, 304, p8(2)],
    [7000, 'GeForce RTX 5070 Ti', 16, 86, 6500, 300, p16], [7100, 'GeForce RTX 5070 Ti', 16, 86, 6500, 300, p16],
    [10000, 'GeForce RTX 5080', 16, 96, 8000, 360, p16], [10500, 'GeForce RTX 5080', 16, 96, 8000, 360, p16],
    [15000, 'GeForce RTX 4090', 24, 110, 11000, 450, p16], [15500, 'GeForce RTX 4090', 24, 110, 11000, 450, p16],
  ].map(a => gpu(...a)),
  item('MOTHERBOARD', 450, 'A520M', { socket: 'AM4', chipset: 'A520', memoryType: 'DDR4', formFactor: 'Micro ATX', memorySlots: 2, m2Slots: 1, pcieGen: 3, videoOutputs: true, vrmPhases: 6 }),
  item('MOTHERBOARD', 650, 'B550M', { socket: 'AM4', chipset: 'B550', memoryType: 'DDR4', formFactor: 'Micro ATX', memorySlots: 4, m2Slots: 2, pcieGen: 4, videoOutputs: true, vrmPhases: 10 }),
  item('MOTHERBOARD', 800, 'B650M', { socket: 'AM5', chipset: 'B650', memoryType: 'DDR5', formFactor: 'Micro ATX', memorySlots: 4, m2Slots: 2, pcieGen: 4, videoOutputs: true, vrmPhases: 12 }),
  item('MOTHERBOARD', 1100, 'B850M', { socket: 'AM5', chipset: 'B850', memoryType: 'DDR5', formFactor: 'Micro ATX', memorySlots: 4, m2Slots: 3, pcieGen: 5, videoOutputs: true, vrmPhases: 14 }),
  item('MOTHERBOARD', 3000, 'X870E Hero', { socket: 'AM5', chipset: 'X870E', memoryType: 'DDR5', formFactor: 'ATX', memorySlots: 4, m2Slots: 5, pcieGen: 5, videoOutputs: true, vrmPhases: 20 }),
  item('MOTHERBOARD', 900, 'B760M', { socket: 'LGA1700', chipset: 'B760', memoryType: 'DDR5', formFactor: 'Micro ATX', memorySlots: 4, m2Slots: 2, pcieGen: 4, videoOutputs: true, vrmPhases: 12 }),
  ...[['DDR4', 16, 300], ['DDR4', 32, 700], ['DDR4', 64, 1500], ['DDR5', 16, 400], ['DDR5', 32, 900], ['DDR5', 64, 1800]]
    .map(([type, gb, yuan]) => item('RAM', yuan, `${type} ${gb}G`, { memoryType: type, capacityGB: gb, modules: 2, speedMTs: type === 'DDR5' ? 6000 : 3200 })),
  ...[[512, 260], [1000, 420], [2000, 800], [4000, 1800]].map(([gb, yuan]) => item('SSD', yuan, `${gb}G`, { capacityGB: gb, interface: 'M.2 PCIe 4.0', readMBs: 7000, nand: 'TLC', dram: 'hmb' })),
  item('PSU', 160, '杂牌 550W', { ratedWatts: 550, pcie8Count: 1, rail12vSplitAmps: [22, 22] }),
  item('PSU', 300, '铜牌 650W', { ratedWatts: 650, efficiency: '铜牌', pcie8Count: 2, rail12vAmps: 50, atxVersion: '2.4', warrantyYears: 3 }),
  item('PSU', 500, '金牌 750W ATX3.1', { ratedWatts: 750, efficiency: '金牌', pcie8Count: 3, pin16Count: 1, rail12vAmps: 62.5, atxVersion: '3.1', protections: ['OVP', 'OCP', 'OPP', 'SCP', 'OTP', 'UVP'], warrantyYears: 7 }),
  item('PSU', 260, '白牌 850W', { ratedWatts: 850, efficiency: '白牌', pcie8Count: 4 }),
  item('PSU', 900, '金牌 1000W ATX3.1', { ratedWatts: 1000, efficiency: '金牌', pcie8Count: 4, pin16Count: 1, rail12vAmps: 83, atxVersion: '3.1', protections: ['OVP', 'OCP', 'OPP', 'SCP', 'OTP', 'UVP'], warrantyYears: 10 }),
  item('CASE', 200, '机箱 mATX', { maxBoardFormFactor: 'Micro ATX', maxGpuLengthMm: 320, maxCoolerHeightMm: 160, maxRadiatorMm: 240 }),
  item('CASE', 350, '机箱 ATX', { maxBoardFormFactor: 'ATX', maxGpuLengthMm: 400, maxCoolerHeightMm: 170, maxRadiatorMm: 360 }),
  item('COOLER', 90, '单塔 150mm', { heightMm: 150, sockets: ['AM4', 'AM5', 'LGA1700'] }),
  item('COOLER', 180, '双塔 158mm', { heightMm: 158, sockets: ['AM4', 'AM5', 'LGA1700'] }),
  item('COOLER', 400, '360 水冷', { radiatorSizeMm: 360, heightMm: 55, sockets: ['AM4', 'AM5', 'LGA1700'] }),
];
const plans = (yuan, scenarios, extra = {}) => optimizePlans(catalog, { budgetCents: yuan * 100, scenarios, tierRatios: TIER_RATIOS, ...extra });
const pick = (plan, slot) => plan.picks.find(p => p.slot === slot)?.item;

test('同一快照、同一参数结果可重复', () => {
  const a = JSON.stringify(plans(8000, ['2k']).plans.map(p => [p.totalCents, p.picks.map(x => x.item.id)]));
  const b = JSON.stringify(plans(8000, ['2k']).plans.map(p => [p.totalCents, p.picks.map(x => x.item.id)]));
  assert.equal(a, b);
});

test('总价等于配件单价之和；推荐结果没有确认不兼容的组合', () => {
  for (const sc of ['2k', '4k', '1080p', 'ai', 'creator', 'office']) for (const yuan of [4000, 8000, 15000, 30000]) {
    for (const p of plans(yuan, [sc]).plans.filter(p => !p.infeasible)) {
      // 2.2.2：完整总价 = 配件单价之和 + 必需附件（机箱风扇等）
      assert.equal(p.totalCents, p.picks.reduce((s, x) => s + x.item.estimatedPriceCents, 0) + p.additionalCosts.reduce((s, x) => s + x.priceCents, 0), `${sc} ${yuan} ${p.id}`);
      assert.equal(p.costBreakdown.completeBuildCents, p.totalCents);
      assert.ok(!p.compatibility.checks.some(c => c.status === 'FAIL'), `${sc} ${yuan} ${p.id}`);
    }
  }
});

test('档位越高、预算越高，同场景综合评分不下降', () => {
  for (const sc of ['2k', '4k', 'ai', 'creator', 'office']) {
    let last = -Infinity;
    for (const yuan of [5000, 8000, 12000, 20000]) {
      const ps = plans(yuan, [sc]).plans.filter(p => !p.infeasible);
      for (let i = 1; i < ps.length; i++) assert.ok(ps[i].score.total >= ps[i - 1].score.total, `${sc} ${yuan} ${ps[i].id}`);
      const balanced = ps.find(p => p.id === 'balanced');
      if (balanced) { assert.ok(balanced.score.total >= last - 0.5, `${sc} ${yuan}`); last = balanced.score.total; }
    }
  }
});

test('严格预算：可行方案都不超目标；不够时说明最低可行预算', () => {
  for (const yuan of [3000, 5000, 9000]) {
    for (const p of plans(yuan, ['2k'], { maxOverPercent: 0 }).plans) {
      if (p.infeasible) assert.ok(p.reasons.length && p.minFeasibleCents > p.targetCents);
      else assert.ok(p.totalCents <= p.targetCents);
    }
  }
});

test('电源：高负载不配杂牌 / 白牌；16pin 显卡优先原生 16pin', () => {
  const p = plans(15000, ['4k']).plans.find(x => x.id === 'balanced');
  const psu = pick(p, 'PSU');
  assert.ok(psuQuality(psu.specs) >= 0.55, psu.name);
  if (pick(p, 'GPU')?.specs.powerPins?.pin16) assert.ok(psu.specs.pin16Count > 0);
});

test('AI：只用 RTX 30 系及以后，显存优先；办公只用核显、CPU 有核显', () => {
  for (const yuan of [8000, 20000]) for (const p of plans(yuan, ['ai']).plans.filter(p => !p.infeasible)) {
    assert.match(pick(p, 'GPU').specs.chipset, /RTX/);
  }
  const ai = plans(20000, ['ai']).plans.find(p => p.id === 'plus');
  assert.equal(pick(ai, 'GPU').specs.capacityGB, 24);
  for (const p of plans(4000, ['office']).plans.filter(p => !p.infeasible)) {
    assert.ok(p.igpu && !pick(p, 'GPU'));
    assert.ok(p.compatibility.checks.find(c => c.id === 'igpuCpu')?.status === 'PASS');
  }
});

test('游戏不为了堆显卡把 CPU 降到拖后腿', () => {
  for (const yuan of [10000, 15000]) {
    const p = plans(yuan, ['2k']).plans.find(x => x.id === 'balanced');
    const g = pick(p, 'GPU').performance.gaming.index;
    const c = pick(p, 'CPU').performance.gaming.index;
    assert.ok(c >= 40 + 0.4 * g - 12, `${yuan}: GPU ${g} CPU ${c}`);
  }
});

test('锁定配件保持不变；锁定件不兼容时三档都报告无解', () => {
  const lockedCpu = { CPU: { name: 'Intel 酷睿 i7 14700KF', priceCents: 260000, specs: { socket: 'LGA1700', maxPowerWatts: 253 } } };
  for (const p of plans(10000, ['2k'], { locked: lockedCpu }).plans.filter(p => !p.infeasible)) {
    assert.ok(!pick(p, 'CPU'));
    assert.equal(pick(p, 'MOTHERBOARD').specs.socket, 'LGA1700');
  }
  const bad = { MOTHERBOARD: { name: 'B650M', priceCents: 80000, specs: { socket: 'AM5', memoryType: 'DDR5', formFactor: 'MICRO ATX' } },
    RAM: { name: 'DDR4', priceCents: 30000, specs: { memoryType: 'DDR4', capacityGB: 32, modules: 2 } } };
  const r = plans(10000, ['2k'], { locked: bad }).plans;
  assert.ok(r.every(p => p.infeasible));
  assert.match(r[0].reasons.join(''), /锁定的配件之间不兼容/);
});

test('性能：组合搜索有剪枝，三档生成耗时可控', () => {
  const r = plans(20000, ['2k']);
  assert.ok(r.meta.stats.combos > 0 && r.meta.stats.rejectedFail >= 0);
  assert.ok(r.meta.elapsedMs < 1500, `耗时 ${r.meta.elapsedMs}ms`);
  assert.ok(enumerateBuilds(catalog, { scenarios: ['2k'], maxCostCents: 1e9 }).builds.length > 10);
});
