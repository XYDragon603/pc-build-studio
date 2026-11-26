// 搜索正确性（V2.2.1 P0-12）：小型合成目录 + 完整穷举作为参考解，验证正式推荐引擎 optimizePlans（与 /plans 接口同一入口）。
// 所有断言都调用正式引擎，不另写演示函数；穷举参考只用于比对。
import test from 'node:test';
import assert from 'node:assert/strict';
import { optimizePlans, tradeoffNotes } from '../src/optimizer.mjs';
import { evaluateBuild, FAIL, powerEstimate } from '../src/compat-rules.mjs';
import { corePerformance } from '../src/recommendation-strategy.mjs';
import { coolerSizeClass, coolingClassFor, stockCooler, sustainedPower } from '../src/hardware-specs.mjs';
import { MIN_REQUIREMENTS, SCORING_PROFILES } from '../src/scoring-profiles.mjs';
import { applyPriceMode, normalizeRecord } from '../src/prices.mjs';

let seq = 0;
const item = (category, yuan, name, specs, extra = {}) => ({
  id: `${category.toLowerCase()}-${++seq}`, category, name, specs, estimatedPriceCents: yuan * 100, referencePriceCents: yuan * 100,
  estimateBasis: 'reference', priceConfidence: 'high', market: 'cn', dataSource: 'zol', priceObservedAt: '2026-11-25T00:00:00Z', ...extra,
});
const perf = (gaming, blender) => ({ performance: { gaming: { index: gaming }, blender: { score: blender } } });
const cpu = (yuan, name, socket, memoryType, gaming, blender, watts, extra = {}) =>
  item('CPU', yuan, name, { socket, memoryType, maxPowerWatts: watts, tdpWatts: Math.round(watts / 1.35), packaging: '盒装', ...extra }, perf(gaming, blender));
const gpu = (yuan, name, chipset, gb, gaming, blender, watts, pins, len = 300, extra = {}) =>
  item('GPU', yuan, name, { chipset, capacityGB: gb, lengthMm: len, heightMm: 125, thicknessMm: 60, slotWidth: 3, boardPowerWatts: watts, powerPins: pins, recommendedPsuWatts: watts >= 400 ? 1000 : watts >= 250 ? 750 : 550, ...extra }, perf(gaming, blender));
const board = (yuan, name, socket, chipset, memoryType, formFactor) => item('MOTHERBOARD', yuan, name, { socket, chipset, memoryType, formFactor, memorySlots: 4, maxMemoryGB: 192, m2Slots: 2, pcieGen: 4, videoOutputs: true, vrmPhases: 12 });
const ram = (yuan, memoryType, gb, speed) => item('RAM', yuan, `${memoryType} ${gb}GB ${speed}`, { memoryType, capacityGB: gb, modules: 2, speedMTs: speed });
const ssd = (yuan, gb) => item('SSD', yuan, `NVMe ${gb}GB`, { capacityGB: gb, interface: 'M.2 PCIe 4.0 x4', nand: 'TLC', dram: 'dram', tbw: gb * 0.6 });
const psu = (yuan, watts, pin16, pcie8) => item('PSU', yuan, `PSU ${watts}W`, { ratedWatts: watts, efficiency: '金牌', atxVersion: '3.1', rail12vAmps: Math.round(watts / 12), pcie8Count: pcie8, pin16Count: pin16, native16Pin: pin16 > 0, protections: ['OVP', 'OPP', 'SCP', 'UVP', 'OCP', 'OTP'], warrantyYears: 10, psuFormFactor: 'ATX', psuLengthMm: 150 });
const cooler = (yuan, name, specs) => item('COOLER', yuan, name, { sockets: ['AM4', 'AM5', 'LGA1700', 'LGA1851'], ...specs });
const pcCase = (yuan, name, specs) => item('CASE', yuan, name, { supportedPsuFormats: ['ATX'], intakePositions: ['front'], exhaustPositions: ['rear'], ...specs });

function makeCatalog() {
  seq = 0;
  return [
    cpu(700, 'AMD Ryzen 5 5600', 'AM4', 'DDR4', 45, 140, 88, { stockCoolerIncluded: true }),
    cpu(1300, 'AMD Ryzen 5 7600', 'AM5', 'DDR5', 70, 230, 88, { stockCoolerIncluded: true }),
    cpu(3200, 'AMD Ryzen 7 9800X3D', 'AM5', 'DDR5', 100, 380, 162),
    cpu(1700, 'Intel Core Ultra 7 265K', 'LGA1851', 'DDR5', 80, 420, 250),
    gpu(2200, 'RTX 4060 测试卡', 'GeForce RTX 4060', 8, 40, 2500, 115, { pin8: 1, pin16: 0 }),
    gpu(3500, 'RTX 5060 Ti 16G 测试卡', 'GeForce RTX 5060 Ti', 16, 52, 3600, 180, { pin8: 1, pin16: 0 }),
    gpu(6500, 'RTX 5070 Ti 测试卡', 'GeForce RTX 5070 Ti', 16, 78, 6500, 300, { pin8: 0, pin16: 1 }),
    gpu(14000, 'RTX 4090 D 测试卡', 'GeForce RTX 4090 D', 24, 100, 9000, 425, { pin8: 0, pin16: 1 }),
    gpu(18000, 'RTX 5090 D 测试卡', 'GeForce RTX 5090 D', 32, 120, 12000, 575, { pin8: 0, pin16: 1 }, 335),
    // 高分但不兼容：需要 4 个 8pin，目录里没有电源能提供（gpuPower 一律 FAIL）
    gpu(5000, 'RTX 5080 四 8pin 测试卡', 'GeForce RTX 5080', 16, 150, 20000, 360, { pin8: 4, pin16: 0 }),
    // 非原厂改装：4090 48GB（官方 24GB）
    gpu(9000, 'NVIDIA GeForce RTX 4090 48GB涡轮', 'GeForce RTX 4090', 48, 100, 9000, 450, { pin8: 0, pin16: 1 }),
    // 缺性能数据
    gpu(2600, 'RTX 5070 无性能数据', 'GeForce RTX 5070', 12, null, null, 250, { pin8: 0, pin16: 1 }),
    board(600, 'B550 ATX', 'AM4', 'B550', 'DDR4', 'ATX'),
    board(900, 'B650M mATX', 'AM5', 'B650', 'DDR5', 'MICRO ATX'),
    board(1100, 'B860 ATX', 'LGA1851', 'B860', 'DDR5', 'ATX'),
    ram(500, 'DDR4', 32, 3200), ram(900, 'DDR4', 64, 3200), ram(700, 'DDR5', 32, 6000), ram(1300, 'DDR5', 64, 6000),
    ssd(200, 512), ssd(400, 1000), ssd(700, 2000), ssd(1500, 4000),
    psu(350, 550, 0, 2), psu(600, 750, 1, 3), psu(1100, 1000, 1, 3), psu(1500, 1300, 1, 3),
    cooler(60, '单塔 125mm', { heightMm: 125 }), cooler(120, '单塔 155mm', { heightMm: 155 }), cooler(250, '双塔 160mm', { heightMm: 160 }), cooler(500, '360 水冷', { radiatorSizeMm: 360, heightMm: 55 }),
    pcCase(200, 'mATX 机箱', { supportedBoardFormats: ['MICRO ATX', 'MINI-ITX'], maxBoardFormFactor: 'MICRO ATX', maxGpuLengthMm: 330, maxCoolerHeightMm: 160, maxRadiatorMm: 240, expansionSlots: 5 }),
    pcCase(350, 'ATX 机箱', { supportedBoardFormats: ['ATX', 'MICRO ATX', 'MINI-ITX'], maxBoardFormFactor: 'ATX', maxGpuLengthMm: 400, maxCoolerHeightMm: 170, maxRadiatorMm: 360, expansionSlots: 7 }),
  ].map(i => (i.category === 'GPU' && i.performance?.gaming?.index == null ? { ...i, performance: undefined } : i));
}

const price = i => i?.estimatedPriceCents ?? 0;
const by = (items, cat) => items.filter(i => i.category === cat);

/**
 * 完整穷举参考：8 个槽位全部组合，约束与正式引擎一致——兼容性无 FAIL、电源 ≥ 选型下限、散热尺寸档 ≥ 负载、
 * 商品状态为全新、显卡有性能数据、不超过本档目标；满足用途最低要求的组合优先（与引擎的软约束一致）。
 * 返回核心性能（corePerformance）最高的值。
 */
function exhaustiveBestCore(items, { scenario, target, allowModified = false }) {
  const profile = SCORING_PROFILES[scenario];
  const req = MIN_REQUIREMENTS[scenario];
  const ok = i => allowModified || !/48GB涡轮/.test(i.name);
  let bestMeeting = -Infinity; let bestAny = -Infinity;
  for (const c of by(items, 'CPU')) for (const g of by(items, 'GPU').filter(ok)) {
    if (!g.performance) continue;
    if (scenario === 'ai' && !/RTX\s*[345]\d{3}/.test(g.specs.chipset)) continue;
    for (const b of by(items, 'MOTHERBOARD').filter(b => b.specs.socket === c.specs.socket)) {
      const base = price(c) + price(g) + price(b);
      if (base > target) continue;
      const p = powerEstimate(c.specs, g.specs, {});
      const watts = sustainedPower(c.specs, b.specs, {});
      const coolers = [...(stockCooler(c) && watts <= 95 ? ['STOCK'] : []), ...by(items, 'COOLER').filter(x => coolerSizeClass(x.specs) >= coolingClassFor(watts))];
      for (const r of by(items, 'RAM').filter(r => r.specs.memoryType === b.specs.memoryType)) for (const s of by(items, 'SSD'))
        for (const u of by(items, 'PSU').filter(u => u.specs.ratedWatts >= p.selectionMinimum)) for (const k of coolers) for (const pc of by(items, 'CASE')) {
          const total = base + price(r) + price(s) + price(u) + price(pc) + (k === 'STOCK' ? 0 : price(k));
          if (total > target) continue;
          const parts = { CPU: c, GPU: g, MOTHERBOARD: b, RAM: r, SSD: s, PSU: u, CASE: pc, COOLER: k === 'STOCK' ? null : k };
          const checks = evaluateBuild(Object.fromEntries(Object.entries(parts).map(([key, v]) => [key, v ? { name: v.name, specs: v.specs } : null])), { stockCooler: k === 'STOCK' });
          if (checks.some(x => x.status === FAIL)) continue;
          const core = corePerformance({ cpu: c, gpu: g }, profile).value;
          const meets = (!req.vramGB || g.specs.capacityGB >= req.vramGB) && (!req.ramGB || r.specs.capacityGB >= req.ramGB(target)) && (!req.ssdGB || s.specs.capacityGB >= req.ssdGB * 0.93);
          if (meets) bestMeeting = Math.max(bestMeeting, core);
          bestAny = Math.max(bestAny, core);
        }
    }
  }
  return Number.isFinite(bestMeeting) ? bestMeeting : bestAny;
}

const run = (items, budget, extra = {}) => optimizePlans(items, { budgetCents: budget * 100, scenarios: ['ai'], tierRatios: { save: 0.8, balanced: 1, plus: 1.2 }, ...extra });
const pick = (plan, slot) => plan.picks.find(p => p.slot === slot)?.item;
const close = (a, b) => Math.abs(a - b) < 1e-9;

test('01 性能优先不会遗漏预算与安全条件内的高性能组合（与完整穷举一致）', () => {
  const items = makeCatalog();
  for (const budget of [8000, 12000, 16000, 20000, 25000, 30000]) {
    const { plans } = run(items, budget, { strategy: 'performance' });
    for (const p of plans.filter(p => !p.infeasible && p.totalCents <= p.targetCents)) {
      const ref = exhaustiveBestCore(items, { scenario: 'ai', target: p.targetCents });
      assert.ok(close(p.corePerformance.value, ref), `¥${budget} ${p.id}: 引擎核心 ${p.corePerformance.value.toFixed(4)} ≠ 穷举 ${ref.toFixed(4)}`);
    }
  }
});

test('02 不过早固定 SSD 与散热器：预算高时选更大容量硬盘，散热器随 CPU 热负载变化', () => {
  const items = makeCatalog();
  const low = run(items, 8000).plans.find(p => p.id === 'save');
  const high = run(items, 30000).plans.find(p => p.id === 'balanced');
  assert.ok(pick(high, 'SSD').specs.capacityGB >= 2000, `3 万元 AI 推荐版硬盘 ${pick(high, 'SSD').specs.capacityGB}GB`);
  assert.ok(pick(high, 'SSD').specs.capacityGB > pick(low, 'SSD').specs.capacityGB);
  const { meta } = run(items, 30000);
  assert.ok(meta.stats.candidates.ssd >= 4, 'SSD 候选在搜索空间中保留 4 种容量');
  // 热负载：250W 的 265K 需要 ≥ 大塔 / 水冷；88W 的 7600 盒装可用原装
  const lockedHot = run(items, 12000, { locked: { CPU: { name: 'Intel Core Ultra 7 265K', priceCents: 170000, specs: by(items, 'CPU')[3].specs } } }).plans.find(p => p.id === 'balanced');
  const hotCooler = pick(lockedHot, 'COOLER');
  assert.ok(hotCooler && coolerSizeClass(hotCooler.specs) >= coolingClassFor(250), `265K 配 ${hotCooler?.name}`);
  const cool = run(items, 8000, { locked: { CPU: { name: 'AMD Ryzen 5 7600', priceCents: 130000, specs: by(items, 'CPU')[1].specs } } }).plans.find(p => p.id === 'save');
  assert.equal(cool.stockCooler, true, '盒装附散热器且 88W：使用原装散热器');
});

test('03 提高预算时，性能优先模式的最优可行核心性能不降低', () => {
  const items = makeCatalog();
  let prev = -Infinity;
  for (const budget of [8000, 10000, 12000, 15000, 18000, 21000, 25000, 30000]) {
    const p = run(items, budget, { strategy: 'performance' }).plans.find(p => p.id === 'balanced');
    if (p.infeasible) continue;
    assert.ok(p.corePerformance.value >= prev - 1e-9, `¥${budget} 核心性能 ${p.corePerformance.value} < 上一预算 ${prev}`);
    prev = p.corePerformance.value;
  }
});

test('04 锁定配件后重新执行全部兼容检查：锁定显卡配足电源，锁定不兼容组合三档无解', () => {
  const items = makeCatalog();
  const g = by(items, 'GPU').find(i => i.name.startsWith('RTX 4090 D'));
  const { plans } = run(items, 22000, { locked: { GPU: { name: g.name, priceCents: price(g), specs: g.specs } } });
  for (const p of plans.filter(p => !p.infeasible)) {
    assert.equal(p.picks.find(x => x.slot === 'GPU'), undefined, '锁定件不重复出现在 picks');
    assert.ok(pick(p, 'PSU').specs.ratedWatts >= 1000, `锁定 4090 D 配 ${pick(p, 'PSU').specs.ratedWatts}W`);
    assert.notEqual(p.compatibility.checks.find(c => c.id === 'gpuPower')?.status, FAIL);
  }
  const am5 = by(items, 'MOTHERBOARD').find(b => b.specs.socket === 'AM5');
  const intel = by(items, 'CPU').find(c => c.specs.socket === 'LGA1851');
  const conflict = run(items, 20000, { locked: { CPU: { name: intel.name, priceCents: price(intel), specs: intel.specs }, MOTHERBOARD: { name: am5.name, priceCents: price(am5), specs: am5.specs } } });
  for (const p of conflict.plans) { assert.equal(p.infeasible, true); assert.match(p.reasons.join(' '), /插槽|不兼容/); }
});

test('05 修改价格后重新搜索（走价格记录与 applyPriceMode，与 /plans 相同路径）', () => {
  const items = makeCatalog();
  const before = run(items, 20000).plans.find(p => p.id === 'balanced');
  const g5090 = by(items, 'GPU').find(i => i.name.startsWith('RTX 5090 D'));
  assert.notEqual(pick(before, 'GPU').id, g5090.id);
  const records = [normalizeRecord({ componentId: g5090.id, priceCents: 900000, sourceName: '合成测试价' })];
  const after = run(applyPriceMode(items, records, { mode: 'manual' }), 20000).plans.find(p => p.id === 'balanced');
  assert.equal(pick(after, 'GPU').id, g5090.id, '5090 D 降价后进入推荐');
  assert.equal(pick(after, 'GPU').estimatedPriceCents, 900000);
});

test('06 三种策略进入不同目标函数：性能优先核心最高，性价比总价最低', () => {
  const items = makeCatalog();
  const r = Object.fromEntries(['value', 'balanced', 'performance'].map(s => [s, run(items, 20000, { strategy: s }).plans.find(p => p.id === 'balanced')]));
  assert.ok(r.performance.corePerformance.value >= r.balanced.corePerformance.value - 1e-9);
  assert.ok(r.balanced.corePerformance.value >= r.value.corePerformance.value - 1e-9);
  assert.ok(r.value.totalCents <= r.balanced.totalCents);
  assert.ok(close(r.performance.corePerformance.value, exhaustiveBestCore(items, { scenario: 'ai', target: r.performance.targetCents })));
  assert.equal(new Set(Object.values(r).map(p => p.totalCents)).size > 1, true, '同一快照下三种策略至少有两种结果不同');
  for (const [s, p] of Object.entries(r)) assert.equal(p.strategy, s);
});

test('07 缺失性能数据不被伪装成真实性能下降：无数据显卡不入选，淘汰原因如实记录', () => {
  const items = makeCatalog();
  const { plans, meta } = run(items, 12000);
  const missing = by(items, 'GPU').find(i => i.name === 'RTX 5070 无性能数据');
  for (const p of plans.filter(p => !p.infeasible)) { assert.notEqual(pick(p, 'GPU')?.id, missing.id); assert.ok(p.corePerformance.metric != null); }
  assert.equal(meta.candidateLog.find(c => c.id === missing.id).exclusion.reason, 'missing-performance-or-workload-support');
});

test('08 不兼容的高分方案不会入选（四 8pin 显卡没有电源能供电）', () => {
  const items = makeCatalog();
  const bad = by(items, 'GPU').find(i => i.name.includes('四 8pin'));
  for (const strategy of ['value', 'balanced', 'performance']) for (const budget of [10000, 20000, 30000])
    for (const p of run(items, budget, { strategy }).plans) assert.notEqual(pick(p, 'GPU')?.id, bad.id);
});

test('09 必要风扇与转接件成本计入总价', () => {
  const items = makeCatalog().map(i => (i.category === 'CASE' ? { ...i, specs: { ...i.specs, requiredFanCostCents: 6000 } } : i));
  for (const p of run(items, 15000).plans.filter(p => !p.infeasible)) {
    const sum = p.picks.reduce((s, x) => s + price(x.item), 0);
    assert.equal(p.totalCents, sum + 6000);
    assert.deepEqual(p.additionalCosts.map(c => c.id), ['case-fans']);
  }
});

test('10 商品状态过滤：改装 48GB 显卡默认不参与，明确允许后才进入候选', () => {
  const items = makeCatalog();
  const modded = by(items, 'GPU').find(i => i.name.includes('48GB涡轮'));
  const def = run(items, 30000);
  for (const p of def.plans) assert.notEqual(pick(p, 'GPU')?.id, modded.id);
  assert.ok(def.meta.productStatusFilter.excluded.some(x => x.id === modded.id && x.status === 'modified'));
  const allowed = run(items, 30000, { allowModified: true });
  assert.ok(allowed.meta.candidateLog.some(c => c.id === modded.id), '允许改装后进入候选记录');
  assert.ok(!allowed.meta.productStatusFilter.excluded.some(x => x.id === modded.id));
});

test('11 升级说明与实际配置一致：每个下降的指标都写明原值、新值与原因', () => {
  const items = makeCatalog();
  for (const budget of [8000, 12000, 20000, 30000]) for (const strategy of ['value', 'balanced', 'performance']) {
    const ps = run(items, budget, { strategy }).plans.filter(p => !p.infeasible);
    for (let n = 1; n < ps.length; n++) {
      const a = ps[n - 1]; const b = ps[n];
      if (b.sameAs) continue;
      const cap = (p, slot) => pick(p, slot)?.specs.capacityGB ?? 0;
      const text = b.notes.join('\n');
      assert.doesNotMatch(text, /保留显卡核心指标与内存容量/, '不再使用固定模板');
      for (const [label, slot] of [['内存容量', 'RAM'], ['硬盘容量', 'SSD'], ['显卡显存', 'GPU']]) {
        if (cap(b, slot) < cap(a, slot)) assert.match(text, new RegExp(`${label}比${a.label}低`), `¥${budget} ${strategy} ${b.id} ${label}下降未说明`);
      }
      if (['RAM', 'SSD', 'GPU'].some(s => cap(b, s) < cap(a, s))) assert.doesNotMatch(text, /核心指标没有下降/);
    }
  }
  // 直接校验说明生成函数：64GB → 32GB 必须写出数值
  const mk = (gb, total) => ({ gpu: { specs: { capacityGB: 16 } }, core: { metric: 100, cpu: 50 }, ram: { specs: { capacityGB: gb } }, ssd: { specs: { capacityGB: 1000 } }, total, score: { total: 50 } });
  const t = tradeoffNotes(mk(64, 800000), mk(32, 820000), '省钱版', { minRamGB: 32 });
  assert.match(t.notes.join(''), /内存容量比省钱版低：64GB → 32GB/); assert.match(t.notes.join(''), /仍满足最低要求 32GB/);
});

test('12 不同预算、用途、策略的结果互不串用（无跨请求缓存）', () => {
  const items = makeCatalog();
  const strip = r => JSON.stringify(r.plans);
  const a1 = run(items, 12000);
  const b = optimizePlans(items, { budgetCents: 3000000, scenarios: ['4k'], strategy: 'performance' });
  const c = run(items, 30000);
  const a2 = run(items, 12000);
  assert.equal(strip(a1), strip(a2));
  assert.notEqual(strip(a1), strip(c));
  assert.notEqual(strip(a1), strip(b));
});
