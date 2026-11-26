// V2.2.3 回归测试：关键风险局部替换、安全备选、降功耗方案、机箱热负载分级、显卡有效限长、16pin 线材额定、
// 风扇接口 / 集线器、原装散热备用成本、主板内存数据优先、SSD 插槽链路、数据补丁导入 / 冲突 / 回滚。
// 全部调用正式模块与正式推荐引擎；合成数据只在内存与临时目录中，不写入正式目录。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateBuild, FAIL, gpuLengthClearance, gpuPowerCheck, powerEstimate } from '../src/compat-rules.mjs';
import { caseThermalCheck, coolerThermalCheck, memorySpeedCheck, pcieLink, thermalRiskLevel } from '../src/hardware-specs.mjs';
import { accessoryCost, costBreakdown } from '../src/accessories.mjs';
import { optimizePlans } from '../src/optimizer.mjs';
import { repairRisks, RISK_SLOTS } from '../src/risk-repair.mjs';
import { applyPatch, loadOverlay, overlayView, rollbackPatch, validateRecord } from '../src/data-patches.mjs';
import { createCatalog } from '../src/catalog.mjs';

let seq = 0;
const item = (category, yuan, name, specs, extra = {}) => ({ id: `${category.toLowerCase()}-${++seq}`, category, name, specs, estimatedPriceCents: yuan * 100, priceConfidence: 'high', productStatus: 'new', market: 'cn', ...extra });
const perf = (gaming, blender) => ({ performance: { gaming: { index: gaming }, blender: { score: blender } } });
const measured = (watts, socket) => [{ kind: 'measured', powerWatts: watts, cpu: '测试 CPU', cpuSocket: socket, ambientC: 25, maxTempC: 85, tempLimitC: 105, durationMinutes: 30, sourceUrl: 'https://example.com/test' }];
const pick = (p, slot) => p.picks.find(x => x.slot === slot)?.item;
const check = (p, id) => p.compatibility.checks.find(c => c.id === id);
const fans = [{ position: 'front', count: 3, sizeMm: 120 }, { position: 'rear', count: 1, sizeMm: 120 }];
const caseSpecs = extra => ({ supportedBoardFormats: ['ATX', 'MICRO ATX'], maxGpuLengthMm: 400, maxCoolerHeightMm: 170, supportedPsuFormats: ['ATX'], expansionSlots: 7, fanMounts: fans, intakePositions: ['front'], exhaustPositions: ['rear'], maxPsuLengthMm: 200, ...extra });

/**
 * 合成目录：便宜机箱缺少 16pin 供电线空间（阻断），贵 ¥60 的机箱公布了空间（可消除阻断）；
 * 便宜电源原生 16pin 线材额定未知（阻断），贵一些的电源线材额定 600W。
 */
function catalog({ withSafeCase = true, withRatedPsu = true, extraGpu = true } = {}) {
  seq = 0;
  return [
    item('CPU', 1300, 'AMD Ryzen 5 7600', { socket: 'AM5', memoryType: 'DDR5', maxPowerWatts: 88, basePowerWatts: 65, packaging: '盒装', stockCoolerIncluded: true }, perf(70, 230)),
    item('CPU', 1700, 'Intel Core Ultra 7 270K Plus', { socket: 'LGA1851', memoryType: 'DDR5', maxPowerWatts: 250, basePowerWatts: 125, packaging: '盒装', stockCoolerIncluded: false }, perf(85, 480)),
    item('GPU', 14000, 'RTX 4090 D', { chipset: 'GeForce RTX 4090 D', capacityGB: 24, lengthMm: 330, heightMm: 140, slotWidth: 3, boardPowerWatts: 425, powerPins: { pin16: 1 } }, perf(100, 9000)),
    ...(extraGpu ? [item('GPU', 3500, 'RTX 5060 Ti 16G', { chipset: 'GeForce RTX 5060 Ti', capacityGB: 16, lengthMm: 250, heightMm: 120, slotWidth: 2, boardPowerWatts: 180, powerPins: { pin8: 1 } }, perf(52, 3600))] : []),
    item('MOTHERBOARD', 900, 'B650M', { socket: 'AM5', chipset: 'B650', memoryType: 'DDR5', formFactor: 'MICRO ATX', memorySlots: 4, maxMemoryGB: 192, m2Slots: 2, pcieGen: 4, videoOutputs: true, fanHeaders: 6 }),
    item('MOTHERBOARD', 1100, 'B860', { socket: 'LGA1851', chipset: 'B860', memoryType: 'DDR5', formFactor: 'ATX', memorySlots: 4, maxMemoryGB: 192, m2Slots: 2, pcieGen: 5, videoOutputs: true, fanHeaders: 6 }),
    item('RAM', 1300, 'DDR5 64GB', { memoryType: 'DDR5', capacityGB: 64, modules: 2, speedMTs: 6000 }),
    item('SSD', 1500, 'NVMe 4TB', { capacityGB: 4000, interface: 'M.2 PCIe 4.0 x4', nand: 'TLC' }),
    item('PSU', 700, '1000W 线材额定未知', { ratedWatts: 1000, efficiency: '金牌', atxVersion: '3.1', rail12vAmps: 83, pcie8Count: 4, native16Pin: true, psuFormFactor: 'ATX', psuLengthMm: 150, warrantyYears: 10, protections: ['OVP', 'OCP', 'OPP', 'SCP', 'OTP', 'UVP'] }),
    ...(withRatedPsu ? [item('PSU', 900, '1000W 12V-2x6 600W 线', { ratedWatts: 1000, efficiency: '金牌', atxVersion: '3.1', rail12vAmps: 83, pcie8Count: 4, native12v2x6: true, connectorPowerRating: 600, psuFormFactor: 'ATX', psuLengthMm: 150, warrantyYears: 10, protections: ['OVP', 'OCP', 'OPP', 'SCP', 'OTP', 'UVP'] })] : []),
    item('COOLER', 99, '单塔 4 热管', { sockets: ['AM5', 'LGA1851'], heightMm: 155, heatPipes: 4 }),
    item('CASE', 200, '机箱 A（缺 16pin 线空间）', caseSpecs({})),
    ...(withSafeCase ? [item('CASE', 260, '机箱 B（公布 16pin 线空间）', caseSpecs({ gpuCableClearanceMm: 200 }))] : []),
  ];
}
/**
 * 跨槽交互目录：最便宜的合格散热器较高（175mm），只放得进缺少 16pin 供电线空间的机箱 A；
 * 稍贵的 150mm 散热器才放得进公布了供电线空间的机箱 B——补件器逐个挑选会留下阻断项，局部替换应找到“散热器 + 机箱”组合。
 */
function crossSlotCatalog({ withSafeCase = true } = {}) {
  seq = 0;
  return [
    item('CPU', 1300, 'AMD Ryzen 5 7600', { socket: 'AM5', memoryType: 'DDR5', maxPowerWatts: 88, basePowerWatts: 65, packaging: '散片' }, perf(70, 230)),
    item('GPU', 14000, 'RTX 4090 D', { chipset: 'GeForce RTX 4090 D', capacityGB: 24, lengthMm: 330, heightMm: 140, slotWidth: 3, boardPowerWatts: 425, powerPins: { pin16: 1 } }, perf(100, 9000)),
    item('GPU', 3500, 'RTX 5060 Ti 16G', { chipset: 'GeForce RTX 5060 Ti', capacityGB: 16, lengthMm: 250, heightMm: 120, slotWidth: 2, boardPowerWatts: 180, powerPins: { pin8: 1 } }, perf(52, 3600)),
    item('MOTHERBOARD', 900, 'B650M', { socket: 'AM5', chipset: 'B650', memoryType: 'DDR5', formFactor: 'MICRO ATX', memorySlots: 4, maxMemoryGB: 192, m2Slots: 2, pcieGen: 4, videoOutputs: true, fanHeaders: 6 }),
    item('RAM', 1300, 'DDR5 64GB', { memoryType: 'DDR5', capacityGB: 64, modules: 2, speedMTs: 6000 }),
    item('SSD', 1500, 'NVMe 4TB', { capacityGB: 4000, interface: 'M.2 PCIe 4.0 x4', nand: 'TLC' }),
    item('PSU', 900, '1000W 12V-2x6 600W 线', { ratedWatts: 1000, efficiency: '金牌', atxVersion: '3.1', rail12vAmps: 83, pcie8Count: 4, native12v2x6: true, connectorPowerRating: 600, psuFormFactor: 'ATX', psuLengthMm: 150, warrantyYears: 10, protections: ['OVP', 'OCP', 'OPP', 'SCP', 'OTP', 'UVP'] }),
    item('COOLER', 99, '高塔 175mm 4 热管', { sockets: ['AM5'], heightMm: 175, heatPipes: 4 }),
    item('COOLER', 129, '矮塔 150mm 4 热管', { sockets: ['AM5'], heightMm: 150, heatPipes: 4 }),
    item('CASE', 200, '机箱 A（散热限高 180，缺 16pin 线空间）', caseSpecs({ maxCoolerHeightMm: 180 })),
    ...(withSafeCase ? [item('CASE', 260, '机箱 B（散热限高 165，公布 16pin 线空间）', caseSpecs({ maxCoolerHeightMm: 165, gpuCableClearanceMm: 200 }))] : []),
  ];
}
const run = (items, yuan, extra = {}) => optimizePlans(items, { budgetCents: yuan * 100, scenarios: ['ai'], tierRatios: { balanced: 1 }, ...extra }).plans[0];

// ---------- 1–4 局部替换 ----------
test('01 高性能候选存在关键风险时触发局部替换', () => {
  const p = run(crossSlotCatalog(), 22000);
  assert.equal(pick(p, 'GPU').name, 'RTX 4090 D', '保留核心性能硬件');
  assert.ok(['resolved', 'reduced'].includes(p.riskSearch.result), p.riskSearch.result);
  assert.ok(p.riskSearch.initial.blockingChecks.length > 0, '初始组合有阻断项');
  assert.ok(p.riskSearch.replacements.length > 0);
  assert.ok(p.riskSearch.slots.CASE, '记录了各槽的候选与淘汰原因');
  assert.deepEqual(p.riskSearch.linkedSlots, ['COOLER'], '机箱候选因散热器超高 FAIL → 关联散热器槽');
  assert.ok(Object.keys(p.riskSearch.slots.CASE.eliminated).some(k => /coolerHeight/.test(k)));
  assert.ok(p.notes.some(n => /局部替换/.test(n)));
});

test('02 替换后执行完整兼容性重新检查与完整成本', () => {
  const p = run(crossSlotCatalog(), 22000);
  assert.deepEqual(p.compatibility.checks.filter(c => c.blocking).map(c => c.id), p.riskSearch.final.blockingChecks);
  const parts = Object.fromEntries(p.picks.map(x => [x.slot, x.item]));
  const direct = evaluateBuild(parts, { igpu: p.igpu, stockCooler: p.stockCooler, workload: p.workload });
  assert.deepEqual(direct.map(c => [c.id, c.status]), p.compatibility.checks.map(c => [c.id, c.status]), '与直接 evaluateBuild 逐项一致');
  assert.equal(p.totalCents, p.picks.reduce((s, x) => s + x.item.estimatedPriceCents, 0) + p.additionalCosts.reduce((s, x) => s + x.priceCents, 0));
  assert.equal(p.riskSearch.result, 'resolved');
  assert.equal(pick(p, 'COOLER').name, '矮塔 150mm 4 热管'); assert.match(pick(p, 'CASE').name, /机箱 B/);
  assert.notEqual(check(p, 'gpuCable').blocking, true); assert.equal(check(p, 'coolerHeight').status, 'PASS');
  assert.deepEqual(p.riskSearch.replacements.map(r => r.slot).sort(), ['case', 'cooler']);
});

test('03 找不到安全替代时保留待核实状态，不伪装为已确认推荐', () => {
  const p = run(catalog({ withSafeCase: false, withRatedPsu: false }), 22000);
  assert.equal(pick(p, 'GPU').name, 'RTX 4090 D', '不为消除 UNKNOWN 降低显卡档位');
  assert.equal(p.riskSearch.result, 'unresolved'); assert.match(p.riskSearch.reason, /没有能减少阻断项的替代/);
  assert.equal(p.recommendationStatus, 'verification_required'); assert.equal(p.formalRecommendation, false);
  assert.ok(p.safeAlternative, '存在可行安全方案时给出独立备选');
  assert.equal(p.safeAlternative.compatibility.checks.some(c => c.blocking || c.status === FAIL), false);
  assert.ok(p.safeAlternative.coreChangePercent < 0);
  // 没有任何安全方案时：不提供备选，也不报错
  const none = run(catalog({ withSafeCase: false, withRatedPsu: false, extraGpu: false }), 22000);
  assert.equal(none.safeAlternative, undefined); assert.equal(none.recommendationStatus, 'verification_required');
});

test('04 已确认安全的同等核心性能候选优先进入可推荐集合', () => {
  const p = run(catalog(), 22000);
  assert.equal(p.compatibility.checks.filter(c => c.blocking && ['gpuPower', 'gpuCable'].includes(c.id)).length, 0);
  // 局部替换模块直接调用：锁定的槽不参与替换
  const blocked = run(catalog(), 22000, { locked: { PSU: { ...catalog()[8], priceCents: 70000 } } });
  assert.ok(!blocked.riskSearch.replacements.some(r => r.slot === 'psu'), '锁定电源不被替换');
  assert.deepEqual(RISK_SLOTS.gpuCable, ['CASE']);
  const noop = repairRisks({ risk: { blockingChecks: [] } }, {});
  assert.equal(noop.log.result, 'none');
});

// ---------- 5–7 散热 ----------
test('05 250W CPU 与散热证据不足：关键待核实并给出降功耗方案', () => {
  const items = catalog().filter(i => !(i.category === 'CPU' && /7600/.test(i.name)));
  const p = optimizePlans(items, { budgetCents: 2200000, scenarios: ['creator'], tierRatios: { balanced: 1 } }).plans[0];
  assert.equal(pick(p, 'CPU').name, 'Intel Core Ultra 7 270K Plus');
  const cool = check(p, 'cpuCooling');
  assert.equal(cool.status, 'UNKNOWN'); assert.equal(cool.blocking, true);
  assert.equal(cool.evidence.engineeringLimitW, 125); assert.equal(cool.evidence.testedPowerW, null); assert.equal(cool.evidence.vendorRatingW, null);
  assert.match(cool.detail, /经验值，不是实测散热能力/);
  assert.ok(p.powerLimitOption); assert.equal(p.powerLimitOption.targetW, 125);
  assert.match(p.corePerformance.conditional, /未确认/);
  assert.equal(p.diagnostics.cpuPerformanceAssumption, 'full-power-unverified');
});

test('06 功耗限制后重新计算性能说明、热负载与电源需求', () => {
  const items = catalog().filter(i => !(i.category === 'CPU' && /7600/.test(i.name)));
  const p = optimizePlans(items, { budgetCents: 2200000, scenarios: ['creator'], tierRatios: { balanced: 1 } }).plans[0];
  const pl = p.powerLimitOption;
  assert.ok(pl.biosSettings.some(s => /PL1/.test(s)) && pl.biosSettings.some(s => /PL2/.test(s)));
  assert.equal(pl.performanceDelta, null); assert.match(pl.performanceNote, /未量化/);
  assert.equal(pl.thermalLoadW.cpu, 125); assert.equal(pl.thermalLoadW.total, 125 + 425);
  assert.equal(pl.coolingAfter, 'CONDITIONAL', '限功耗后散热证据覆盖');
  const full = powerEstimate({ maxPowerWatts: 250 }, { boardPowerWatts: 425 });
  const limited = powerEstimate({ maxPowerWatts: 250 }, { boardPowerWatts: 425 }, { cpuPowerLimitWatts: 125 });
  assert.equal(limited.cpuW, 125); assert.ok(limited.calculated < full.calculated);
  assert.equal(pl.psuRequirement.calculated, limited.calculated);
  // 明确限功耗时 coolerThermalCheck 按限制校核
  assert.equal(coolerThermalCheck({ socket: 'LGA1851', maxPowerWatts: 250, basePowerWatts: 125 }, { heatPipes: 4 }, {}, {}, { cpuPowerLimitWatts: 125 }).status, 'CONDITIONAL');
});

test('07 高热负载风道证据不足：风扇位不能确认高功耗散热', () => {
  assert.equal(thermalRiskLevel(759), 'critical'); assert.equal(thermalRiskLevel(522), 'high'); assert.equal(thermalRiskLevel(300), 'medium');
  const pc = { fanMounts: [{ position: 'front', count: 3, sizeMm: 140 }, { position: 'top', count: 3, sizeMm: 120 }, { position: 'rear', count: 1, sizeMm: 120 }], frontIntake: 'mesh' };
  const hot = caseThermalCheck({ maxPowerWatts: 159 }, { boardPowerWatts: 600 }, pc);
  assert.equal(hot.status, 'UNKNOWN'); assert.equal(hot.critical, true); assert.match(hot.detail, /不能确认/);
  const mid = caseThermalCheck({ maxPowerWatts: 162 }, { boardPowerWatts: 360 }, pc);
  assert.equal(mid.status, 'CONDITIONAL'); assert.equal(mid.critical, true, '450–600W：安全类条件项');
  const checks = evaluateBuild({ CPU: { specs: { maxPowerWatts: 162, socket: 'AM5' } }, GPU: { specs: { boardPowerWatts: 360 } }, CASE: { specs: pc } });
  assert.equal(checks.find(c => c.id === 'caseAirflow').severity, 'safety');
  assert.equal(caseThermalCheck({ maxPowerWatts: 88 }, { boardPowerWatts: 180 }, pc).critical, false);
  // 有覆盖负载的整机实测才可能 PASS
  const tested = { ...pc, thermalTests: [{ kind: 'measured', sourceUrl: 'https://example.com/case', cpuWatts: 200, gpuWatts: 600, ambientC: 25, durationMinutes: 30, withinLimits: true }] };
  assert.equal(caseThermalCheck({ maxPowerWatts: 159 }, { boardPowerWatts: 600 }, tested).status, 'PASS');
});

// ---------- 8–9 尺寸与线材 ----------
test('08 显卡有效限长：说明与实际扣减一致，不重复扣减', () => {
  const r = gpuLengthClearance({ lengthMm: 334 }, { maxGpuLengthMm: 415 }, { frontFans: true });
  assert.equal(r.evidence.frontFanAllowanceMm, 25); assert.equal(r.evidence.effectiveLimitMm, 390); assert.equal(r.evidence.marginMm, 56);
  assert.match(r.detail, /有效限长 390mm/); assert.match(r.detail, /余量 56mm/);
  const included = gpuLengthClearance({ lengthMm: 334 }, { maxGpuLengthMm: 415, gpuLengthIncludesFrontFans: true }, { frontFans: true });
  assert.equal(included.evidence.frontFanAllowanceMm, 0); assert.equal(included.evidence.marginMm, 81); assert.match(included.detail, /不重复扣减/);
  // 前置冷排：扣冷排 + 风扇，不再另扣前置风扇
  const aio = gpuLengthClearance({ lengthMm: 330 }, { maxGpuLengthMm: 400, radiatorPositions: [{ position: 'front', sizesMm: [360] }] }, { frontFans: true, cooler: { radiatorSizeMm: 360, radiatorThicknessMm: 27 } });
  assert.equal(aio.evidence.radiatorAllowanceMm, 52); assert.equal(aio.evidence.frontFanAllowanceMm, 0); assert.equal(aio.evidence.effectiveLimitMm, 348);
  assert.equal(gpuLengthClearance({ lengthMm: 360 }, { maxGpuLengthMm: 400, radiatorPositions: [{ position: 'front', sizesMm: [360] }] }, { cooler: { radiatorSizeMm: 360, radiatorThicknessMm: 27 } }).status, FAIL);
  assert.equal(gpuLengthClearance({ lengthMm: 380 }, { maxGpuLengthMm: 400 }, { frontFans: true }).status, 'UNKNOWN', '扣除风扇后不足：可能顶到');
});

test('09 电源线材额定缺失：所有功耗等级一致处理', () => {
  for (const watts of [200, 360, 575]) {
    const r = gpuPowerCheck({ boardPowerWatts: watts, powerPins: { pin16: 1 } }, { native16Pin: true, pcie8Count: 6, ratedWatts: 1300 });
    assert.equal(r.status, 'UNKNOWN', `${watts}W`); assert.equal(r.critical, watts >= 300); assert.match(r.detail, /不能用电源总功率代替线材额定/);
  }
  assert.equal(gpuPowerCheck({ boardPowerWatts: 360, powerPins: { pin16: 1 } }, { native16Pin: true, connectorPowerRating: 450 }).status, 'PASS');
  assert.equal(gpuPowerCheck({ boardPowerWatts: 575, powerPins: { pin16: 1 } }, { native16Pin: true, connectorPowerRating: 450 }).status, FAIL);
  // 电源长度：按该电源自身长度说明，不统一当 140mm；线材空间单独判断
  const c = evaluateBuild({ PSU: { specs: { psuLengthMm: 180, psuFormFactor: 'ATX', modular: '全模组', ratedWatts: 850 } }, CASE: { specs: { maxPsuLengthMm: 190, supportedPsuFormats: ['ATX'] } } });
  assert.equal(c.find(x => x.id === 'psuCable').status, 'UNKNOWN'); assert.match(c.find(x => x.id === 'psuCable').detail, /剩余 10mm/);
});

// ---------- 10–12 附件 ----------
test('10 机箱与主板风扇接口容量', () => {
  const pc = { fanMounts: fans };
  const enough = accessoryCost({ cpuW: 150, gpuW: 300, pc, board: { fanHeaders: 6 }, cooler: { fanCount: 1 } });
  assert.ok(!enough.required.some(r => r.id === 'fan-hub'));
  const short = accessoryCost({ cpuW: 150, gpuW: 300, pc, board: { fanHeaders: 2 }, cooler: { fanCount: 2 } });
  const hub = short.required.find(r => r.id === 'fan-hub');
  assert.equal(hub.headersNeeded, 5); assert.equal(hub.priceCents, 4000); assert.equal(hub.priceSource, 'estimate');
  const unknown = accessoryCost({ cpuW: 150, gpuW: 300, pc, board: {} });
  const u = unknown.required.find(r => r.id === 'fan-hub');
  assert.equal(u.priceCents, 0); assert.deepEqual(u.estimatedRangeCents, [0, 4000]); assert.equal(unknown.priceStatus, 'estimated');
  const fan = short.required.find(r => r.id === 'case-fans');
  assert.equal(fan.sizeMm, 120); assert.equal(fan.positions.length, fan.quantity); assert.equal(fan.modelStatus, 'unspecified');
});

test('11 风扇及集线器成本分类：已确认 / 估算 / 未知', () => {
  const acc = accessoryCost({ cpuW: 150, gpuW: 300, pc: { fanMounts: fans }, board: { fanHeaders: 2 }, pricing: { fanUnitCents: 2000 } });
  const cb = costBreakdown(100000, acc);
  assert.equal(cb.confirmedAccessoriesCents, acc.required.find(r => r.id === 'case-fans').priceCents);
  assert.equal(cb.estimatedAccessoriesCents, 4000, '集线器为估算价');
  assert.equal(cb.completeBuildCents, 100000 + acc.requiredCents);
  assert.match(cb.totalLabel, /估算总价/);
  const withUnknown = costBreakdown(100000, accessoryCost({ cpuW: 150, gpuW: 300, pc: { fanMounts: fans }, board: {} }));
  assert.equal(withUnknown.contingentAccessoriesMaxCents, 4000);
});

test('12 原装散热器包装 SKU 未确认：备用散热成本进入区间，严格预算按上限判断', () => {
  const acc = accessoryCost({ cpuW: 88, gpuW: 0, pc: { fanMounts: fans }, board: { fanHeaders: 4 }, stock: { confirmed: false, fallbackCents: 9900 } });
  const c = acc.required.find(r => r.id === 'stock-cooler-contingency');
  assert.equal(c.priceCents, 0); assert.deepEqual(c.estimatedRangeCents, [0, 9900]); assert.equal(acc.priceStatus, 'estimated');
  assert.ok(!accessoryCost({ cpuW: 88, gpuW: 0, pc: { fanMounts: fans }, board: { fanHeaders: 4 }, stock: { confirmed: true } }).required.some(r => r.id === 'stock-cooler-contingency'));
  // 正式引擎：原装散热方案的区间上限含备用散热器；严格预算下目标落在估算价与上限之间时不入选
  const items = catalog();
  const loose = optimizePlans(items, { budgetCents: 600000, scenarios: ['office'], tierRatios: { balanced: 1 } }).plans[0];
  if (loose.stockCooler && !loose.infeasible) {
    const hi = loose.costBreakdown.estimatedRangeCents[1];
    assert.ok(hi > loose.totalCents, '上限含备用散热器');
    const target = Math.floor((loose.totalCents + hi) / 2 / 100) * 100;
    const strict = optimizePlans(items, { budgetCents: target, scenarios: ['office'], tierRatios: { balanced: 1 }, maxOverPercent: 0 }).plans[0];
    const total = strict.infeasible ? null : strict.costBreakdown.estimatedRangeCents[1];
    assert.ok(strict.infeasible || total <= strict.targetCents, '严格预算不把区间上限超标的方案标为预算内');
  }
});

// ---------- 13–14 内存与 SSD ----------
test('13 主板内存频率数据优先，未录入时不按同平台普遍值确认', () => {
  const cpu = { cpuMemoryMaxMTs: 7200, cpuMemoryMaxMTsByType: { DDR5: 7200 } };
  const ram = { memoryType: 'DDR5', speedMTs: 6400, modules: 2 };
  const none = memorySpeedCheck(cpu, {}, ram);
  assert.equal(none.status, 'UNKNOWN'); assert.match(none.detail, /主板内存上限 \/ QVL 未录入/); assert.doesNotMatch(none.detail, /同平台/);
  assert.equal(memorySpeedCheck(cpu, { memoryMaxMTs: 6400 }, ram).status, 'CONDITIONAL', '主板官方 6400');
  assert.equal(memorySpeedCheck(cpu, { memoryMaxMTs: 6000 }, ram).status, 'CONDITIONAL', '高于主板上限：按上限运行的条件项');
  assert.match(memorySpeedCheck(cpu, { memoryMaxMTs: 6000 }, ram).detail, /高于已知上限 6000/);
  assert.equal(memorySpeedCheck(cpu, { memoryMaxMTs: 6400, memoryQvl: [{ sku: 'K1', modules: 2, rank: 1, speedMTs: 6400 }] }, { ...ram, rank: 1, jedecMTs: 6400 }, 'K1').status, 'PASS', '主板 QVL 命中');
});

test('14 SSD 插槽级链路：预计链路、CPU 限制、共享通道', () => {
  const board = { m2Links: [
    { slot: 'M2_1', source: 'CPU', protocol: 'NVME', gen: 5, lanes: 4, sharedLanes: ['与 PCIe x16 第二槽共享'] },
    { slot: 'M2_2', source: 'PCH', protocols: ['NVME'], gen: 4, lanes: 4, lengths: [2280] },
  ] };
  const r = pcieLink({ storagePcieLink: { gen: 5, lanes: 4 } }, board, { pcieLink: { gen: 5, lanes: 4 } }, { storage: true });
  assert.equal(r.slot, 'M2_1'); assert.equal(r.status, 'CONDITIONAL', '共享通道为条件项'); assert.match(r.detail, /预计协商链路/); assert.match(r.detail, /共享/);
  const long = pcieLink({ storagePcieLink: { gen: 4, lanes: 4 } }, { m2Links: [board.m2Links[1]] }, { pcieLink: { gen: 4, lanes: 4 }, m2Length: 22110 }, { storage: true });
  assert.equal(long.status, FAIL, '22110 SSD 装不进只支持 2280 的插槽');
  const checks = evaluateBuild({ CPU: { specs: { storagePcieLink: { gen: 4, lanes: 4 }, pcieLink: { gen: 4, lanes: 16 } } }, MOTHERBOARD: { specs: { ...board, gpuPcieLink: { gen: 5, lanes: 16 }, m2Slots: 2 } }, SSD: { specs: { interface: 'M.2 PCIe 5.0 x4', pcieLink: { gen: 5, lanes: 4 } } }, GPU: { specs: { pcieLink: { gen: 5, lanes: 16 } } } });
  assert.equal(checks.find(c => c.id === 'ssdPcie').label, 'SSD 预计 PCIe 链路');
  assert.equal(checks.find(c => c.id === 'pcie').label, '显卡预计 PCIe 链路');
});

// ---------- 15 数据补丁 ----------
test('15 数据补丁导入、冲突检测及回滚', t => {
  const dir = mkdtempSync(join(tmpdir(), 'pc-patch-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const overlayPath = join(dir, 'overlay.json');
  const items = [{ id: 'case-x', category: 'CASE', name: '测试机箱 X', mpn: 'CX-1', specs: { maxGpuLengthMm: 400 } }, { id: 'psu-y', category: 'PSU', name: '测试电源 Y G13MG', mpn: 'PY-1', specs: {} }];
  const base = { source_url: 'https://example.com/spec', source_type: 'manufacturer', observed_at: '2026-11-20T00:00:00Z', verified_at: '2026-11-25T00:00:00Z', confidence: 'high', verification_status: 'verified' };
  const patch = { id: 'p1', records: [
    { ...base, op: 'UPDATE', component_id: 'case-x', category: 'CASE', field_path: 'specs.gpuCableClearanceMm', old_value: null, new_value: 195, unit: 'mm' },
    { ...base, op: 'UPDATE', component_id: 'case-x', category: 'CASE', field_path: 'specs.maxGpuLengthMm', old_value: 380, new_value: 410, unit: 'mm' }, // old_value 与当前 400 不符 → 冲突
    { ...base, op: 'UPDATE', category: 'PSU', manufacturer_model: '测试电源 Y', manufacturer_sku: 'PY-1', hardware_revision: 'G13MG', field_path: 'specs.connectorPowerRating', new_value: 600, unit: 'W' },
    { ...base, op: 'UPDATE', component_id: 'psu-y', category: 'PSU', hardware_revision: 'REV 2.0', field_path: 'specs.native12v2x6', new_value: true }, // 版本无法确认 → 冲突
    { ...base, op: 'ADD', category: 'COOLER', manufacturer_model: '新散热器 Z', manufacturer_sku: 'CZ-9', field_path: 'specs.heatPipes', new_value: 6 },
    { ...base, op: 'UNRESOLVED', component_id: 'case-x', category: 'CASE', field_path: 'specs.frontIntake', notes: '官网未写前面板结构' },
    { ...base, op: 'UPDATE', component_id: 'case-x', category: 'CASE', field_path: 'specs.connectorPowerRating', new_value: 500 }, // 校验失败（非标准等级）
  ] };
  assert.deepEqual(validateRecord({ op: 'UNRESOLVED', category: 'CASE', component_id: 'x', field_path: 'specs.maxGpuHeightMm', new_value: 1 }).length > 0, true, 'UNRESOLVED 不能写值');
  const dry = applyPatch(patch, { catalogItems: items, overlayPath, dryRun: true });
  assert.equal(loadOverlay(overlayPath).patches.length, 0, 'dry-run 不写文件');
  const r = applyPatch(patch, { catalogItems: items, overlayPath });
  assert.equal(dry.applied.length, r.applied.length);
  assert.equal(r.applied.length, 3); assert.equal(r.conflicts.length, 2); assert.equal(r.unresolved.length, 1); assert.equal(r.rejected.length, 1);
  assert.match(r.conflicts.find(c => c.record.field_path === 'specs.maxGpuLengthMm').reason, /old_value/);
  assert.match(r.conflicts.find(c => c.record.hardware_revision === 'REV 2.0').reason, /硬件版本/);
  const view = overlayView(loadOverlay(overlayPath));
  assert.equal(view.updates.get('case-x').gpuCableClearanceMm, 195); assert.equal(view.updates.get('psu-y').connectorPowerRating, 600);
  assert.equal(view.added.length, 1); assert.equal(view.added[0].specs.heatPipes, 6);
  assert.throws(() => applyPatch(patch, { catalogItems: items, overlayPath }), /已应用/);
  // 覆盖层进入运行时目录（空目录 + 覆盖层；合成数据不写入正式目录）
  const cat = createCatalog(dir, {}, { patchOverlay: overlayPath });
  assert.ok(cat.all().some(i => i.dataSource === 'patch' && i.name === '新散热器 Z'));
  // 回滚
  const rb = rollbackPatch('p1', { overlayPath });
  assert.equal(rb.records, 3); assert.equal(loadOverlay(overlayPath).patches.length, 0);
  assert.equal(overlayView(loadOverlay(overlayPath)).updates.size, 0);
  writeFileSync(join(dir, 'noop'), '');
});

// ---------- 16 以前关键问题 ----------
test('16 以前全部关键问题回归：高端不降档、风扇计价、散热不按尺寸、16pin 不用散热限高', () => {
  const p = run(catalog(), 22000);
  assert.ok(pick(p, 'GPU').specs.capacityGB >= 24);
  assert.ok(p.additionalCosts.some(c => c.id === 'case-fans'));
  assert.ok(!/塔高.*足以|按散热器尺寸/.test(check(p, 'cpuCooling')?.detail ?? ''));
  const cable = check(p, 'gpuCable');
  assert.ok(!/按散热器限高.*推断/.test(cable.detail));
  assert.ok(p.diagnostics.generatedAt && p.diagnostics.dataSnapshotId && p.diagnostics.rulesVersion === '2.2.3');
  assert.equal(p.diagnostics.constraints.budgetCents, 2200000);
  assert.ok(Array.isArray(p.diagnostics.risks));
});
