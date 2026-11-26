import { fanMountCapacity, requiredCaseFans } from './accessories.mjs';
import { capacityCovers, coolingCapacity, powerLimitOption, VENDOR_RATING_MAX_W } from './thermal-evidence.mjs';
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
  // 2.2.2：分开报告四类依据：CPU 官方规格、主板上限、内存 JEDEC 配置、组合稳定性（QVL / 实测）
  const factors = { cpuSpec: published ? `CPU 官方最高 ${published} MT/s` : 'CPU 内存规格未知', boardSpec: board.memoryMaxMTs ? `主板上限 ${board.memoryMaxMTs} MT/s` : '主板内存上限未录入',
    jedec: ram.jedecMTs ? `JEDEC ${ram.jedecMTs} MT/s` : '内存 JEDEC 配置未知（标称值可能是 XMP / EXPO）', stability: qvl ? '主板 QVL 列有此料号' : '组合稳定性未验证（无 QVL / 实测）' };
  const why = `［${Object.values(factors).join('；')}］`;
  if (target > limit) return { status: 'CONDITIONAL', factors, detail: `标称 ${target} MT/s，高于已知上限 ${limit} MT/s：按 ${limit} MT/s 或 JEDEC 频率运行；标称频率属于超频，需核对 QVL 并验证稳定性。${why}` };
  if (published && board.memoryMaxMTs && qvl && ram.jedecMTs >= target) return { status: 'PASS', factors, detail: `该料号、条数和 Rank 有主板 QVL，${target} MT/s 在已知范围内。` };
  if (ram.jedecMTs && ram.jedecMTs < target) return { status: 'CONDITIONAL', factors, detail: `JEDEC ${ram.jedecMTs} MT/s。标称 ${target} MT/s 需核对 XMP/EXPO、主板 QVL 和稳定性。${why}` };
  // 在 CPU 官方上限内、不超过 2 条：频率本身在规格内；若为 XMP / EXPO 标称需在 BIOS 开启（条件项，不是未知项）
  // 主板内存上限未知时，只认定所有同平台主板普遍支持的频率（DDR4 ≤3200、DDR5 ≤6000）；更高频率仍需主板与 QVL
  const boardOk = board.memoryMaxMTs ? target <= board.memoryMaxMTs : target <= (/DDR4/i.test(ram.memoryType ?? '') ? 3200 : 6000);
  if (published && target <= limit && boardOk && (ram.modules ?? 2) <= 2) return { status: 'CONDITIONAL', factors, detail: `标称 ${target} MT/s，在 CPU 官方支持的 ${published} MT/s 以内。若为 XMP / EXPO 标称频率，需在 BIOS 开启；在规格内不等于保证稳定，4 条或双面颗粒可能需要降频。${why}` };
  const reason = !published ? 'CPU 内存规格未知' : !boardOk ? `CPU 规格已知（${published} MT/s），但 ${target} MT/s 高于同平台主板普遍支持的频率，主板上限未录入` : '条数超过 2 条';
  return { status: 'UNKNOWN', factors, detail: `标称 ${target} MT/s：${reason}，不能确认能以标称频率运行（不影响开机，最低按 JEDEC 频率运行）。${why}` };
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
// 2.2.2：删除 2.2.1 的 coolerSizeClass / coolingClassFor（按塔高、冷排尺寸推断散热功率）。
// 塔高只用于机箱安装检查（coolerHeight）；散热能力只认 thermal-evidence.mjs 中的证据等级。
export function coolerThermalCheck(cpu, cooler, pc, board = {}, workload = {}, { stock = false } = {}) {
  const watts = sustainedPower(cpu, board, workload);
  if (!watts) return { status: 'UNKNOWN', critical: true, detail: '缺少 CPU 持续负载功耗 / 主板功耗限制数据，不能确认持续散热。', evidence: { type: 'incomplete' } };
  const limited = workload.cpuPowerLimitWatts ?? board.cpuPowerLimitWatts;
  const limitNote = limited ? `（按明确的功耗限制 ${limited}W，可能降低持续多核性能）` : '（按 CPU 官方最大睿频功耗 / PPT 保守校核）';
  const tested = !stock && measuredCooling(cpu, cooler, pc, board, workload);
  if (tested) return { status: 'PASS', critical: false, detail: `CPU 持续负载 ${watts}W${limitNote}。有同插槽、机箱进风条件下 ≥${watts}W、≥20 分钟的温度测试，环境 ≥${workload.ambientC ?? 25}°C；来源 ${tested.sourceUrl}`,
    evidence: { type: 'measurement', coveredWatts: tested.powerWatts, sourceUrl: tested.sourceUrl } };
  const cap = coolingCapacity(cooler ?? {}, { stock, cpu, quiet: workload.quiet, maxNoiseDbA: workload.maxNoiseDbA ?? 35 });
  const evidence = { type: cap.level === 'measured' ? 'measurement' : cap.level === 'none' ? 'incomplete' : cap.level === 'vendor_rating' ? 'vendor-rating' : 'engineering-judgment',
    level: cap.level, coveredWatts: cap.watts, requiredWatts: watts, sourceUrl: cap.sourceUrl, confidence: cap.confidence };
  if (capacityCovers(cap, watts)) {
    return { status: 'CONDITIONAL', critical: false, evidence,
      detail: `CPU 持续负载 ${watts}W${limitNote}。依据：${cap.basis}${cap.sourceUrl ? `（${cap.sourceUrl}）` : ''}，覆盖 ${cap.watts}W。${cap.level === 'measured' ? '测试平台与本机机箱风道不同，' : ''}本机持续满载温度${workload.quiet ? '与噪音' : ''}仍需实测确认。` };
  }
  const option = powerLimitOption(cap, cpu);
  evidence.powerLimitOptionW = option;
  return { status: 'UNKNOWN', critical: true, evidence,
    detail: `CPU 持续负载 ${watts}W${limitNote}。${cap.level === 'none' ? `该散热器${cap.basis}` : `现有依据（${cap.basis}）只覆盖约 ${cap.level === 'vendor_rating' ? Math.min(cap.watts, VENDOR_RATING_MAX_W) : cap.watts}W${cap.level === 'vendor_rating' && watts > VENDOR_RATING_MAX_W ? `，高于 ${VENDOR_RATING_MAX_W}W 的持续负载必须有实测` : ''}`}，不能确认能压住 ${watts}W 持续负载（塔高 / 冷排尺寸不作为散热能力依据）。${option ? `可选运行条件：在 BIOS 将 CPU 持续功耗（PL1/PL2 或 PPT）限制到 ≤${option}W，多核性能会下降，幅度未量化；` : ''}或换用有覆盖 ${watts}W 实测证据的散热器。` };
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
  // 2.2.2：风扇需求与附件成本共用 accessories.mjs 的同一规则；另购风扇费用已计入完整总价（不再写“未计入”）。
  const need = requiredCaseFans(watts, gpuW);
  const cap = fanMountCapacity(pc);
  const included = pc?.includedFans;
  const buy = Math.max(0, need.intake + need.exhaust - (included ?? 0));
  const fanText = `至少 ${need.intake} 个进风 + ${need.exhaust} 个排风风扇${need.optionalTopExhaust ? '，建议再加顶部排风（可选，未计入）' : ''}；${included == null ? `预装数量未公布，按另购 ${buy} 个计入完整总价` : `预装 ${included} 个${buy ? `，另购 ${buy} 个已计入完整总价` : ''}`}`;
  const basis = `依据为规格与工程判断，没有整机持续温度${workload.quiet ? '与噪音' : ''}实测。`;
  if (cap) {
    if (cap.intake < need.intake || cap.exhaust < need.exhaust) {
      return { status: 'UNKNOWN', critical: high, detail: `CPU ${watts}W + GPU ${gpuW}W，共约 ${need.total}W：需要 ${need.intake} 进风 + ${need.exhaust} 排风，机箱已知风扇位只有进风 ${cap.intake} / 排风 ${cap.exhaust} 个，风道能力不足或数据不全，不能确认散热。` };
    }
    const meshNote = need.total > 450 ? (pc?.frontIntake === 'mesh' ? '前面板为网孔进风。' : '前面板进风结构（网孔 / 封闭玻璃）未公布：高负载下须确认为网孔或有足够侧进风开孔。') : '';
    return { status: 'CONDITIONAL', critical: false, intakeKnown: pc?.frontIntake === 'mesh', detail: `CPU ${watts}W + GPU ${gpuW}W，共约 ${need.total}W。机箱风扇位进风 ${cap.intake} / 排风 ${cap.exhaust} 个，满足 ${fanText}。${meshNote}${basis}` };
  }
  const positions = pc?.intakePositions?.length && pc?.exhaustPositions?.length;
  if (positions && !high) {
    return { status: 'CONDITIONAL', critical: false, detail: `CPU ${watts}W + GPU ${gpuW}W，共约 ${need.total}W。机箱有进风、排风安装位（数量未公布）：${fanText}。${basis}` };
  }
  return { status: 'UNKNOWN', critical: high,
    detail: `${high ? '高功耗' : '此'}配置（CPU ${watts}W + GPU ${gpuW}W）：${positions ? '机箱风扇位数量未公布，高负载下不能确认能装下所需风扇。' : '缺少进排风安装位数据。'}需要 ${need.intake} 进风 + ${need.exhaust} 排风；没有覆盖此负载的整机散热测试。` };
}

// Full chain = endpoint ∩ CPU controller ∩ board electrical link. Missing data
// stays unknown; the old single pcieGen field cannot prove an x16 electrical link.
/**
 * M.2 插槽级模型（2.2.2）。主板 m2Links 每项规范化为：
 *   slot_id、source（CPU / PCH）、pcie_generation、electrical_lanes、supported_protocols（NVME / SATA）、
 *   supported_lengths（2242 / 2260 / 2280 / 22110）、shared_lanes（与哪些接口共享）、disabled_ports（占用后禁用的 SATA 等）、
 *   cpu_dependent_limits（[{ cpuPattern, effect: 'disabled' | { gen, lanes } }]）
 */
export function m2Slots(board = {}, cpuName = '') {
  return (board.m2Links ?? []).map((l, i) => {
    const limits = l.cpuDependentLimits ?? l.cpu_dependent_limits ?? [];
    const hit = limits.find(x => x.cpuPattern && new RegExp(x.cpuPattern, 'i').test(cpuName));
    return {
      slot_id: l.slot ?? l.slot_id ?? `M.2_${i + 1}`, source: l.source ?? null,
      pcie_generation: hit?.effect?.gen ?? l.gen ?? l.pcie_generation ?? null, electrical_lanes: hit?.effect?.lanes ?? l.lanes ?? l.electrical_lanes ?? null,
      supported_protocols: l.protocols ?? l.supported_protocols ?? (l.protocol ? [l.protocol] : []), supported_lengths: l.lengths ?? l.supported_lengths ?? [],
      shared_lanes: l.sharedLanes ?? l.shared_lanes ?? [], disabled_ports: l.disabledPorts ?? l.disabled_ports ?? [],
      disabledByCpu: hit?.effect === 'disabled',
    };
  });
}

/** SSD 预计协商链路：SSD 端点 ∩ 插槽电气规格 ∩ 上游控制器（CPU 直连槽取 CPU 存储链路；芯片组槽取插槽自身，另提示与芯片组上行共享） */
export function storageLink(cpu = {}, board = {}, ssd = {}, { cpuName = '' } = {}) {
  const end = ssd.pcieLink;
  const protocol = ssd.m2Protocol ?? (/SATA/i.test(ssd.interface ?? '') && !/PCIE|NVME/i.test(ssd.interface ?? '') ? 'SATA' : 'NVME');
  const slots = m2Slots(board, cpuName);
  const missing = [];
  if (protocol === 'NVME' && !end) missing.push('SSD 端点 PCIe 版本 / 通道');
  if (!slots.length) missing.push(`主板 M.2 插槽级数据（${board.m2Slots ? `目录只记录了 ${board.m2Slots} 个 M.2 接口，没有每个插槽的来源、代数与通道` : '插槽数量与规格'}）`);
  if (!slots.length) return { status: 'UNKNOWN', missing, detail: `无法计算 SSD 链路，缺少：${missing.join('；')}。` };
  const usable = slots.filter(sl => !sl.disabledByCpu && (!sl.supported_protocols.length || sl.supported_protocols.includes(protocol)) &&
    (!ssd.m2Length || !sl.supported_lengths.length || sl.supported_lengths.includes(ssd.m2Length)));
  if (!usable.length) return { status: 'FAIL', detail: `主板已知 M.2 插槽都不支持该 SSD（${protocol}${ssd.m2Length ? `、${ssd.m2Length}` : ''}${slots.some(sl => sl.disabledByCpu) ? '；部分插槽在此 CPU 下不可用' : ''}）。` };
  if (protocol === 'SATA') return { status: 'CONDITIONAL', detail: `M.2 SATA SSD 可用 ${usable.map(u => u.slot_id).join(' / ')}；${usable.some(u => u.disabled_ports.length) ? `占用后禁用 ${usable.flatMap(u => u.disabled_ports).join('、')}` : '需核对是否与 SATA 口共享'}。` };
  const controllerFor = sl => (String(sl.source ?? '').toUpperCase() === 'CPU' ? cpu.storagePcieLink : sl.pcie_generation ? { gen: sl.pcie_generation, lanes: sl.electrical_lanes } : null);
  const rate = sl => { const c = controllerFor(sl); return c && end && sl.pcie_generation ? Math.min(end.gen, sl.pcie_generation, c.gen) * Math.min(end.lanes, sl.electrical_lanes, c.lanes) : -1; };
  const best = usable.reduce((a, b) => (rate(b) > rate(a) || (rate(b) === rate(a) && b.source === 'CPU' && a.source !== 'CPU') ? b : a));
  const controller = controllerFor(best);
  if (!controller) missing.push(String(best.source).toUpperCase() === 'CPU' ? 'CPU 直连 M.2 链路规格' : '插槽代数 / 通道');
  if (!best.pcie_generation || !best.electrical_lanes) missing.push(`${best.slot_id} 代数 / 通道`);
  if (missing.length) return { status: 'UNKNOWN', missing, detail: `无法计算 SSD 链路，缺少：${[...new Set(missing)].join('；')}。` };
  const gen = Math.min(end.gen, best.pcie_generation, controller.gen);
  const lanes = Math.min(end.lanes, best.electrical_lanes, controller.lanes);
  const constrained = gen < end.gen || lanes < end.lanes;
  const shared = [...best.shared_lanes, ...(board.laneSharing ?? [])];
  const pch = String(best.source ?? '').toUpperCase() !== 'CPU';
  return { status: constrained || shared.length || pch ? 'CONDITIONAL' : 'PASS', gen, lanes, slot: best.slot_id,
    detail: `预计协商链路 PCIe ${gen}.0 ×${lanes}（${best.slot_id}${best.source ? `，${best.source} 直连` : ''}；理论值，非装机实测）；SSD 支持 ${end.gen}.0 ×${end.lanes}。${constrained ? '链路低于 SSD 规格，顺序读写上限降低。' : ''}${pch ? '芯片组插槽与其他芯片组设备共享上行带宽。' : ''}${shared.length ? `通道共享：${shared.join('；')}` : ''}` };
}

export function pcieLink(cpu = {}, board = {}, device = {}, { storage = false, cpuName = '' } = {}) {
  if (storage) return storageLink(cpu, board, device, { cpuName });
  const end = device.pcieLink;
  const controller = storage ? cpu.storagePcieLink : cpu.pcieLink;
  const nvmeSlots = storage ? (board.m2Links ?? []).filter(s => s.protocol === 'NVME') : [];
  const slot = storage
    ? nvmeSlots.reduce((best, s) => {
      if (!best) return s;
      const bw = x => Math.min(end?.gen ?? 7, x.gen, controller?.gen ?? 7) * Math.min(end?.lanes ?? 4, x.lanes, controller?.lanes ?? 16);
      const d = bw(s) - bw(best);
      if (d !== 0) return d > 0 ? s : best;
      const raw = s.gen * s.lanes - best.gen * best.lanes;
      if (raw !== 0) return raw > 0 ? s : best;
      return s.source === 'CPU' && best.source !== 'CPU' ? s : best;
    }, null)
    : board.gpuPcieLink;
  if (storage && board.m2Links?.length && !slot && end) return { status: 'FAIL', detail: '主板已知 M.2 插槽只支持 SATA，所选 SSD 需要 NVMe / PCIe 协议。' };
  if (!storage && end?.physicalLanes && slot?.physicalLanes && end.physicalLanes > slot.physicalLanes) return { status: 'FAIL', detail: '显卡物理连接器长于主板已知的封闭插槽，无法安装；电气通道限制另行计算。' };
  if (!end || !slot || !controller) return { status: 'UNKNOWN', detail: `缺少 ${storage ? 'M.2' : '显卡'}链路端点、CPU 控制器或主板电气通道数据。` };
  const all = [end, slot, controller];
  if (all.some(l => !(l.gen > 0 && l.lanes > 0))) return { status: 'UNKNOWN', detail: 'PCIe 版本或电气通道数不完整。' };
  const gen = Math.min(...all.map(l => l.gen));
  const lanes = Math.min(...all.map(l => l.lanes));
  const constrained = gen < end.gen || lanes < end.lanes;
  const sharing = board.laneSharing?.length;
  const slotNote = storage && slot.slot ? `（首选 ${slot.slot}${slot.source ? `，${slot.source} 直连` : ''}）` : '';
  return { status: constrained || sharing ? 'CONDITIONAL' : 'PASS', gen, lanes,
    detail: `实际链路 PCIe ${gen}.0 ×${lanes}${slotNote}；设备支持 ${end.gen}.0 ×${end.lanes}。${end.lanes <= 8 && constrained ? '通道较少的显卡 / SSD 在旧平台带宽受限，可能影响表现，未推断精确性能损失。' : ''}${sharing ? `需核对通道共享：${board.laneSharing.join('；')}` : ''}` };
}

// Additional persisted fields. Nested evidence is bounded JSON and is consumed
// only when its required measurements and HTTPS source are present.
export const HARDWARE_DETAIL_FIELDS = ['supportedBoardFormats', 'basePowerWatts', 'sustainedPowerWatts', 'cpuPowerLimitWatts', 'pcieLink', 'storagePcieLink', 'gpuPcieLink', 'm2Links', 'laneSharing', 'vendorCoolingWatts', 'coolingEvidence', 'thermalTests', 'frontIntake', 'intakePositions', 'exhaustPositions', 'includedFans', 'fanSizesMm', 'requiredFanCostCents', 'maxGpuHeightMm', 'maxGpuThicknessMm', 'expansionSlots', 'gpuCableClearanceMm', 'requiredCableClearanceMm', 'supportedPsuFormats', 'maxPsuLengthMm', 'psuLengthMm', 'psuFormFactor', 'radiatorPositions', 'radiatorConflicts', 'thicknessMm', 'slotWidth', 'specEvidence', 'workload'];
HARDWARE_DETAIL_FIELDS.push('pcieGeneration', 'fanMounts', 'psuWidthMm', 'psuHeightMm', 'psuAtxBracketIncluded',
  'supportsPsuAtxAdapter', 'requiredPsuBracketCostCents', 'psuGpuCableMm', 'psuCpuCableMm', 'psuBoardCableMm',
  'gpuCablePathMm', 'cpuCablePathMm', 'boardCablePathMm', 'cpuMemoryMaxMTs', 'cpuMemoryByModules', 'cpuMemoryMaxMTsByType', 'memoryMaxMTs',
  'rank', 'jedecMTs', 'memoryQvl', 'stockCoolerIncluded', 'stockCoolerRetailSkus', 'retailCoolerName', 'native16PinCableWatts',
  'rebarSupport', 'biosFlashback', 'biosVersion',
  // 2.2.2：电源版本与接口、散热结构证据、SSD 规范化、16pin 线材与冷排空间
  'manufacturerModel', 'manufacturerSku', 'hardwareRevision', 'electricalStandard', 'native12vhpwr', 'native12v2x6', 'connectorPowerRating',
  'pcie8pinConnectors', 'independentPcieCables', 'cableSource', 'adapterIncluded', 'heatPipes', 'radiatorThicknessMm', 'bitsPerCell',
  'powerConnectorPosition', 'gpuLengthIncludesFrontFans', 'topRadiatorClearanceMm');
export function hardwareDetails(input) {
  const out = {};
  for (const key of HARDWARE_DETAIL_FIELDS) if (input[key] !== undefined) {
    const value = input[key];
    const encoded = JSON.stringify(value);
    if (encoded.length > 16000) throw new Error(`${key} 超过数据大小上限`);
    if (typeof value === 'number' && (!Number.isFinite(value) || value < 0 || value > 1000000)) throw new Error(`${key} 数值无效`);
    if (key !== 'fanSizesMm' && /Watts$|Mm$|Slots$|Fans$|Cents$|MTs$|slotWidth/.test(key) && typeof value !== 'number') throw new Error(`${key} 必须是数值`);
    if (key.endsWith('Cents') && !Number.isSafeInteger(value)) throw new Error(`${key} 必须为整数分`);
    if (['stockCoolerIncluded', 'psuAtxBracketIncluded', 'supportsPsuAtxAdapter', 'biosFlashback'].includes(key) && typeof value !== 'boolean') throw new Error(`${key} 必须为布尔值`);
    if (key === 'rebarSupport' && typeof value !== 'boolean' && value !== 'bios-update') throw new Error('rebarSupport 必须为布尔值或 bios-update');
    if (key === 'biosVersion' && typeof value !== 'string') throw new Error('biosVersion 必须是字符串');
    if (['manufacturerModel', 'manufacturerSku', 'hardwareRevision', 'electricalStandard', 'cableSource'].includes(key) && (typeof value !== 'string' || value.length > 200)) throw new Error(`${key} 必须是字符串`);
    if (['native12vhpwr', 'native12v2x6', 'adapterIncluded', 'gpuLengthIncludesFrontFans'].includes(key) && typeof value !== 'boolean') throw new Error(`${key} 必须为布尔值`);
    if (['connectorPowerRating', 'pcie8pinConnectors', 'independentPcieCables', 'heatPipes', 'bitsPerCell'].includes(key) && !Number.isSafeInteger(value)) throw new Error(`${key} 必须为整数`);
    if (key === 'connectorPowerRating' && ![150, 300, 450, 600].includes(value)) throw new Error('16pin 线材额定只能是 150 / 300 / 450 / 600W');
    if (key === 'bitsPerCell' && (value < 1 || value > 4)) throw new Error('bitsPerCell 只能是 1–4');
    if (key === 'powerConnectorPosition' && !['top', 'end'].includes(value)) throw new Error('powerConnectorPosition 只能是 top / end');
    if (key === 'cpuMemoryMaxMTsByType' && (!value || typeof value !== 'object' || Array.isArray(value) ||
      !Object.entries(value).every(([k, rate]) => /^DDR[45]$/i.test(k) && Number.isSafeInteger(rate) && rate > 0))) throw new Error('CPU 内存类型上限无效');
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
