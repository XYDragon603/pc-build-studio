import test from 'node:test';
import assert from 'node:assert/strict';
import { recommend, shares } from '../src/recommend.mjs';

let n = 0;
const item = (category, cents, specs) => ({ id: `t-${++n}`, category, name: `${category}-${cents / 100}`, estimatedPriceCents: cents, specs });

const catalog = [
  item('CPU', 100000, { socket: 'AM5', maxPowerWatts: 88 }),
  item('CPU', 160000, { socket: 'AM5', maxPowerWatts: 88 }),
  item('CPU', 300000, { socket: 'AM5', maxPowerWatts: 162 }),
  item('CPU', 120000, { socket: 'LGA1700', maxPowerWatts: 181 }),
  item('MOTHERBOARD', 70000, { socket: 'AM5', memoryType: 'DDR5', formFactor: 'Micro ATX' }),
  item('MOTHERBOARD', 90000, { socket: 'AM5', memoryType: 'DDR5', formFactor: 'ATX' }),
  item('MOTHERBOARD', 60000, { socket: 'LGA1700', memoryType: 'DDR4', formFactor: 'Micro ATX' }),
  item('RAM', 45000, { memoryType: 'DDR5', capacityGB: 32, modules: 2, speedMTs: 6000 }),
  item('RAM', 40000, { memoryType: 'DDR5', capacityGB: 32, modules: 2, speedMTs: 4800 }),
  item('RAM', 30000, { memoryType: 'DDR4', capacityGB: 32, modules: 2, speedMTs: 3200 }),
  ...[['RTX 4060', 230000, 240], ['RTX 4060', 240000, 250], ['RTX 5060 Ti', 380000, 300], ['RTX 5060 Ti', 400000, 320],
    ['RTX 5080', 900000, 340], ['RTX 5080', 950000, 350]].map(([chip, cents, len]) =>
    item('GPU', cents, { chipset: `GeForce ${chip}`, capacityGB: 16, lengthMm: len, recommendedPsuWatts: chip === 'RTX 5080' ? 850 : 550 })),
  item('PSU', 35000, { ratedWatts: 650, efficiency: '金牌' }),
  item('PSU', 30000, { ratedWatts: 650, efficiency: '铜牌' }),
  item('PSU', 80000, { ratedWatts: 850, efficiency: '金牌' }),
  item('COOLER', 15000, { coolingType: '风冷', heightMm: 155, sockets: ['AM5', 'LGA1700'] }),
  item('COOLER', 25000, { coolingType: '风冷', heightMm: 165, sockets: ['AM5'] }),
  item('COOLER', 50000, { coolingType: '水冷', radiatorSizeMm: 360, sockets: ['AM5'] }),
  item('CASE', 20000, { maxBoardFormFactor: 'Micro ATX', maxGpuLengthMm: 300, maxCoolerHeightMm: 160 }),
  item('CASE', 30000, { maxBoardFormFactor: 'ATX', maxGpuLengthMm: 380, maxCoolerHeightMm: 170, maxRadiatorMm: 360 }),
  item('SSD', 40000, { capacityGB: 1000, interface: 'M.2 PCIe 4.0', readMBs: 7000 }),
  item('SSD', 30000, { capacityGB: 1000, interface: 'M.2 SATA', readMBs: 550 }),
  item('SSD', 70000, { capacityGB: 2000, interface: 'M.2 PCIe 4.0', readMBs: 7000 }),
];
const bySlot = r => Object.fromEntries(r.picks.map(p => [p.slot, p.item]));

test('8000 元 2K 游戏：配齐 8 件、兼容、不超预算', () => {
  const r = recommend(catalog, { budgetCents: 800000, scenarios: ['2k'] });
  const p = bySlot(r);
  assert.equal(r.picks.length, 8);
  assert.ok(r.totalCents <= 800000, `总价 ${r.totalCents}`);
  assert.equal(p.MOTHERBOARD.specs.socket, p.CPU.specs.socket);
  assert.equal(p.RAM.specs.memoryType, p.MOTHERBOARD.specs.memoryType);
  if (p.RAM.specs.memoryType === 'DDR5') assert.ok(p.RAM.specs.speedMTs >= 6000);
  assert.ok(p.CASE.specs.maxGpuLengthMm >= p.GPU.specs.lengthMm + 10);
  assert.ok(p.PSU.specs.ratedWatts >= p.GPU.specs.recommendedPsuWatts);
  assert.match(p.SSD.specs.interface, /PCIe/);
  assert.ok(r.picks.every(x => x.reason));
});

test('超预算时显卡自动降档', () => {
  const r = recommend(catalog, { budgetCents: 600000, scenarios: ['2k'] });
  assert.ok(r.totalCents <= 600000, `总价 ${r.totalCents}`);
  assert.match(bySlot(r).GPU.specs.chipset, /4060|5060/);
});

test('锁定的配件保留：锁定显卡后不再挑显卡，预算扣除其价格，机箱照锁定显卡长度挑', () => {
  const r = recommend(catalog, { budgetCents: 800000, scenarios: ['2k'], locked: { GPU: { priceCents: 400000, specs: { lengthMm: 320, recommendedPsuWatts: 550 } } } });
  const p = bySlot(r);
  assert.equal(p.GPU, undefined);
  assert.equal(r.lockedCents, 400000);
  assert.ok(p.CASE.specs.maxGpuLengthMm >= 330);
});

test('安静优先：电源选金牌，散热器在预算内选更好的', () => {
  const r = recommend(catalog, { budgetCents: 800000, scenarios: ['2k', 'quiet'] });
  assert.match(bySlot(r).PSU.specs.efficiency, /金/);
  const s = shares(['2k', 'quiet']);
  assert.ok(s.COOLER > shares(['2k']).COOLER);
});

test('高功耗 CPU 配 240mm 以上水冷，机箱需支持冷排', () => {
  const r = recommend(catalog, { budgetCents: 2000000, scenarios: ['2k'], locked: { CPU: { priceCents: 300000, specs: { socket: 'AM5', maxPowerWatts: 162 } } } });
  const p = bySlot(r);
  assert.ok(p.COOLER.specs.radiatorSizeMm >= 240);
  assert.ok(p.CASE.specs.maxRadiatorMm >= p.COOLER.specs.radiatorSizeMm);
});
