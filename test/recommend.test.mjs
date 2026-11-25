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

test('有性能数据时 CPU 按性能分挑，不按价格', () => {
  const perfCatalog = catalog.map(i => i.category !== 'CPU' ? i : i);
  const cheapFast = { ...item('CPU', 120000, { socket: 'AM5', maxPowerWatts: 88 }), performance: { blender: { score: 400 } } };
  const pricySlow = { ...item('CPU', 140000, { socket: 'AM5', maxPowerWatts: 88 }), performance: { blender: { score: 250 } } };
  const r = recommend([...perfCatalog.filter(i => i.category !== 'CPU'), cheapFast, pricySlow], { budgetCents: 800000, scenarios: ['2k'] });
  assert.equal(bySlot(r).CPU.id, cheapFast.id);
  assert.match(r.picks.find(p => p.slot === 'CPU').reason, /Blender 多核分最高/);
});

test('有游戏指数时显卡按指数选档次', () => {
  const gpu = (chip, cents, index) => ({ ...item('GPU', cents, { chipset: chip, capacityGB: 16, lengthMm: 300, recommendedPsuWatts: 650 }), performance: { gaming: { index } } });
  // 同价位：指数高的 RX 9070 XT 应胜出
  const gpus = [gpu('Radeon RX 9070 XT', 450000, 140), gpu('Radeon RX 9070 XT', 460000, 140), gpu('GeForce RTX 5070', 440000, 110), gpu('GeForce RTX 5070', 450000, 110)];
  const r = recommend([...catalog.filter(i => i.category !== 'GPU'), ...gpus], { budgetCents: 1200000, scenarios: ['2k'] });
  assert.match(bySlot(r).GPU.specs.chipset, /9070 XT/);
  assert.match(r.picks.find(p => p.slot === 'GPU').reason, /2K 游戏性能 140%/);
});

test('游戏指数与 Blender 分不混比：预算内有游戏指数时只按游戏指数挑 CPU', () => {
  const x3d = { ...item('CPU', 130000, { socket: 'AM5', maxPowerWatts: 162 }), performance: { gaming: { index: 96.4 }, blender: { score: 334 } } };
  const manyCores = { ...item('CPU', 135000, { socket: 'AM5', maxPowerWatts: 162 }), performance: { blender: { score: 600 } } };
  const r = recommend([...catalog.filter(i => i.category !== 'CPU'), x3d, manyCores], { budgetCents: 800000, scenarios: ['2k'] });
  assert.equal(bySlot(r).CPU.id, x3d.id);
  assert.match(r.picks.find(p => p.slot === 'CPU').reason, /游戏指数最高/);
});

test('用途档案：AI 显卡占一半预算、剪辑 CPU 加大、电竞 CPU 比 2K 多、4K 显卡更多；不认识的场景按通用', async () => {
  const { profileOf } = await import('../src/recommend.mjs');
  assert.ok(shares(['ai']).GPU >= 0.5 && shares(['ai']).RAM > shares(['2k']).RAM);
  assert.ok(shares(['creator']).CPU > shares(['2k']).CPU && shares(['creator']).GPU < shares(['2k']).GPU);
  assert.ok(shares(['1080p']).CPU > shares(['2k']).CPU && shares(['4k']).GPU > shares(['2k']).GPU);
  assert.equal(profileOf(['ai', 'quiet']).key, 'ai');
  assert.equal(profileOf(['office']).key, 'office');
  assert.equal(profileOf([]).key, 'general');
  assert.deepEqual(shares([]), shares(['office']));
});

test('AI：先比显存，优先 RTX 30 系及以后的 NVIDIA；内存、硬盘按档案加大', () => {
  const gpu = (chip, cents, gb, compute, gaming) => ({ ...item('GPU', cents, { chipset: chip, capacityGB: gb, lengthMm: 300, recommendedPsuWatts: 650 }),
    performance: { blender: { score: compute }, gaming: { index: gaming } } });
  const gpus = [
    // 12GB 但游戏、算力都更强 vs 16GB 稍慢：AI 要 16GB
    gpu('GeForce RTX 5070', 440000, 12, 6000, 70), gpu('GeForce RTX 5070', 450000, 12, 6000, 70),
    gpu('GeForce RTX 5060 Ti', 360000, 16, 4000, 50), gpu('GeForce RTX 5060 Ti', 370000, 16, 4000, 50),
    // 同价 16GB 的 AMD 不选
    gpu('Radeon RX 9070', 350000, 16, 3000, 75), gpu('Radeon RX 9070', 355000, 16, 3000, 75),
  ];
  const ram64 = [item('RAM', 90000, { memoryType: 'DDR5', capacityGB: 64, modules: 2, speedMTs: 6000 }),
    item('RAM', 70000, { memoryType: 'DDR4', capacityGB: 64, modules: 2, speedMTs: 3200 })];
  const items = [...catalog.filter(i => i.category !== 'GPU'), ...gpus, ...ram64];
  const ai = bySlot(recommend(items, { budgetCents: 1200000, scenarios: ['ai'] }));
  assert.match(ai.GPU.specs.chipset, /5060 Ti/);
  assert.equal(ai.RAM.specs.capacityGB, 64);
  assert.equal(ai.SSD.specs.capacityGB, 2000);
  // 同样的预算，2K 游戏按游戏指数挑 RX 9070
  assert.match(bySlot(recommend(items, { budgetCents: 1200000, scenarios: ['2k'] })).GPU.specs.chipset, /9070/);
});

test('剪辑：只要 ≥ 8GB 的 RTX；CPU 按多核分挑', () => {
  const gpu = (chip, cents, gb, compute) => ({ ...item('GPU', cents, { chipset: chip, capacityGB: gb, lengthMm: 250, recommendedPsuWatts: 450 }), performance: { blender: { score: compute } } });
  const gpus = [gpu('GeForce GTX 1650', 90000, 4, 800), gpu('GeForce GTX 1650', 95000, 4, 800),
    gpu('GeForce RTX 3050', 130000, 8, 1200), gpu('GeForce RTX 3050', 135000, 8, 1200)];
  const x3d = { ...item('CPU', 130000, { socket: 'AM5', maxPowerWatts: 162 }), performance: { gaming: { index: 96 }, blender: { score: 330 } } };
  const manyCores = { ...item('CPU', 135000, { socket: 'AM5', maxPowerWatts: 162 }), performance: { gaming: { index: 76 }, blender: { score: 600 } } };
  const items = [...catalog.filter(i => i.category !== 'GPU' && i.category !== 'CPU'), ...gpus, x3d, manyCores];
  const r = bySlot(recommend(items, { budgetCents: 600000, scenarios: ['creator'] }));
  assert.match(r.GPU.specs.chipset, /RTX 3050/);
  assert.equal(r.CPU.id, manyCores.id);
  assert.equal(bySlot(recommend(items, { budgetCents: 600000, scenarios: ['2k'] })).CPU.id, x3d.id);
});

test('核显判断：ZOL 写“不支持”的 F 系列没有核显', async () => {
  const { hasIntegratedGraphics } = await import('../src/recommend.mjs');
  assert.equal(hasIntegratedGraphics({ name: 'Intel 酷睿 Ultra 5 225F', specs: { integratedGraphics: '不支持' } }), false);
  assert.equal(hasIntegratedGraphics({ name: 'AMD Ryzen 7 9850X3D', specs: { integratedGraphics: 'AMD Radeon Graphics' } }), true);
  assert.equal(hasIntegratedGraphics({ name: 'Intel 酷睿 i5 12400F', specs: {} }), false);
  assert.equal(hasIntegratedGraphics({ name: 'Intel 酷睿 i5 12400', specs: {} }), true);
});

test('预算有余量时同插槽升级 CPU（游戏按游戏指数）；办公不升级', () => {
  const cpu = (cents, index) => ({ ...item('CPU', cents, { socket: 'AM5', maxPowerWatts: 88 }), performance: { gaming: { index }, blender: { score: index * 5 } } });
  const cheap = cpu(100000, 60);
  const fast = cpu(250000, 95);
  // 显卡只有一档便宜的，升不上去，余量应该给 CPU
  const gpus = [item('GPU', 150000, { chipset: 'GeForce RTX 3050', capacityGB: 8, lengthMm: 250, recommendedPsuWatts: 450 }),
    item('GPU', 155000, { chipset: 'GeForce RTX 3050', capacityGB: 8, lengthMm: 255, recommendedPsuWatts: 450 })];
  const items = [...catalog.filter(i => i.category !== 'CPU' && i.category !== 'GPU'), cheap, fast, ...gpus];
  const game = recommend(items, { budgetCents: 900000, scenarios: ['2k'] });
  assert.equal(bySlot(game).CPU.id, fast.id);
  assert.match(game.picks.find(p => p.slot === 'CPU').reason, /余量/);
  assert.ok(game.totalCents <= 900000);
  const office = recommend(items, { budgetCents: 900000, scenarios: ['office'], igpu: true });
  assert.ok(!/余量/.test(office.picks.find(p => p.slot === 'CPU')?.reason ?? ''));
});
