// 从批量测试结果生成 DATA_REQUIREMENTS.json（2.2.3）：哪些配件缺哪些字段，导致哪些检查待核实、影响多少套方案。
// 供数据研究方按优先级补数据（不需要等待此文件才能开始）。字段路径与 docs/DATA_PATCH_SCHEMA.json 的 field_path 一致。
// 用法：node scripts/data-requirements.mjs <batch-results.json> <输出路径>
import { readFileSync, writeFileSync } from 'node:fs';

// 检查 → 需要的数据（配件槽、字段、说明）
const NEEDS = {
  gpuCable: [['CASE', 'specs.gpuCableClearanceMm', '机箱侧板到显卡 16pin 插头方向的可用空间（或显卡高度限制）'], ['CASE', 'specs.maxGpuHeightMm', '机箱显卡高度限制（与显卡高度同一测量基准）'], ['GPU', 'specs.requiredCableClearanceMm', '显卡 / 线材厂商要求的 16pin 直线段空间（含显卡高度）'], ['GPU', 'specs.powerConnectorPosition', '16pin 插头位置 top / end']],
  gpuPower: [['PSU', 'specs.connectorPowerRating', '原厂 12VHPWR / 12V-2x6 线材额定（150/300/450/600W）'], ['PSU', 'specs.native12v2x6', '是否带原生 12V-2x6'], ['PSU', 'specs.independentPcieCables', '独立 PCIe 线材数量（区别于插头数）'], ['PSU', 'specs.hardwareRevision', '具体硬件版本 / Rev']],
  caseAirflow: [['CASE', 'specs.thermalTests', '覆盖该负载的整机持续温度测试（CPU W、GPU W、环境温度、时长、来源）'], ['CASE', 'specs.includedFans', '预装风扇数量'], ['CASE', 'specs.frontIntake', '前面板进风结构 mesh / closed']],
  cpuCooling: [['COOLER', 'specs.thermalTests', '散热器持续负载实测（功耗、CPU、插槽、环境、温度、时长、来源）'], ['COOLER', 'specs.vendorCoolingWatts', '厂商官方标称散热功率（附来源）']],
  memorySpeed: [['MOTHERBOARD', 'specs.memoryMaxMTs', '主板官方内存频率上限（按条数 / Rank）'], ['MOTHERBOARD', 'specs.memoryQvl', '主板内存 QVL（料号、条数、Rank、频率）'], ['RAM', 'specs.jedecMTs', '内存 JEDEC 频率']],
  ssdPcie: [['MOTHERBOARD', 'specs.m2Links', '每个 M.2 插槽的来源（CPU/PCH）、代数、通道、协议、长度、共享与禁用规则'], ['SSD', 'specs.pcieLink', 'SSD 接口代数与通道']],
  pcie: [['MOTHERBOARD', 'specs.gpuPcieLink', '第一条 x16 插槽的电气通道'], ['GPU', 'specs.pcieLink', '显卡接口代数与电气通道']],
  bios: [['MOTHERBOARD', 'specs.biosVersion', '出厂 BIOS 版本 / CPU 支持列表']],
  gpuHeight: [['CASE', 'specs.maxGpuHeightMm', '机箱显卡高度限制']],
  gpuThickness: [['CASE', 'specs.maxGpuThicknessMm', '机箱显卡厚度限制']],
  gpuLength: [['CASE', 'specs.gpuLengthIncludesFrontFans', '显卡限长是否已扣除前置风扇']],
  psuLength: [['CASE', 'specs.maxPsuLengthMm', '机箱电源限长'], ['PSU', 'specs.psuLengthMm', '电源长度']],
  coolerHeight: [['COOLER', 'specs.heightMm', '散热器高度'], ['CASE', 'specs.maxCoolerHeightMm', '机箱散热器限高']],
  radiatorLayout: [['CASE', 'specs.radiatorPositions', '冷排安装位置与尺寸'], ['COOLER', 'specs.radiatorThicknessMm', '冷排厚度']],
  psuFormat: [['PSU', 'specs.psuFormFactor', '电源规格 ATX / SFX']],
};
const ACCESSORY_NEEDS = { 'fan-hub': ['MOTHERBOARD', 'specs.fanHeaders', '主板风扇接口数量（CPU_FAN + SYS_FAN）'], 'stock-cooler-contingency': ['CPU', 'specs.stockCoolerRetailSkus', '附带原装散热的零售料号'] };

const [input, output] = process.argv.slice(2);
if (!input || !output) { console.error('用法：node scripts/data-requirements.mjs <batch-results.json> <输出路径>'); process.exit(2); }
const { runs } = JSON.parse(readFileSync(input, 'utf8'));
const req = new Map();
const add = (part, slot, field, why, check, priority, plan) => {
  if (!part?.id) return;
  const key = `${part.id}|${field}`;
  const r = req.get(key) ?? { component_id: part.id, category: slot, name: part.name, field_path: field, description: why, checks: new Set(), priority: 'P2', plans: new Set() };
  r.checks.add(check); r.plans.add(plan);
  if (priority < r.priority) r.priority = priority;
  req.set(key, r);
};
for (const run of runs) for (const p of run.plans ?? []) {
  const planKey = `${run.label} ${p.tier}`;
  for (const c of p.nonPassChecks ?? []) {
    if (c.status === 'CONDITIONAL' && !c.critical) continue;
    const priority = c.blocking ? 'P0' : c.critical ? 'P1' : 'P2';
    for (const [slot, field, why] of NEEDS[c.id] ?? []) add(p.parts?.[slot], slot, field, why, c.id, priority, planKey);
  }
  for (const a of p.costBreakdown?.requiredAccessories ?? []) if (ACCESSORY_NEEDS[a.id] && a.priceSource === 'contingency') {
    const [slot, field, why] = ACCESSORY_NEEDS[a.id]; add(p.parts?.[slot], slot, field, why, a.id, 'P2', planKey);
  }
}
const list = [...req.values()].map(r => ({ ...r, checks: [...r.checks], plansAffected: r.plans.size, plans: [...r.plans].slice(0, 12) }))
  .sort((a, b) => a.priority.localeCompare(b.priority) || b.plansAffected - a.plansAffected);
const out = { generatedAt: new Date().toISOString(), source: input, schema: 'docs/DATA_PATCH_SCHEMA.json',
  note: '按优先级补充：P0 为方案阻断项，P1 为关键条件项，P2 为一般待核实。无法核实的字段请提交 UNRESOLVED 记录，不要写入推测值。',
  summary: { requirements: list.length, byPriority: Object.fromEntries(['P0', 'P1', 'P2'].map(k => [k, list.filter(r => r.priority === k).length])), byField: Object.fromEntries([...new Set(list.map(r => r.field_path))].map(f => [f, list.filter(r => r.field_path === f).length])) },
  requirements: list };
writeFileSync(output, JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out.summary));
