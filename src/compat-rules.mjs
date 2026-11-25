// 整机兼容性规则（前后端共用：后端出方案、保存方案时用，前端配置页的兼容性面板也直接用这份）。
//
// 每条检查返回五种状态之一：
//   PASS           确认兼容
//   FAIL           确认不兼容（自动推荐必须排除）
//   CONDITIONAL    满足条件后兼容（如更新 BIOS、用显卡附带的转接线、开 XMP）
//   UNKNOWN        缺少数据，无法判断（不得当成通过）
//   NOT_APPLICABLE 不适用（如有独显时不检查核显输出）
// critical 标记供电等安全相关检查：它们 UNKNOWN 时整机只能是“待核实”。
//
// 规则只用目录里写明的数据；认不出的组合返回 UNKNOWN，不按价格或型号名猜。

import { parseGpuPower } from './specs-enrich.mjs';

export const PASS = 'PASS';
export const FAIL = 'FAIL';
export const CONDITIONAL = 'CONDITIONAL';
export const UNKNOWN = 'UNKNOWN';
export const NOT_APPLICABLE = 'NOT_APPLICABLE';

/** 整机结论的严重程度：FAIL > UNKNOWN（关键）> CONDITIONAL > UNKNOWN（非关键）> PASS */
const RANK = { FAIL: 4, UNKNOWN: 2, CONDITIONAL: 2, PASS: 0, NOT_APPLICABLE: 0 };

const up = v => String(v ?? '').trim().toUpperCase();
const BOARD_RANK = { 'MINI-ITX': 1, 'MICRO ATX': 2, ATX: 3, EATX: 4 };

/** 散热器扣具等价：AM5 沿用 AM4 扣具，LGA1851 与 LGA1700 扣具相同，LGA1200 与 LGA115X 相同 */
const MOUNT_EQUIV = { AM5: ['AM5', 'AM4'], AM4: ['AM4', 'AM5'], LGA1851: ['LGA1851', 'LGA1700'], LGA1700: ['LGA1700', 'LGA1851'],
  LGA1200: ['LGA1200', 'LGA115X', 'LGA1151', 'LGA1150', 'LGA1155', 'LGA1156'] };

/** 带核显：ZOL 写了集成显卡（“不支持”除外），或 AMD G 系列 / Intel 非 F 型号 */
export function cpuHasIgpu(name, specs = {}) {
  const igpu = specs.integratedGraphics;
  if (igpu != null && igpu !== '') return !/不支持|^无|^否|none|n\/a/i.test(String(igpu));
  const n = up(name);
  if (/RYZEN.*\d{4}G(T|E)?\b/.test(n)) return true;
  return /INTEL|酷睿|CORE/.test(n) && !/\d{3,5}K?F\b|KF\b/.test(n);
}

/** CPU 代际（用于 BIOS 判断）；认不出返回 null */
export function cpuGeneration(name) {
  const n = up(name);
  let m = n.match(/(?:RYZEN|锐龙)\s*(?:THREADRIPPER\s*)?(?:[3579]\s*)?(?:PRO\s*)?(\d)(\d{3})([A-Z0-9]*)/);
  if (m) {
    const series = Number(m[1]);
    const suffix = m[3];
    // 3000 系列的 G 型号（3200G / 3400G）是 Zen+ APU，平台支持与 3000 不同
    if (series === 3 && /^G/.test(suffix)) return { vendor: 'AMD', family: 'zen+apu' };
    if (series <= 2) return { vendor: 'AMD', family: 'zen1' };
    if (series === 3) return { vendor: 'AMD', family: 'zen2' };
    if (series === 4 || series === 5) return { vendor: 'AMD', family: 'zen3' };
    if (series === 7 || series === 8) return { vendor: 'AMD', family: 'zen4' };
    // 9850X3D、9950X3D2 是较晚发布的型号，较早出厂的主板 BIOS 可能还不认
    if (series === 9) return { vendor: 'AMD', family: /9850X3D|9950X3D2/.test(n) ? 'zen5-new' : 'zen5' };
  }
  m = n.match(/ULTRA\s*[3579]\s*(\d{3})([A-Z]*)(\s*PLUS)?/);
  if (m) return { vendor: 'Intel', family: m[3] || /PLUS/.test(n) ? 'arrow-plus' : 'arrow' };
  m = n.match(/I[3579][\s-]*(\d{2})(\d{3})/);
  if (m) {
    const gen = Number(m[1]);
    if (gen === 12) return { vendor: 'Intel', family: 'alder' };
    if (gen === 13 || gen === 14) return { vendor: 'Intel', family: 'raptor' };
    return { vendor: 'Intel', family: `gen${gen}` };
  }
  return null;
}

/** 芯片组系列：AMD 300/400/500/600/800，Intel 600/700/800 */
function chipsetSeries(chipset) {
  const c = up(chipset).match(/([ABHQXZ])(\d)(\d{2})/);
  if (!c) return null;
  return { letter: c[1], series: Number(c[2]) * 100 };
}

/**
 * BIOS / 平台支持。依据 AMD、Intel 公开的平台支持关系：
 * - AM4：Ryzen 3000 / 5000 装 300、400 系主板需更新 BIOS；B550 / A520 不支持 Ryzen 1000、2000 和 3000G APU
 * - AM5：Ryzen 9000 装 600 系主板需更新 BIOS
 * - LGA1700：13、14 代装 600 系主板需更新 BIOS
 * - LGA1851：Ultra 200S Plus 需较新 BIOS
 */
export function biosSupport(cpuName, boardChipset) {
  const gen = cpuGeneration(cpuName);
  const cs = chipsetSeries(boardChipset);
  if (!gen || !cs) return { status: UNKNOWN, detail: '缺少 CPU 代际或主板芯片组信息，请向商家确认主板 BIOS 是否支持这颗 CPU。' };
  const amd = gen.vendor === 'AMD';
  const update = what => ({ status: CONDITIONAL, detail: `${what}：主板需要更新到支持这颗 CPU 的 BIOS（新批次可能已出厂支持），下单前向商家确认，或选带 BIOS 免 CPU 刷新功能的主板。` });
  if (amd && cs.series >= 300 && cs.series <= 500) {
    if (cs.series === 500 && ['zen1', 'zen+apu'].includes(gen.family)) return { status: FAIL, detail: `${boardChipset} 不支持这一代 Ryzen（AMD 未提供支持）。` };
    if (cs.series === 500 && gen.family === 'zen3') return update(`${boardChipset} 早期批次`);
    if (cs.series <= 400 && ['zen2', 'zen3'].includes(gen.family)) return update(`${boardChipset} 装 Ryzen ${gen.family === 'zen2' ? '3000' : '5000'}`);
    if (['zen2', 'zen3', 'zen1', 'zen+apu'].includes(gen.family)) return { status: PASS, detail: `${boardChipset} 原生支持。` };
  }
  if (amd && cs.series >= 600) {
    if (['zen4'].includes(gen.family)) return { status: PASS, detail: `${boardChipset} 原生支持 Ryzen 7000 / 8000。` };
    if (gen.family === 'zen5' && cs.series === 600) return update(`${boardChipset} 装 Ryzen 9000`);
    if (gen.family === 'zen5') return { status: PASS, detail: `${boardChipset} 支持 Ryzen 9000。` };
    if (gen.family === 'zen5-new') return update('较新发布的 Ryzen 9000 型号');
  }
  if (!amd && cs.series >= 600 && cs.series <= 700) {
    if (gen.family === 'alder') return { status: PASS, detail: `${boardChipset} 原生支持 12 代酷睿。` };
    if (gen.family === 'raptor') return cs.series === 600 ? update(`${boardChipset} 装 13 / 14 代酷睿`) : { status: PASS, detail: `${boardChipset} 原生支持 13 / 14 代酷睿。` };
  }
  if (!amd && cs.series === 800) {
    if (gen.family === 'arrow') return { status: PASS, detail: `${boardChipset} 原生支持 Ultra 200S。` };
    if (gen.family === 'arrow-plus') return update('Ultra 200S Plus');
  }
  return { status: UNKNOWN, detail: `没有 ${boardChipset} 与这颗 CPU 的支持关系数据，请向商家确认。` };
}

/** 16pin 显卡用转接线需要几个 8pin：≤300W 2 个，≤450W 3 个，更高 4 个（显卡附带转接线的常见规格） */
const adapterPins = watts => (watts > 450 ? 4 : watts > 300 ? 3 : 2);

/** 显卡供电接口 × 电源接口 */
export function gpuPowerCheck(gpu, psu) {
  // 旧方案只存了接口文字（gpuPowerConnector: "16PIN" / 目录 powerConnectors），也能解析
  const need = gpu?.powerPins ?? parseGpuPower(gpu?.gpuPowerConnector ?? gpu?.powerConnectors);
  if (!need) return { status: UNKNOWN, detail: '显卡缺少供电接口数据，请核对显卡需要几个 8pin / 16pin，以及电源是否够用。' };
  if (need.none) return { status: NOT_APPLICABLE, detail: '显卡不需要外接供电。' };
  const has8 = psu?.pcie8Count;
  const has16 = psu?.pin16Count;
  const native16 = has16 > 0 || psu?.native16Pin === true;
  if (need.pin16) {
    if (native16) return { status: PASS, detail: `显卡 16pin 供电，电源带原生 16pin（12VHPWR / 12V-2x6）线${psu?.atxVersion?.startsWith('3') ? `，ATX ${psu.atxVersion}` : ''}。` };
    const watts = gpu.boardPowerWatts ?? gpu.maxPowerWatts ?? gpu.tdpWatts ?? null;
    const pins = adapterPins(watts ?? 600);
    if (has8 == null) return { status: UNKNOWN, detail: '显卡 16pin 供电，电源没有标注原生 16pin，也没有标注显卡 8pin 接口数量，无法确认能否用转接线。' };
    if (has8 >= pins) return { status: CONDITIONAL, detail: `显卡 16pin 供电，电源没有原生 16pin：用显卡附带的转接线（需 ${pins} 个 8pin，电源有 ${has8} 个）。转接线要插紧、不要过度弯折；更稳妥是换带原生 16pin 的 ATX 3.x 电源。` };
    return { status: FAIL, detail: `显卡 16pin 供电${watts ? `（约 ${watts}W）` : ''}，转接需要 ${pins} 个 8pin，电源只有 ${has8} 个，也没有原生 16pin。` };
  }
  const needPins = need.pin8 + need.pin6;
  if (has8 == null) return { status: UNKNOWN, detail: `显卡需要 ${describePins(need)}，电源没有标注显卡供电接口数量。` };
  // 电源的 8pin 多为 6+2pin，可当 6pin 用；6pin 只能接 6pin
  const usable = has8 + (need.pin6 ? Math.min(psu.pcie6Count ?? 0, need.pin6) : 0);
  if (usable >= needPins && has8 >= need.pin8) return { status: PASS, detail: `显卡需要 ${describePins(need)}，电源有 ${has8} 个 8pin${psu.pcie6Count ? `、${psu.pcie6Count} 个 6pin` : ''}。` };
  return { status: FAIL, detail: `显卡需要 ${describePins(need)}，电源只有 ${has8} 个 8pin${psu.pcie6Count ? `、${psu.pcie6Count} 个 6pin` : ''}。` };
}
const describePins = p => [p.pin8 && `${p.pin8} 个 8pin`, p.pin6 && `${p.pin6} 个 6pin`].filter(Boolean).join(' + ');

/** 整机功耗估算：CPU 峰值 + 显卡整卡功耗 + 75W（主板、内存、硬盘、风扇） */
export function powerEstimate(cpu, gpu, { igpu = false } = {}) {
  const cpuW = cpu?.maxPowerWatts ?? null;
  const gpuW = igpu ? 0 : (gpu?.boardPowerWatts ?? gpu?.maxPowerWatts ?? gpu?.tdpWatts ?? null);
  const load = cpuW != null && gpuW != null ? cpuW + gpuW + 75 : null;
  const recommended = Math.max(load ? Math.ceil(load * 1.25) : 0, igpu ? 0 : (gpu?.recommendedPsuWatts ?? 0)) || null;
  return { cpuW, gpuW, load, recommended };
}

/**
 * 整机检查。parts：{ CPU, GPU, MOTHERBOARD, RAM, SSD, PSU, CASE, COOLER }，每项为 { name, specs } 或 null。
 * opts：igpu（不配独显）、stockCooler（用原装散热）。
 */
export function evaluateBuild(parts, { igpu = false, stockCooler = false } = {}) {
  const s = slot => parts[slot]?.specs ?? null;
  const cpu = s('CPU'); const gpu = igpu ? null : s('GPU'); const board = s('MOTHERBOARD'); const ram = s('RAM');
  const ssd = s('SSD'); const psu = s('PSU'); const pc = s('CASE'); const cooler = stockCooler ? null : s('COOLER');
  const checks = [];
  const add = (id, label, status, detail, critical = false) => checks.push({ id, label, status, detail, critical });

  // CPU 插槽
  if (cpu && board) {
    const a = up(cpu.socket); const b = up(board.socket);
    if (!a || !b) add('socket', 'CPU 插槽', UNKNOWN, 'CPU 或主板缺少插槽信息。', true);
    else add('socket', 'CPU 插槽', a === b ? PASS : FAIL, a === b ? `CPU 与主板均为 ${a}。` : `CPU 为 ${a}，主板为 ${b}，装不上。`, true);
  }
  // BIOS
  if (cpu && board) {
    const r = biosSupport(parts.CPU?.name, board.chipset);
    add('bios', 'BIOS 支持', r.status, r.detail);
  }
  // 内存代际、条数、容量、频率
  if (board && ram) {
    const a = up(board.memoryType); const b = up(ram.memoryType);
    if (!a || !b) add('memoryType', '内存代际', UNKNOWN, '主板或内存缺少 DDR 代际信息。', true);
    else add('memoryType', '内存代际', a === b ? PASS : FAIL, a === b ? `主板与内存均为 ${a}。` : `主板支持 ${a}，内存是 ${b}。`, true);
    if (ram.modules && board.memorySlots) {
      add('memorySlots', '内存条数', ram.modules <= board.memorySlots ? PASS : FAIL,
        ram.modules <= board.memorySlots ? `${ram.modules} 条内存，主板 ${board.memorySlots} 个插槽。` : `${ram.modules} 条内存，主板只有 ${board.memorySlots} 个插槽。`);
    }
    if (ram.capacityGB && board.maxMemoryGB) {
      add('memoryCapacity', '内存容量', ram.capacityGB <= board.maxMemoryGB ? PASS : FAIL, `内存 ${ram.capacityGB}GB，主板最大 ${board.maxMemoryGB}GB。`);
    }
    const base = a === 'DDR4' ? 3200 : a === 'DDR5' ? (up(board.socket).startsWith('AM') ? 5200 : 5600) : null;
    if (base && ram.speedMTs) {
      add('memorySpeed', '内存频率', ram.speedMTs > base ? CONDITIONAL : PASS, ram.speedMTs > base
        ? `内存标称 ${ram.speedMTs} MT/s，高于平台默认 ${base}：要在 BIOS 里开 ${up(board.socket).startsWith('AM') ? 'EXPO / XMP' : 'XMP'} 才能跑到标称频率，否则按 ${base} 运行。`
        : `${ram.speedMTs} MT/s，平台默认即可运行。`);
    }
  }
  // 核显方案：CPU 核显 + 主板视频接口
  if (igpu) {
    if (parts.CPU) add('igpuCpu', 'CPU 核显', cpuHasIgpu(parts.CPU.name, cpu ?? {}) ? PASS : FAIL,
      cpuHasIgpu(parts.CPU.name, cpu ?? {}) ? '不配独显，CPU 带核显。' : '不配独显，但这颗 CPU 没有核显，接显示器不会亮。', true);
    if (board) add('videoOutput', '主板视频接口', board.videoOutputs === true ? PASS : board.videoOutputs === false ? FAIL : UNKNOWN,
      board.videoOutputs === true ? '主板有视频输出接口，核显可以接显示器。' : board.videoOutputs === false ? '主板没有视频输出接口，核显用不了。' : '主板缺少视频接口信息。', true);
  } else {
    add('videoOutput', '主板视频接口', NOT_APPLICABLE, '有独立显卡，显示器接显卡。');
  }
  // 显卡供电、电源功率、12V
  if (gpu && psu) {
    const r = gpuPowerCheck(gpu, psu);
    add('gpuPower', '显卡供电接口', r.status, r.detail, true);
  }
  if (cpu && psu) {
    const p = powerEstimate(cpu, gpu, { igpu });
    if (!psu.ratedWatts) add('psuWatts', '电源功率', UNKNOWN, '电源缺少额定功率。', true);
    else if (!p.recommended) add('psuWatts', '电源功率', UNKNOWN, `电源 ${psu.ratedWatts}W；CPU 或显卡缺少功耗数据，无法估算余量。`, true);
    else add('psuWatts', '电源功率', psu.ratedWatts >= p.recommended ? PASS : FAIL,
      `${p.load ? `估算满载约 ${p.load}W，` : ''}建议 ≥ ${p.recommended}W（含 25% 余量${gpu?.recommendedPsuWatts ? `，显卡厂商建议 ${gpu.recommendedPsuWatts}W` : ''}），电源额定 ${psu.ratedWatts}W。`, true);
    // 12V 输出：单路电流明确时检查 CPU + 显卡；多路 12V 时提示单路上限
    const need12 = p.cpuW != null && p.gpuW != null ? p.cpuW + p.gpuW : null;
    if (psu.rail12vAmps && need12) {
      const w = Math.round(psu.rail12vAmps * 12);
      add('psu12v', '电源 12V 输出', w >= need12 * 1.1 ? PASS : FAIL, `12V 输出约 ${w}W（${psu.rail12vAmps}A），CPU + 显卡约 ${need12}W。`, true);
    } else if (psu.rail12vSplitAmps?.length && p.gpuW) {
      const single = Math.round(Math.max(...psu.rail12vSplitAmps) * 12);
      add('psu12v', '电源 12V 输出', p.gpuW <= single * 0.9 ? CONDITIONAL : FAIL,
        `电源是多路 12V（每路约 ${single}W），显卡约 ${p.gpuW}W ${p.gpuW <= single * 0.9 ? '在单路能力内，但余量有限，建议选单路 12V 的电源' : '超过单路能力，满载可能触发保护关机'}。`, true);
    }
  }
  // 散热器扣具
  if (cpu && cooler) {
    const list = Array.isArray(cooler.sockets) ? cooler.sockets.map(up) : null;
    const socket = up(cpu.socket);
    if (!list || !socket) add('coolerSocket', '散热器扣具', UNKNOWN, '散热器缺少支持插槽列表。');
    else {
      const direct = list.includes(socket);
      const via = !direct && (MOUNT_EQUIV[socket] ?? []).find(x => list.includes(x));
      add('coolerSocket', '散热器扣具', direct || via ? PASS : FAIL,
        direct ? `散热器支持 ${socket}。` : via ? `散热器列出 ${via}，${socket} 与 ${via} 扣具相同。` : `散热器不支持 ${socket}。`);
    }
  }
  // 机箱：显卡长度、风冷高度 / 冷排、主板板型
  if (pc) {
    if (gpu) add('gpuLength', '显卡长度', !gpu.lengthMm || !pc.maxGpuLengthMm ? UNKNOWN : gpu.lengthMm <= pc.maxGpuLengthMm ? PASS : FAIL,
      !gpu.lengthMm || !pc.maxGpuLengthMm ? '显卡长度或机箱显卡限长缺少数据。' : `显卡 ${gpu.lengthMm}mm，机箱限长 ${pc.maxGpuLengthMm}mm${gpu.lengthMm <= pc.maxGpuLengthMm ? `，余量 ${pc.maxGpuLengthMm - gpu.lengthMm}mm` : ''}。`);
    if (cooler?.radiatorSizeMm) add('radiator', '水冷排', !pc.maxRadiatorMm ? UNKNOWN : cooler.radiatorSizeMm <= pc.maxRadiatorMm ? PASS : FAIL,
      !pc.maxRadiatorMm ? '机箱缺少冷排支持数据。' : `冷排 ${cooler.radiatorSizeMm}mm，机箱最大 ${pc.maxRadiatorMm}mm。`);
    else if (cooler) add('coolerHeight', '风冷高度', !cooler.heightMm || !pc.maxCoolerHeightMm ? UNKNOWN : cooler.heightMm <= pc.maxCoolerHeightMm ? PASS : FAIL,
      !cooler.heightMm || !pc.maxCoolerHeightMm ? '散热器高度或机箱限高缺少数据。' : `散热器 ${cooler.heightMm}mm，机箱限高 ${pc.maxCoolerHeightMm}mm。`);
    if (board) {
      const size = BOARD_RANK[up(board.formFactor)]; const max = BOARD_RANK[up(pc.maxBoardFormFactor)];
      add('boardFit', '主板板型', !size || !max ? UNKNOWN : size <= max ? PASS : FAIL,
        !size || !max ? '主板板型或机箱支持的板型缺少数据。' : `主板 ${up(board.formFactor)}，机箱最大 ${up(pc.maxBoardFormFactor)}。`);
    }
  }
  // M.2 固态
  if (ssd && board && /M\.2/i.test(ssd.interface ?? '')) {
    add('m2', 'M.2 接口', board.m2Slots == null ? UNKNOWN : board.m2Slots > 0 ? PASS : FAIL,
      board.m2Slots == null ? '主板缺少 M.2 接口数量。' : board.m2Slots > 0 ? `主板有 ${board.m2Slots} 个 M.2 接口。` : '主板没有 M.2 接口，只能用 SATA 固态。');
  }
  // PCIe 代数：x8 显卡在 PCIe 3.0 主板上带宽减半
  if (gpu && board?.pcieGen) {
    const chip = up(gpu.chipset);
    const x8 = /RTX\s*(4060|5060|5050|3050)|RX\s*(6600|6650|7600|9060)|RX\s*6500|ARC\s*B5/.test(chip) && !/4060\s*TI/.test(chip) ? true : null;
    if (x8 && board.pcieGen <= 3) add('pcie', 'PCIe 带宽', CONDITIONAL, '这张显卡只用 PCIe x8，插在 PCIe 3.0 主板上带宽减半，显存不够时掉帧更明显。');
    else add('pcie', 'PCIe 带宽', PASS, `主板 PCIe ${board.pcieGen}.0。`);
  }
  // Intel Arc：ReBAR
  if (gpu?.needsResizableBar && board) {
    const old = chipsetSeries(board.chipset);
    add('rebar', 'Resizable BAR', old && old.letter !== 'Z' && old.series === 300 && up(board.socket) === 'AM4' ? UNKNOWN : CONDITIONAL,
      'Intel Arc 显卡需要在 BIOS 里开启 Resizable BAR 和 Above 4G Decoding、系统用 UEFI 模式安装，否则性能大幅下降。');
  }
  // 主板供电：高功耗 CPU 配入门芯片组 / 供电相数少
  if (cpu?.maxPowerWatts >= 200 && board) {
    const entry = /^(A[56]20|H[68]10|A320)$/.test(up(board.chipset));
    const fewPhases = board.vrmPhases && board.vrmPhases < 10;
    if (entry || fewPhases) add('vrm', '主板供电', CONDITIONAL, `CPU 峰值约 ${cpu.maxPowerWatts}W，${entry ? `${up(board.chipset)} 是入门芯片组` : `主板供电 ${board.vrmPhases} 相`}，长时间满载可能过热降频；建议选供电更好的 B / Z 系主板。`);
    else if (board.vrmPhases) add('vrm', '主板供电', PASS, `主板供电 ${board.vrmPhases} 相。`);
  }
  return checks;
}

/** 整机结论：有 FAIL 即不兼容；关键项 UNKNOWN 为“待核实”；其余条件项为“条件兼容” */
export function overallStatus(checks) {
  if (checks.some(c => c.status === FAIL)) return FAIL;
  if (checks.some(c => c.status === UNKNOWN && c.critical)) return UNKNOWN;
  if (checks.some(c => c.status === CONDITIONAL || c.status === UNKNOWN)) return CONDITIONAL;
  return PASS;
}

export const severity = status => RANK[status] ?? 0;
