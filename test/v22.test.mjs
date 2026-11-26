import test from 'node:test';
import assert from 'node:assert/strict';
import { correctHardware } from '../src/catalog-corrections.mjs';
import { enrichSpecs } from '../src/specs-enrich.mjs';
import { caseThermalCheck, hardwareDetails, memorySpeedCheck, pcieLink, psuFitCheck, stockCooler } from '../src/hardware-specs.mjs';
import { biosSupport, cpuHasIgpu, evaluateBuild, overallStatus, powerEstimate } from '../src/compat-rules.mjs';
import { optimizePlans } from '../src/optimizer.mjs';
import { corePerformance } from '../src/recommendation-strategy.mjs';
import { SCORING_PROFILES } from '../src/scoring-profiles.mjs';
import { applyPriceMode, normalizeRecord, parseCsv, toCsv } from '../src/prices.mjs';
import { loadScenarioPerformance, matchingBenchmark } from '../src/scenario-performance.mjs';

const corrected = (id, category, specs = {}) => correctHardware({ id, category, specs });
const part = specs => ({ specs });
const check = (parts, id) => evaluateBuild(parts).find(c => c.check_id === id);
const inno = () => corrected('zol-2120074', 'GPU', { tdpWatts: 575 });
test('01 SKU 600W 优先，保留原芯片功耗字段及官方来源', () => {
  const i = inno();
  assert.equal(i.specs.tdpWatts, 575);
  assert.equal(powerEstimate({ maxPowerWatts: 250 }, i.specs).gpuW, 600);
  assert.equal(i.fieldProvenance.find(e => e.field_name === 'boardPowerWatts').verification_status, 'verified');
});
test('02 3.5 槽保留小数，三个空槽无法安装', () => {
  const gpu = inno();
  assert.equal(gpu.specs.slotWidth, 3.5);
  assert.equal(enrichSpecs({ category: 'GPU', specs: {}, rawParams: { 插槽: '3.5槽' } }).slotWidth, 3.5);
  assert.equal(check({ GPU: gpu, CASE: part({ expansionSlots: 3 }) }, 'gpuSlots').status, 'FAIL');
});
test('03 电源物理规格和电气规范分开', () => {
  const i = corrected('zol-2119748', 'PSU', { atxVersion: '3.0' });
  assert.equal(i.specs.atxVersion, '3.1');
  assert.equal(i.specs.psuFormFactor, 'SFX-L');
  assert.equal(i.specs.psuLengthMm, 125);
});
test('04 SFX-L 转 ATX 需要支架、深度和走线证据', () => {
  const psu = corrected('zol-2119748', 'PSU').specs;
  const pc = { supportedPsuFormats: ['ATX'], supportsPsuAtxAdapter: true, maxPsuLengthMm: 210 };
  assert.equal(psuFitCheck(psu, pc).status, 'UNKNOWN');
  assert.equal(psuFitCheck(psu, { ...pc, maxPsuLengthMm: 120 }).status, 'FAIL');
  assert.equal(psuFitCheck(psu, { ...pc, gpuCablePathMm: 460 }).status, 'FAIL');
  assert.equal(psuFitCheck(psu, { ...pc, gpuCablePathMm: 400, boardCablePathMm: 410, cpuCablePathMm: 520 }).status, 'CONDITIONAL');
});
test('05 技嘉官方 208×120×40mm 参与安装检查', () => {
  const gpu = corrected('zol-2130988', 'GPU');
  assert.deepEqual([gpu.specs.lengthMm, gpu.specs.heightMm, gpu.specs.thicknessMm], [208, 120, 40]);
  assert.equal(check({ GPU: gpu, CASE: part({ maxGpuHeightMm: 119 }) }, 'gpuHeight').status, 'FAIL');
});
test('06 Ryzen 2700 的 2933 MT/s 上限不会被 DDR4 默认值覆盖', () => {
  const cpu = corrected('zol-1213501', 'CPU');
  assert.match(memorySpeedCheck(cpu.specs, {}, { speedMTs: 3200 }).detail, /2933/);
  assert.equal(memorySpeedCheck(cpu.specs, {}, { speedMTs: 3200 }).status, 'CONDITIONAL');
});
test('07 270K Plus 7200 上限仍需具体条数、Rank、JEDEC 与 QVL', () => {
  const cpu = corrected('zol-2162063', 'CPU');
  assert.equal(cpu.specs.cpuMemoryMaxMTs, 7200);
  const ram = { speedMTs: 7200, modules: 2, rank: 1, jedecMTs: 7200 };
  assert.equal(memorySpeedCheck(cpu.specs, {}, ram).status, 'UNKNOWN');
  assert.equal(memorySpeedCheck(cpu.specs, { memoryMaxMTs: 7200, memoryQvl: [{ ...ram, sku: 'same' }] }, ram, 'same').status, 'PASS');
});
test('08 散片和未匹配价格料号不能沿用盒装散热', () => {
  const cpu = corrected('zol-1440587', 'CPU', { packaging: '盒装' });
  assert.equal(stockCooler(cpu), false);
  assert.equal(stockCooler({ ...cpu, mpn: '100-100001015BOX' }), true);
  assert.equal(stockCooler({ ...cpu, mpn: '100-100001015BOX', specs: { ...cpu.specs, packaging: '散片' } }), false);
  assert.equal(stockCooler({ ...cpu, mpn: '100-100001015BOX', priceRecord: { condition: 'new', sku: 'store-sku' } }), false);
});

const item = (id, category, cost, specs, performance = {}) =>
  ({ id, name: id, category, specs, performance, estimatedPriceCents: cost, priceConfidence: 'medium' });
const fixtures = [
  item('cpu-a', 'CPU', 45000, { socket: 'AM5', maxPowerWatts: 88 }, { blender: { score: 200 } }),
  item('cpu-b', 'CPU', 65000, { socket: 'AM5', maxPowerWatts: 88 }, { blender: { score: 450 } }),
  item('gpu-a', 'GPU', 65000, { chipset: 'RTX 3060', capacityGB: 12, lengthMm: 200, boardPowerWatts: 150, powerPins: { pin8: 1 } }, { blender: { score: 1200 } }),
  item('gpu-b', 'GPU', 175000, { chipset: 'RTX 3090', capacityGB: 24, lengthMm: 210, boardPowerWatts: 175, powerPins: { pin8: 2 } }, { blender: { score: 6800 } }),
  item('board', 'MOTHERBOARD', 35000, { socket: 'AM5', chipset: 'B650', formFactor: 'MICRO ATX', memoryType: 'DDR5' }),
  item('ram', 'RAM', 45000, { memoryType: 'DDR5', capacityGB: 64, modules: 2, speedMTs: 5600 }),
  item('ssd', 'SSD', 25000, { interface: 'SATA', capacityGB: 1000 }),
  item('psu', 'PSU', 40000, { ratedWatts: 750, psuFormFactor: 'ATX', psuLengthMm: 140, pcie8Count: 2, efficiency: '80 PLUS Gold', atxVersion: '3.1', rail12vAmps: 61 }),
  item('case', 'CASE', 25000, { maxGpuLengthMm: 330, maxCoolerHeightMm: 165, maxPsuLengthMm: 180, supportedBoardFormats: ['MICRO ATX'], supportedPsuFormats: ['ATX'], requiredFanCostCents: 6000 }),
  item('cooler', 'COOLER', 10000, { sockets: ['AM5'], heightMm: 145 }),
];
function run(budgetCents, options = {}, items = fixtures) {
  return optimizePlans(items, { budgetCents, maxOverPercent: 0, scenarios: ['ai'], tierRatios: { balanced: 1 }, strategy: 'performance', ...options }).plans[0];
}
test('09 风扇 6000 分进入预算与额外费用', () => {
  const p = run(600000);
  assert.equal(p.additionalCosts.find(c => c.id === 'case-fans').priceCents, 6000);
  assert.equal(p.totalCents, 6000 + p.picks.reduce((sum, i) => sum + i.item.estimatedPriceCents, 0));
});
test('10 同风道证据下低功耗可条件评估，高功耗需核实', () => {
  const pc = { frontIntake: 'mesh', fanMounts: [{ position: 'rear', sizeMm: 120, count: 1 }] };
  assert.equal(caseThermalCheck({ maxPowerWatts: 88 }, null, pc).status, 'CONDITIONAL');
  assert.equal(caseThermalCheck({ maxPowerWatts: 88 }, { boardPowerWatts: 600 }, pc).critical, true);
});
test('11 缺少链路性能数据不会构成安装冲突', () => {
  const c = check({ GPU: part({}), MOTHERBOARD: part({}) }, 'pcie');
  assert.equal(c.status, 'UNKNOWN');
  assert.equal(c.severity, 'performance');
  assert.equal(c.blocking, false);
  assert.equal(overallStatus([c]), 'CONDITIONAL');
});
test('12 高功率没有已知原装线材额定值时保留关键 UNKNOWN', () => {
  const c = check({ GPU: inno(), PSU: part({ native16Pin: true }) }, 'gpuPower');
  assert.equal(c.status, 'UNKNOWN');
  assert.equal(c.blocking, true);
  assert.equal(overallStatus([c]), 'UNKNOWN');
});
test('13 预算内性能搜索与小型目录的完整穷举相符', () => {
  const cpus = fixtures.filter(i => i.category === 'CPU');
  const gpus = fixtures.filter(i => i.category === 'GPU');
  const fixed = fixtures.filter(i => !['CPU', 'GPU'].includes(i.category));
  for (const budget of [330000, 420000, 600000]) {
    const ranked = [];
    for (const cpu of cpus) for (const gpu of gpus) {
      const parts = Object.fromEntries([...fixed, cpu, gpu].map(i => [i.category, i]));
      const cost = Object.values(parts).reduce((sum, p) => sum + p.estimatedPriceCents, 6000);
      if (cost <= budget && evaluateBuild(parts).every(c => c.status !== 'FAIL')) {
        ranked.push({ cpu, gpu, cost, core: corePerformance({ cpu, gpu }, SCORING_PROFILES.ai).value });
      }
    }
    ranked.sort((a, b) => b.core - a.core || a.cost - b.cost);
    const p = run(budget);
    assert.equal(p.picks.find(i => i.slot === 'GPU').item.id, ranked[0].gpu.id);
    assert.equal(p.picks.find(i => i.slot === 'CPU').item.id, ranked[0].cpu.id);
  }
});
test('14 数据可信度不会改变核心性能指标', () => {
  const [cpu, , gpu] = fixtures;
  const score = i => corePerformance({ cpu, gpu: i }, SCORING_PROFILES.ai);
  assert.deepEqual(score(gpu), score({ ...gpu, priceConfidence: 'high', fieldProvenance: [{}] }));
});
test('15 严格预算的超支方案在单独的替代字段', () => {
  const p = run(100000);
  assert.equal(p.infeasible, true);
  assert.equal(p.formalRecommendation, false);
  assert.ok(p.alternative.totalCents > p.targetCents);
  assert.deepEqual(p.picks, []);
});
test('16 不同价格模式会重新搜索核心配件', () => {
  const records = [{ componentId: 'gpu-b', observedAt: '2026-11-25', priceCents: 80000, shippingCents: 0, condition: 'new', stockStatus: 'in_stock', priceType: 'manual' }];
  const result = mode => run(350000, {}, applyPriceMode(fixtures, records, { mode })).picks.find(i => i.slot === 'GPU').item.id;
  assert.deepEqual([result('estimate'), result('manual')], ['gpu-a', 'gpu-b']);
  const now = new Date('2026-11-25T12:00:00Z');
  const input = { componentId: 'gpu-b', priceCents: 80000, priceType: 'verified', sourceName: '测试商家',
    sourceUrl: 'https://example.com/gpu-b', observedAt: '2026-11-25T10:00:00Z' };
  assert.equal(normalizeRecord(input, now).quotedAt, null);
  const quote = normalizeRecord({ ...input, quotedAt: '2026-11-24T15:00:00Z' }, now);
  assert.equal(quote.recordedAt, now.toISOString());
  assert.equal(parseCsv(toCsv([quote]))[0].quotedAt, '2026-11-24T15:00:00.000Z');
  assert.throws(() => normalizeRecord({ ...input, quotedAt: now.toISOString() }, now), /实际报价时间/);
});
test('17 选件依据和兼容表共享计算需求、策略下限及额定值', () => {
  const plan = run(600000);
  const psu = plan.picks.find(p => p.slot === 'PSU');
  const evidence = plan.compatibility.checks.find(c => c.id === 'psuWatts').evidence;
  assert.match(psu.reason, new RegExp(`计算需求 ${evidence.calculated}W`));
  assert.match(psu.reason, new RegExp(`采购下限 ${evidence.policyFloor}W`));
  assert.equal(evidence.ratedWatts, psu.item.specs.ratedWatts);
});
test('18 预算不足、显存不足可同时存在', () => {
  const p = run(100000, { maxOverPercent: null, workload: { minVramGB: 48 } });
  assert.equal(p.assessment.budget, 'over');
  assert.equal(p.assessment.requirements, 'unmet');
  assert.match(p.notes.join(), /同时超预算/);
  assert.equal(run(100000, { workload: { minVramGB: 48 } }).alternative.assessment.requirements, 'unmet');
});
test('19 ATX 主板与 A21 Micro ATX 冲突', () => {
  const pc = corrected('zol-1948423', 'CASE');
  assert.equal(check({ CASE: pc, MOTHERBOARD: part({ formFactor: 'ATX' }) }, 'boardFit').status, 'FAIL');
  assert.equal(pc.specs.fanMounts.find(x => x.position === 'rear').count, 1);
  assert.equal(pc.specs.includedFans, undefined);
});
test('20 A520 对应型号 GPU 与 M.2 PCIe 3.0 回归', () => {
  const i = corrected('zol-1336495', 'MOTHERBOARD', { chipset: 'A520', pcieGen: 4 });
  assert.equal(i.specs.pcieGen, 3);
  assert.equal(i.specs.gpuPcieLink.gen, 3);
  assert.equal(i.specs.m2Links[0].gen, 3);
});
test('场景基准要求同一个测试组与任务', () => {
  const data = loadScenarioPerformance(null);
  const gpu = { performance: { benchmarks: data.forGpu('RTX 5080') } };
  assert.equal(matchingBenchmark(gpu, { task: 'raster4k', benchmarkId: 'gn-2025-re4-4k-raster' }).value, 122);
  assert.equal(matchingBenchmark(gpu, { task: 'rayTracing', benchmarkId: 'gn-2025-re4-4k-raster' }), null);
  const c = { performance: { benchmarks: data.forGpu('RTX 4060') } };
  const cs2 = { task: 'esports', benchmarkId: 'cb-2024-cs2-1080p-very-high', game: 'CS2', quality: '最高' };
  assert.equal(matchingBenchmark(c, cs2).value, 157.4);
  assert.equal(matchingBenchmark(c, { ...cs2, quality: '低' }), null);
  const llm = { task: 'llm', benchmarkId: 'puget-2025-llamacpp-phi3-generation', model: 'Phi-3 Mini Q4_K_M' };
  assert.equal(matchingBenchmark(gpu, llm).value, 232);
  assert.equal(matchingBenchmark(gpu, { ...llm, model: 'Llama 2 7B Chat' }), null);
  assert.equal(data.forGpu('RTX 4090', 24).find(row => row.task === 'finetuning').value, 1.79);
  assert.equal(data.forGpu('RTX 4090', 48).some(row => row.task === 'finetuning'), false);
});
test('21 Core Ultra 200S Plus 平台规格（7200 MT/s、PCIe 5.0 直连 M.2、无原装散热）', () => {
  const k = enrichSpecs({ category: 'CPU', name: 'Intel Core Ultra 5 250K Plus', specs: { socket: 'LGA1851', packaging: '盒装' } });
  assert.equal(k.cpuMemoryMaxMTs, 7200);
  assert.equal(k.cpuMemoryMaxMTsByType.DDR5, 7200);
  assert.deepEqual(k.pcieLink, { gen: 5, lanes: 16 });
  assert.deepEqual(k.storagePcieLink, { gen: 5, lanes: 4 });
  assert.equal(k.stockCoolerIncluded, false);
  assert.equal(stockCooler({ name: 'Intel Core Ultra 5 250K Plus', mpn: 'BX80768250K', specs: k }), false);
  assert.equal(cpuHasIgpu('Intel Core Ultra 5 250K Plus', k), true);

  const kf = corrected('zol-2179677', 'CPU', enrichSpecs({ category: 'CPU', name: 'Intel 酷睿 Ultra 5 250KF Plus', specs: { socket: 'LGA1851', packaging: '盒装' } }));
  assert.equal(cpuHasIgpu('Intel 酷睿 Ultra 5 250KF Plus', kf.specs), false);
  assert.equal(kf.specs.cpuMemoryMaxMTs, 7200);
  assert.deepEqual(kf.specs.storagePcieLink, { gen: 5, lanes: 4 });
});
test('22 ZOL 机箱风扇位与水冷位结构化解析不虚构标配风扇数', () => {
  const gx = enrichSpecs({ category: 'CASE', name: '航嘉GX750A掠夺者', specs: {}, rawParams: {
    前置风扇位: '3×120mm风扇位', 后置风扇位: '1×120mm风扇位', 其它风扇位: '侧置：2×120mm风扇位 顶置：3×120mm风扇位', 支持水冷: '顶置：360mm水冷排',
  } });
  assert.deepEqual(gx.intakePositions, ['front', 'side']);
  assert.deepEqual(gx.exhaustPositions, ['rear', 'top']);
  assert.equal(gx.maxRadiatorMm, 360);
  assert.deepEqual(gx.radiatorPositions, [{ position: 'top', sizesMm: [360] }]);
  assert.equal(gx.includedFans, undefined);
  assert.equal(gx.fanMounts.find(m => m.position === 'top').count, 3);

  const withStock = enrichSpecs({ category: 'CASE', name: '测试机箱', specs: {}, rawParams: {
    其它风扇位: '前置：3×120mm风扇位（标配1×120mm风扇） 后置：1×120mm风扇（标配）',
  } });
  assert.equal(withStock.includedFans, 2);
});
test('23 主板多槽 M.2 择优匹配、BIOS Flashback 与 ReBAR 结构化判定', () => {
  const b860 = corrected('buildcores-6efb715c-74b5-4f50-8948-46069e4e1307', 'MOTHERBOARD', { socket: 'LGA1851', chipset: 'B860' });
  const ssd5 = { pcieLink: { gen: 5, lanes: 4 } };
  const cpu5 = { storagePcieLink: { gen: 5, lanes: 4 } };
  const link = pcieLink(cpu5, b860.specs, ssd5, { storage: true });
  assert.equal(link.status, 'PASS');
  assert.match(link.detail, /M2A_CPU/);

  const biosMsg = biosSupport('Intel 酷睿 Ultra 7 270K Plus', 'Z890', { biosFlashback: true });
  assert.equal(biosMsg.status, 'CONDITIONAL');
  assert.match(biosMsg.detail, /Flashback/);

  const arcBase = { CPU: part({ socket: 'AM4', maxPowerWatts: 65 }), GPU: part({ chipset: 'Arc B580', needsResizableBar: true, powerPins: { pin8: 1 }, boardPowerWatts: 190, lengthMm: 270 }), MOTHERBOARD: part({ socket: 'AM4', chipset: 'B550', rebarSupport: true }) };
  assert.equal(check(arcBase, 'rebar').status, 'CONDITIONAL');
  assert.equal(check({ ...arcBase, MOTHERBOARD: part({ socket: 'AM4', chipset: 'A320', rebarSupport: false }) }, 'rebar').status, 'FAIL');
  assert.equal(check({ ...arcBase, MOTHERBOARD: part({ socket: 'AM4', chipset: 'A320' }) }, 'rebar').status, 'UNKNOWN');

  const validated = hardwareDetails({ rebarSupport: 'bios-update', biosFlashback: true, cpuMemoryMaxMTsByType: { DDR5: 7200 } });
  assert.equal(validated.rebarSupport, 'bios-update');
});
test('24 optimizePlans 延迟切片检查与完整 evaluateBuild 逐项一致', () => {
  const res = optimizePlans(fixtures, { budgetCents: 600000, maxOverPercent: 0, scenarios: ['ai'], strategy: 'performance' });
  for (const plan of res.plans) {
    if (plan.infeasible) continue;
    const parts = Object.fromEntries(plan.picks.map(p => [p.slot, p.item]));
    const direct = evaluateBuild(parts, { igpu: plan.igpu, stockCooler: plan.stockCooler, workload: plan.workload });
    assert.deepEqual(plan.compatibility.checks, direct);
  }
});
