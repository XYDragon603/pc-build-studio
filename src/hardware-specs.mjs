// Shared, explicit physical formats. Product names and case exterior dimensions
// are never used as evidence of motherboard support.
export const BOARD_FORMATS = ['MINI-ITX', 'MICRO ATX', 'ATX', 'EATX'];
const FORMAT_NAMES = { MINIITX: 'MINI-ITX', ITX: 'MINI-ITX', MICROATX: 'MICRO ATX', MATX: 'MICRO ATX', ATX: 'ATX', EATX: 'EATX', EXTENDEDATX: 'EATX' };
const formatCache = new Map();
export function boardFormat(value) {
  const raw = String(value ?? '');
  // 纯字符串归一化，结果只取决于输入；缓存避免搜索中每个组合重复做正则替换（2.2.1 性能）
  let hit = formatCache.get(raw);
  if (hit === undefined) { hit = FORMAT_NAMES[raw.trim().toUpperCase().replace(/[ _-]/g, '')] ?? null; if (formatCache.size < 5000) formatCache.set(raw, hit); }
  return hit;
}
export function boardFormats(value) {
  if (Array.isArray(value)) return [...new Set(value.map(boardFormat).filter(Boolean))];
  // Consume M-ATX as one token, rather than also finding ATX inside it.
  return [...new Set((String(value ?? '').toUpperCase().match(/(?:EXTENDED|MICRO|MINI)[ _-]?(?:ATX|ITX)|E[ -]?ATX|M[ -]?ATX|MINI[ -]?ITX|\bITX\b|\bATX\b/g) ?? []).map(boardFormat).filter(Boolean))];
}
export function supportedBoardFormats(specs = {}) {
  if (Array.isArray(specs.supportedBoardFormats)) return boardFormats(specs.supportedBoardFormats);
  if (specs.supportedBoards) return boardFormats(specs.supportedBoards);
  const max = boardFormat(specs.maxBoardFormFactor);
  // Legacy explicit maximum is retained, but never infer EATX dimensions.
  return max ? BOARD_FORMATS.slice(0, BOARD_FORMATS.indexOf(max) + 1) : [];
}
export function boardCaseStatus(board, pc) {
  const format = boardFormat(board?.formFactor);
  const supported = supportedBoardFormats(pc ?? {});
  return !format || !supported.length ? 'UNKNOWN' : supported.includes(format) ? 'PASS' : 'FAIL';
}

export const sustainedPower = (cpu = {}, board = {}, workload = {}) => {
  const requested = cpu.sustainedPowerWatts ?? cpu.maxPowerWatts ?? null;
  const limit = workload.cpuPowerLimitWatts ?? board.cpuPowerLimitWatts;
  return requested == null ? null : limit > 0 ? Math.min(requested, limit) : requested;
};
export const gpuPowerWatts = gpu => gpu?.boardPowerWatts ?? gpu?.maxPowerWatts ?? gpu?.tdpWatts ?? null;

export function stockCooler(item) {
  const specs = item?.specs ?? {};
  const sku = item?.priceRecord?.sku ?? item?.mpn;
  if (/散片|tray|oem/i.test(specs.packaging ?? '') || (item?.priceRecord && item.priceRecord.condition !== 'new' && item.priceRecord.condition !== 'old-stock')) return false;
  if (specs.stockCoolerIncluded === false) return false;
  if (sku && specs.stockCoolerRetailSkus?.some(id => id.toUpperCase() === sku.toUpperCase())) return true;
  return specs.stockCoolerIncluded === true && /盒装|boxed/i.test(specs.packaging ?? '') && (!item?.priceRecord || Boolean(sku));
}

export function memorySpeedCheck(cpu, board, ram, sku) {
  // 按内存类型取 CPU 官方上限（Intel 12–14 代同时支持 DDR4-3200 与 DDR5-4800/5600）
  const published = cpu?.cpuMemoryMaxMTsByType?.[String(ram?.memoryType ?? '').toUpperCase()] ?? cpu?.cpuMemoryMaxMTs;
  const dimmLimit = cpu?.cpuMemoryByModules?.[ram.modules] ?? published;
  const rankLimit = cpu?.cpuMemoryByModules?.[`${ram.modules}x${ram.rank}R`];
  const limit = Math.min(dimmLimit ?? Infinity, rankLimit ?? Infinity, board.memoryMaxMTs ?? Infinity);
  const target = ram.speedMTs;
  const qvl = sku && board.memoryQvl?.find(entry => entry.sku === sku && entry.modules === ram.modules &&
    entry.rank === ram.rank && entry.speedMTs >= target);
  if (!target) return null;
  if (target > limit) return { status: 'CONDITIONAL', detail: `标称 ${target} MT/s，高于已知上限 ${limit} MT/s。采用经主板和 CPU 验证的 JEDEC 频率，超频需核对 QVL 并验证稳定性。` };
  if (published && board.memoryMaxMTs && qvl && ram.jedecMTs >= target) return { status: 'PASS', detail: `该料号、条数和 Rank 有主板 QVL，${target} MT/s 在已知范围内。` };
  if (ram.jedecMTs && ram.jedecMTs < target) return { status: 'CONDITIONAL', detail: `JEDEC ${ram.jedecMTs} MT/s。标称 ${target} MT/s 需核对 XMP/EXPO、主板 QVL 和稳定性。` };
  // 在 CPU 官方上限内、不超过 2 条：频率本身在规格内；若为 XMP / EXPO 标称需在 BIOS 开启（条件项，不是未知项）
  // 主板内存上限未知时，只认定所有同平台主板普遍支持的频率（DDR4 ≤3200、DDR5 ≤6000）；更高频率仍需主板与 QVL
  const boardOk = board.memoryMaxMTs ? target <= board.memoryMaxMTs : target <= (/DDR4/i.test(ram.memoryType ?? '') ? 3200 : 6000);
  if (published && target <= limit && boardOk && (ram.modules ?? 2) <= 2) return { status: 'CONDITIONAL', detail: `标称 ${target} MT/s，在 CPU 官方支持的 ${published} MT/s 以内。若内存为 XMP / EXPO 标称频率，需在 BIOS 开启；4 条或双面颗粒可能需要降频。` };
  return { status: 'UNKNOWN', detail: `标称 ${target} MT/s，CPU 最高 ${published ?? '未知'} MT/s。需核对板卡、条数、Rank、JEDEC 配置和 QVL。` };
}

export function psuFitCheck(psu, pc) {
  const format = psu.psuFormFactor;
  const supports = pc.supportedPsuFormats ?? [];
  if (!format || !supports.length) return { status: 'UNKNOWN', detail: '电源物理规格或机箱安装规格缺失。' };
  if (supports.includes(format)) return { status: 'PASS', detail: `机箱支持 ${format} 电源安装。深度和线材空间另行检查。` };
  if (!['SFX', 'SFX-L'].includes(format) || !supports.includes('ATX')) return { status: 'FAIL', detail: `机箱支持 ${supports.join('/')}，与 ${format} 安装孔位不匹配。` };
  if (pc.supportsPsuAtxAdapter === false) return { status: 'FAIL', detail: '机箱明确不支持该转接安装方式。' };
  const bracket = psu.psuAtxBracketIncluded === true || pc.requiredPsuBracketCostCents > 0;
  const spaceKnown = psu.psuLengthMm > 0 && pc.maxPsuLengthMm > 0;
  if (!bracket || !spaceKnown || pc.supportsPsuAtxAdapter !== true) return { status: 'UNKNOWN', detail: 'SFX/SFX-L 转 ATX 需核实支架、机箱安装空间和走线。' };
  if (psu.psuLengthMm > pc.maxPsuLengthMm) return { status: 'FAIL', detail: '转接后电源深度超过机箱限长。' };
  const paths = [['psuGpuCableMm', 'gpuCablePathMm'], ['psuCpuCableMm', 'cpuCablePathMm'], ['psuBoardCableMm', 'boardCablePathMm']];
  if (paths.some(([wire, path]) => psu[wire] > 0 && pc[path] > psu[wire])) return { status: 'FAIL', detail: '原配电源线短于已知走线距离，当前组合无法完成布线。' };
  if (paths.some(([wire, path]) => !psu[wire] || !pc[path])) return { status: 'UNKNOWN', detail: '转接支架和深度已核对，仍需测量显卡、主板和 CPU 供电走线。' };
  return { status: 'CONDITIONAL', detail: '用已核实的转接支架安装，并按已测走线布置原配线材。' };
}
const source = e => typeof e?.sourceUrl === 'string' && /^https:\/\//.test(e.sourceUrl);
export function measuredCooling(cpu, cooler, pc, board = {}, workload = {}) {
  const watts = sustainedPower(cpu, board, workload);
  return cooler?.thermalTests?.find(t => source(t) && t.kind === 'measured' && t.cpuSocket === cpu?.socket &&
    t.powerWatts >= watts && t.ambientC >= (workload.ambientC ?? 25) && t.maxTempC <= t.tempLimitC &&
    t.caseAirflow === pc?.frontIntake && pc?.frontIntake && t.durationMinutes >= 20 &&
    (!workload.quiet || (t.noiseDbA != null && t.noiseDbA <= (workload.maxNoiseDbA ?? 35))));
}
/** 散热器尺寸档（工程近似）：0 未知 / 1 小型（≥120mm 塔或任意水冷）/ 2 中塔（≥145mm 或 240 水冷）/ 3 大塔（≥155mm 或 240+）/ 4 旗舰（≥158mm 双塔或 280+ 水冷） */
export function coolerSizeClass(cooler) {
  const r = cooler?.radiatorSizeMm ?? 0; const h = cooler?.heightMm ?? 0;
  if (r >= 280 || h >= 158) return 4;
  if (r >= 240 || h >= 155) return 3;
  if (h >= 145) return 2;
  if (r > 0 || h >= 120) return 1;
  return 0;
}
/** 持续功耗需要的尺寸档：≤120W 小型，≤180W 中塔，≤250W 大塔，以上旗舰 */
export const coolingClassFor = watts => (watts <= 120 ? 1 : watts <= 180 ? 2 : watts <= 250 ? 3 : 4);

export function coolerThermalCheck(cpu, cooler, pc, board = {}, workload = {}) {
  const watts = sustainedPower(cpu, board, workload);
  if (!watts) return { status: 'UNKNOWN', detail: '缺少 CPU 持续负载功耗 / 主板功耗限制数据，不能确认持续散热。' };
  const tested = measuredCooling(cpu, cooler, pc, board, workload);
  if (tested) return { status: 'PASS', detail: `有同插槽、机箱进风条件下 ≥${watts}W、≥20 分钟的温度测试，环境 ≥${workload.ambientC ?? 25}°C；来源 ${tested.sourceUrl}` };
  const rated = cooler?.vendorCoolingWatts;
  const limited = workload.cpuPowerLimitWatts ?? board.cpuPowerLimitWatts;
  // 2.2.1：没有实测、也没有厂商标称时，按散热器尺寸档做工程判断（冷排越大、塔越高越强），结果为 CONDITIONAL
  // （需满足条件：持续满载温度待实测），不是 PASS。尺寸档不足或厂商标称低于负载时保持 UNKNOWN。
  const sizeClass = coolerSizeClass(cooler);
  if (!(rated && watts > rated) && sizeClass >= coolingClassFor(watts)) {
    return { status: 'CONDITIONAL', detail: `CPU 持续负载按 ${watts}W 校核${limited ? `（明确限制 ${limited}W，可能降低持续多核性能）` : ''}。${rated ? `散热器厂商标称 ${rated}W；` : ''}按散热器尺寸（${cooler?.radiatorSizeMm ? `${cooler.radiatorSizeMm}mm 冷排` : `塔高 ${cooler?.heightMm}mm`}）的工程判断足以覆盖此负载，但没有同平台持续温度实测，满载温度与噪音需实测确认。` };
  }
  return { status: limited && rated && watts <= rated && source(cooler?.coolingEvidence) ? 'CONDITIONAL' : 'UNKNOWN',
    detail: `CPU 持续负载按 ${watts}W 校核${limited ? `（明确限制 ${limited}W，可能降低持续多核性能）` : '（未取得持续实测时保守使用峰值；主板实际功耗限制待核实）'}。${rated ? `散热器厂商标称 ${rated}W，不能等同于实测散热能力。` : ''}缺少相同插槽、环境温度和机箱风道下的持续温度${workload.quiet ? '及噪音' : ''}测试，不能确认散热通过。` };
}
export function caseThermalCheck(cpu, gpu, pc, board = {}, workload = {}) {
  const watts = sustainedPower(cpu, board, workload);
  if (watts == null || (gpu && gpu.boardPowerWatts == null && gpu.maxPowerWatts == null && gpu.tdpWatts == null)) return { status: 'UNKNOWN', critical: true, detail: '缺少 CPU / GPU 持续负载功耗，不能确认机箱散热覆盖此配置。' };
  const gpuW = gpuPowerWatts(gpu) ?? 0;
  const high = watts >= 180 || gpuW >= 250 || watts + gpuW >= 400;
  const test = pc?.thermalTests?.find(t => source(t) && t.kind === 'measured' && t.cpuWatts >= watts && t.gpuWatts >= gpuW &&
    t.ambientC >= (workload.ambientC ?? 25) && t.durationMinutes >= 20 && t.withinLimits === true &&
    (!workload.quiet || (t.noiseDbA != null && t.noiseDbA <= (workload.maxNoiseDbA ?? 35))));
  if (test) return { status: 'PASS', detail: `有覆盖 CPU ${watts}W + GPU ${gpuW}W 的机箱持续温度${workload.quiet ? '与噪音' : ''}测试：${test.sourceUrl}`, critical: high };
  if (!high && !workload.quiet && watts + gpuW <= 200 && pc?.frontIntake === 'mesh' &&
    (pc.exhaustPositions?.length || pc.fanMounts?.some(m => m.position === 'rear'))) {
    return { status: 'CONDITIONAL', critical: false, detail: `CPU + GPU 校核约 ${watts + gpuW}W，有网孔进风及排风安装位。保持进出风口畅通并确认后排风扇已安装。${pc.includedFans == null ? '预装数量未知，若没有风扇须另购并计入预算。' : ''} 依据为规格和工程判断。` };
  }
  // 2.2.1：进 / 排风安装位已知（目录覆盖约一半机箱）时，按整机负载给出明确的风扇配置要求，记为 CONDITIONAL（工程判断，
  // 持续温度待实测）。2.2.0 还要求“预装风扇数量”（覆盖 0/231）和整机实测，任何高功耗整机都无法满足，只能被剔除。
  // 进排风位置未知时仍为 UNKNOWN（高功耗为阻断项）。
  const positions = pc?.intakePositions?.length && pc?.exhaustPositions?.length;
  if (positions) {
    const total = watts + gpuW;
    const intake = total <= 250 ? 1 : total <= 450 ? 2 : 3;
    return { status: 'CONDITIONAL', critical: high,
      detail: `CPU ${watts}W + GPU ${gpuW}W，共约 ${total}W。机箱有前进风、后排风安装位：至少需要 ${intake} 个进风 + 1 个排风风扇${total > 450 ? '，建议再加顶部排风' : ''}。${pc.includedFans == null ? '预装风扇数量未公布，不足时需另购（未计入总价）。' : `预装 ${pc.includedFans} 个。`}依据为规格与工程判断，没有整机持续温度${workload.quiet ? '与噪音' : ''}实测。` };
  }
  const layout = pc?.frontIntake && pc?.intakePositions?.length && pc?.exhaustPositions?.length && pc?.includedFans != null;
  return { status: layout && !high && !workload.quiet ? 'CONDITIONAL' : 'UNKNOWN', critical: high,
    detail: `${high ? '高功耗' : '此'}配置（CPU ${watts ?? '?'}W + GPU ${gpuW}W）：${layout ? `已知进排风布局及预装 ${pc.includedFans} 个风扇，仍需核对风扇配置和持续温度。` : '缺少完整进排风、风扇数量或安装布局数据。'}没有覆盖此负载的整机散热${workload.quiet ? '和噪音' : ''}测试，不能仅凭显卡限长判断通过。${pc?.requiredFanCostCents == null ? '额外风扇成本待核实。' : ''}` };
}

// Full chain = endpoint ∩ CPU controller ∩ board electrical link. Missing data
// stays unknown; the old single pcieGen field cannot prove an x16 electrical link.
export function pcieLink(cpu = {}, board = {}, device = {}, { storage = false } = {}) {
  const end = device.pcieLink;
  const slot = storage ? board.m2Links?.find(s => s.protocol === 'NVME') : board.gpuPcieLink;
  const controller = storage ? cpu.storagePcieLink : cpu.pcieLink;
  if (storage && board.m2Links?.length && !slot && end) return { status: 'FAIL', detail: '主板已知 M.2 插槽只支持 SATA，所选 SSD 需要 NVMe / PCIe 协议。' };
  if (!storage && end?.physicalLanes && slot?.physicalLanes && end.physicalLanes > slot.physicalLanes) return { status: 'FAIL', detail: '显卡物理连接器长于主板已知的封闭插槽，无法安装；电气通道限制另行计算。' };
  if (!end || !slot || !controller) return { status: 'UNKNOWN', detail: `缺少 ${storage ? 'M.2' : '显卡'}链路端点、CPU 控制器或主板电气通道数据。` };
  const all = [end, slot, controller];
  if (all.some(l => !(l.gen > 0 && l.lanes > 0))) return { status: 'UNKNOWN', detail: 'PCIe 版本或电气通道数不完整。' };
  const gen = Math.min(...all.map(l => l.gen));
  const lanes = Math.min(...all.map(l => l.lanes));
  const constrained = gen < end.gen || lanes < end.lanes;
  const sharing = board.laneSharing?.length;
  return { status: constrained || sharing ? 'CONDITIONAL' : 'PASS', gen, lanes,
    detail: `实际链路 PCIe ${gen}.0 ×${lanes}；设备支持 ${end.gen}.0 ×${end.lanes}。${end.lanes <= 8 && constrained ? '通道较少的显卡 / SSD 在旧平台带宽受限，可能影响表现，未推断精确性能损失。' : ''}${sharing ? `需核对通道共享：${board.laneSharing.join('；')}` : ''}` };
}

// Additional persisted fields. Nested evidence is bounded JSON and is consumed
// only when its required measurements and HTTPS source are present.
export const HARDWARE_DETAIL_FIELDS = ['supportedBoardFormats', 'basePowerWatts', 'sustainedPowerWatts', 'cpuPowerLimitWatts', 'pcieLink', 'storagePcieLink', 'gpuPcieLink', 'm2Links', 'laneSharing', 'vendorCoolingWatts', 'coolingEvidence', 'thermalTests', 'frontIntake', 'intakePositions', 'exhaustPositions', 'includedFans', 'fanSizesMm', 'requiredFanCostCents', 'maxGpuHeightMm', 'maxGpuThicknessMm', 'expansionSlots', 'gpuCableClearanceMm', 'requiredCableClearanceMm', 'supportedPsuFormats', 'maxPsuLengthMm', 'psuLengthMm', 'psuFormFactor', 'radiatorPositions', 'radiatorConflicts', 'thicknessMm', 'slotWidth', 'specEvidence', 'workload'];
HARDWARE_DETAIL_FIELDS.push('pcieGeneration', 'fanMounts', 'psuWidthMm', 'psuHeightMm', 'psuAtxBracketIncluded',
  'supportsPsuAtxAdapter', 'requiredPsuBracketCostCents', 'psuGpuCableMm', 'psuCpuCableMm', 'psuBoardCableMm',
  'gpuCablePathMm', 'cpuCablePathMm', 'boardCablePathMm', 'cpuMemoryMaxMTs', 'cpuMemoryByModules', 'memoryMaxMTs',
  'rank', 'jedecMTs', 'memoryQvl', 'stockCoolerIncluded', 'stockCoolerRetailSkus', 'retailCoolerName', 'native16PinCableWatts');
export function hardwareDetails(input) {
  const out = {};
  for (const key of HARDWARE_DETAIL_FIELDS) if (input[key] !== undefined) {
    const value = input[key];
    const encoded = JSON.stringify(value);
    if (encoded.length > 16000) throw new Error(`${key} 超过数据大小上限`);
    if (typeof value === 'number' && (!Number.isFinite(value) || value < 0 || value > 1000000)) throw new Error(`${key} 数值无效`);
    if (key !== 'fanSizesMm' && /Watts$|Mm$|Slots$|Fans$|Cents$|MTs$|slotWidth/.test(key) && typeof value !== 'number') throw new Error(`${key} 必须是数值`);
    if (key.endsWith('Cents') && !Number.isSafeInteger(value)) throw new Error(`${key} 必须为整数分`);
    if (['stockCoolerIncluded', 'psuAtxBracketIncluded', 'supportsPsuAtxAdapter'].includes(key) && typeof value !== 'boolean') throw new Error(`${key} 必须为布尔值`);
    if (['fanMounts', 'memoryQvl', 'stockCoolerRetailSkus', 'fanSizesMm'].includes(key) && !Array.isArray(value)) throw new Error(`${key} 必须为数组`);
    if (key === 'fanMounts' && !value.every(m => m && ['front', 'top', 'rear', 'side', 'bottom'].includes(m.position) &&
      Number.isSafeInteger(m.count) && m.count > 0 && [80, 92, 120, 140, 180, 200].includes(m.sizeMm))) throw new Error('风扇安装位无效');
    if (key === 'cpuMemoryByModules' && (!value || typeof value !== 'object' || Array.isArray(value) ||
      !Object.entries(value).every(([k, rate]) => /^\d(?:x[12]R)?$/.test(k) && Number.isSafeInteger(rate) && rate > 0))) throw new Error('CPU 内存拓扑无效');
    if (key === 'memoryQvl' && !value.every(q => q && typeof q.sku === 'string' && Number.isSafeInteger(q.modules) &&
      Number.isSafeInteger(q.rank) && Number.isSafeInteger(q.speedMTs) && q.speedMTs > 0)) throw new Error('主板 QVL 条目无效');
    if (key === 'pcieGeneration' && ![1, 2, 3, 4, 5, 6, 7].includes(value)) throw new Error('PCIe 代数无效');
    if (key === 'stockCoolerRetailSkus' && !value.every(s => typeof s === 'string')) throw new Error('散热器包装料号无效');
    if (['thermalTests', 'specEvidence', 'supportedBoardFormats', 'intakePositions', 'exhaustPositions', 'm2Links', 'laneSharing', 'radiatorPositions', 'radiatorConflicts', 'supportedPsuFormats', 'fanSizesMm'].includes(key) && (!Array.isArray(value) || value.length > 64)) throw new Error(`${key} 必须是最多 64 项的数组`);
    if (['pcieLink', 'storagePcieLink', 'gpuPcieLink', 'coolingEvidence', 'workload'].includes(key) && (!value || typeof value !== 'object' || Array.isArray(value))) throw new Error(`${key} 必须是对象`);
    const textArrays = ['supportedBoardFormats', 'intakePositions', 'exhaustPositions', 'laneSharing', 'radiatorConflicts', 'supportedPsuFormats'];
    if (textArrays.includes(key) && !value.every(x => typeof x === 'string' && x.length <= 500)) throw new Error(`${key} 只接受字符串数组`);
    if (['pcieLink', 'storagePcieLink', 'gpuPcieLink'].includes(key) && (![1, 2, 3, 4, 5, 6, 7].includes(value.gen) || ![1, 2, 4, 8, 16, 32].includes(value.lanes))) throw new Error(`${key} PCIe 代数 / 通道数无效`);
    if (key === 'm2Links' && !value.every(l => l && ['NVME', 'SATA'].includes(l.protocol) && (l.protocol === 'SATA' || ([1, 2, 3, 4, 5, 6, 7].includes(l.gen) && [1, 2, 4].includes(l.lanes))))) throw new Error('M.2 链路无效');
    if (key === 'radiatorPositions' && !value.every(p => p && typeof p.position === 'string' && Array.isArray(p.sizesMm) && p.sizesMm.every(n => [120, 140, 240, 280, 360, 420].includes(n)))) throw new Error('冷排安装位置数据无效');
    if (key === 'thermalTests') for (const t of value) {
      if (!source(t) || t.kind !== 'measured') throw new Error('温度测试需要 measured 类型与 HTTPS 来源');
      for (const [k, v] of Object.entries(t)) if (['powerWatts', 'ambientC', 'maxTempC', 'tempLimitC', 'durationMinutes', 'noiseDbA', 'cpuWatts', 'gpuWatts'].includes(k) && (!Number.isFinite(v) || v < 0 || v > 2000)) throw new Error(`测试数据 ${k} 无效`);
    }
    if (key === 'frontIntake' && !['mesh', 'solid', 'side', 'bottom', 'open'].includes(value)) throw new Error('前面板进风结构无效');
    if (key === 'specEvidence' && !value.every(e => source(e))) throw new Error('规格证据需要 HTTPS 来源');
    out[key] = JSON.parse(encoded);
  }
  return out;
}
