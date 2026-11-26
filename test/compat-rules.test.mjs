import test from 'node:test';
import assert from 'node:assert/strict';
import { biosSupport, CONDITIONAL, cpuGeneration, evaluateBuild, FAIL, gpuPowerCheck, NOT_APPLICABLE, overallStatus, PASS, UNKNOWN } from '../src/compat-rules.mjs';
import { parseGpuPower, enrichSpecs } from '../src/specs-enrich.mjs';

const part = (name, specs) => ({ name, specs });
const base = () => ({
  CPU: part('AMD Ryzen 5 7600', { socket: 'AM5', maxPowerWatts: 88 }),
  MOTHERBOARD: part('B650M', { socket: 'AM5', chipset: 'B650', memoryType: 'DDR5', formFactor: 'Micro ATX', memorySlots: 4, maxMemoryGB: 192, m2Slots: 2, pcieGen: 4, videoOutputs: true }),
  RAM: part('DDR5 6000 32GB', { memoryType: 'DDR5', capacityGB: 32, modules: 2, speedMTs: 6000 }),
  GPU: part('RTX 5070', { chipset: 'GeForce RTX 5070', lengthMm: 300, boardPowerWatts: 250, recommendedPsuWatts: 650, powerPins: { pin6: 0, pin8: 0, pin16: 1 } }),
  PSU: part('850W', { ratedWatts: 850, pcie8Count: 4, pin16Count: 1, connectorPowerRating: 450, atxVersion: '3.1', rail12vAmps: 70 }),
  SSD: part('1TB', { interface: 'M.2 PCIe 4.0' }),
  CASE: part('ATX', { maxBoardFormFactor: 'ATX', maxGpuLengthMm: 380, maxCoolerHeightMm: 165 }),
  COOLER: part('风冷', { heightMm: 155, sockets: ['AM4', 'LGA1700'] }),
});
const byId = (checks, id) => checks.find(c => c.id === id);

test('显卡供电接口解析：8pin 数量、16pin 多种写法只算一个、无外接供电', () => {
  assert.deepEqual(parseGpuPower('8pin+8pin+8pin'), { pin6: 0, pin8: 3, pin16: 0 });
  assert.deepEqual(parseGpuPower('6pin+8pin'), { pin6: 1, pin8: 1, pin16: 0 });
  assert.deepEqual(parseGpuPower('新版12V-2x6 16Pin'), { pin6: 0, pin8: 0, pin16: 1 });
  assert.deepEqual(parseGpuPower('12pin+4pin'), { pin6: 0, pin8: 0, pin16: 1 });
  assert.equal(parseGpuPower('无外接电源接口').none, true);
  assert.equal(parseGpuPower(''), undefined);
});

test('电源字段解析：额定功率取参数表，不从型号名推断；多路 12V 不相加', () => {
  const s = enrichSpecs({ category: 'PSU', name: '金河田智能芯680 GT版', specs: { ratedWatts: 500 },
    rawParams: { 额定功率: '500W', '显卡接口（8Pin）': '1个', '显卡接口（6pin）': '1个', '12V1输出电流': '22A', '12V2输出电流': '22A', 电源版本: 'ATX 12V 2.31' } });
  assert.deepEqual([s.ratedWatts, s.pcie8Count, s.pcie6Count, s.atxVersion, s.rail12vAmps], [500, 1, 1, '2.31', undefined]);
  assert.deepEqual(s.rail12vSplitAmps, [22, 22]);
});

test('16pin 显卡：原生 PASS，转接线够用 CONDITIONAL，8pin 不够 FAIL，缺数据 UNKNOWN', () => {
  const gpu = { powerPins: { pin6: 0, pin8: 0, pin16: 1 }, boardPowerWatts: 360 };
  // 2.2.3：原生 16pin 需要线材额定等级；未知时各功耗等级一律 UNKNOWN（不按电源总功率推断）
  assert.equal(gpuPowerCheck(gpu, { pin16Count: 1, connectorPowerRating: 450 }).status, PASS);
  assert.equal(gpuPowerCheck(gpu, { pin16Count: 1 }).status, UNKNOWN);
  assert.equal(gpuPowerCheck(gpu, { pin16Count: 0, pcie8Count: 4 }).status, CONDITIONAL);
  // 2.2.2：原生 16pin 明确没有时 8pin 不够为 FAIL；原生接口未知时不能判死（可能有未记录的原生线）
  assert.equal(gpuPowerCheck(gpu, { pcie8Count: 2, native16Pin: false }).status, FAIL);
  assert.equal(gpuPowerCheck(gpu, { pcie8Count: 2 }).status, UNKNOWN);
  assert.equal(gpuPowerCheck(gpu, {}).status, UNKNOWN);
  assert.equal(gpuPowerCheck({}, { pcie8Count: 4 }).status, UNKNOWN);
});

test('8pin 显卡对照电源 8pin 数量；无外接供电不适用', () => {
  assert.equal(gpuPowerCheck({ powerPins: { pin6: 0, pin8: 2, pin16: 0 } }, { pcie8Count: 2 }).status, PASS);
  assert.equal(gpuPowerCheck({ powerPins: { pin6: 0, pin8: 2, pin16: 0 } }, { pcie8Count: 1 }).status, FAIL);
  assert.equal(gpuPowerCheck({ powerPins: { pin6: 1, pin8: 1, pin16: 0 } }, { pcie8Count: 1, pcie6Count: 1 }).status, PASS);
  assert.equal(gpuPowerCheck({ powerPins: { none: true } }, {}).status, NOT_APPLICABLE);
});

test('BIOS：按 CPU 代际与芯片组判断', () => {
  assert.equal(cpuGeneration('AMD Ryzen 5 3400G').family, 'zen+apu');
  assert.equal(biosSupport('AMD Ryzen 5 5600', 'B450').status, CONDITIONAL);
  assert.equal(biosSupport('AMD Ryzen 5 3400G', 'B550').status, FAIL);
  assert.equal(biosSupport('AMD Ryzen 5 7600', 'B650').status, PASS);
  assert.equal(biosSupport('AMD Ryzen 7 9700X', 'B650').status, CONDITIONAL);
  assert.equal(biosSupport('Intel 酷睿 i5 14600KF', 'B660').status, CONDITIONAL);
  assert.equal(biosSupport('Intel 酷睿 i5 14600KF', 'B760').status, PASS);
  assert.equal(biosSupport('Intel 酷睿 Ultra 7 270K Plus', 'Z890').status, CONDITIONAL);
  assert.equal(biosSupport('龙芯3A6000', 'B650').status, UNKNOWN);
});

test('整机：旧快照缺少持续散热与空间数据，必须待核实；扣具按等价插槽判断', () => {
  const checks = evaluateBuild(base());
  assert.equal(byId(checks, 'coolerSocket').status, PASS);
  assert.equal(byId(checks, 'memorySpeed').status, UNKNOWN);
  assert.equal(byId(checks, 'memorySpeed').blocking, false);
  assert.equal(byId(checks, 'gpuPower').status, PASS);
  assert.equal(overallStatus(checks), UNKNOWN);
  assert.ok(!checks.some(c => c.status === FAIL));
});

test('整机：关键数据缺失不能算通过；确认冲突为 FAIL', () => {
  const noPins = base();
  noPins.PSU = part('650W', { ratedWatts: 650 });
  assert.equal(overallStatus(evaluateBuild(noPins)), UNKNOWN);
  const small = base();
  small.PSU = part('500W', { ratedWatts: 500, pcie8Count: 2, pin16Count: 1 });
  assert.equal(byId(evaluateBuild(small), 'psuWatts').status, FAIL);
  const ddr4 = base();
  ddr4.RAM = part('DDR4', { memoryType: 'DDR4', capacityGB: 16, modules: 2, speedMTs: 3200 });
  assert.equal(overallStatus(evaluateBuild(ddr4)), FAIL);
});

test('核显方案：CPU 没核显或主板没视频口为 FAIL；有独显时不适用', () => {
  const p = base();
  p.CPU = part('Intel 酷睿 Ultra 5 225F', { socket: 'AM5', integratedGraphics: '不支持', maxPowerWatts: 120 });
  assert.equal(byId(evaluateBuild(p, { igpu: true }), 'igpuCpu').status, FAIL);
  assert.equal(byId(evaluateBuild(base()), 'videoOutput').status, NOT_APPLICABLE);
  const noVideo = base();
  noVideo.MOTHERBOARD.specs.videoOutputs = false;
  noVideo.CPU = part('AMD Ryzen 5 8600G', { socket: 'AM5', maxPowerWatts: 88 });
  assert.equal(byId(evaluateBuild(noVideo, { igpu: true }), 'videoOutput').status, FAIL);
});

test('多路 12V：显卡超过单路能力为 FAIL；Arc 需要 ReBAR；x8 显卡在 PCIe 3.0 上为条件项', () => {
  const p = base();
  p.PSU = part('500W 双路', { ratedWatts: 650, pcie8Count: 2, pin16Count: 1, rail12vSplitAmps: [22, 22] });
  p.GPU.specs.boardPowerWatts = 300;
  assert.equal(byId(evaluateBuild(p), 'psu12v').status, FAIL);
  const arc = base();
  arc.GPU = part('Arc B580', { chipset: 'Arc B580', needsResizableBar: true, powerPins: { pin6: 0, pin8: 1, pin16: 0 }, boardPowerWatts: 190, lengthMm: 270 });
  arc.MOTHERBOARD.specs.pcieGen = 3;
  arc.CPU.specs.pcieLink = { gen: 4, lanes: 16 };
  arc.GPU.specs.pcieLink = { gen: 4, lanes: 8 };
  arc.MOTHERBOARD.specs.gpuPcieLink = { gen: 3, lanes: 16, physicalLanes: 16 };
  const checks = evaluateBuild(arc);
  assert.equal(byId(checks, 'rebar').status, CONDITIONAL);
  assert.equal(byId(checks, 'pcie').status, CONDITIONAL);
});
