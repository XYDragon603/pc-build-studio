import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateBuild, overallStatus } from '../src/compat-rules.mjs';
import { boardFormat, boardFormats, boardCaseStatus, coolerThermalCheck, pcieLink } from '../src/hardware-specs.mjs';
import { enrichSpecs } from '../src/specs-enrich.mjs';
import { correctHardware } from '../src/catalog-corrections.mjs';
import { optimizePlans } from '../src/optimizer.mjs';
import { createApiServer } from '../src/api.mjs';
import { applyPriceMode, normalizeRecord } from '../src/prices.mjs';
import { dataQualityReport } from '../src/data-quality.mjs';

// All prices and thermal/FPS measurements here are synthetic control data,
// isolated from the real catalog. example.com identifies the synthetic source.
const evidence = { sourceUrl: 'https://example.com/synthetic-test', kind: 'measured', durationMinutes: 30, ambientC: 30 };
const item = (id, category, yuan, specs, performance) => ({ id, name: id, category, specs, productStatus: 'new', estimatedPriceCents: yuan * 100, referencePriceCents: yuan * 100, estimateBasis: 'reference', priceConfidence: 'high', market: 'cn', dataSource: 'zol', manufacturer: 'Synthetic', mpn: id, aliases: [], partNumbers: [], summary: '', sourceUrl: 'https://example.com/synthetic', ...(performance ? { performance } : {}) });
const catalog = [
  item('cpu-a', 'CPU', 600, { socket: 'AM5', maxPowerWatts: 88, integratedGraphics: 'yes', pcieLink: { gen: 4, lanes: 16 }, storagePcieLink: { gen: 4, lanes: 4 } }, { gaming: { index: 70 }, blender: { score: 250 } }),
  item('cpu-b', 'CPU', 1200, { socket: 'AM5', maxPowerWatts: 250, pcieLink: { gen: 5, lanes: 16 } }, { gaming: { index: 95 }, blender: { score: 500 } }),
  ...[['gpu-a', 500, 12, 30, 1500, 150], ['gpu-b', 1000, 16, 65, 4000, 200], ['gpu-c', 2600, 24, 110, 10000, 450]].map(([id, cost, gb, index, compute, w]) => item(id, 'GPU', cost, { chipset: 'GeForce RTX 4090', capacityGB: gb, boardPowerWatts: w, lengthMm: 280, heightMm: 120, thicknessMm: 50, slotWidth: 3, powerPins: { pin8: 2, pin16: 0 }, pcieLink: { gen: 4, lanes: 16 } }, { gaming: { index }, blender: { score: compute } })),
  item('board-a', 'MOTHERBOARD', 400, { socket: 'AM5', chipset: 'B650', memoryType: 'DDR5', formFactor: 'MICRO ATX', memorySlots: 4, maxMemoryGB: 128, m2Slots: 2, vrmPhases: 14, videoOutputs: true, gpuPcieLink: { gen: 4, lanes: 16, physicalLanes: 16 }, m2Links: [{ protocol: 'NVME', gen: 4, lanes: 4 }] }),
  item('board-atx', 'MOTHERBOARD', 450, { socket: 'AM5', chipset: 'B650', memoryType: 'DDR5', formFactor: 'ATX', memorySlots: 4, m2Slots: 2, videoOutputs: true }),
  ...[16, 32, 64].map(gb => item(`ram-${gb}`, 'RAM', gb * 5, { memoryType: 'DDR5', capacityGB: gb, modules: 2, speedMTs: 5200 })),
  item('ssd-a', 'SSD', 250, { capacityGB: 1000, interface: 'M.2 PCIe 4.0 x4', pcieLink: { gen: 4, lanes: 4 }, nand: 'TLC', dram: 'hmb', readMBs: 6000 }),
  item('ssd-b', 'SSD', 400, { capacityGB: 2000, interface: 'M.2 PCIe 4.0 x4', pcieLink: { gen: 4, lanes: 4 }, nand: 'TLC', dram: 'hmb', readMBs: 6000 }),
  item('psu-a', 'PSU', 400, { ratedWatts: 1000, pcie8Count: 4, pin16Count: 1, rail12vAmps: 83, atxVersion: '3.1', efficiency: 'GOLD', warrantyYears: 10, protections: ['OCP', 'OPP', 'OVP', 'UVP', 'OTP', 'SCP'], psuFormFactor: 'ATX', psuLengthMm: 140 }),
  item('case-m', 'CASE', 180, { supportedBoardFormats: ['MICRO ATX', 'MINI-ITX'], maxBoardFormFactor: 'MICRO ATX', maxGpuLengthMm: 350, maxGpuHeightMm: 160, maxGpuThicknessMm: 80, expansionSlots: 7, maxCoolerHeightMm: 180, supportedPsuFormats: ['ATX'], maxPsuLengthMm: 180, frontIntake: 'mesh', includedFans: 3, intakePositions: ['front'], exhaustPositions: ['rear'], thermalTests: [{ ...evidence, cpuWatts: 300, gpuWatts: 500, withinLimits: true, noiseDbA: 39 }] }),
  item('case-quiet', 'CASE', 260, { supportedBoardFormats: ['MICRO ATX', 'ATX', 'MINI-ITX'], maxBoardFormFactor: 'ATX', maxGpuLengthMm: 350, maxGpuHeightMm: 160, maxGpuThicknessMm: 80, expansionSlots: 7, maxCoolerHeightMm: 180, supportedPsuFormats: ['ATX'], maxPsuLengthMm: 180, frontIntake: 'mesh', includedFans: 3, intakePositions: ['front'], exhaustPositions: ['rear'], thermalTests: [{ ...evidence, cpuWatts: 300, gpuWatts: 500, withinLimits: true, noiseDbA: 28 }] }),
  item('cooler-a', 'COOLER', 90, { heightMm: 150, sockets: ['AM5'], thermalTests: [{ ...evidence, cpuSocket: 'AM5', powerWatts: 300, maxTempC: 80, tempLimitC: 90, caseAirflow: 'mesh', noiseDbA: 40 }] }),
  item('cooler-quiet', 'COOLER', 160, { heightMm: 158, sockets: ['AM5'], thermalTests: [{ ...evidence, cpuSocket: 'AM5', powerWatts: 300, maxTempC: 75, tempLimitC: 90, caseAirflow: 'mesh', noiseDbA: 28 }] }),
  item('keyboard', 'KEYBOARD', 80, { mechanical: true, wireless: true }), item('mouse', 'MOUSE', 60, { dpi: 16000, wireless: true }),
];
const opts = (budget = 800000, extra = {}) => ({ budgetCents: budget, scenarios: ['2k'], maxOverPercent: 0, ...extra });
const plans = (budget, extra) => optimizePlans(catalog, opts(budget, extra)).plans;
const picks = p => Object.fromEntries(p.picks.map(x => [x.slot, x.item]));
const fixtureParts = () => Object.fromEntries(['CPU', 'GPU', 'MOTHERBOARD', 'RAM', 'SSD', 'PSU', 'CASE', 'COOLER'].map(s => [s, structuredClone(catalog.find(i => i.category === s))]));

test('V2.1 01: 板型枚举不包含匹配；ATX 不能安装到仅 M-ATX 机箱，缺字段 UNKNOWN', () => {
  assert.deepEqual(boardFormats('M-ATX（紧凑型），MINI-ITX（迷你型）'), ['MICRO ATX', 'MINI-ITX']);
  assert.equal(boardFormat('M-ATX'), 'MICRO ATX');
  assert.equal(boardCaseStatus({ formFactor: 'ATX' }, { supportedBoards: 'M-ATX' }), 'FAIL');
  assert.equal(boardCaseStatus({}, { maxBoardFormFactor: 'ATX' }), 'UNKNOWN');
});
test('V2.1 02: 主板更换后重新检查机箱支持集合', () => {
  const p = fixtureParts(); assert.equal(evaluateBuild(p).find(c => c.id === 'boardFit').status, 'PASS');
  p.MOTHERBOARD.specs.formFactor = 'ATX'; assert.equal(evaluateBuild(p).find(c => c.id === 'boardFit').status, 'FAIL');
});
test('V2.1 03: 更换显卡后供电、长宽厚、扩展槽及风道全部重新检查', () => {
  const p = fixtureParts();
  p.GPU.specs = { ...p.GPU.specs, lengthMm: 400, thicknessMm: 90, slotWidth: 8, boardPowerWatts: 600, powerPins: { pin8: 5 } };
  delete p.CASE.specs.thermalTests;
  const c = evaluateBuild(p);
  for (const id of ['gpuPower', 'gpuLength', 'gpuThickness', 'gpuSlots']) assert.equal(c.find(c => c.id === id).status, 'FAIL', id);
  assert.notEqual(c.find(c => c.id === 'caseAirflow').status, 'PASS');
});
test('V2.1 04: 高功耗 CPU 不靠高度或标称 TDP 通过，明确限功耗仅条件通过', () => {
  const cpu = { socket: 'AM5', maxPowerWatts: 250 };
  const cooler = { heightMm: 170, vendorCoolingWatts: 240, coolingEvidence: { sourceUrl: 'https://example.com/vendor' } };
  assert.equal(coolerThermalCheck(cpu, cooler, {}).status, 'UNKNOWN');
  const limited = coolerThermalCheck(cpu, cooler, {}, { cpuPowerLimitWatts: 180 });
  assert.equal(limited.status, 'CONDITIONAL'); assert.match(limited.detail, /降低持续多核性能/);
});
// 2.2.1：进排风安装位未知 → UNKNOWN（阻断）；已知 → CONDITIONAL（列出风扇配置要求），没有整机实测永远不是 PASS
test('V2.1 05: 高功耗 GPU 缺机箱风道时不是 PASS，整机 UNKNOWN', () => {
  const p = fixtureParts(); p.GPU.specs.boardPowerWatts = 450;
  p.CASE.specs = { ...p.CASE.specs, frontIntake: undefined, thermalTests: undefined, intakePositions: undefined, exhaustPositions: undefined };
  const c = evaluateBuild(p); const airflow = c.find(c => c.id === 'caseAirflow');
  assert.equal(airflow.status, 'UNKNOWN'); assert.equal(airflow.blocking, true); assert.equal(overallStatus(c), 'UNKNOWN');
  // 2.2.2：高负载只知道风扇位“有无”、不知道数量时仍为关键待核实；数量满足需求才是 CONDITIONAL
  p.CASE.specs = { ...p.CASE.specs, intakePositions: ['front'], exhaustPositions: ['rear'] };
  assert.equal(evaluateBuild(p).find(c => c.id === 'caseAirflow').status, 'UNKNOWN');
  p.CASE.specs = { ...p.CASE.specs, fanMounts: [{ position: 'front', count: 3, sizeMm: 120 }, { position: 'rear', count: 1, sizeMm: 120 }] };
  const known = evaluateBuild(p).find(c => c.id === 'caseAirflow');
  assert.equal(known.status, 'CONDITIONAL'); assert.match(known.detail, /进风/); assert.match(known.detail, /没有整机持续温度/);
});
test('V2.1 06: A520 错误数据库校正为 PCIe 3.0 并保存官方来源', () => {
  const i = correctHardware({ ...item('zol-1336495', 'MOTHERBOARD', 469, { chipset: 'A520', pcieGen: 4 }) });
  assert.equal(i.specs.pcieGen, 3); assert.equal(i.specs.m2Links[0].gen, 3); assert(i.specs.specEvidence[0].sourceUrl.includes('amd.com'));
  const pc = enrichSpecs({ category: 'CASE', specs: { maxBoardFormFactor: 'ATX' }, rawParams: { 机箱结构: 'ATX', 适用主板: 'M-ATX,MINI-ITX' } });
  assert.equal(pc.maxBoardFormFactor, 'MICRO ATX');
});
test('V2.1 07: PCIe x4 显卡计算完整链路，带宽受限是 CONDITIONAL，缺数据 UNKNOWN', () => {
  const r = pcieLink({ pcieLink: { gen: 4, lanes: 16 } }, { gpuPcieLink: { gen: 3, lanes: 16 } }, { pcieLink: { gen: 4, lanes: 4 } });
  assert.equal(r.status, 'CONDITIONAL'); assert.equal(r.lanes, 4); assert.equal(r.gen, 3); assert.match(r.detail, /未推断精确性能损失/);
  assert.equal(pcieLink({}, {}, {}).status, 'UNKNOWN');
});
test('V2.1 08: 高端配置缺实测数据不能获得高可信度和高噪音分', () => {
  const noEvidence = catalog.map(i => ({ ...i, specs: { ...i.specs, thermalTests: undefined } }));
  for (const p of optimizePlans(noEvidence, opts(1500000, { scenarios: ['ai'] })).plans.filter(p => !p.infeasible)) {
    // 2.2.1：工程判断可以把空间 / 风道检查推到 CONDITIONAL，但没有实测时整机永远不是 PASS，也不是正式推荐
    assert(p.score.parts.trust <= 40); assert.equal(p.score.parts.noise, 0); assert.notEqual(p.compatibility.overall, 'PASS'); assert.equal(p.formalRecommendation, false);
  }
});
test('V2.1 09: 严格预算不输出正式超支推荐', () => { for (const p of plans(400000)) assert(p.infeasible || p.totalCents <= p.targetCents); });
test('V2.1 10: 无解有独立原因和超预算替代方案', () => {
  for (const p of plans(100000)) { assert(p.infeasible); assert(p.reasons.length); assert(p.alternative.totalCents > p.targetCents); assert.equal(p.formalRecommendation, false); }
});
test('V2.1 11: 相同快照下结果与候选淘汰记录一致', () => {
  const a = optimizePlans(catalog, opts()), b = optimizePlans(catalog, opts());
  const noTime = p => JSON.parse(JSON.stringify(p, (k, v) => (k === 'generatedAt' ? undefined : v)));
  assert.deepEqual(noTime(a.plans), noTime(b.plans)); assert.deepEqual(a.meta.candidateLog, b.meta.candidateLog); assert.equal(a.meta.dataSnapshotId, b.meta.dataSnapshotId); assert.equal(a.meta.stats.globalOptimalityProven, false);
});
test('V2.1 12: 提高档位时显卡核心性能和内存容量不无理由下降', () => {
  const ps = plans(500000, { scenarios: ['creator'] }).filter(p => !p.infeasible);
  for (let n = 1; n < ps.length; n++) { const a = picks(ps[n - 1]), b = picks(ps[n]); assert(b.GPU.performance.blender.score >= a.GPU.performance.blender.score); assert(b.RAM.specs.capacityGB >= a.RAM.specs.capacityGB); }
});
test('V2.1 13: 手动修改价格后重新搜索，而非只改变合计', () => {
  const expensive = catalog.map(i => i.id === 'gpu-c' ? { ...i, estimatedPriceCents: 1000000 } : i);
  const before = optimizePlans(expensive, opts(650000)).plans[1];
  const records = [normalizeRecord({ componentId: 'gpu-c', priceCents: 90000, sourceName: '合成测试价' })];
  const priced = applyPriceMode(expensive, records, { mode: 'manual' });
  const after = optimizePlans(priced, opts(650000)).plans[1];
  assert.notEqual(picks(before).GPU.id, 'gpu-c'); assert.equal(picks(after).GPU.id, 'gpu-c');
});
test('V2.1 14: 锁定件仍完整检查物理兼容和供电', () => {
  const p = fixtureParts();
  const locked = Object.fromEntries(Object.entries(p).map(([s, i]) => [s, { name: i.name, priceCents: i.estimatedPriceCents, specs: i.specs }]));
  locked.MOTHERBOARD.specs.formFactor = 'ATX';
  assert(plans(800000, { locked }).every(p => p.infeasible));
});
test('V2.1 15: 安静优先使用覆盖负载的实测噪音依据', () => {
  const p = plans(800000, { scenarios: ['2k', 'quiet'] })[1];
  assert.equal(picks(p).COOLER.id, 'cooler-quiet'); assert.equal(picks(p).CASE.id, 'case-quiet');
  assert.equal(p.compatibility.checks.find(c => c.id === 'cpuCooling').status, 'PASS');
});
test('V2.1 16: 外设成本计入档位目标预算，缺外设时说明无解', () => {
  for (const p of plans(500000, { peripherals: ['KEYBOARD', 'MOUSE'] }).filter(p => !p.infeasible)) {
    assert.equal(p.totalCents, p.picks.reduce((n, x) => n + x.item.estimatedPriceCents, 0) + p.peripherals.totalCents + p.additionalCosts.reduce((n, x) => n + x.priceCents, 0)); assert(p.totalCents <= p.targetCents);
  }
  assert(plans(800000, { peripherals: ['MONITOR'] }).every(p => p.infeasible));
});
test('V2.1 API: 规格修正即时生效、来源校验、数据质量报告', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pc-v21-')); t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'zol-catalog.json'), JSON.stringify({ items: catalog }));
  const server = createApiServer({ directory: dir }); server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(done => server.close(done)));
  const url = `http://127.0.0.1:${server.address().port}/api/v1`;
  const input = { specs: { supportedBoardFormats: ['ATX'] }, sourceUrl: 'https://example.com/verified-manual', note: '测试规格修正' };
  const put = await fetch(url + '/catalog/case-m/specs', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  assert.equal(put.status, 200); const updated = await put.json(); assert.deepEqual(updated.specs.supportedBoardFormats, ['ATX']);
  assert.equal((await fetch(url + '/catalog/case-m').then(r => r.json())).specs.supportedBoardFormats[0], 'ATX');
  const bad = await fetch(url + '/catalog/case-m/specs', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...input, specs: { maxPowerWatts: 'bad' } }) }); assert.equal(bad.status, 400);
  assert.equal((await fetch(url + '/catalog/quality-report')).status, 200);
});
test('V2.1 数据质量: 内存价格倒挂可追溯且不擅改价格，未来报价被拒绝', () => {
  const i = [item('small', 'RAM', 859, { memoryType: 'DDR4', modules: 2, capacityGB: 32 }), item('large', 'RAM', 849, { memoryType: 'DDR4', modules: 2, capacityGB: 64 })];
  const r = dataQualityReport(i); assert.equal(r.counts['capacity-price-inversion'], 1); assert.equal(i[0].estimatedPriceCents, 85900);
  const now = new Date('2026-11-25T00:00:00Z'); assert.throws(() => normalizeRecord({ componentId: 'x', priceCents: 100, observedAt: '2026-11-25T01:00:00Z' }, now));
});
test('V2.1 额外采购费用和电源品质下限都是实际约束', () => {
  const withFans = catalog.map(i => i.category === 'CASE' ? { ...i, specs: { ...i.specs, requiredFanCostCents: 12000 } } : i);
  const generated = optimizePlans(withFans, opts()).plans.filter(p => !p.infeasible);
  assert(generated.length > 0);
  for (const p of generated) {
    assert.equal(p.additionalCosts[0].priceCents, 12000);
    assert.equal(p.totalCents, p.picks.reduce((sum, x) => sum + x.item.estimatedPriceCents, 0) + 12000);
  }
  const lowQuality = catalog.map(i => i.category === 'PSU' ? { ...i, specs: { ratedWatts: 1500, pcie8Count: 4, pin16Count: 1 } } : i);
  const locked = { CPU: { priceCents: 100000, specs: { socket: 'AM5', maxPowerWatts: 250 } }, GPU: { priceCents: 100000, specs: { chipset: 'RTX 4090', boardPowerWatts: 450, powerPins: { pin8: 2 } } } };
  assert(optimizePlans(lowQuality, opts(1000000, { locked })).plans.every(p => p.infeasible));
});
