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
import { requiredCaseFans } from './accessories.mjs';
import { boardCaseStatus, boardFormat, supportedBoardFormats, coolerThermalCheck, caseThermalCheck, pcieLink, gpuPowerWatts, memorySpeedCheck, psuFitCheck, sustainedPower } from './hardware-specs.mjs';

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
  // 2.2.3：AM4 Athlon APU——200GE / 220GE / 240GE 为 Raven Ridge（Zen），3000G / 300GE / 320GE 为 Picasso（Zen+ APU）
  if (/ATHLON\s*(?:SILVER\s*|GOLD\s*)?(?:PRO\s*)?2[024]0GE\b/.test(n)) return { vendor: 'AMD', family: 'zen1' };
  if (/ATHLON\s*(?:SILVER\s*|GOLD\s*)?(?:PRO\s*)?(?:3000G|3[02]0GE)\b/.test(n)) return { vendor: 'AMD', family: 'zen+apu' };
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
export function biosSupport(cpuName, boardChipset, boardSpecs = {}) {
  const gen = cpuGeneration(cpuName);
  const cs = chipsetSeries(boardChipset);
  if (!gen || !cs) return { status: UNKNOWN, detail: '缺少 CPU 代际或主板芯片组信息，请向商家确认主板 BIOS 是否支持这颗 CPU。' };
  const amd = gen.vendor === 'AMD';
  const flashback = boardSpecs?.biosFlashback === true ? '（该主板支持无 CPU 刷新 BIOS / Flashback）' : '';
  const update = what => ({ status: CONDITIONAL, detail: `${what}：主板需要更新到支持这颗 CPU 的 BIOS（新批次可能已出厂支持），下单前向商家确认，或选带 BIOS 免 CPU 刷新功能的主板${flashback}。` });
  if (amd && cs.series >= 300 && cs.series <= 500) {
    if (cs.series === 500 && ['zen1', 'zen+apu'].includes(gen.family)) return { status: FAIL, detail: `${boardChipset} 不支持这一代 Ryzen（AMD 未提供支持）。` };
    if (cs.series === 500 && gen.family === 'zen3') return update(`${boardChipset} 早期批次`);
    if (cs.series <= 400 && ['zen2', 'zen3'].includes(gen.family)) return update(`${boardChipset} 装 Ryzen ${gen.family === 'zen2' ? '3000' : '5000'}`);
    // 300 系主板装 Zen+ APU（3000G / 3200G / 3400G）需要较新 BIOS
    if (cs.series === 300 && gen.family === 'zen+apu') return update(`${boardChipset} 装 Zen+ APU`);
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

/**
 * 电源显卡供电接口的规范化视图（2.2.2）。
 * native16：true 有原生 12VHPWR / 12V-2x6；false 明确没有；null 未知（数据缺失时既不默认有，也不默认没有）。
 * pcie8：6+2pin / 8pin 插头数；independentCables：独立 PCIe 线材数（与插头数分开，一根线可能带两个插头）。
 */
export function psuConnectors(psu = {}) {
  const explicitNo = psu.native12v2x6 === false && psu.native12vhpwr !== true || psu.native12vhpwr === false && psu.native12v2x6 !== true;
  const yes = psu.native12v2x6 === true || psu.native12vhpwr === true || psu.pin16Count > 0 || psu.native16Pin === true;
  const no = !yes && (explicitNo || psu.pin16Count === 0 || psu.native16Pin === false);
  return {
    native16: yes ? true : no ? false : null,
    native16Type: psu.native12v2x6 === true ? '12V-2x6' : psu.native12vhpwr === true ? '12VHPWR' : yes ? '16pin' : null,
    native16Count: psu.pin16Count ?? (yes ? 1 : no ? 0 : null),
    native16Watts: psu.connectorPowerRating ?? psu.native16PinCableWatts ?? null,
    pcie8: psu.pcie8pinConnectors ?? psu.pcie8Count ?? null,
    independentCables: psu.independentPcieCables ?? null,
    cableSource: psu.cableSource ?? null,
    revision: psu.hardwareRevision ?? null,
  };
}

const CABLE_RULE = '只使用该电源原厂配套的模组线，禁止混用其他电源（含同品牌不同型号）的模组线。';

/** 显卡供电接口 × 电源接口 */
export function gpuPowerCheck(gpu, psu) {
  // 旧方案只存了接口文字（gpuPowerConnector: "16PIN" / 目录 powerConnectors），也能解析
  const need = gpu?.powerPins ?? parseGpuPower(gpu?.gpuPowerConnector ?? gpu?.powerConnectors);
  if (!need) return { status: UNKNOWN, detail: '显卡缺少供电接口数据，请核对显卡需要几个 8pin / 16pin，以及电源是否够用。' };
  if (!need.none && !need.pin6 && !need.pin8 && !need.pin16) return { status: UNKNOWN, detail: '显卡供电接口记录不完整。' };
  if (need.none) return { status: NOT_APPLICABLE, detail: '显卡不需要外接供电。' };
  const c = psuConnectors(psu ?? {});
  const has8 = c.pcie8;
  const watts = gpuPowerWatts(gpu);
  const highPower = (watts ?? 600) >= 450;
  if (need.pin16) {
    const pins = adapterPins(watts ?? 600);
    if (c.native16 === true) {
      if (c.native16Watts != null && watts != null && c.native16Watts < watts) return { status: FAIL, detail: `电源原生 ${c.native16Type} 线额定 ${c.native16Watts}W，低于显卡整卡规格 ${watts}W。` };
      // 2.2.3：所有功耗等级用同一规则——原生线额定未知即无法确认（12VHPWR / 12V-2x6 线材有 150 / 300 / 450 / 600W 等级），不按整机电源额定功率推断；≥300W 为关键
      if (c.native16Watts == null) return { status: UNKNOWN, critical: (watts ?? 600) >= 300, detail: `显卡整卡规格 ${watts ?? '未知'}W。电源有原生 16pin，但没有该原厂线材的额定功率等级（150 / 300 / 450 / 600W）记录，须按线材标注或电源厂商说明核对；不能用电源总功率代替线材额定。${CABLE_RULE}` };
      return { status: PASS, detail: `显卡 16pin 供电，电源带原生 ${c.native16Type}${c.native16Watts ? `（线材额定 ${c.native16Watts}W）` : ''}${psu?.atxVersion?.startsWith('3') ? `，ATX ${psu.atxVersion}` : ''}。插头须插到底。${CABLE_RULE}` };
    }
    if (has8 == null) return { status: UNKNOWN, detail: `显卡 16pin 供电。电源${c.native16 === false ? '明确没有原生 16pin' : '是否有原生 16pin 未知'}，也没有显卡 8pin 接口数量，无法确认供电方案。` };
    if (has8 < pins) {
      // 原生接口未知时不能判死：可能有未记录的原生 16pin
      return c.native16 === false
        ? { status: FAIL, detail: `显卡 16pin 供电${watts ? `（约 ${watts}W）` : ''}，转接需要 ${pins} 个 8pin，电源只有 ${has8} 个，也没有原生 16pin。` }
        : { status: UNKNOWN, detail: `显卡 16pin 供电，转接需要 ${pins} 个 8pin，电源记录只有 ${has8} 个；电源是否有原生 16pin 未知，须按具体型号 / Rev 版本核实。` };
    }
    const nativeText = c.native16 === false ? '电源明确没有原生 16pin' : '电源是否有原生 16pin 未知（目录只记录了 8pin 插头数，不能据此认定没有，也不能认定有）';
    const cables = c.independentCables;
    if (cables != null && cables >= pins) return { status: CONDITIONAL, detail: `显卡 16pin 供电，${nativeText}：用显卡附带的转接线，需 ${pins} 根独立 8pin 线（电源有 ${cables} 根独立 PCIe 线、${has8} 个插头）。${highPower ? '高功耗显卡更稳妥是用带原生 12V-2x6 原厂线的电源。' : ''}${CABLE_RULE}` };
    if (cables != null && cables < pins) return { status: highPower ? FAIL : CONDITIONAL, detail: `显卡 16pin 转接需要 ${pins} 根独立 8pin 线，电源只有 ${cables} 根独立 PCIe 线（${has8} 个插头含一线双头）。${highPower ? '高功耗显卡不能用一线双头凑数。' : '一线双头需确认厂商允许。'}` };
    return { status: highPower ? UNKNOWN : CONDITIONAL, detail: `显卡 16pin 供电${watts ? `（约 ${watts}W）` : ''}，${nativeText}。转接需 ${pins} 根独立 8pin 线；电源有 ${has8} 个 8pin 插头，但独立线材数量未知（一根线可能带两个插头），${highPower ? '高功耗显卡须核实后才能使用。' : '需核实。'}${CABLE_RULE}` };
  }
  const needPins = (need.pin8 ?? 0) + (need.pin6 ?? 0);
  if (has8 == null) return { status: UNKNOWN, detail: `显卡需要 ${describePins(need)}，电源没有标注显卡供电接口数量。` };
  // 电源的 8pin 多为 6+2pin，可当 6pin 用；6pin 只能接 6pin
  const usable = has8 + (need.pin6 ? Math.min(psu.pcie6Count ?? 0, need.pin6) : 0);
  if (!(usable >= needPins && has8 >= (need.pin8 ?? 0))) return { status: FAIL, detail: `显卡需要 ${describePins(need)}，电源只有 ${has8} 个 8pin${psu.pcie6Count ? `、${psu.pcie6Count} 个 6pin` : ''}。` };
  const cables = c.independentCables;
  if (needPins >= 3 && cables != null && cables < needPins) return { status: CONDITIONAL, detail: `显卡需要 ${describePins(need)}，电源 ${has8} 个插头但只有 ${cables} 根独立 PCIe 线，需一线双头供电，须确认厂商允许。` };
  if (needPins >= 3 && cables == null) return { status: CONDITIONAL, detail: `显卡需要 ${describePins(need)}，电源有 ${has8} 个 8pin 插头；独立线材数量未知，建议每个接口各用一根独立线。${CABLE_RULE}` };
  return { status: PASS, detail: `显卡需要 ${describePins(need)}，电源有 ${has8} 个 8pin${psu.pcie6Count ? `、${psu.pcie6Count} 个 6pin` : ''}。` };
}
/**
 * 16pin（12VHPWR / 12V-2x6）供电线空间（2.2.2）。
 * 需求：显卡 / 线材厂商给出的要求（requiredCableClearanceMm，含显卡高度）优先；否则用 35mm 工程参考值
 * （常见厂商安装建议，PCI-SIG 没有适用于全部线材的统一数值）。插头位置：powerConnectorPosition 为 'end' 时不占侧板空间。
 * 空间：只认机箱的供电线空间 gpuCableClearanceMm 或显卡高度限制 maxGpuHeightMm（同一基准）。
 * CPU 散热器限高测量基准不同，只作参考，不能确认安全空间；高功耗（≥300W）缺少依据时为关键待核实。
 */
export const CABLE_BEND_REFERENCE_MM = 35;
const mm = v => Math.round(v * 10) / 10;
export function gpuCableClearance(gpu = {}, pc = {}) {
  const watts = gpuPowerWatts(gpu) ?? 0;
  const critical = watts >= 300;
  if (gpu.powerConnectorPosition === 'end') return { status: CONDITIONAL, critical: false, detail: '16pin 插头在显卡尾部，不占侧板方向空间；需核对显卡长度方向与前置风扇 / 冷排的走线余量。' };
  const vendorNeed = gpu.requiredCableClearanceMm;
  const need = vendorNeed ?? (gpu.heightMm != null ? mm(gpu.heightMm + CABLE_BEND_REFERENCE_MM) : null);
  const needText = vendorNeed ? `厂商要求 ${vendorNeed}mm` : `显卡高度 ${gpu.heightMm ?? '?'}mm + ${CABLE_BEND_REFERENCE_MM}mm 工程参考直线段（非统一官方要求）= ${need ?? '?'}mm`;
  const room = pc.gpuCableClearanceMm ?? pc.maxGpuHeightMm ?? null;
  if (need != null && room != null) {
    const margin = mm(room - need);
    if (margin < 0) return { status: FAIL, critical: true, detail: `16pin 供电线需 ${needText}，机箱${pc.gpuCableClearanceMm != null ? '供电线空间' : '显卡高度限制'} ${room}mm，空间不足，插头会被侧板压弯。` };
    if (margin < 10) return { status: UNKNOWN, critical, detail: `16pin 供电线需 ${needText}，机箱空间 ${room}mm，余量仅 ${margin}mm；理论余量过小，须实测或换用 90° 原厂线。` };
    return { status: vendorNeed ? PASS : CONDITIONAL, critical: false, detail: `16pin 供电线需 ${needText}，机箱空间 ${room}mm，余量 ${margin}mm。插头须插到底，直线段内不要弯折。` };
  }
  const proxy = pc.maxCoolerHeightMm != null && need != null ? mm(pc.maxCoolerHeightMm - need) : null;
  return { status: UNKNOWN, critical,
    detail: `16pin 供电线需 ${needText}。机箱没有公布显卡高度限制或供电线空间${proxy != null ? `；CPU 散热器限高 ${pc.maxCoolerHeightMm}mm 与显卡高度测量基准不同，不能作为供电线空间依据（按其粗算余量 ${proxy}mm，仅供参考）` : ''}。${critical ? `显卡约 ${watts}W，属高功耗 16pin，须实测侧板空间或确认机箱 / 线材厂商数据后再使用。` : '需核实侧板空间。'}`,
    evidence: { type: 'incomplete', requiredMm: need, proxyMarginMm: proxy } };
}

/**
 * 水冷冷排安装（2.2.2）：按机箱公布的冷排位置逐个校核。
 *   顶部：冷排厚度 + 25mm 风扇与内存高度 / 主板散热片共用空间（机箱有 topRadiatorClearanceMm 时比较，否则需核对）
 *   前置：冷排厚度 + 25mm 风扇占用显卡限长，重新计算显卡可用长度
 * 冷排厚度未知时按不确定处理，不套用典型值。
 */
export function radiatorLayoutCheck(cooler = {}, pc = {}, gpu = null, ram = null) {
  const size = cooler.radiatorSizeMm;
  const positions = (pc.radiatorPositions ?? []).filter(p => p.sizesMm?.includes(size));
  if (!pc.radiatorPositions?.length) return { status: UNKNOWN, critical: true, detail: `机箱缺少 ${size}mm 冷排的具体安装位置数据，不能确认与显卡、内存、电源的空间关系。` };
  if (!positions.length) return { status: FAIL, critical: true, detail: `机箱公布的冷排位置（${pc.radiatorPositions.map(p => `${p.position} ${p.sizesMm.join('/')}`).join('，')}）都不支持 ${size}mm。` };
  const thick = cooler.radiatorThicknessMm;
  const stack = thick != null ? thick + 25 : null;
  const notes = [];
  const top = positions.find(p => p.position === 'top');
  if (top) {
    if (pc.topRadiatorClearanceMm != null && stack != null) {
      const ramH = ram?.heightMm ?? null;
      if (stack > pc.topRadiatorClearanceMm) notes.push({ ok: false, text: `顶部冷排 + 风扇厚 ${stack}mm，超过顶部空间 ${pc.topRadiatorClearanceMm}mm` });
      else return { status: CONDITIONAL, critical: false, detail: `${size}mm 冷排装顶部：冷排 ${thick}mm + 风扇 25mm = ${stack}mm，顶部空间 ${pc.topRadiatorClearanceMm}mm${ramH ? `；内存高 ${ramH}mm 需核对与冷排错位` : '；需核对内存高度与主板供电散热片'}。` };
    } else {
      return { status: CONDITIONAL, critical: false, detail: `${size}mm 冷排装顶部（机箱支持）。${stack != null ? `冷排 ${thick}mm + 风扇 25mm = ${stack}mm，` : '冷排厚度未知，'}机箱未公布顶部冷排与内存 / 主板散热片间距，装机前须核对高马甲内存与冷排是否冲突。` };
    }
  }
  const front = positions.find(p => p.position === 'front');
  if (front && gpu) {
    if (stack == null) notes.push({ ok: null, text: '前置冷排厚度未知，无法重新计算显卡可用长度' });
    else if (gpu.lengthMm != null && pc.maxGpuLengthMm != null) {
      const usable = pc.maxGpuLengthMm - stack;
      if (gpu.lengthMm <= usable) return { status: CONDITIONAL, critical: false, detail: `${size}mm 冷排装前置：显卡可用长度 ${pc.maxGpuLengthMm} − ${stack} = ${usable}mm，显卡 ${gpu.lengthMm}mm（余量 ${usable - gpu.lengthMm}mm）；机箱限长是否已扣除前置风扇需按说明书核对。` };
      notes.push({ ok: false, text: `前置冷排后显卡可用长度 ${usable}mm，小于显卡 ${gpu.lengthMm}mm` });
    }
  } else if (front) return { status: CONDITIONAL, critical: false, detail: `${size}mm 冷排装前置（核显方案无显卡长度冲突）。` };
  const other = positions.find(p => !['top', 'front'].includes(p.position));
  if (other) return { status: CONDITIONAL, critical: false, detail: `${size}mm 冷排装${other.position}位置；需核对与其他配件的空间。${notes.map(n => n.text).join('；')}` };
  if (notes.some(n => n.ok === false) && !notes.some(n => n.ok === null)) return { status: FAIL, critical: true, detail: notes.map(n => n.text).join('；') };
  return { status: UNKNOWN, critical: true, detail: `${notes.map(n => n.text).join('；')}，不能确认冷排安装空间。` };
}

/**
 * 显卡有效限长（2.2.3）：显式记录每一项扣减，只扣一次。
 *   rawLimitMm               机箱公布的显卡限长
 *   includesFrontFans        机箱说明限长是否已扣除前置风扇（gpuLengthIncludesFrontFans）
 *   frontFanAllowanceMm      需要前置进风且限长未扣除风扇时 25mm
 *   radiatorAllowanceMm      水冷只能装前置时：冷排厚度 + 25mm 风扇（风扇装在冷排上，不再另扣前置风扇）
 *   effectiveLimitMm         rawLimit − 实际扣减
 *   marginMm                 有效限长 − 显卡长度
 */
export function gpuLengthClearance(gpu = {}, pc = {}, { frontFans = false, cooler = null } = {}) {
  const raw = pc.maxGpuLengthMm ?? null;
  const len = gpu.lengthMm ?? null;
  const source = pc.gpuLengthSource ?? (pc.specEvidence?.[0]?.sourceUrl ?? null);
  const evidence = { rawLimitMm: raw, includesFrontFans: pc.gpuLengthIncludesFrontFans ?? null, frontFanAllowanceMm: 0, radiatorAllowanceMm: 0, effectiveLimitMm: null, gpuLengthMm: len, marginMm: null, source, measurementCondition: pc.gpuLengthCondition ?? '未注明测量条件' };
  if (!raw || !len) return { status: UNKNOWN, detail: '显卡长度或机箱显卡限长缺少数据。', evidence };
  const sizes = cooler?.radiatorSizeMm;
  const frontOnlyRadiator = sizes && !(pc.radiatorPositions ?? []).some(p => p.position === 'top' && p.sizesMm?.includes(sizes)) && (pc.radiatorPositions ?? []).some(p => p.position === 'front' && p.sizesMm?.includes(sizes));
  if (frontOnlyRadiator) {
    if (cooler.radiatorThicknessMm == null) return { status: UNKNOWN, detail: `${sizes}mm 冷排只能装前置，冷排厚度未知，无法计算显卡有效限长（机箱限长 ${raw}mm）。`, evidence };
    evidence.radiatorAllowanceMm = cooler.radiatorThicknessMm + 25;
  } else if (frontFans && pc.gpuLengthIncludesFrontFans !== true) evidence.frontFanAllowanceMm = 25;
  const deduct = evidence.radiatorAllowanceMm + evidence.frontFanAllowanceMm;
  evidence.effectiveLimitMm = mm(raw - deduct);
  evidence.marginMm = mm(evidence.effectiveLimitMm - len);
  const parts = [`机箱限长 ${raw}mm`];
  if (evidence.radiatorAllowanceMm) parts.push(`− 前置冷排 + 风扇 ${evidence.radiatorAllowanceMm}mm`);
  if (evidence.frontFanAllowanceMm) parts.push('− 前置风扇 25mm（机箱未说明限长已扣除风扇）');
  if (pc.gpuLengthIncludesFrontFans === true && frontFans) parts.push('（机箱说明限长已扣除前置风扇，不重复扣减）');
  const calc = `${parts.join(' ')} = 有效限长 ${evidence.effectiveLimitMm}mm；显卡 ${len}mm`;
  if (len > raw) return { status: FAIL, detail: `显卡 ${len}mm 超过机箱限长 ${raw}mm。`, evidence };
  if (evidence.marginMm < 0) return { status: deduct && evidence.radiatorAllowanceMm ? FAIL : UNKNOWN, detail: `${calc}，余量 ${evidence.marginMm}mm：装上${evidence.radiatorAllowanceMm ? '前置冷排' : '前置风扇'}后可能顶到显卡。`, evidence };
  return { status: PASS, detail: `${calc}，余量 ${evidence.marginMm}mm。`, evidence };
}

const describePins = p => [p.pin8 && `${p.pin8} 个 8pin`, p.pin6 && `${p.pin6} 个 6pin`].filter(Boolean).join(' + ');

/** 整机功耗估算：CPU 峰值 + 显卡整卡功耗 + 75W（主板、内存、硬盘、风扇） */
export function powerEstimate(cpu, gpu, { igpu = false, cpuPowerLimitWatts = null } = {}) {
  // 2.2.3：明确的 CPU 功耗限制（BIOS 限功耗方案）按限制值计算电源需求
  const cpuW = cpu?.maxPowerWatts != null && cpuPowerLimitWatts > 0 ? Math.min(cpu.maxPowerWatts, cpuPowerLimitWatts) : cpu?.maxPowerWatts ?? null;
  const gpuW = igpu ? 0 : gpuPowerWatts(gpu);
  const load = cpuW != null && gpuW != null ? cpuW + gpuW + 75 : null;
  const calculated = load == null ? null : Math.ceil(load * 1.25);
  const manufacturer = igpu ? null : gpu?.recommendedPsuWatts ?? null;
  const recommended = Math.max(calculated ?? 0, manufacturer ?? 0) || null;
  const policyFloor = igpu ? 300 : 450;
  return { cpuW, gpuW, load, recommended, calculated, manufacturer, policyFloor, selectionMinimum: Math.max(recommended ?? 0, policyFloor) };
}

const physicalChecks = new Set(['socket', 'memoryType', 'memorySlots', 'memoryCapacity', 'igpuCpu', 'videoOutput',
  'coolerSocket', 'gpuLength', 'gpuHeight', 'gpuThickness', 'gpuSlots', 'psuLength', 'psuFormat', 'radiator', 'radiatorLayout', 'coolerHeight', 'boardFit', 'm2']);
const safetyChecks = new Set(['gpuPower', 'psuWatts', 'psu12v', 'gpuCable', 'cpuCooling', 'caseAirflow', 'vrm']);
const performanceChecks = new Set(['memorySpeed', 'pcie', 'ssdPcie', 'rebar']);
function describeCheck(id, label, status, detail, critical, evidence) {
  const severity = status === FAIL && ['pcie', 'ssdPcie'].includes(id) ? 'physical'
    : physicalChecks.has(id) ? 'physical' : safetyChecks.has(id) ? (critical || status === FAIL ? 'safety' : 'measurement')
      : performanceChecks.has(id) ? 'performance' : id === 'bios' ? 'installation' : 'data';
  const blocking = status === FAIL || (status === UNKNOWN && critical);
  return { id, check_id: id, label, status, detail, critical, severity, blocking,
    evidence: evidence ?? { type: status === UNKNOWN ? 'incomplete' : id === 'bios' ? 'platform-rule' : 'specification', detail },
    confidence: status === UNKNOWN ? 'low' : status === CONDITIONAL ? 'medium' : 'high',
    required_action: status === PASS || status === NOT_APPLICABLE ? null : detail };
}

export function riskSummary(checks) {
  const domain = severity => overallStatus(checks.filter(c => c.severity === severity));
  return { physical: domain('physical'), safety: domain('safety'), blockingChecks: checks.filter(c => c.blocking).map(c => c.id),
    needsConfirmation: checks.some(c => c.status === UNKNOWN || c.status === CONDITIONAL) };
}

/**
 * 整机检查。parts：{ CPU, GPU, MOTHERBOARD, RAM, SSD, PSU, CASE, COOLER }，每项为 { name, specs } 或 null。
 * opts：igpu（不配独显）、stockCooler（用原装散热）。
 */
export function evaluateBuild(parts, { igpu = false, stockCooler = false, workload = {} } = {}) {
  const s = slot => parts[slot]?.specs ?? null;
  const cpu = s('CPU'); const gpu = igpu ? null : s('GPU'); const board = s('MOTHERBOARD'); const ram = s('RAM');
  const ssd = s('SSD'); const psu = s('PSU'); const pc = s('CASE'); const cooler = stockCooler ? null : s('COOLER');
  const checks = [];
  const add = (id, label, status, detail, critical = false, evidence) => checks.push(describeCheck(id, label, status, detail, critical, evidence));
  const highPower = (gpuPowerWatts(gpu) ?? 0) >= 250 || (cpu?.maxPowerWatts ?? 0) >= 180;
  workload = { ...(cpu?.workload ?? {}), ...workload };

  // CPU 插槽
  if (cpu && board) {
    const a = up(cpu.socket); const b = up(board.socket);
    if (!a || !b) add('socket', 'CPU 插槽', UNKNOWN, 'CPU 或主板缺少插槽信息。', true);
    else add('socket', 'CPU 插槽', a === b ? PASS : FAIL, a === b ? `CPU 与主板均为 ${a}。` : `CPU 为 ${a}，主板为 ${b}，装不上。`, true);
  }
  // BIOS
  if (cpu && board) {
    const r = biosSupport(parts.CPU?.name, board.chipset, board);
    add('bios', 'BIOS 支持', r.status, r.detail, r.status === UNKNOWN);
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
    const speed = memorySpeedCheck(cpu, board, ram, parts.RAM?.mpn ?? ram.memorySku);
    if (speed) add('memorySpeed', '内存频率', speed.status, speed.detail, false, speed.factors ? { type: speed.status === UNKNOWN ? 'incomplete' : 'specification', factors: speed.factors, detail: speed.detail } : undefined);
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
    add('gpuPower', '显卡供电接口', r.status, r.detail, r.critical ?? true);
  }
  if (cpu && psu) {
    const p = powerEstimate(cpu, gpu, { igpu, cpuPowerLimitWatts: workload.cpuPowerLimitWatts });
    if (!psu.ratedWatts) add('psuWatts', '电源功率', UNKNOWN, '电源缺少额定功率。', true);
    else if (!p.recommended) add('psuWatts', '电源功率', UNKNOWN, `电源 ${psu.ratedWatts}W；CPU 或显卡缺少功耗数据，无法估算余量。`, true);
    else add('psuWatts', '电源功率', psu.ratedWatts < p.recommended ? FAIL : p.calculated == null ? UNKNOWN : PASS,
      `计算需求 ${p.calculated ?? '未知'}W，显卡厂商建议 ${p.manufacturer ?? '未提供'}W，采购策略下限 ${p.policyFloor}W，校核需求 ${p.recommended}W，电源额定 ${psu.ratedWatts}W。`, true,
      { type: 'power-calculation', ...p, ratedWatts: psu.ratedWatts });
    // 12V 输出：单路电流明确时检查 CPU + 显卡；多路 12V 时提示单路上限
    const need12 = p.cpuW != null && p.gpuW != null ? p.cpuW + p.gpuW : null;
    if (psu.rail12vAmps && need12) {
      const w = Math.round(psu.rail12vAmps * 12);
      add('psu12v', '电源 12V 输出', w >= need12 * 1.1 ? PASS : FAIL, `12V 输出约 ${w}W（${psu.rail12vAmps}A），CPU + 显卡约 ${need12}W。`, true);
    } else if (psu.rail12vSplitAmps?.length && p.gpuW) {
      const single = Math.round(Math.max(...psu.rail12vSplitAmps) * 12);
      add('psu12v', '电源 12V 输出', p.gpuW <= single * 0.9 ? CONDITIONAL : FAIL,
        `电源是多路 12V（每路约 ${single}W），显卡约 ${p.gpuW}W ${p.gpuW <= single * 0.9 ? '在单路能力内，但余量有限，建议选单路 12V 的电源' : '超过单路能力，满载可能触发保护关机'}。`, true);
    } else if (need12 >= 400) {
      add('psu12v', '电源 12V 输出', UNKNOWN, '高负载配置缺少电源 12V 合并额定输出和分路限制，额定总瓦数不能证明此项通过。', true);
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
  if (cpu && (cooler || stockCooler)) {
    // 2.2.2：原装散热与第三方散热共用证据模型；不按塔高推断能力，覆盖不了持续负载时为关键待核实并给出降功耗条件
    const r = coolerThermalCheck(cpu, cooler, pc, board ?? {}, workload, { stock: stockCooler });
    add('cpuCooling', 'CPU 持续散热', r.status,
      stockCooler && r.status !== UNKNOWN ? `使用盒装原装散热器：必须核对所购 SKU 包装实际含散热器，并采用厂家默认功耗限制。${r.detail}` : r.detail, r.critical,
      r.evidence ? { ...r.evidence, detail: r.detail } : undefined);
  }
  if (cpu && pc) {
    const r = caseThermalCheck(cpu, gpu, pc, board ?? {}, workload);
    add('caseAirflow', '机箱风道与热负载', r.status, r.detail, r.critical && r.status !== PASS,
      { type: r.status === PASS ? 'measurement' : r.status === CONDITIONAL ? 'engineering-judgment' : 'incomplete', thermalRiskLevel: r.thermalRiskLevel ?? null, detail: r.detail });
  }
  // 机箱：显卡长度、风冷高度 / 冷排、主板板型
  if (pc) {
    if (gpu) {
      const frontFans = cpu && requiredCaseFans(sustainedPower(cpu, board ?? {}, workload) ?? 0, gpuPowerWatts(gpu) ?? 0).intake > 0;
      const r = gpuLengthClearance(gpu, pc, { frontFans, cooler });
      add('gpuLength', '显卡长度', r.status, r.detail, true, { type: r.status === UNKNOWN ? 'incomplete' : 'specification', ...r.evidence, detail: r.detail });
    }
    if (cooler?.radiatorSizeMm) add('radiator', '水冷排', !pc.maxRadiatorMm ? UNKNOWN : cooler.radiatorSizeMm <= pc.maxRadiatorMm ? PASS : FAIL,
      !pc.maxRadiatorMm ? '机箱缺少冷排支持数据。' : `冷排 ${cooler.radiatorSizeMm}mm，机箱最大 ${pc.maxRadiatorMm}mm。`);
    else if (cooler) add('coolerHeight', '风冷高度', !cooler.heightMm || !pc.maxCoolerHeightMm ? UNKNOWN : cooler.heightMm <= pc.maxCoolerHeightMm ? PASS : FAIL,
      !cooler.heightMm || !pc.maxCoolerHeightMm ? '散热器高度或机箱限高缺少数据。' : `散热器 ${cooler.heightMm}mm，机箱限高 ${pc.maxCoolerHeightMm}mm。`, true);
    if (board) {
      const status = boardCaseStatus(board, pc);
      add('boardFit', '主板板型', status, status === UNKNOWN ? '主板板型或明确的机箱主板支持集合缺少数据。' : `主板 ${boardFormat(board.formFactor)}，机箱明确支持 ${supportedBoardFormats(pc).join(' / ')}。`, true);
    }
    const compare = (id, label, size, limit, critical = true) => add(id, label, size == null || limit == null ? UNKNOWN : size <= limit ? PASS : FAIL,
      size == null || limit == null ? `${label}缺少尺寸 / 限制数据。` : `${size}，允许最大 ${limit}。`, critical);
    // 2.2.1：机箱几乎不公布“显卡高度 / 厚度限制、电源长度限制、供电线空间”（运行时目录覆盖率 0–1/231），
    // 2.2.0 对这些缺失一律判 UNKNOWN，显卡 ≥250W 时为阻断项——高端显卡整机因此全部无法入选。
    // 现在：机箱公布了限制就直接比较（PASS / FAIL）；没公布时用已有规格做保守推断，推断可装入记为 CONDITIONAL
    // 并写明依据和需要核对的内容；推断不了（尺寸未知、或超过替代限制）仍为 UNKNOWN，保持原来的阻断级别。
    const slotsOf = g => (g.slotWidth != null ? Math.ceil(g.slotWidth) : g.thicknessMm ? Math.ceil(g.thicknessMm / 20.32) : null);
    if (gpu) {
      // 高度：机箱散热器限高与显卡高度都从主板平面量到侧板方向，散热器还要扣掉 CPU 插座与顶盖高度，作为替代偏保守
      // 2.2.2：散热器限高与显卡高度的测量基准不一定相同（前者从主板平面算，后者从 PCIe 插槽 / 挡板算），
      // 只有余量足够大（≥15mm）时才作为“需核对”的推断；余量小于 15mm 时不能据此判断可装入。
      const PROXY_MARGIN = 15;
      if (pc.maxGpuHeightMm == null && gpu.heightMm != null && pc.maxCoolerHeightMm != null && gpu.heightMm + PROXY_MARGIN <= pc.maxCoolerHeightMm) {
        add('gpuHeight', '显卡高度', CONDITIONAL, `显卡高 ${gpu.heightMm}mm。机箱未公布显卡高度限制；参考散热器限高 ${pc.maxCoolerHeightMm}mm（测量基准可能不同，余量 ${pc.maxCoolerHeightMm - gpu.heightMm}mm ≥ ${PROXY_MARGIN}mm 才采用此推断），需实测侧板空间。`, highPower,
          { type: 'engineering-judgment', detail: '散热器限高作为显卡高度参考（非同一测量基准）' });
      } else if (pc.maxGpuHeightMm == null && gpu.heightMm != null && pc.maxCoolerHeightMm != null && gpu.heightMm <= pc.maxCoolerHeightMm) {
        add('gpuHeight', '显卡高度', UNKNOWN, `显卡高 ${gpu.heightMm}mm，散热器限高 ${pc.maxCoolerHeightMm}mm，余量仅 ${pc.maxCoolerHeightMm - gpu.heightMm}mm；两者测量基准不同，机箱未公布显卡高度限制，不能确认可装入。`, highPower);
      } else compare('gpuHeight', '显卡高度', gpu.heightMm, pc.maxGpuHeightMm, highPower);
      // 厚度：机箱没有厚度限制时由扩展槽位约束（每槽 20.32mm）；槽位冲突由 gpuSlots 判 FAIL
      const slots = slotsOf(gpu);
      if (pc.maxGpuThicknessMm == null && slots != null && pc.expansionSlots != null && slots <= pc.expansionSlots) {
        add('gpuThickness', '显卡厚度', CONDITIONAL, `显卡约占 ${slots} 槽，机箱 ${pc.expansionSlots} 个扩展槽位${slots === pc.expansionSlots ? '，需主板第一条 x16 插槽位于第一槽' : ''}；机箱未公布显卡厚度限制，需核对底部电源仓 / 风扇空间。`, highPower,
          { type: 'engineering-judgment', detail: '扩展槽位推断厚度' });
      } else compare('gpuThickness', '显卡厚度', gpu.thicknessMm, pc.maxGpuThicknessMm, highPower);
      compare('gpuSlots', '显卡扩展槽', slots, pc.expansionSlots, highPower);
      if (gpu.powerPins?.pin16 || /16PIN|12V/i.test(gpu.gpuPowerConnector ?? '')) {
        const r = gpuCableClearance(gpu, pc);
        add('gpuCable', '显卡供电线空间', r.status, r.detail, r.critical, r.evidence);
      }
    }
    if (psu) {
      // 电源长度：机箱公布限长就比较；没公布时，ATX 电源 ≤160mm 且机箱支持 ATX 电源：ATX 标准深度 140mm，主流 ATX 机箱电源仓支持 160mm 以上
      const atxCase = !pc.supportedPsuFormats?.length || pc.supportedPsuFormats.includes('ATX');
      if (pc.maxPsuLengthMm == null && psu.psuLengthMm != null && psu.psuLengthMm <= 160 && (psu.psuFormFactor ?? 'ATX') === 'ATX' && atxCase) {
        // 2.2.3：电源长度来自该电源自身规格（不统一按 140mm）；机箱限长未公布时只作条件推断。线材空间另行检查（psuCable）
        add('psuLength', '电源长度', CONDITIONAL, `电源长 ${psu.psuLengthMm}mm（该电源规格）。机箱未公布电源限长，按常见 ATX 电源仓可容纳 ≤160mm 电源推断可装入，需按机箱说明书核对；ATX 规范没有统一电源深度。`, highPower,
          { type: 'engineering-judgment', detail: 'ATX 标准尺寸推断' });
      } else compare('psuLength', '电源长度', psu.psuLengthMm, pc.maxPsuLengthMm, highPower || psu.psuFormFactor === 'SFX-L');
      // 2.2.3：线材空间与电源本体长度分开判断（模组接口需要额外弯折空间）
      if (pc.maxPsuLengthMm != null && psu.psuLengthMm != null && /模组/.test(psu.modular ?? '') && psu.psuLengthMm <= pc.maxPsuLengthMm) {
        const bend = psu.cableBendAllowanceMm ?? 25;
        const room = pc.maxPsuLengthMm - psu.psuLengthMm;
        add('psuCable', '电源线材空间', room >= bend ? CONDITIONAL : UNKNOWN, `模组电源长 ${psu.psuLengthMm}mm，机箱电源限长 ${pc.maxPsuLengthMm}mm，剩余 ${room}mm；模组线插头需约 ${bend}mm 弯折空间（工程参考）${room >= bend ? '，需核对硬盘笼 / 风扇位置' : '，空间可能不足'}。`, false);
      }
      const fit = psuFitCheck(psu, pc);
      add('psuFormat', '电源规格', fit.status, fit.detail, true);
    }
    if (cooler?.radiatorSizeMm) {
      const r = radiatorLayoutCheck(cooler, pc, gpu, ram);
      add('radiatorLayout', '冷排安装与空间共享', r.status, r.detail, r.critical);
    }
  }
  // M.2 固态
  if (ssd && board && /M\.2/i.test(ssd.interface ?? '')) {
    add('m2', 'M.2 接口', board.m2Slots == null ? UNKNOWN : board.m2Slots > 0 ? PASS : FAIL,
      board.m2Slots == null ? '主板缺少 M.2 接口数量。' : board.m2Slots > 0 ? `主板有 ${board.m2Slots} 个 M.2 接口。` : '主板没有 M.2 接口，只能用 SATA 固态。');
  }
  if (gpu && board) {
    const r = pcieLink(cpu ?? {}, board, gpu);
    add('pcie', '显卡预计 PCIe 链路', r.status, r.detail);
  }
  if (ssd && board && /M\.2|NVME/i.test(ssd.interface ?? '')) {
    const r = pcieLink(cpu ?? {}, board, ssd, { storage: true, cpuName: parts.CPU?.name ?? '' });
    add('ssdPcie', 'SSD 预计 PCIe 链路', r.status, r.detail);
  }
  // Intel Arc：ReBAR
  if (gpu?.needsResizableBar && board) {
    if (board.rebarSupport === false) {
      add('rebar', 'Resizable BAR', FAIL, '主板明确不支持 Resizable BAR / Above 4G Decoding，Intel Arc 显卡在此平台上性能严重受限。');
    } else if (board.rebarSupport === true) {
      add('rebar', 'Resizable BAR', CONDITIONAL, '主板支持 Resizable BAR：需在 BIOS 中开启 ReBAR 与 Above 4G Decoding、系统用 UEFI 模式安装，否则 Intel Arc 性能大幅下降。');
    } else if (board.rebarSupport === 'bios-update') {
      add('rebar', 'Resizable BAR', CONDITIONAL, '主板支持通过更新 BIOS 开启 Resizable BAR：需确认 BIOS 已更新并开启 ReBAR 与 Above 4G Decoding（UEFI 模式），否则 Intel Arc 性能大幅下降。');
    } else {
      const old = chipsetSeries(board.chipset);
      add('rebar', 'Resizable BAR', old && old.letter !== 'Z' && old.series === 300 && up(board.socket) === 'AM4' ? UNKNOWN : CONDITIONAL,
        'Intel Arc 显卡需要在 BIOS 里开启 Resizable BAR 和 Above 4G Decoding、系统用 UEFI 模式安装，否则性能大幅下降。');
    }
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
  if (checks.some(c => c.status === UNKNOWN && (c.blocking ?? c.critical))) return UNKNOWN;
  if (checks.some(c => c.status === CONDITIONAL || c.status === UNKNOWN)) return CONDITIONAL;
  return PASS;
}

export const severity = status => RANK[status] ?? 0;
