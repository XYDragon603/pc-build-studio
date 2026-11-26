// V2.2.2 回归测试：散热证据、必需附件成本、电源接口与 Rev 版本、16pin 空间、SSD 插槽链路、NAND、内存规格与边际收益。
// 全部调用正式模块与正式推荐引擎 optimizePlans（与 POST /api/v1/plans 同一入口），不另写演示函数。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { evaluateBuild, FAIL, gpuCableClearance, gpuPowerCheck, psuConnectors, radiatorLayoutCheck } from '../src/compat-rules.mjs';
import { coolerThermalCheck, gpuPowerWatts, memorySpeedCheck, pcieLink, stockCooler, sustainedPower } from '../src/hardware-specs.mjs';
import { capacityCovers, coolingCapacity } from '../src/thermal-evidence.mjs';
import { accessoryCost, fanMountCapacity } from '../src/accessories.mjs';
import { correctHardware, revisionMatches } from '../src/catalog-corrections.mjs';
import { enrichSpecs, nandBitsPerCell } from '../src/specs-enrich.mjs';
import { memoryValue, optimizePlans } from '../src/optimizer.mjs';
import { corePerformance } from '../src/recommendation-strategy.mjs';
import { MIN_REQUIREMENTS, SCORING_PROFILES } from '../src/scoring-profiles.mjs';

const measured = (watts, socket = 'LGA1851') => [{ kind: 'measured', powerWatts: watts, cpu: '测试 CPU', cpuSocket: socket, ambientC: 25, maxTempC: 88, tempLimitC: 105, durationMinutes: 30, sourceUrl: 'https://example.com/cooler-test' }];
const status = (checks, id) => checks.find(c => c.id === id);

// ---------- 合成目录（正式引擎） ----------
let seq = 0;
const item = (category, yuan, name, specs, extra = {}) => ({ id: `${category.toLowerCase()}-${++seq}`, category, name, specs, estimatedPriceCents: yuan * 100,
  priceConfidence: 'high', productStatus: 'new', market: 'cn', ...extra });
const perf = (gaming, blender) => ({ performance: { gaming: { index: gaming }, blender: { score: blender } } });
function catalog({ fanCase = {} } = {}) {
  seq = 0;
  return [
    item('CPU', 1300, 'AMD Ryzen 5 7600', { socket: 'AM5', memoryType: 'DDR5', maxPowerWatts: 88, basePowerWatts: 65, packaging: '盒装', stockCoolerIncluded: true }, perf(70, 230)),
    item('CPU', 1700, 'Intel Core Ultra 7 270K Plus', { socket: 'LGA1851', memoryType: 'DDR5', maxPowerWatts: 250, basePowerWatts: 125, packaging: '盒装', stockCoolerIncluded: false }, perf(85, 480)),
    item('GPU', 3500, 'RTX 5060 Ti 16G', { chipset: 'GeForce RTX 5060 Ti', capacityGB: 16, lengthMm: 250, heightMm: 120, slotWidth: 2, boardPowerWatts: 180, powerPins: { pin8: 1 } }, perf(52, 3600)),
    item('GPU', 14000, 'RTX 4090 D', { chipset: 'GeForce RTX 4090 D', capacityGB: 24, lengthMm: 300, heightMm: 140, slotWidth: 3, boardPowerWatts: 425, powerPins: { pin16: 1 } }, perf(100, 9000)),
    item('GPU', 18000, 'RTX 5090 D', { chipset: 'GeForce RTX 5090 D', capacityGB: 32, lengthMm: 320, heightMm: 145, slotWidth: 3, boardPowerWatts: 575, powerPins: { pin16: 1 } }, perf(120, 12000)),
    item('MOTHERBOARD', 900, 'B650M', { socket: 'AM5', chipset: 'B650', memoryType: 'DDR5', formFactor: 'MICRO ATX', memorySlots: 4, maxMemoryGB: 192, m2Slots: 2, pcieGen: 4, videoOutputs: true, fanHeaders: 6 }),
    item('MOTHERBOARD', 1100, 'B860', { socket: 'LGA1851', chipset: 'B860', memoryType: 'DDR5', formFactor: 'ATX', memorySlots: 4, maxMemoryGB: 192, m2Slots: 2, pcieGen: 5, videoOutputs: true, fanHeaders: 6 }),
    item('RAM', 700, 'DDR5 32GB', { memoryType: 'DDR5', capacityGB: 32, modules: 2, speedMTs: 6000 }),
    item('RAM', 1300, 'DDR5 64GB', { memoryType: 'DDR5', capacityGB: 64, modules: 2, speedMTs: 6000 }),
    item('SSD', 400, 'NVMe 1TB', { capacityGB: 1000, interface: 'M.2 PCIe 4.0 x4', nand: 'TLC' }),
    item('SSD', 1500, 'NVMe 4TB', { capacityGB: 4000, interface: 'M.2 PCIe 4.0 x4', nand: 'TLC' }),
    item('PSU', 600, '750W', { ratedWatts: 750, efficiency: '金牌', atxVersion: '3.1', rail12vAmps: 62, pcie8Count: 3, native16Pin: true, connectorPowerRating: 450, psuFormFactor: 'ATX', psuLengthMm: 140, warrantyYears: 10, protections: ['OVP', 'OCP', 'OPP', 'SCP', 'OTP', 'UVP'] }),
    item('PSU', 1200, '1200W', { ratedWatts: 1200, efficiency: '白金', atxVersion: '3.1', rail12vAmps: 100, pcie8Count: 6, native12v2x6: true, connectorPowerRating: 600, psuFormFactor: 'ATX', psuLengthMm: 160, warrantyYears: 10, protections: ['OVP', 'OCP', 'OPP', 'SCP', 'OTP', 'UVP'] }),
    item('COOLER', 99, '单塔 4 热管 155mm', { sockets: ['AM5', 'LGA1851'], heightMm: 155, heatPipes: 4 }),
    item('COOLER', 300, '双塔 6 热管 158mm（实测 260W）', { sockets: ['AM5', 'LGA1851'], heightMm: 158, heatPipes: 6, thermalTests: measured(260) }),
    item('CASE', 200, 'ATX 机箱', { supportedBoardFormats: ['ATX', 'MICRO ATX'], maxGpuLengthMm: 400, maxCoolerHeightMm: 170, gpuCableClearanceMm: 200, supportedPsuFormats: ['ATX'], expansionSlots: 7,
      fanMounts: [{ position: 'front', count: 3, sizeMm: 120 }, { position: 'rear', count: 1, sizeMm: 120 }], intakePositions: ['front'], exhaustPositions: ['rear'], ...fanCase }),
  ];
}
const run = (items, budget, extra = {}) => optimizePlans(items, { budgetCents: budget * 100, scenarios: ['ai'], ...extra });
const pick = (plan, slot) => plan.picks.find(p => p.slot === slot)?.item;

// ---------- 1–4 散热 ----------
test('01 相同高度的不同散热器不能默认拥有相同散热能力', () => {
  const cpu = { socket: 'LGA1851', maxPowerWatts: 250, basePowerWatts: 125 };
  const plain = { heightMm: 155 };
  const pipes = { heightMm: 155, heatPipes: 4 };
  const tested = { heightMm: 155, heatPipes: 6, thermalTests: measured(260) };
  assert.equal(coolingCapacity(plain).watts, 0, '只有塔高：没有任何散热能力依据');
  assert.equal(coolingCapacity(pipes).watts, 125, '4 热管：只到低功耗工程判断');
  assert.equal(coolerThermalCheck(cpu, plain, {}).status, 'UNKNOWN');
  assert.equal(coolerThermalCheck(cpu, pipes, {}).status, 'UNKNOWN');
  assert.equal(coolerThermalCheck(cpu, tested, {}).status, 'CONDITIONAL');
  // 塔高变化不影响能力
  assert.deepEqual(coolingCapacity({ heightMm: 120, heatPipes: 4 }).watts, coolingCapacity({ heightMm: 170, heatPipes: 4 }).watts);
});

test('02 缺少高功耗散热依据时不得声称覆盖 250W', () => {
  const cpu = { socket: 'LGA1851', maxPowerWatts: 250, basePowerWatts: 125 };
  const vendor240 = { heightMm: 155, vendorCoolingWatts: 240, coolingEvidence: { sourceUrl: 'https://www.deepcool.com/x' } };
  const r = coolerThermalCheck(cpu, vendor240, {});
  assert.equal(r.status, 'UNKNOWN'); assert.equal(r.critical, true);
  assert.match(r.detail, /必须有实测/); assert.match(r.detail, /≤200W/);
  assert.equal(r.evidence.powerLimitOptionW, 200, '给出降功耗运行条件（限制到厂商标称可用的 200W）');
  const checks = evaluateBuild({ CPU: { name: '270K Plus', specs: cpu }, COOLER: { specs: { ...vendor240, sockets: ['LGA1851'] } } });
  assert.equal(status(checks, 'cpuCooling').blocking, true, '整机为关键待核实');
  // ≤200W 时厂商标称可作为条件依据
  assert.equal(coolerThermalCheck({ socket: 'AM5', maxPowerWatts: 162 }, vendor240, {}).status, 'CONDITIONAL');
});

test('03 270W 持续负载需要独立散热证据或功耗限制', () => {
  const cpu = { socket: 'AM5', maxPowerWatts: 270, basePowerWatts: 170 };
  const cooler = { heatPipes: 6, thermalTests: measured(260, 'AM5') };
  const open = coolerThermalCheck(cpu, cooler, {});
  assert.equal(open.status, 'UNKNOWN'); assert.equal(open.evidence.powerLimitOptionW, 260);
  assert.match(open.detail, /限制到 ≤260W/);
  assert.equal(coolerThermalCheck(cpu, cooler, {}, {}, { cpuPowerLimitWatts: 250 }).status, 'CONDITIONAL', '明确限功耗到证据覆盖范围内');
  assert.equal(coolerThermalCheck(cpu, { heatPipes: 7, thermalTests: measured(280, 'AM5') }, {}).status, 'CONDITIONAL');
});

test('04 选择水冷时重新校核冷排位置、厚度与显卡空间', () => {
  const aio = { radiatorSizeMm: 360, radiatorThicknessMm: 27 };
  const frontOnly = { maxGpuLengthMm: 380, radiatorPositions: [{ position: 'front', sizesMm: [240, 360] }] };
  assert.equal(radiatorLayoutCheck(aio, frontOnly, { lengthMm: 340 }).status, FAIL, '380 − 27 − 25 = 328mm < 340mm');
  assert.equal(radiatorLayoutCheck(aio, frontOnly, { lengthMm: 300 }).status, 'CONDITIONAL');
  assert.equal(radiatorLayoutCheck({ radiatorSizeMm: 360 }, frontOnly, { lengthMm: 300 }).status, 'UNKNOWN', '冷排厚度未知不套用典型值');
  assert.equal(radiatorLayoutCheck(aio, { radiatorPositions: [{ position: 'top', sizesMm: [240] }] }, { lengthMm: 300 }).status, FAIL, '顶部只支持 240');
  const top = radiatorLayoutCheck(aio, { radiatorPositions: [{ position: 'top', sizesMm: [360] }] }, { lengthMm: 300 });
  assert.equal(top.status, 'CONDITIONAL'); assert.match(top.detail, /内存/);
  assert.equal(radiatorLayoutCheck(aio, {}, null).status, 'UNKNOWN');
});

// ---------- 5–9 电源与 16pin ----------
test('05 电源原生 16pin 字段正确传递到兼容性模块', () => {
  const gpu = { name: '5090 D', specs: { boardPowerWatts: 575, powerPins: { pin16: 1 } } };
  const ok = evaluateBuild({ GPU: gpu, PSU: { specs: { native12v2x6: true, connectorPowerRating: 600, pcie8pinConnectors: 6 } } });
  assert.equal(status(ok, 'gpuPower').status, 'PASS');
  const weak = evaluateBuild({ GPU: gpu, PSU: { specs: { native12vhpwr: true, connectorPowerRating: 450 } } });
  assert.equal(status(weak, 'gpuPower').status, FAIL);
  assert.equal(psuConnectors({ pcie8Count: 8 }).native16, null, '只记录 8pin 时原生接口未知，不默认没有');
  assert.equal(psuConnectors({ native12v2x6: false, native12vhpwr: false }).native16, false);
});

test('06 不同电源 Rev 版本不能错误合并', () => {
  const record = { id: 'gw-g13mg-5194268', requiresRevision: ['G13MG', '5194268'] };
  assert.equal(revisionMatches(record, { name: '长城G13 GW-ATX1300BL', mpn: 'GW-ATX1300BL' }), false);
  assert.equal(revisionMatches(record, { name: '长城 GW-ATX1300BL G13MG 金牌全模组' }), true);
  const old = correctHardware({ id: 'x-old', category: 'PSU', name: '长城G13 GW-ATX1300BL', mpn: 'GW-ATX1300BL', specs: { pcie8Count: 8 } });
  assert.equal(old.specs.native12v2x6, undefined, '旧版条目不得合并 G13MG 的原生 16pin');
  assert.ok(old.skippedCorrections?.length, '跳过的修正有记录');
  const mg = correctHardware({ id: 'x-new', category: 'PSU', name: '长城 GW-ATX1300BL G13MG', mpn: 'GW-ATX1300BL', specs: {} });
  assert.equal(mg.specs.native12v2x6, true); assert.equal(mg.specs.manufacturerSku, '5194268');
});

test('07 独立 PCIe 线材与插头数量分别判断', () => {
  const gpu = { boardPowerWatts: 575, powerPins: { pin16: 1 } };
  const base = { native16Pin: false, pcie8pinConnectors: 8 };
  assert.equal(gpuPowerCheck(gpu, { ...base, independentPcieCables: 2 }).status, FAIL, '8 个插头但只有 2 根线，不能凑出 4 根独立线');
  assert.equal(gpuPowerCheck(gpu, { ...base, independentPcieCables: 4 }).status, 'CONDITIONAL');
  assert.equal(gpuPowerCheck(gpu, base).status, 'UNKNOWN', '线材数量未知');
  const triple = { boardPowerWatts: 350, powerPins: { pin8: 3 } };
  assert.equal(gpuPowerCheck(triple, { pcie8Count: 4, independentPcieCables: 2 }).status, 'CONDITIONAL');
  assert.equal(gpuPowerCheck(triple, { pcie8Count: 4, independentPcieCables: 4 }).status, 'PASS');
  assert.match(gpuPowerCheck(gpu, { ...base, independentPcieCables: 4 }).detail, /禁止混用/);
});

test('08 高功耗显卡供电空间不足或证据缺失时保持阻断', () => {
  const gpu = { heightMm: 148, boardPowerWatts: 575, powerPins: { pin16: 1 } };
  const tight = gpuCableClearance(gpu, { gpuCableClearanceMm: 185 });
  assert.equal(tight.status, 'UNKNOWN'); assert.equal(tight.critical, true, '理论余量 2mm 为关键待核实');
  assert.equal(gpuCableClearance(gpu, { gpuCableClearanceMm: 170 }).status, FAIL);
  assert.equal(gpuCableClearance(gpu, { gpuCableClearanceMm: 200 }).status, 'CONDITIONAL');
  assert.equal(gpuCableClearance({ ...gpu, requiredCableClearanceMm: 190 }, { gpuCableClearanceMm: 205 }).status, 'PASS', '厂商要求优先于 35mm 参考值');
  const checks = evaluateBuild({ GPU: { specs: gpu }, CASE: { specs: { maxGpuLengthMm: 400, maxCoolerHeightMm: 185 } } });
  assert.equal(status(checks, 'gpuCable').blocking, true);
});

test('09 CPU 散热限高不得直接等同于 GPU 供电线空间', () => {
  const gpu = { heightMm: 147.6, boardPowerWatts: 450, powerPins: { pin16: 1 } };
  const r = gpuCableClearance(gpu, { maxCoolerHeightMm: 230 });
  assert.equal(r.status, 'UNKNOWN', '即使散热限高很大，也不能确认供电线空间');
  assert.match(r.detail, /测量基准不同/); assert.match(r.detail, /非统一官方要求/);
  // 小功率 16pin 卡同样未知，但不是关键阻断
  assert.equal(gpuCableClearance({ heightMm: 120, boardPowerWatts: 200 }, { maxCoolerHeightMm: 230 }).critical, false);
});

// ---------- 10–12 附件成本 ----------
test('10 必需机箱风扇费用进入完整总价，严格预算按完整总价判断', () => {
  const items = catalog();
  const plans = run(items, 9000).plans.filter(p => !p.infeasible);
  assert.ok(plans.length);
  for (const p of plans) {
    const core = p.picks.reduce((s, x) => s + x.item.estimatedPriceCents, 0);
    assert.equal(p.coreTotalCents, core);
    assert.equal(p.totalCents, core + p.additionalCosts.reduce((s, x) => s + x.priceCents, 0));
    assert.equal(p.costBreakdown.completeBuildCents, p.totalCents);
    assert.ok(p.additionalCosts.find(c => c.id === 'case-fans').quantity >= 2, '预装风扇未知：按另购计价');
    assert.equal(p.assessment.budget === 'met', false, '附件价格为估算时不标为无条件满足');
  }
  // 严格预算：目标落在“核心价”和“完整价”之间时，不能算预算内
  const best = run(items, 9000, { tierRatios: { balanced: 1 } }).plans[0];
  const target = Math.ceil((best.coreTotalCents + 100) / 10000) * 10000;
  if (target < best.totalCents) {
    const strict = run(items, target / 100, { tierRatios: { balanced: 1 }, maxOverPercent: 0 }).plans[0];
    assert.ok(strict.infeasible || strict.totalCents <= target);
  }
});

test('11 原装散热器包装状态未知时按另购散热器计价', () => {
  const boxed = { name: 'AMD Ryzen 5 7600', specs: { stockCoolerIncluded: true, packaging: '盒装' } };
  assert.equal(stockCooler(boxed), true);
  assert.equal(stockCooler({ ...boxed, specs: { stockCoolerIncluded: true } }), false, '包装未知：不按原装散热计 0 元');
  assert.equal(stockCooler({ ...boxed, specs: { stockCoolerIncluded: true, packaging: '散片' } }), false);
  const items = catalog().map(i => (i.name === 'AMD Ryzen 5 7600' ? { ...i, specs: { ...i.specs, packaging: undefined } } : i));
  const locked = { CPU: items[0] };
  const p = run(items, 9000, { locked: { CPU: { ...locked.CPU, priceCents: locked.CPU.estimatedPriceCents } }, scenarios: ['2k'] }).plans.find(p => !p.infeasible);
  assert.equal(p.stockCooler, false); assert.ok(pick(p, 'COOLER'), '另购的散热器计入总价');
});

test('12 修改附件数量与单价后重新计算预算', () => {
  const pc = { fanMounts: [{ position: 'front', count: 3, sizeMm: 120 }, { position: 'rear', count: 1, sizeMm: 120 }] };
  const est = accessoryCost({ cpuW: 250, gpuW: 575, pc, board: { fanHeaders: 6 } });
  // 2.2.3：主板风扇接口数量未知时，集线器只进入区间上限（¥40），不计入估算总价
  const noHeaders = accessoryCost({ cpuW: 250, gpuW: 575, pc });
  assert.equal(noHeaders.requiredCents, 12000); assert.deepEqual(noHeaders.rangeCents, [6000, 16000]);
  assert.equal(est.additionalFans, 4); assert.equal(est.priceStatus, 'estimated'); assert.deepEqual(est.rangeCents, [6000, 12000]);
  const user = accessoryCost({ cpuW: 250, gpuW: 575, pc, pricing: { fanUnitCents: 1000 } });
  assert.equal(user.requiredCents, 4000);
  const included = accessoryCost({ cpuW: 250, gpuW: 575, pc: { ...pc, includedFans: 3 }, board: { fanHeaders: 6 }, pricing: { fanUnitCents: 1000 } });
  assert.equal(included.additionalFans, 1); assert.equal(included.requiredCents, 1000); assert.equal(included.priceStatus, 'known');
  assert.deepEqual(fanMountCapacity({ fanMounts: [{ position: 'front', count: 3, sizeMm: 120 }, { position: 'front', count: 2, sizeMm: 140 }, { position: 'rear', count: 1, sizeMm: 120 }] }), { intake: 3, exhaust: 1 }, '同位置不同尺寸二选一，不相加');
  // 正式引擎：改单价后完整总价随之变化
  const items = catalog();
  const a = run(items, 30000, { tierRatios: { balanced: 1 }, strategy: 'performance', accessoryPricing: { fanUnitCents: 1000 } }).plans[0];
  const b = run(items, 30000, { tierRatios: { balanced: 1 }, strategy: 'performance', accessoryPricing: { fanUnitCents: 5000 } }).plans[0];
  const fans = a.additionalCosts.find(c => c.id === 'case-fans');
  assert.equal(fans.unitPriceCents, 1000); assert.equal(fans.priceSource, 'user');
  assert.equal(b.totalCents - b.coreTotalCents, b.additionalCosts.find(c => c.id === 'case-fans').quantity * 5000);
  // 单价已确认但机箱预装数量未知（按 0 个计）：数量仍是假设，状态保持“含估算”
  assert.equal(a.assessment.budget, 'met_with_estimated_accessories');
  const known = run(catalog({ fanCase: { includedFans: 4 } }), 30000, { tierRatios: { balanced: 1 }, strategy: 'performance' }).plans[0];
  assert.equal(known.additionalCosts.length, 0); assert.equal(known.assessment.budget, 'met', '预装风扇已满足需求：没有估算附件');
});

// ---------- 13–16 存储与内存 ----------
test('13 SSD 具体插槽及预计 PCIe 链路', () => {
  const board = { m2Links: [
    { slot: 'M2_1', source: 'CPU', protocol: 'NVME', gen: 5, lanes: 4 },
    { slot: 'M2_2', source: 'PCH', protocols: ['NVME', 'SATA'], gen: 4, lanes: 4, cpuDependentLimits: [{ cpuPattern: 'RYZEN\\s*5\\s*8500', effect: 'disabled' }] },
  ] };
  const gen5 = { pcieLink: { gen: 5, lanes: 4 } };
  const r = pcieLink({ storagePcieLink: { gen: 5, lanes: 4 } }, board, gen5, { storage: true });
  assert.equal(r.status, 'PASS'); assert.equal(r.slot, 'M2_1'); assert.match(r.detail, /预计协商链路.*非装机实测/);
  // CPU 只有 PCIe 3.0 存储链路：芯片组插槽不受 CPU 存储链路限制，选 M2_2 的 4.0 ×4
  const old = pcieLink({ storagePcieLink: { gen: 3, lanes: 4 } }, board, gen5, { storage: true });
  assert.equal(old.slot, 'M2_2'); assert.equal(old.gen, 4); assert.equal(old.status, 'CONDITIONAL');
  // 依赖 CPU 的禁用：Ryzen 5 8500 下 M2_2 不可用
  const apu = pcieLink({ storagePcieLink: { gen: 3, lanes: 4 } }, board, gen5, { storage: true, cpuName: 'AMD Ryzen 5 8500G' });
  assert.equal(apu.slot, 'M2_1'); assert.equal(apu.gen, 3);
  // M.2 SATA 只能用支持 SATA 的插槽
  assert.match(pcieLink({}, board, { interface: 'M.2 SATA', m2Protocol: 'SATA' }, { storage: true }).detail, /M2_2/);
  assert.equal(pcieLink({}, { m2Links: [board.m2Links[0]] }, { m2Protocol: 'SATA' }, { storage: true }).status, FAIL);
  // 只有接口数量没有插槽数据：说明缺什么
  const unknown = pcieLink({ storagePcieLink: { gen: 4, lanes: 4 } }, { m2Slots: 2 }, gen5, { storage: true });
  assert.equal(unknown.status, 'UNKNOWN'); assert.match(unknown.detail, /插槽级数据/);
  // 端点规格来自 ZOL “通道”
  const e = enrichSpecs({ category: 'SSD', name: 'x', specs: { interface: 'M.2 PCIe' }, rawParams: { 通道: 'Gen4×4', 接口类型: 'M.2 PCIe接口', 闪存架构: 'TLC三层单元' } });
  assert.deepEqual(e.pcieLink, { gen: 4, lanes: 4 });
});

test('14 NAND 类型按每单元比特数规范化', () => {
  assert.equal(nandBitsPerCell('Samsung V-NAND 3-bit TLC'), 3);
  assert.equal(nandBitsPerCell('三星 V-NAND 3bit MLC'), 3, '三星 3-bit MLC 是 TLC');
  assert.equal(nandBitsPerCell('MLC多层单元'), 2);
  assert.equal(nandBitsPerCell('QLC多层单元'), 4);
  assert.equal(nandBitsPerCell('TLC三层单元/QLC四层单元'), null, '多值不猜');
  const e = enrichSpecs({ category: 'SSD', name: '三星990 PRO NVMe M.2（4TB）', specs: {}, rawParams: { 闪存架构: 'MLC多层单元' } });
  assert.equal(e.nandVendorTerm, 'MLC多层单元', '保留厂商 / 来源原始术语');
  const fixed = correctHardware({ id: 'zol-1425887', category: 'SSD', name: '三星990 PRO NVMe M.2（4TB）', specs: e });
  assert.equal(fixed.specs.bitsPerCell, 3); assert.equal(fixed.specs.nand, 'TLC');
  assert.match(fixed.specCorrection.sourceUrl, /news\.samsung\.com/);
});

test('15 CPU 内存规格与组合稳定性判断分离', () => {
  const cpu = { cpuMemoryMaxMTs: 7200, cpuMemoryMaxMTsByType: { DDR5: 7200 } };
  const r = memorySpeedCheck(cpu, {}, { memoryType: 'DDR5', speedMTs: 6400, modules: 2 });
  assert.equal(r.status, 'UNKNOWN');
  assert.match(r.factors.cpuSpec, /7200/); assert.match(r.factors.boardSpec, /未录入/); assert.match(r.factors.jedec, /未知/); assert.match(r.factors.stability, /未验证/);
  assert.match(r.detail, /CPU 规格已知/);
  // 2.2.3：主板数据缺失时不再按“同平台普遍 6000”放行；有主板上限后为条件项
  assert.equal(memorySpeedCheck(cpu, {}, { memoryType: 'DDR5', speedMTs: 6000, modules: 2 }).status, 'UNKNOWN');
  const ok = memorySpeedCheck(cpu, { memoryMaxMTs: 6400 }, { memoryType: 'DDR5', speedMTs: 6000, modules: 2 });
  assert.equal(ok.status, 'CONDITIONAL'); assert.match(ok.detail, /不保证一定开机或稳定/);
  assert.equal(memorySpeedCheck(cpu, { memoryMaxMTs: 8000 }, { memoryType: 'DDR5', speedMTs: 6400, modules: 2 }).status, 'CONDITIONAL');
  // 250KF Plus：修正数据带来官方 7200（不再显示未知）
  const kf = correctHardware({ id: 'zol-2179677', category: 'CPU', name: 'Intel 酷睿 Ultra 5 250KF Plus', specs: enrichSpecs({ category: 'CPU', name: 'Intel 酷睿 Ultra 5 250KF Plus', specs: { socket: 'LGA1851' } }) });
  assert.equal(kf.specs.cpuMemoryMaxMTs, 7200); assert.equal(kf.specs.maxPowerWatts, 159);
});

test('16 内存容量超过目标后边际收益递减', () => {
  const t = 32;
  assert.ok(memoryValue(16, t) < 0.9);
  assert.equal(memoryValue(32, t), 0.9);
  assert.ok(memoryValue(64, t) > memoryValue(32, t), '超过目标仍有少量收益（不强制禁止 64GB）');
  assert.ok(memoryValue(64, t) - memoryValue(32, t) < memoryValue(32, t) - memoryValue(16, t), '收益递减');
  assert.ok(memoryValue(128, t) - memoryValue(64, t) < memoryValue(64, t) - memoryValue(32, t));
  assert.ok(memoryValue(512, t) <= 1);
  // 用户明确需要 128GB：按 128GB 重新计算
  assert.ok(memoryValue(64, 128) < 0.9);
  // 错误的内存频率（PC5-51200 当成 MT/s）被纠正
  const ram = enrichSpecs({ category: 'RAM', name: 'x', specs: { speedMTs: 51200, memoryType: 'DDR5' }, rawParams: {} });
  assert.equal(ram.speedMTs, 6400);
});

// ---------- 17–20 引擎 ----------
test('17 高预算 AI 推荐不会因本轮修复无故降档', () => {
  const items = catalog();
  const p30 = run(items, 30000).plans.find(p => p.id === 'balanced');
  assert.equal(pick(p30, 'GPU').specs.capacityGB, 32, `3 万元 AI 推荐版 ${pick(p30, 'GPU').name}`);
  const p20 = run(items, 20000).plans.find(p => p.id === 'balanced');
  assert.ok(pick(p20, 'GPU').specs.capacityGB >= 24);
  // 高端显卡入选不是靠放宽安全标准：关键项仍如实列出
  assert.ok(p30.compatibility.checks.every(c => c.status !== FAIL));
});

test('17b 真实目录：3 万 / 2 万 AI 推荐版仍为 32GB / 24GB 显卡（目录存在时）', { skip: !existsSync(fileURLToPath(new URL('../.runtime/zol-catalog.json', import.meta.url))) }, async () => {
  const { createCatalog } = await import('../src/catalog.mjs');
  const { forPlans } = await import('../src/recommend.mjs').catch(() => ({}));
  const all = createCatalog(fileURLToPath(new URL('../.runtime', import.meta.url))).all();
  const pool = (forPlans ? all.filter(forPlans) : all.filter(i => i.market === 'cn' && !i.possiblyStale && !i.workstation && !['series-low', 'class-median'].includes(i.estimateBasis)));
  for (const [yuan, gb] of [[30000, 32], [20000, 24]]) {
    const p = optimizePlans(pool, { budgetCents: yuan * 100, scenarios: ['ai'], tierRatios: { save: .8, balanced: 1, plus: 1.2 } }).plans.find(x => x.id === 'balanced');
    assert.ok(pick(p, 'GPU').specs.capacityGB >= gb, `${yuan} 元：${pick(p, 'GPU').name}`);
  }
});

test('18 性能优先模式增加预算时最优可行核心性能不下降', () => {
  const items = catalog();
  let last = -Infinity;
  for (const yuan of [8000, 12000, 16000, 20000, 25000, 30000]) {
    const p = run(items, yuan, { tierRatios: { balanced: 1 }, strategy: 'performance' }).plans[0];
    if (p.infeasible) continue;
    assert.ok(p.corePerformance.value >= last - 1e-9, `¥${yuan} 核心 ${p.corePerformance.value} < ${last}`);
    last = p.corePerformance.value;
  }
});

test('19 有界搜索在小型合成目录中与穷举一致（含附件成本与散热证据）', () => {
  const items = catalog();
  const by = c => items.filter(i => i.category === c);
  const profile = SCORING_PROFILES.ai;
  for (const yuan of [10000, 20000, 30000]) {
    const target = yuan * 100;
    const req = MIN_REQUIREMENTS.ai;
    let best = -Infinity; let bestAny = -Infinity;
    for (const c of by('CPU')) for (const g of by('GPU')) for (const b of by('MOTHERBOARD').filter(b => b.specs.socket === c.specs.socket)) {
      const watts = sustainedPower(c.specs, b.specs, {});
      const covering = by('COOLER').filter(k => capacityCovers(coolingCapacity(k.specs, { cpu: c.specs }), watts));
      const coolers = [...(stockCooler(c) && watts <= 95 ? ['STOCK'] : []), ...(covering.length ? covering : by('COOLER'))];
      for (const r of by('RAM')) for (const s of by('SSD')) for (const u of by('PSU')) for (const k of coolers) for (const pc of by('CASE')) {
        const acc = accessoryCost({ cpuW: watts, gpuW: gpuPowerWatts(g.specs), pc: pc.specs, psu: u.specs }).requiredCents;
        const total = [c, g, b, r, s, u, pc].reduce((n, x) => n + x.estimatedPriceCents, 0) + (k === 'STOCK' ? 0 : k.estimatedPriceCents) + acc;
        if (total > target) continue;
        const parts = { CPU: c, GPU: g, MOTHERBOARD: b, RAM: r, SSD: s, PSU: u, CASE: pc, COOLER: k === 'STOCK' ? null : k };
        const checks = evaluateBuild(Object.fromEntries(Object.entries(parts).map(([key, v]) => [key, v ? { name: v.name, specs: v.specs } : null])), { stockCooler: k === 'STOCK' });
        if (checks.some(x => x.status === FAIL)) continue;
        if (u.specs.ratedWatts < 450) continue;
        const core = corePerformance({ cpu: c, gpu: g }, profile).value;
        // 与引擎相同的用途最低要求（显存 / 内存 / 硬盘）：有满足的组合时只在其中比较
        const meets = (!req.vramGB || g.specs.capacityGB >= req.vramGB) && (!req.ramGB || r.specs.capacityGB >= req.ramGB(target)) && (!req.ssdGB || s.specs.capacityGB >= req.ssdGB * 0.93);
        if (meets) best = Math.max(best, core);
        bestAny = Math.max(bestAny, core);
      }
    }
    if (!Number.isFinite(best)) best = bestAny;
    const p = run(items, yuan, { tierRatios: { balanced: 1 }, strategy: 'performance' }).plans[0];
    if (p.infeasible) { assert.equal(best, -Infinity); continue; }
    assert.ok(Math.abs(p.corePerformance.value - best) < 1e-9, `¥${yuan}: 引擎 ${p.corePerformance.value} ≠ 穷举 ${best}`);
  }
});

test('20 锁定配件及修改价格后全量重新校核', () => {
  const items = catalog();
  const gpu = items.find(i => i.name === 'RTX 5090 D');
  const lockedGpu = { ...gpu, priceCents: gpu.estimatedPriceCents };
  const p = run(items, 30000, { locked: { GPU: lockedGpu }, tierRatios: { balanced: 1 } }).plans[0];
  const ids = p.compatibility.checks.map(c => c.id);
  for (const id of ['gpuPower', 'psuWatts', 'gpuCable', 'gpuLength', 'caseAirflow', 'cpuCooling']) assert.ok(ids.includes(id), `锁定显卡后仍执行 ${id}`);
  assert.ok(pick(p, 'PSU').specs.ratedWatts >= 1000, '锁定 575W 显卡时重新配足电源');
  // 修改价格：显卡改价后总价与预算判断随之变化
  const cheaper = run(items.map(i => (i.id === gpu.id ? { ...i, estimatedPriceCents: gpu.estimatedPriceCents - 200000 } : i)), 30000, { tierRatios: { balanced: 1 }, strategy: 'performance' }).plans[0];
  const before = run(items, 30000, { tierRatios: { balanced: 1 }, strategy: 'performance' }).plans[0];
  if (pick(cheaper, 'GPU').id === gpu.id && pick(before, 'GPU').id === gpu.id) assert.ok(cheaper.totalCents < before.totalCents);
  assert.ok(cheaper.compatibility.checks.length > 10, '改价后重新完整校核');
});
