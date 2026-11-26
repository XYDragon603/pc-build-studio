// 平台规格表（2.2.1）：按 CPU 代际 / 显卡芯片补厂商公开规格，只补缺失字段，不覆盖目录或人工修正。
//
// 为什么需要：2.2.0 的兼容规则读取 cpuMemoryMaxMTs、pcieLink、stockCoolerIncluded，但运行时目录里
// CPU 内存上限只有 4/256 条、CPU PCIe 链路 1/256 条、显卡链路 11/809 条有值，36 套测试的“内存频率”全部 UNKNOWN。
//
// 来源：AMD 产品规格页（Ryzen 各系列 “Max. Memory Speed / PCI Express Version / Thermal Solution (PIB)”），
// Intel ARK（Memory Types / PCI Express Revision / Box 散热器），NVIDIA / AMD / Intel 显卡规格页（Bus Interface）。
// 只收录在同一代际内一致的规格；同代内有差异的按型号单列。不确定的（如是否附带散热器）不写，交给规则判 UNKNOWN。

const AMD = 'https://www.amd.com/en/products/specifications/processors.html';
const INTEL = 'https://www.intel.com/content/www/us/en/ark.html';
const NVIDIA = 'https://www.nvidia.com/en-us/geforce/graphics-cards/compare/';
const RADEON = 'https://www.amd.com/en/products/specifications/graphics.html';
const ARC = 'https://www.intel.com/content/www/us/en/products/docs/discrete-gpus/arc/desktop/a-series/overview.html';

// CPU：[名称匹配, { 内存上限（按内存类型）, CPU 给显卡的 PCIe 链路, 来源 }]。按顺序匹配第一条。
const CPU_RULES = [
  // AMD Zen+ / Zen 2 APU（PCIe 3.0、DDR4-2933）
  [/RYZEN\s*[357]\s*2\d{3}(X|G)?\b|RYZEN\s*[35]\s*3[24]00G\b/i, { mem: { DDR4: 2933 }, pcie: { gen: 3, lanes: 16 }, src: AMD }],
  // Ryzen 4000 桌面（4100 / 4500 / 4600G / PRO 4650G）：Zen 2，PCIe 3.0；APU 显卡通道 x16（4600G 系列为 x16 Gen3）
  [/RYZEN\s*[35]\s*(PRO\s*)?4[156]\d0G?\b/i, { mem: { DDR4: 3200 }, pcie: { gen: 3, lanes: 16 }, src: AMD }],
  // Ryzen 5000 中 Cezanne 核心（5500、5600G/GT、5500GT、5700G、5700）：PCIe 3.0
  [/RYZEN\s*[357]\s*5(500|600G|600GT|500GT|700G|700)\b(?!X)/i, { mem: { DDR4: 3200 }, pcie: { gen: 3, lanes: 16 }, src: AMD }],
  // 其余 Ryzen 3000 / 5000（Zen 2 / Zen 3 桌面，含 X3D、XT）：PCIe 4.0、DDR4-3200
  [/RYZEN\s*[3579]\s*[35]\d{3}(X3D|XT|X)?\b/i, { mem: { DDR4: 3200 }, pcie: { gen: 4, lanes: 16 }, src: AMD }],
  // Ryzen 7000 / 8000G：DDR5-5200；7000 PCIe 5.0，8000G APU PCIe 4.0
  [/RYZEN\s*[3579]\s*8\d00G/i, { mem: { DDR5: 5200 }, pcie: { gen: 4, lanes: 8 }, src: AMD }],
  [/RYZEN\s*[3579]\s*7\d{3}/i, { mem: { DDR5: 5200 }, pcie: { gen: 5, lanes: 16 }, src: AMD }],
  // Ryzen 9000：DDR5-5600、PCIe 5.0
  [/RYZEN\s*[3579]\s*9\d{3}|锐龙\s*9\s*9\d{3}/i, { mem: { DDR5: 5600 }, pcie: { gen: 5, lanes: 16 }, src: AMD }],
  // Intel 12 代：DDR5-4800 / DDR4-3200，PCIe 5.0 x16
  [/I[3579][\s-]*12\d{3}/i, { mem: { DDR5: 4800, DDR4: 3200 }, pcie: { gen: 5, lanes: 16 }, src: INTEL }],
  // Intel 13 / 14 代：i3、i5-13400/14400 及以下 DDR5-4800，i5-13600K/14600K 及以上 DDR5-5600；DDR4-3200
  [/I[35][\s-]*1[34](1\d\d|4\d\d)/i, { mem: { DDR5: 4800, DDR4: 3200 }, pcie: { gen: 5, lanes: 16 }, src: INTEL }],
  [/I[3579][\s-]*1[34]\d{3}/i, { mem: { DDR5: 5600, DDR4: 3200 }, pcie: { gen: 5, lanes: 16 }, src: INTEL }],
  // Intel Core Ultra 200S（非 Plus）：DDR5-6400、PCIe 5.0
  // “Plus” 系列（250K Plus 等）规格不同，不在此表（由人工修正数据提供）；名称以 Plus 结尾的不匹配
  [/ULTRA\s*[579]\s*2\d{2}[A-Z]*$/i, { mem: { DDR5: 6400 }, pcie: { gen: 5, lanes: 16 }, src: INTEL }],
];

// 零售盒装附带散热器的型号（厂商规格 “Thermal Solution (PIB)” / Intel Box 附散热器）。
// 只列确定附带的；X / K / X3D / XT 等不附带的型号和不确定的型号不列（规则判为需另购散热器）。
const BOXED_WITH_COOLER = [
  /RYZEN\s*7\s*2700X?\b/i, /RYZEN\s*[35]\s*(2200G|2400G|3200G|3400G)\b/i,
  /RYZEN\s*[35]\s*(3100|3300X|3500X|3600|3600X)\b(?!T)/i, /RYZEN\s*[79]\s*(3700X|3800X|3900X)\b(?!T)/i,
  /RYZEN\s*[35]\s*(4100|4500|4600G)\b/i,
  /RYZEN\s*5\s*(5500|5600|5600X|5600G|5600GT|5500GT)\b(?!X3D)/i, /RYZEN\s*7\s*5700G\b/i,
  /RYZEN\s*[579]\s*(7600|7700|7900)\b(?!X)/i,
  // Intel 12–14 代非 K 盒装附 Laminar 散热器；国行特供（x490F / x790F）是否附带不确定，不列
  /I[3579][\s-]*1[234](?![47]90)\d{2}0F?\b(?!K)/i,
];

const GPU_LINKS = [
  // [芯片匹配, 版本, 电气通道]
  [/RX\s*6[45]00(\s*XT)?\b/i, 4, 4],
  [/RTX\s*(3050|4060|4060\s*TI|5050|5060|5060\s*TI)\b/i, null, 8],
  [/RX\s*(6600|6650|7600|7650)/i, 4, 8],
  [/ARC\s*(A3[18]0|B5[78]0)/i, 4, 8],
  [/RTX\s*50\d0/i, 5, 16], [/RX\s*90\d0/i, 5, 16],
  [/RTX\s*[34]0\d0|RX\s*[67]\d{3}|ARC\s*A[57]\d0/i, 4, 16],
  [/RTX\s*20\d0|GTX\s*16\d0/i, 3, 16],
];
const gpuGen = chip => (/RTX\s*50/i.test(chip) ? 5 : /RX\s*90/i.test(chip) ? 5 : /RTX\s*[34]0|RX\s*[67]\d{3}|ARC/i.test(chip) ? 4 : /RTX\s*20|GTX\s*16/i.test(chip) ? 3 : null);

/** 按 CPU 名称补平台字段：cpuMemoryMaxMTsByType、cpuMemoryMaxMTs（CPU 内存类型对应值）、pcieLink、stockCoolerIncluded */
export function cpuPlatform(name, specs = {}) {
  const out = {};
  const rule = CPU_RULES.find(([re]) => re.test(name))?.[1];
  if (rule) {
    out.cpuMemoryMaxMTsByType = rule.mem;
    const type = String(specs.memoryType ?? '').toUpperCase();
    out.cpuMemoryMaxMTs = rule.mem[type] ?? Math.max(...Object.values(rule.mem));
    out.pcieLink = rule.pcie;
    out.platformSource = rule.src;
  }
  if (/盒装|BOX/i.test(String(specs.packaging ?? '')) && BOXED_WITH_COOLER.some(re => re.test(name))) out.stockCoolerIncluded = true;
  return out;
}

/** 按显卡芯片补 PCIe 版本与电气通道（目录里的 “PCI Express 5.0 16X” 是物理接口，不代表电气通道） */
export function gpuPlatform(chipset) {
  const chip = String(chipset ?? '');
  const hit = GPU_LINKS.find(([re]) => re.test(chip));
  if (!hit) return {};
  const gen = hit[1] ?? gpuGen(chip);
  return gen ? { pcieLink: { gen, lanes: hit[2] }, platformSource: /RTX|GTX/i.test(chip) ? NVIDIA : /ARC/i.test(chip) ? ARC : RADEON } : {};
}

/** 主板第一条显卡插槽：桌面芯片组主板第一条 x16 插槽为 CPU 直连 x16，版本取主板标注的 PCIe 版本 */
export function boardPlatform(specs = {}) {
  return specs.pcieGen ? { gpuPcieLink: { gen: specs.pcieGen, lanes: 16, basis: '第一条 x16 插槽（CPU 直连），版本取主板标注' } } : {};
}
