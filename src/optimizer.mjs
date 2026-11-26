// 整机组合优化：三档方案（省钱版 / 推荐版 / 进阶版）。
//
// 流程：
//   A. 读用途与预算约束（严格预算 / 允许超出比例 / 锁定配件）
//   B. 为 CPU、显卡生成候选：按用途的性能指标做 Pareto 筛选（价格更高但性能不更好的去掉），各取十几个
//   C. 为每个 CPU 平台配主板候选（按 BIOS 支持、供电、PCIe、M.2 评价，不按价格）；内存、硬盘按容量档取候选
//   D. 枚举 CPU × 主板 × 显卡 × 内存 × 硬盘，按需求补电源、散热、机箱；搜索中执行兼容性规则，FAIL 的组合直接丢弃
//   E. 对完整可行配置打综合分（scoring-profiles.mjs 的权重）
//   F. 每档求“评分 − 花钱惩罚”最大的组合；预算越高的档位评分不会更低
//   G. 提升不明显的档位沿用上一档并说明；给出各档之间的升级说明与剩余预算的去向
// 搜索规模受控（候选数上限 + 部分总价剪枝），不对全量配件做笛卡尔积。
import { psuConnectors } from './compat-rules.mjs';
import { biosSupport, cpuHasIgpu, CONDITIONAL, evaluateBuild, FAIL, gpuPowerCheck, NOT_APPLICABLE, overallStatus, PASS, powerEstimate, UNKNOWN } from './compat-rules.mjs';
import { cpuKey } from './perfkeys.mjs';
import { CPU_BALANCE, LEGACY_TRUST_PENALTY, MIN_REQUIREMENTS, QUIET_NOISE_WEIGHT, SCORING_PROFILES, SCORING_VERSION, SOFTWARE_VERSION } from './scoring-profiles.mjs';
import { createHash } from 'node:crypto';
import { boardCaseStatus, boardFormat, gpuPowerWatts, supportedBoardFormats, sustainedPower, stockCooler } from './hardware-specs.mjs';
/** 原装散热是否按零售料号逐条确认（stockCoolerRetailSkus 命中所购 SKU）；仅凭“盒装”字样不算确认 */
const stockCoolerConfirmed = cpu => { const sku = cpu.priceRecord?.sku ?? cpu.mpn; return Boolean(sku && cpu.specs.stockCoolerRetailSkus?.some(id => id.toUpperCase() === String(sku).toUpperCase())); };
import { capacityCovers, coolingCapacity, VENDOR_RATING_MAX_W } from './thermal-evidence.mjs';
import { accessoryCost, costBreakdown } from './accessories.mjs';
import { nandBitsPerCell } from './specs-enrich.mjs';
const CASE_CHECK_IDS = new Set(['caseAirflow', 'gpuLength', 'gpuHeight', 'gpuThickness', 'gpuSlots', 'gpuCable', 'psuLength', 'psuFormat', 'coolerHeight', 'radiator', 'radiatorLayout', 'boardFit']);
const powerLimitValue = cap => (cap.level === 'vendor_rating' ? Math.min(cap.watts, VENDOR_RATING_MAX_W) : cap.watts);
import { validateWorkload, workloadProfile } from './workloads.mjs';
import { CORE_EPSILON, STRATEGIES, corePerformance, selectionValue, selectBuild, strongerOptions } from './recommendation-strategy.mjs';
import { matchingBenchmark } from './scenario-performance.mjs';
import { recommendPeripherals } from './peripherals.mjs';
import { productStatus, statusAllowed } from './product-status.mjs';
import { repairRisks } from './risk-repair.mjs';

export const SLOTS = ['CPU', 'GPU', 'MOTHERBOARD', 'RAM', 'SSD', 'PSU', 'CASE', 'COOLER'];
const PLATFORMS = /^(AM5|AM4|LGA1700|LGA1851)$/;
const BOARD_RANK = { 'MINI-ITX': 1, 'MICRO ATX': 2, ATX: 3, EATX: 4 };
const up = v => String(v ?? '').trim().toUpperCase();
const price = item => item.estimatedPriceCents ?? item.priceCents ?? 0;
const yuan = cents => `¥${Math.round(cents / 100).toLocaleString('zh-CN')}`;
const median = values => { const s = [...values].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));

/** 用途档案：认识的用途取第一个；只有“办公”或都不认识时按办公 */
export function profileKey(scenarios = []) {
  return scenarios.find(s => s !== 'office' && SCORING_PROFILES[s]) ?? 'office';
}

// ---------- 候选 ----------

/** 同类同规格里比中位价低一半以上的价格当作错价，不进候选（价格可信度另算） */
function saneItems(items, category, bucket) {
  const list = items.filter(i => i.category === category && price(i) > 0);
  const groups = new Map();
  for (const i of list) { const k = bucket(i); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(price(i)); }
  // 2.2.2：低于中位价一半、且没有其他报价佐证（±15% 内至少 2 条同类报价）才当作错价。
  // 2.2.1 只看中位价：DDR4 32GB 中位价被高价 RGB 套条拉到 ¥1,159，¥469 / ¥499 / ¥519 三条互相印证的正常报价被当成错价剔除，
  // 最便宜的“合格”32GB 变成 ¥859，比 64GB（¥849）还贵，推荐因此出现不必要的 64GB。
  return list.filter(i => {
    const g = groups.get(bucket(i)); const p = price(i);
    if (g.length < 3 || p >= median(g) * 0.5) return true;
    // 2.2.3：有 ≥1 条 ±15% 内的其他同类报价即视为有佐证（2.2.2 要求 2 条，DDR4 16GB ¥259 / ¥269 互相印证仍被删）
    return g.filter(x => x >= p * 0.85 && x <= p * 1.15).length - 1 >= 1;
  });
}

/** Pareto：按价格升序，只留性能比所有更便宜候选都高的（价格更高但性能不更好的去掉）；过多时均匀抽样，保留两端 */
function paretoByPrice(list, metric, max = 14, audit = [], cost = price) {
  const sorted = [...list].sort((a, b) => cost(a) - cost(b) || metric(b) - metric(a));
  const front = [];
  let best = -Infinity;
  for (const c of sorted) if (metric(c) > best) { front.push(c); best = metric(c); } else audit.push({ id: c.id, reason: 'price-performance-dominated', dominatedBy: front.at(-1)?.id });
  if (front.length <= max) return front;
  const step = (front.length - 1) / (max - 1);
  const kept = [...new Set(Array.from({ length: max }, (_, k) => front[Math.round(k * step)]))];
  for (const i of front.filter(i => !kept.includes(i))) audit.push({ id: i.id, reason: 'search-width-top-k', limit: max });
  return kept;
}

const gpuGroupKey = i => `${up(i.specs.chipset).replace(/^(GEFORCE|RADEON)\s*/, '')} ${i.specs.capacityGB}GB`;
const isNvidiaRtx = i => /RTX/i.test(i.specs.chipset ?? '');
const aiReady = i => /RTX\s*[345]\d{3}/i.test(i.specs.chipset ?? '');

function cpuCandidates(items, profile, { igpu, locked, audit = [] }) {
  if (locked.CPU) return [locked.CPU];
  const pool = saneItems(items, 'CPU', i => up(i.specs.socket)).filter(i => PLATFORMS.test(up(i.specs.socket)) && (!igpu || cpuHasIgpu(i.name, i.specs)));
  // 同一型号（盒装 / 散片等）取最便宜的一条
  const byModel = new Map();
  for (const i of pool) {
    const k = cpuKey(i.name) ?? i.name;
    if (!byModel.has(k) || price(i) < price(byModel.get(k))) byModel.set(k, i);
  }
  const models = [...byModel.values()];
  const metric = cpuMetric(profile);
  const measured = models.filter(i => metric(i) != null);
  // 没有性能数据的不靠价格冒充性能：有足够带数据的候选时不考虑它们
  if (measured.length >= 3) {
    const sockets = [...new Set(measured.map(i => i.specs.socket))];
    const front = sockets.flatMap(socket => paretoByPrice(measured.filter(i => i.specs.socket === socket), metric, 6, audit));
    // 2.2.3：低预算兜底——同插槽里比所有有跑分的 CPU 都便宜、但缺少跑分的型号（最多 3 个）也参与，评分中 CPU 分为 0、
    // 方案标明“CPU 性能数据缺失”。2.2.2 完全排除它们，2000 元办公因此找不到预算内方案。
    // 只用于核显（办公）方案：独显方案的低价位由显卡主导，加入无跑分 CPU 只会放大组合数
    const floor = !igpu ? [] : [...new Set(models.map(i => i.specs.socket))].flatMap(socket => {
      const cheapestMeasured = Math.min(...measured.filter(i => i.specs.socket === socket).map(price));
      return models.filter(i => i.specs.socket === socket && metric(i) == null && price(i) < cheapestMeasured).sort((a, b) => price(a) - price(b)).slice(0, 3);
    });
    for (const i of floor) audit.push({ id: i.id, reason: 'low-budget-fallback-missing-performance' });
    return [...front, ...floor];
  }
  return [...models].sort((a, b) => price(a) - price(b)).slice(0, 14);
}

const cpuMetric = profile => (profile.cpuMetric === 'gaming'
  ? i => i.performance?.gaming?.index ?? null
  : i => i.performance?.blender?.score ?? null);

function gpuMetric(profile) {
  if (profile.gpuMetric === 'ai') return i => (aiReady(i) && i.performance?.blender ? Math.log2(1 + i.specs.capacityGB / 12) * Math.sqrt(i.performance.blender.score) : null);
  if (profile.gpuMetric === 'creator') return i => (isNvidiaRtx(i) && i.specs.capacityGB >= 8 && i.performance?.blender ? i.performance.blender.score : null);
  return i => i.performance?.gaming?.index ?? null;
}

function gpuCandidates(items, profile, { locked, allowIgpu, audit = [], workload }) {
  if (locked.GPU) return [locked.GPU];
  if (profile.gpuMetric === 'none') return [null];
  const pool = saneItems(items, 'GPU', gpuGroupKey).filter(i => i.specs.chipset && i.specs.capacityGB && (i.specs.lengthMm ?? 0) >= 150 && i.specs.lengthMm <= 380);
  const groups = new Map();
  for (const i of pool) { const k = gpuGroupKey(i); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(i); }
  // 每个芯片 + 显存档取一张代表卡：不低于中位价 75% 里最便宜的、数据完整（供电接口、长度）的优先
  const reps = [...groups.values()].map(list => {
    const m = median(list.map(price));
    const sane = list.filter(i => price(i) >= m * 0.75);
    const complete = sane.filter(i => i.specs.powerPins);
    const chosen = [...(complete.length ? complete : sane.length ? sane : list)].sort((a, b) => price(a) - price(b) || a.id.localeCompare(b.id))[0];
    for (const i of list.filter(i => i !== chosen)) audit.push({ id: i.id, reason: 'same-chip-vram-representative', representative: chosen.id });
    return chosen;
  });
  const metric = gpuMetric(profile);
  // 2.2.1：先剔除“无法组成整机”的显卡，再做支配裁剪；支配比较用“显卡 + 能带动它的最便宜电源”的价格。
  // 2.2.0 在兼容性检查之前按显卡单价做 Pareto：一张没有任何电源能供电（或没有机箱装得下）的便宜高分卡，
  // 会把真正可装的卡裁掉（合成目录穷举测试 01 复现：四 8pin 的 5080 裁掉了 5070 Ti）。
  const psus = items.filter(i => i.category === 'PSU' && i.specs.ratedWatts && price(i) > 0);
  const caseLimits = items.filter(i => i.category === 'CASE').map(i => i.specs.maxGpuLengthMm).filter(Boolean);
  const effective = new Map();
  const buildable = reps.filter(g => {
    const need = powerEstimate({ maxPowerWatts: 120 }, g.specs, {}).selectionMinimum;
    const options = psus.filter(u => u.specs.ratedWatts >= need && gpuPowerCheck(g.specs, u.specs).status !== FAIL);
    if (!options.length) { audit.push({ id: g.id, reason: 'no-psu-can-power', detail: `没有电源同时满足 ≥${need}W 与显卡供电接口` }); return false; }
    if (caseLimits.length && g.specs.lengthMm && !caseLimits.some(l => l >= g.specs.lengthMm + 10)) { audit.push({ id: g.id, reason: 'no-case-fits', detail: `没有机箱容纳 ${g.specs.lengthMm}mm 显卡` }); return false; }
    effective.set(g.id, price(g) + Math.min(...options.map(price)));
    return true;
  });
  const cost = g => effective.get(g.id) ?? price(g);
  const measured = buildable.filter(i => metric(i) != null);
  const ai = profile.gpuMetric === 'ai';
  const nondominated = ai ? measured.filter(i => !measured.some(j => cost(j) <= cost(i) && j.specs.capacityGB >= i.specs.capacityGB && j.performance.blender.score >= i.performance.blender.score && (cost(j) < cost(i) || j.performance.blender.score > i.performance.blender.score || j.specs.capacityGB > i.specs.capacityGB))) : null;
  if (ai) for (const i of measured.filter(i => !nondominated.includes(i))) audit.push({ id: i.id, reason: 'price-vram-compute-dominated' });
  const front = measured.length >= 3 ? ai ? nondominated.sort((a, b) => cost(a) - cost(b)).slice(0, 24) : paretoByPrice(measured, metric, 20, audit, cost) : buildable.sort((a, b) => cost(a) - cost(b)).slice(0, 20);
  for (const i of reps.filter(i => matchingBenchmark(i, workload))) if (!front.includes(i)) front.push(i);
  for (const i of reps.filter(i => metric(i) == null)) audit.push({ id: i.id, reason: 'missing-performance-or-workload-support' });
  if (ai) for (const i of nondominated.filter(i => !front.includes(i))) audit.push({ id: i.id, reason: 'search-width-top-k', limit: 24 });
  // 游戏用途在预算很低时也评估核显（显卡分很低，只有放不下独显时才会被选）
  return allowIgpu ? [null, ...front] : front;
}

/** 主板品质（0–1）：供电相数、PCIe 代数、M.2 数量；不看价格 */
function boardQuality(b) {
  const s = b.specs;
  let q = 0.4;
  if (s.vrmPhases) q += clamp((s.vrmPhases - 6) / 14) * 0.3; else q += 0.1;
  if (s.pcieGen >= 4) q += 0.15;
  if (s.m2Slots >= 2) q += 0.1;
  if (s.videoOutputs) q += 0.05;
  return clamp(q);
}

function boardCandidates(items, { igpu, locked }) {
  if (locked.MOTHERBOARD) return new Map([['*', [locked.MOTHERBOARD]]]);
  const pool = saneItems(items, 'MOTHERBOARD', i => `${up(i.specs.socket)}:${up(i.specs.memoryType)}`)
    .filter(i => PLATFORMS.test(up(i.specs.socket)) && i.specs.memoryType && BOARD_RANK[up(i.specs.formFactor)] && !(igpu && i.specs.videoOutputs === false));
  // 按（插槽、内存代际、芯片组系列）分组，各取价格—品质 Pareto 前几名；保证每代芯片组都有候选（BIOS 原生支持要用）
  const groups = new Map();
  for (const b of pool) {
    const series = up(b.specs.chipset).match(/[ABHQXZ](\d)/)?.[1] ?? '?';
    const k = `${up(b.specs.socket)}|${up(b.specs.memoryType)}|${series}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(b);
  }
  const bySocket = new Map();
  for (const [k, list] of groups) {
    const socket = k.split('|')[0];
    if (!bySocket.has(socket)) bySocket.set(socket, []);
    bySocket.get(socket).push(...paretoByPrice(list, boardQuality, 3));
  }
  return bySocket;
}

function ramCandidates(items, profile, { locked }) {
  if (locked.RAM) return new Map([['*', [locked.RAM]]]);
  const pool = saneItems(items, 'RAM', i => `${up(i.specs.memoryType)}:${i.specs.capacityGB}`).filter(i => !i.possiblyStale && i.specs.memoryType && i.specs.capacityGB);
  const byType = new Map();
  for (const type of ['DDR4', 'DDR5']) {
    const list = pool.filter(i => up(i.specs.memoryType) === type);
    const picks = [];
    for (const gb of [16, 32, 64]) {
      const sized = list.filter(i => i.specs.capacityGB === gb);
      const dual = sized.filter(i => i.specs.modules === 2);
      const base = dual.length ? dual : sized;
      // 同容量：最便宜的；DDR5 另取最便宜的 ≥6000 MT/s（游戏有收益）
      const cheapest = [...base].sort((a, b) => price(a) - price(b))[0];
      if (cheapest) picks.push(cheapest);
      if (type === 'DDR5' && profile.cpuMetric === 'gaming') {
        const fast = base.filter(i => (i.specs.speedMTs ?? 0) >= 6000).sort((a, b) => price(a) - price(b))[0];
        if (fast && fast !== cheapest) picks.push(fast);
      }
    }
    byType.set(type, picks);
  }
  return byType;
}

/** 固态品质：TLC / 有缓存（DRAM 或 HMB）/ PCIe 4.0+ 读 ≥5000；剪辑、AI 工作盘更看重 */
function ssdQuality(s) {
  const spec = s.specs;
  let q = 0.4;
  // 2.2.2：按规范化的每单元比特数计分（SLC/MLC/TLC 同档，QLC 扣分）；厂商术语只作展示
  const bits = spec.bitsPerCell ?? nandBitsPerCell(spec.nand);
  if (bits && bits <= 3) q += 0.25; else if (bits === 4) q -= 0.1;
  if (spec.dram === 'dram' || spec.dram === 'hmb') q += 0.15; else if (spec.dram === 'none') q -= 0.05;
  if (/PCIE\s*[45]/i.test(spec.interface ?? '') && (spec.readMBs ?? 0) >= 5000) q += 0.2;
  return clamp(q);
}

function ssdCandidates(items, profile, { locked }) {
  if (locked.SSD) return [locked.SSD];
  const pool = saneItems(items, 'SSD', i => String(i.specs.capacityGB)).filter(i => i.specs.capacityGB && !['series-low'].includes(i.estimateBasis));
  const out = [];
  for (const gb of [512, 1000, 2000, 4000]) {
    if (gb > profile.ssdGB * 2) continue;
    const sized = pool.filter(i => Math.abs(i.specs.capacityGB - gb) <= gb * 0.07);
    const cheapest = [...sized].sort((a, b) => price(a) - price(b))[0];
    const good = sized.filter(i => ssdQuality(i) >= 0.75).sort((a, b) => price(a) - price(b))[0];
    for (const s of [cheapest, good]) if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

// ---------- 按需补电源、散热、机箱 ----------

/** 电源品质（0–1）：能效、ATX 3.x、单路 12V、保护、质保；数据缺失按中等偏低，不从价格或品牌推断 */
/** 电源品质下限（补件器与局部替换共用）：高负载要金牌级以上，安静优先再提高 */
export function psuQualityFloor(p, need, quiet) {
  const load = p.load ?? need / 1.25;
  return (load > 500 ? 0.55 : load > 300 ? 0.4 : 0.15) + (quiet ? 0.12 : 0);
}

export function psuQuality(s) {
  const eff = String(s.efficiency ?? '');
  let q = /钛金|TITANIUM/i.test(eff) ? 0.55 : /白金|铂金|PLATINUM/i.test(eff) ? 0.5 : /金|GOLD/i.test(eff) ? 0.42 : /银|SILVER/i.test(eff) ? 0.32
    : /铜|BRONZE/i.test(eff) ? 0.28 : /白牌|STANDARD|^80/i.test(eff) ? 0.18 : 0.15;
  if (String(s.atxVersion ?? '').startsWith('3')) q += 0.12;
  if (s.rail12vAmps) q += 0.08; else if (s.rail12vSplitAmps?.length) q -= 0.05;
  if (s.protections?.length) q += 0.15 * clamp(s.protections.length / 6);
  if (s.warrantyYears >= 7) q += 0.12; else if (s.warrantyYears >= 5) q += 0.08; else if (s.warrantyYears >= 3) q += 0.03;
  return clamp(q);
}

function makeCompleter(items, { igpu, quiet, locked, workload = {}, diagnostics, accessoryPricing = {} }) {
  const psus = saneItems(items, 'PSU', i => String(Math.round((i.specs.ratedWatts ?? 0) / 100) * 100)).filter(i => i.specs.ratedWatts);
  const coolers = saneItems(items, 'COOLER', i => (i.specs.radiatorSizeMm ? `liquid:${i.specs.radiatorSizeMm}` : 'air'));
  // 2.2.3：没有显卡限长的机箱仍可用于核显方案（有独显时在尺寸筛选中排除）
  const cases = saneItems(items, 'CASE', () => 'all');
  // 目录里有整机实测的机箱才可能 PASS；否则风道依据最好只能是 CONDITIONAL（提前停止用）
  const bestAirflowRank = cases.some(i => i.specs.thermalTests?.length) ? 0 : 1;
  const memo = new Map();
  const cached = (key, fn) => { if (!memo.has(key)) memo.set(key, fn()); return memo.get(key); };
  const rejected = (item, type, reason) => {
    if (!diagnostics) return;
    diagnostics[type] = (diagnostics[type] ?? 0) + 1;
    const key = `${item.id}|${reason}`;
    const record = diagnostics.records[key] ?? { id: item.id, name: item.name, priceCents: price(item), type, reason, occurrences: 0 };
    record.occurrences++; diagnostics.records[key] = record;
  };

  /** 电源：功率 ≥ 需求；供电接口、12V 不能 FAIL；按负载设品质下限（高负载要金牌级、ATX 3.x 更好），满足的里面挑最便宜 */
  function psu(cpu, gpu) {
    if (locked.PSU) return locked.PSU;
    const g = gpu?.specs ?? {};
    const p = powerEstimate(cpu.specs, igpu ? null : g, { igpu });
    const need = p.selectionMinimum;
    const pinsKey = JSON.stringify(g.powerPins ?? null);
    const key = `psu|${need}|${pinsKey}|${p.gpuW}|${p.cpuW}|${quiet}`;
    return cached(key, () => {
      const graded = psus.filter(i => i.specs.ratedWatts >= need).map(i => {
        const checks = evaluateBuild({ CPU: { specs: cpu.specs }, GPU: igpu || !gpu ? null : { specs: g }, PSU: { specs: i.specs } }, { igpu })
          .filter(c => ['gpuPower', 'psu12v', 'psuWatts'].includes(c.id));
        // 高功耗（显卡 ≥250W）时，电源长度未知会让机箱的电源长度检查成为阻断项：同等条件下优先长度已知的电源
        // 电源规格（ATX / SFX）未知时机箱的电源规格检查是阻断项（不论功耗）：同样优先规格已知的电源
        const lengthUnknown = ((p.gpuW ?? 0) >= 250 && !i.specs.psuLengthMm) || !i.specs.psuFormFactor ? 2 : 0;
        const rank = Math.max(lengthUnknown, ...checks.map(c => (c.status === FAIL ? 9 : c.status === UNKNOWN ? 2 : c.status === CONDITIONAL ? 1 : 0)));
        // 2.2.2：16pin 显卡同等检查结果下优先原生 12VHPWR / 12V-2x6 原厂线（未知次之，明确没有最后）
        const native = g.powerPins?.pin16 ? ({ true: 0, null: 1, false: 2 })[String(psuConnectors(i.specs).native16)] : 0;
        return { item: i, rank, native, q: psuQuality(i.specs) };
      }).filter(x => { if (x.rank >= 9) rejected(x.item, 'specification', '电源接口、额定功率或 12V 检查失败'); return x.rank < 9; });
      if (!graded.length) return null;
      const floor = psuQualityFloor(p, need, quiet);
      for (const x of graded.filter(x => x.q < floor)) rejected(x.item, 'quality', `供电品质 ${x.q.toFixed(2)} 低于当前负载下限 ${floor.toFixed(2)}`);
      const eligible = graded.filter(x => x.q >= floor);
      if (!eligible.length) return null;
      const bestRank = Math.min(...eligible.map(x => x.rank));
      return eligible.filter(x => x.rank === bestRank).sort((a, b) => a.native - b.native || price(a.item) - price(b.item))[0].item;
    });
  }

  /** 散热：按 CPU 持续功耗要求散热能力；合格风冷可参与；AMD 盒装非 X 型号低预算可用原装散热 */
  function cooler(cpu, board) {
    if (locked.COOLER) return locked.COOLER;
    const peak = sustainedPower(cpu.specs, board?.specs, workload);
    const stockOk = !quiet && peak > 0 && peak <= 95 && stockCooler(cpu);
    const key = `cooler|${cpu.id}|${peak}|${quiet}|${stockOk}`;
    return cached(key, () => {
      if (stockOk) return 'STOCK';
      const fits = coolers.filter(c => { const fit = evaluateBuild({ CPU: { specs: { socket: cpu.specs.socket } }, COOLER: { specs: c.specs } }).find(x => x.id === 'coolerSocket')?.status === PASS; if (!fit) rejected(c, 'specification', `没有确认支持 CPU 插槽 ${cpu.specs.socket}`); return fit; });
      // 2.2.2：按散热证据选（thermal-evidence.mjs），不再按塔高 / 冷排尺寸推断能力。
      //   第一优先：证据覆盖持续负载（实测 / ≤200W 的厂商标称 / 低功耗工程判断）里最便宜的；
      //   都覆盖不了：选证据覆盖功率最高的（降功耗运行条件最宽），同等再比价格；检查结果为关键待核实。
      const watts = peak ?? 0;
      const graded = fits.map(c => ({ c, cap: coolingCapacity(c.specs, { cpu: cpu.specs, quiet, maxNoiseDbA: workload.maxNoiseDbA ?? 35 }) }));
      const covering = graded.filter(x => capacityCovers(x.cap, watts));
      for (const x of graded.filter(x => !covering.includes(x))) rejected(x.c, 'quality', `散热证据（${x.cap.level}，${x.cap.watts}W）不覆盖 ${watts || '未知'}W 持续负载`);
      const evidenceRank = l => ({ measured: 0, vendor_rating: 1, engineering: 2, stock: 2, none: 3 })[l] ?? 3;
      // 安装尺寸未知（风冷无高度、水冷无冷排尺寸）会让机箱的安装检查成为阻断项：同样覆盖负载时优先尺寸已知的
      const dimsUnknown = c => (c.specs.radiatorSizeMm ? 0 : c.specs.heightMm ? 0 : 1);
      if (covering.length) return covering.sort((a, b) => dimsUnknown(a.c) - dimsUnknown(b.c) || price(a.c) - price(b.c) || evidenceRank(a.cap.level) - evidenceRank(b.cap.level) || a.c.id.localeCompare(b.c.id))[0].c;
      return graded.sort((a, b) => powerLimitValue(b.cap) - powerLimitValue(a.cap) || price(a.c) - price(b.c) || a.c.id.localeCompare(b.c.id))[0]?.c ?? null;
    });
  }

  /** 机箱：装得下主板、显卡（留 10mm）、散热器 / 冷排；没有风道数据，不按价格当品质——满足条件里最便宜 */
  function pcCase(cpu, board, gpu, cool, psu) {
    if (locked.CASE) return locked.CASE;
    const len = igpu || !gpu ? 0 : gpu.specs.lengthMm ?? 0;
    const c = cool && cool !== 'STOCK' ? cool.specs : {};
    const fmt = boardFormat(board.specs.formFactor);
    const peakW = sustainedPower(cpu.specs, board.specs, workload);
    const key = `case|${fmt}|${peakW}|${cpu.specs.maxPowerWatts ?? ''}|${c.thermalTests?.length ? cpu.specs.socket : ''}|${board.specs.rebarSupport ?? ''}|${board.specs.gpuPcieLink?.physicalLanes ?? ''}|${gpu?.id ?? 'igpu'}|${cool?.id ?? cool}|${psu.id}|${quiet}`;
    // 静态尺寸筛选只取决于主板板型与尺寸，单独缓存并按价格排序
    const fitKey = `casefit|${fmt}|${len}|${c.radiatorSizeMm ?? 0}|${c.heightMm ?? 0}`;
    const fitting = cached(fitKey, () => cases.filter(i => {
      if (boardCaseStatus(board.specs, i.specs) !== PASS) { rejected(i, 'specification', '主板板型冲突或没有明确的支持规格集合'); return false; }
      if (len && !i.specs.maxGpuLengthMm) { rejected(i, 'specification', '机箱缺少显卡限长，独显方案不能确认可装'); return false; }
      if (len && i.specs.maxGpuLengthMm < len + 10) { rejected(i, 'specification', '显卡长度加 10mm 安装余量超过机箱限长'); return false; }
      if (c.radiatorSizeMm && (i.specs.maxRadiatorMm ?? 0) < c.radiatorSizeMm) { rejected(i, 'specification', '冷排不满足机箱支持上限'); return false; }
      if (!c.radiatorSizeMm && c.heightMm && (i.specs.maxCoolerHeightMm ?? 0) < c.heightMm) { rejected(i, 'specification', '散热器高度不满足机箱上限'); return false; }
      return true;
    }).sort((a, b) => price(a) - price(b) || a.id.localeCompare(b.id)));
    // 排序（2.2.1）：阻断性待核实项数量 → 风道依据（实测 PASS / 工程判断 CONDITIONAL / 未知）→ 价格。
    // 按价格从低到高评估，遇到“无阻断项且风道依据已达目录可能的最好等级”即停：与全量排序结果相同。
    // 2.2.2：阻断性待核实项数量 → 风道依据（实测 PASS / 工程判断 CONDITIONAL / 未知）→ 机箱空间类待核实项数
    // → 完整成本（机箱价 + 必需风扇等附件）。2.2.1 只比机箱标价、不计另购风扇，30/36 套落在同一款 ¥154 机箱。
    // 按标价从低到高评估；附件成本 ≥ 0，所以当最优已无阻断项、风道达最好等级且下一款标价已不低于最优完整成本时即停。
    return cached(key, () => {
      let best = null;
      // 高负载（>450W）时，前面板进风结构已知为网孔的机箱优先（进风结构是实际散热依据，不是价格）
      const highLoad = (sustainedPower(cpu.specs, board.specs, workload) ?? 0) + (igpu || !gpu ? 0 : gpuPowerWatts(gpu.specs) ?? 0) > 450;
      const better = (a, b) => a.blocking - b.blocking || a.rank - b.rank || a.unknown - b.unknown || (highLoad ? a.intake - b.intake : 0) || a.complete - b.complete;
      for (const item of fitting) {
        if (best && best.blocking === 0 && best.rank <= bestAirflowRank && best.unknown === 0 && (!highLoad || best.intake === 0) && price(item) >= best.complete) break;
        const checks = evaluateBuild({ CPU: cpu, GPU: gpu, MOTHERBOARD: board, COOLER: cool === 'STOCK' ? null : cool, PSU: psu, CASE: item }, { igpu, stockCooler: cool === 'STOCK', workload: { ...workload, quiet } });
        if (checks.some(x => x.status === FAIL)) { rejected(item, 'specification', '补齐电源、散热器、显卡后最终物理或供电检查失败'); continue; }
        const thermal = checks.find(x => x.id === 'caseAirflow');
        const cand = { item, blocking: checks.filter(x => x.blocking).length, rank: thermal?.status === PASS ? 0 : thermal?.status === CONDITIONAL ? 1 : 2,
          unknown: checks.filter(x => CASE_CHECK_IDS.has(x.id) && x.status === UNKNOWN).length, intake: item.specs.frontIntake === 'mesh' ? 0 : 1,
          complete: price(item) + accessories(cpu, board, gpu, psu, item, cool).requiredCents };
        if (!best || better(cand, best) < 0) best = cand;
      }
      return best?.item ?? null;
    });
  }

  /** 必需附件：只取决于 CPU 持续功耗、显卡功耗、机箱与电源；同一请求内缓存 */
  // 原装散热未按零售料号确认时的备用散热器价格：同插槽、安装尺寸已知的最便宜散热器
  const fallbackCooler = socket => cached(`fallback|${socket}`, () => coolers.filter(c => (c.specs.heightMm || c.specs.radiatorSizeMm) && evaluateBuild({ CPU: { specs: { socket } }, COOLER: { specs: c.specs } }).find(x => x.id === 'coolerSocket')?.status === PASS).sort((a, b) => price(a) - price(b))[0] ?? null);
  function accessories(cpu, board, gpu, psu, pc, cool = null, w = workload) {
    const cpuW = sustainedPower(cpu.specs, board?.specs, w) ?? 0;
    const gpuW = igpu || !gpu ? 0 : gpuPowerWatts(gpu.specs) ?? 0;
    const stock = cool === 'STOCK' ? { confirmed: stockCoolerConfirmed(cpu), fallbackCents: fallbackCooler(up(cpu.specs.socket)) ? price(fallbackCooler(up(cpu.specs.socket))) : null } : null;
    const coolerSpecs = cool && cool !== 'STOCK' ? cool.specs : null;
    // 缓存键只用真正影响结果的派生值（主板风扇接口数、散热器风扇数、原装散热确认状态），避免按主板 / 散热器 ID 逐一失配
    const coolerFans = coolerSpecs ? (coolerSpecs.radiatorSizeMm ? `r${coolerSpecs.radiatorSizeMm}` : `f${coolerSpecs.fanCount ?? 1}`) : cool === 'STOCK' ? 'stock' : 'none';
    const stockKey = stock ? `${stock.confirmed}|${stock.fallbackCents}` : '';
    return cached(`acc|${cpuW}|${gpuW}|${pc.id}|${psu.id}|${board?.specs.fanHeaders ?? ''}|${coolerFans}|${stockKey}`, () => accessoryCost({ cpuW, gpuW, pc: pc.specs, psu: psu.specs, board: board?.specs, cooler: coolerSpecs, stock,
      pricing: { fanUnitCents: accessoryPricing.fanUnitCents, includedFans: locked.CASE && pc === locked.CASE ? accessoryPricing.includedFans : undefined } }));
  }

  const baseChecksMap = new Map();
  return { psu, cooler, pcCase, accessories, baseChecksFor: (cpu, board, gpu, cool, psu, pc) => {
    const key = `${cpu.id}|${board.id}|${gpu?.id ?? 'igpu'}|${cool?.id ?? cool}|${psu.id}|${pc.id}`;
    let checks = baseChecksMap.get(key);
    if (!checks) {
      checks = evaluateBuild({ CPU: cpu, GPU: gpu, MOTHERBOARD: board, COOLER: cool === 'STOCK' ? null : cool, PSU: psu, CASE: pc }, { igpu, stockCooler: cool === 'STOCK', workload: { ...workload, quiet } });
      baseChecksMap.set(key, checks);
    }
    return checks;
  } };
}

// ---------- 评分 ----------

/**
 * 内存容量的用途价值（2.2.2，0–1）：低于目标按 0.9·√(容量/目标) 计（不足越多越低）；达到目标得 0.9；
 * 超过目标只按 0.1·(1 − 目标/容量) 递减增加（2× 目标 0.95、4× 目标 0.975）。目标 = 用途建议容量与用户最低内存的较大者。
 * 2.2.1 为 √(容量/目标) 截断到 1：超过目标后完全不加分、低于目标又扣得较少，没有“舒适容量后递减”的区分。
 */
export function memoryValue(gb, target) {
  if (!(gb > 0) || !(target > 0)) return 0;
  return gb < target ? 0.9 * Math.sqrt(gb / target) : 0.9 + 0.1 * (1 - target / gb);
}

const CONF = { high: 1, medium: 0.7, low: 0.3 };

function buildScoringEnv(ctx) {
  const { profile, refs, quiet, workload = {}, profileKey: key } = ctx;
  const w = { ...profile.weights };
  if (quiet) {
    const extra = QUIET_NOISE_WEIGHT - w.noise;
    const others = Object.keys(w).filter(k => k !== 'noise');
    const sum = others.reduce((s, k) => s + w[k], 0);
    for (const k of others) w[k] -= extra * (w[k] / sum);
    w.noise = QUIET_NOISE_WEIGHT;
  }
  const cpuFn = cpuMetric(profile);
  const gaming = profile.cpuMetric === 'gaming';
  const proxyBasis = profile.gpuMetric === 'gaming' ? '2K 光栅指数代理；不代表 1080p FPS、4K 光追、超分或帧生成结果' : 'Blender 渲染代理；不代表剪辑编码、LLM 或训练吞吐';
  return { profile, refs, quiet, workload, key, w, cpuFn, gaming, proxyBasis };
}

function precomputeOuterScore(b, env) {
  const { profile, refs, workload, key, cpuFn } = env;
  const parts = {};
  if (profile.gpuMetric === 'none') parts.gpu = 0;
  else if (!b.gpu) parts.gpu = 0.03;
  else if (profile.gpuMetric === 'ai') {
    const compute = b.gpu.performance?.blender?.score;
    parts.gpu = 0.75 * clamp(b.gpu.specs.capacityGB / (profile.vramRefGB ?? 24)) + 0.25 * (compute ? clamp(compute / refs.gpuCompute) : 0);
  } else if (profile.gpuMetric === 'creator') {
    const compute = b.gpu.performance?.blender?.score;
    parts.gpu = Math.sqrt((compute ? clamp(compute / refs.gpuCompute) : 0) * (b.gpu.specs.capacityGB >= 12 ? 1 : 0.9));
  } else {
    const idx = b.gpu.performance?.gaming?.index;
    parts.gpu = idx ? clamp(idx / refs.gpuGaming) ** (profile.gpuCurve ?? 0.7) : 0;
  }
  const measuredScenario = b.benchmark;
  if (measuredScenario) parts.gpu = measuredScenario.value / (measuredScenario.value + (measuredScenario.reference ?? 20));
  const cm = cpuFn(b.cpu);
  const cpuRatio = cm / (profile.cpuMetric === 'gaming' ? refs.cpuGaming : refs.cpuBlender);
  parts.cpu = cm != null ? Math.sqrt(clamp(cpuRatio)) : 0;
  const evidenceScore = id => ({ PASS: 1, CONDITIONAL: .4, UNKNOWN: 0, FAIL: 0 })[b.baseChecks.find(c => c.id === id)?.status] ?? 0;
  parts.quality = (psuQuality(b.psu.specs) + boardQuality(b.board) + evidenceScore('cpuCooling') + evidenceScore('caseAirflow')) / 4;
  const noise = b.case.specs.thermalTests?.find(t => t.kind === 'measured' && t.sourceUrl && t.cpuWatts >= sustainedPower(b.cpu.specs, b.board.specs, workload) && t.gpuWatts >= (b.gpu?.specs.boardPowerWatts ?? b.gpu?.specs.tdpWatts ?? 0) && t.noiseDbA != null);
  parts.noise = noise ? clamp((50 - noise.noiseDbA) / 25) : 0;
  parts.balance = b.gpu && b.cpu.performance?.gaming ? clamp(b.cpu.performance.gaming.index / (CPU_BALANCE.base + CPU_BALANCE.perGpu * (b.gpu.performance?.gaming?.index ?? 0))) : .3;
  const baseUpgrade = ((b.board.specs.m2Slots ?? 0) > 1 ? .3 : 0) + (['AM5', 'LGA1851'].includes(up(b.board.specs.socket)) ? .4 : 0);
  const boardMemSlots = b.board.specs.memorySlots ?? 0;
  let bottleneck = 0;
  if (profile.cpuMetric === 'gaming' && b.gpu?.performance?.gaming && cm != null) {
    const need = CPU_BALANCE.base + CPU_BALANCE.perGpu * b.gpu.performance.gaming.index;
    bottleneck = Math.max(0, need - cm) * CPU_BALANCE.penalty;
  }
  const baseItems = [b.cpu, b.gpu, b.board, b.psu, b.case, b.cooler === 'STOCK' ? null : b.cooler].filter(Boolean);
  const baseConfSum = baseItems.reduce((s, i) => s + (CONF[i.priceConfidence] ?? .3), 0);
  const baseLegacy = baseItems.filter(i => i.priceFlags?.includes('legacy')).length;
  const proxy = !measuredScenario && key !== 'office';
  const proxyCap = proxy ? (['4k', 'ai', 'creator'].includes(key) ? .4 : .65) : 1;
  const coreDim = Math.round((parts.gpu * (profile.gpuMetric === 'none' ? 0 : .65) + parts.cpu * (profile.gpuMetric === 'none' ? 1 : .35)) * 100);
  const fixedWeighted = 100 * (env.w.gpu * parts.gpu + env.w.cpu * parts.cpu + env.w.quality * parts.quality + env.w.noise * parts.noise + env.w.balance * parts.balance) - bottleneck;
  const performanceBasis = measuredScenario ? '同一测试组的显卡型号实测，整机表现仍受搭配影响' : env.proxyBasis;
  const fixedScoreParts = {
    gpu: Math.round(parts.gpu * 100), cpu: Math.round(parts.cpu * 100), quality: Math.round(parts.quality * 100),
    noise: Math.round(parts.noise * 100), balance: Math.round(parts.balance * 100),
  };
  return { fixedScoreParts, baseUpgrade, boardMemSlots, bottleneck: Math.round(bottleneck * 10) / 10, baseConfSum, baseItemCount: baseItems.length + 2, baseLegacy, proxy, proxyCap, coreDim, fixedWeighted, performanceBasis };
}

function fastScoreBuild(b, env, outer, checkCounts) {
  const { profile, workload, key, w } = env;
  const ramGB = b.ram.specs.capacityGB ?? 0;
  const memory = memoryValue(ramGB, Math.max(profile.ramGB, workload.minRamGB ?? 0)) * (env.gaming && up(b.ram.specs.memoryType) === 'DDR5' && (b.ram.specs.speedMTs ?? 0) >= 6000 ? 1 : 0.95);
  const storage = 0.75 * clamp(Math.sqrt((b.ssd.specs.capacityGB ?? 0) / profile.ssdGB)) + 0.25 * ssdQuality(b.ssd);
  const upgrade = (outer.boardMemSlots > (b.ram.specs.modules ?? 0) ? .3 : 0) + outer.baseUpgrade;
  const conf = (outer.baseConfSum + (CONF[b.ram.priceConfidence] ?? .3) + (CONF[b.ssd.priceConfidence] ?? .3)) / outer.baseItemCount;
  const legacy = outer.baseLegacy + (b.ram.priceFlags?.includes('legacy') ? 1 : 0) + (b.ssd.priceFlags?.includes('legacy') ? 1 : 0);
  let trust = clamp(conf - 0.03 * checkCounts.cond - 0.15 * checkCounts.unknownCritical - 0.05 * checkCounts.unknown - LEGACY_TRUST_PENALTY * legacy);
  if (outer.proxy) trust = Math.min(trust, outer.proxyCap);
  const total = outer.fixedWeighted + 100 * (w.memory * memory + w.storage * storage + w.upgrade * upgrade + w.trust * trust);
  const mScore = Math.round(memory * 100);
  const sScore = Math.round(storage * 100);
  const uScore = Math.round(upgrade * 100);
  const tScore = Math.round(trust * 100);
  return {
    total: Math.round(total * 10) / 10, bottleneck: outer.bottleneck,
    scope: key, workload: workload.task, performanceBasis: outer.performanceBasis, confidence: outer.proxy ? 'low' : 'medium',
    dimensions: { core: outer.coreDim, balance: outer.fixedScoreParts.balance, memoryStorage: Math.round((memory + storage) * 50), reliability: outer.fixedScoreParts.quality, upgrade: uScore, noiseEfficiency: outer.fixedScoreParts.noise, trust: tScore },
    parts: { ...outer.fixedScoreParts, memory: mScore, storage: sScore, upgrade: uScore, trust: tScore },
  };
}

// ---------- 主流程 ----------

/** 锁定配件 → 候选项（硬约束） */
function lockedItems(locked) {
  return Object.fromEntries(Object.entries(locked).filter(([, p]) => !p.igpu).map(([slot, p]) => [slot, {
    id: `locked-${slot.toLowerCase()}`, category: slot, name: p.name || `已锁定的${slot}`, specs: p.specs ?? {}, estimatedPriceCents: p.priceCents ?? 0, locked: true,
  }]));
}

/**
 * 枚举并评估整机组合。返回可行组合列表（总价、评分、配件、兼容性），供各档挑选。
 * maxCostCents：部分总价剪枝上限。
 */
export function enumerateBuilds(items, { scenarios = [], locked: lockedInput = {}, maxCostCents = Infinity, igpuOnly = false, allowIgpu = false, workload = {}, lazyChecks = false, accessoryPricing = {} }) {
  const key = profileKey(scenarios);
  const profile = workloadProfile(SCORING_PROFILES[key], key, workload);
  const quiet = scenarios.includes('quiet');
  const locked = lockedItems(lockedInput);
  const igpuLocked = !!lockedInput.GPU?.igpu;
  const audit = [];
  const cpus = cpuCandidates(items, profile, { igpu: igpuOnly || igpuLocked, locked, audit });
  const gpus = igpuOnly || igpuLocked ? [null] : gpuCandidates(items, profile, { locked, allowIgpu, audit, workload });
  const boards = boardCandidates(items, { igpu: igpuOnly || igpuLocked || gpus.includes(null), locked });
  const rams = ramCandidates(items, profile, { locked });
  const ssds = ssdCandidates(items, profile, { locked });
  // 性能参照值取全部候选里最好的（与预算无关，不同预算的评分才能比较）；评分里再开平方，体现边际收益递减
  const top = (list, f) => Math.max(1, ...list.filter(Boolean).map(f));
  const refs = {
    gpuGaming: top(gpus, g => g.performance?.gaming?.index ?? 0),
    gpuCompute: top(gpus, g => g.performance?.blender?.score ?? 0),
    cpuGaming: top(cpus, c => c.performance?.gaming?.index ?? 0),
    cpuBlender: top(cpus, c => c.performance?.blender?.score ?? 0),
  };
  // 核显 / 独显各一套补件器（电源需求、机箱显卡长度不同），内部按需求缓存
  const diagnostics = { quality: 0, specification: 0, records: {} };
  const completers = { true: makeCompleter(items, { igpu: true, quiet, locked, workload, diagnostics, accessoryPricing }), false: makeCompleter(items, { igpu: false, quiet, locked, workload, diagnostics, accessoryPricing }) };
  const evalWorkload = { ...workload, quiet };
  const scoreEnv = buildScoringEnv({ profile, refs, quiet, workload, profileKey: key });
  const RAM_CHECK_IDS = new Set(['memoryType', 'memorySlots', 'memoryCapacity', 'memorySpeed']);
  const severityRank = c => (c.status === FAIL ? 4 : c.status === UNKNOWN && (c.blocking ?? c.critical) ? 3 : c.status === CONDITIONAL || c.status === UNKNOWN ? 1 : 0);
  const countStats = list => {
    let cond = 0; let unknownCritical = 0; let unknown = 0;
    const failIds = []; const blockingIds = [];
    let physical = 0; let safety = 0; let needsConfirmation = false;
    for (const c of list) {
      if (c.status === FAIL) failIds.push(c.id);
      else if (c.status === CONDITIONAL) { cond++; needsConfirmation = true; }
      else if (c.status === UNKNOWN) {
        needsConfirmation = true;
        if (c.critical) unknownCritical++; else unknown++;
      }
      if (c.blocking) blockingIds.push(c.id);
      const r = severityRank(c);
      if (c.severity === 'physical') { if (r > physical) physical = r; }
      else if (c.severity === 'safety') { if (r > safety) safety = r; }
    }
    return { cond, unknownCritical, unknown, failIds, blockingIds, physical, safety, needsConfirmation };
  };
  const statusFromRank = r => (r >= 4 ? FAIL : r >= 3 ? UNKNOWN : r >= 1 ? CONDITIONAL : PASS);
  const ramMemo = new Map();
  const ssdMemo = new Map();
  const getRamEval = (cpu, board, ram) => {
    const mk = `${cpu.id}|${board.id}|${ram.id}`;
    let hit = ramMemo.get(mk);
    if (!hit) {
      const checks = evaluateBuild({ CPU: { name: cpu.name, specs: cpu.specs }, MOTHERBOARD: { name: board.name, specs: board.specs }, RAM: { name: ram.name, specs: ram.specs, mpn: ram.mpn } }, { igpu: false, workload: evalWorkload }).filter(c => RAM_CHECK_IDS.has(c.id));
      hit = { checks, stats: countStats(checks) };
      ramMemo.set(mk, hit);
    }
    return hit;
  };
  const getSsdEval = (cpu, board, ssd) => {
    const mk = `${cpu.id}|${board.id}|${ssd.id}`;
    let hit = ssdMemo.get(mk);
    if (!hit) {
      const all = evaluateBuild({ CPU: { name: cpu.name, specs: cpu.specs }, MOTHERBOARD: { name: board.name, specs: board.specs }, SSD: { name: ssd.name, specs: ssd.specs } }, { igpu: false, workload: evalWorkload });
      const m2 = all.filter(c => c.id === 'm2');
      const ssdPcie = all.filter(c => c.id === 'ssdPcie');
      const combined = [...m2, ...ssdPcie];
      hit = { m2, ssdPcie, stats: countStats(combined) };
      ssdMemo.set(mk, hit);
    }
    return hit;
  };
  const minSsdPrice = ssds.length ? Math.min(...ssds.map(price)) : 0;
  const builds = [];
  const stats = { initialCandidates: Object.fromEntries(SLOTS.map(s => [s, items.filter(i => i.category === s).length])), candidates: { cpu: cpus.length, gpu: gpus.length, board: [...boards.values()].flat().length, ram: [...rams.values()].flat().length, ssd: ssds.length }, combos: 0, completed: 0, rejectedBudget: 0, rejectedFail: 0, incomplete: 0, rejectedByRule: {}, searchBounded: true, globalOptimalityProven: false };
  for (const cpu of cpus) {
    const socket = up(cpu.specs.socket);
    const boardList = locked.MOTHERBOARD ? boards.get('*') : boards.get(socket) ?? [];
    for (const board of boardList) {
      if (!locked.MOTHERBOARD && up(board.specs.socket) !== socket) continue;
      const bios = biosSupport(cpu.name, board.specs.chipset, board.specs);
      if (bios.status === FAIL) continue;
      const ramList = locked.RAM ? rams.get('*') : rams.get(up(board.specs.memoryType)) ?? [];
      const minRamPrice = ramList.length ? Math.min(...ramList.map(price)) : 0;
      const ssdList = board.specs.m2Slots === 0 ? ssds.filter(s => !/M\.2/i.test(s.specs.interface ?? '')) : ssds;
      const ramEvals = ramList.map(ram => ({ ram, ramPrice: price(ram), ...getRamEval(cpu, board, ram) }));
      const ssdEvals = ssdList.map(ssd => ({ ssd, ssdPrice: price(ssd), ...getSsdEval(cpu, board, ssd) }));
      for (const gpu of gpus) {
        const igpu = gpu === null;
        if (igpu && !cpuHasIgpu(cpu.name, cpu.specs)) continue;
        if (igpu && board.specs.videoOutputs === false) continue;
        const base = price(cpu) + price(board) + (gpu ? price(gpu) : 0);
        if (base > maxCostCents) { stats.rejectedBudget++; continue; }
        const completer = completers[igpu];
        const cool = completer.cooler(cpu, board);
        if (cool === null) { stats.incomplete++; continue; }
        const psu = completer.psu(cpu, gpu);
        if (!psu) { stats.incomplete++; continue; }
        const pc = completer.pcCase(cpu, board, gpu, cool, psu);
        if (!pc) { stats.incomplete++; continue; }
        // 2.2.2：必需附件（机箱风扇、电源支架）按 accessories.mjs 计入完整总价；选件、预算、兼容说明、导出共用
        const acc = completer.accessories(cpu, board, gpu, psu, pc, cool);
        const fixed = base + price(psu) + price(pc) + (cool === 'STOCK' ? 0 : price(cool)) + acc.requiredCents;
        if (fixed + minRamPrice + minSsdPrice > maxCostCents) {
          const n = ramList.length * ssds.length;
          stats.combos += n; stats.rejectedBudget += n;
          continue;
        }
        const baseChecks = completer.baseChecksFor(cpu, board, gpu, cool, psu, pc);
        const pcieIdx = baseChecks.findIndex(c => c.id === 'pcie');
        const tailIdx = baseChecks.findIndex(c => c.id === 'rebar' || c.id === 'vrm');
        const splitPcie = pcieIdx >= 0 ? pcieIdx : (tailIdx >= 0 ? tailIdx : baseChecks.length);
        const splitAfterPcie = pcieIdx >= 0 ? pcieIdx + 1 : splitPcie;
        const bHead = baseChecks.slice(0, baseChecks.findIndex(c => !['socket', 'bios'].includes(c.id)) === -1 ? baseChecks.length : baseChecks.findIndex(c => !['socket', 'bios'].includes(c.id)));
        const bMid = baseChecks.slice(bHead.length, splitPcie);
        const bPcie = baseChecks.slice(splitPcie, splitAfterPcie);
        const bTail = baseChecks.slice(splitAfterPcie);
        const baseStats = countStats(baseChecks);
        let core = corePerformance({ cpu, gpu }, profile);
        const benchmark = matchingBenchmark(gpu, workload);
        if (benchmark) core = { ...core, proxy: null, metric: benchmark.value, value: Math.log1p(benchmark.value / (benchmark.reference ?? 20)), benchmark };
        const outerScore = precomputeOuterScore({ cpu, gpu, board, psu, case: pc, cooler: cool, baseChecks, benchmark }, scoreEnv);
        for (const { ram, ramPrice, checks: ramChecks, stats: ramStats } of ramEvals) {
          const afterRam = fixed + ramPrice;
          if (afterRam + minSsdPrice > maxCostCents) {
            stats.combos += ssds.length; stats.rejectedBudget += ssds.length;
            continue;
          }
          if (ssds.length !== ssdList.length) stats.combos += (ssds.length - ssdList.length);
          for (const { ssd, ssdPrice, m2, ssdPcie, stats: ssdStats } of ssdEvals) {
            stats.combos++;
            const total = afterRam + ssdPrice;
            if (total > maxCostCents) { stats.rejectedBudget++; continue; }
            const failIds = baseStats.failIds.length || ramStats.failIds.length || ssdStats.failIds.length
              ? [...baseStats.failIds, ...ramStats.failIds, ...ssdStats.failIds] : null;
            if (failIds) { stats.rejectedFail++; for (const id of failIds) stats.rejectedByRule[id] = (stats.rejectedByRule[id] ?? 0) + 1; continue; }
            const checks = lazyChecks ? null : [...bHead, ...ramChecks, ...bMid, ...m2, ...bPcie, ...ssdPcie, ...bTail];
            const checkCounts = { cond: baseStats.cond + ramStats.cond + ssdStats.cond, unknownCritical: baseStats.unknownCritical + ramStats.unknownCritical + ssdStats.unknownCritical, unknown: baseStats.unknown + ramStats.unknown + ssdStats.unknown };
            const risk = {
              physical: statusFromRank(Math.max(baseStats.physical, ramStats.physical, ssdStats.physical)),
              safety: statusFromRank(Math.max(baseStats.safety, ramStats.safety, ssdStats.safety)),
              blockingChecks: baseStats.blockingIds.length || ramStats.blockingIds.length || ssdStats.blockingIds.length
                ? [...baseStats.blockingIds, ...ramStats.blockingIds, ...ssdStats.blockingIds] : [],
              needsConfirmation: baseStats.needsConfirmation || ramStats.needsConfirmation || ssdStats.needsConfirmation,
            };
            const b = { cpu, gpu, board, ram, ssd, psu, case: pc, cooler: cool, igpu, checks, ...(lazyChecks ? { _slices: [bHead, ramChecks, bMid, m2, bPcie, ssdPcie, bTail] } : {}), total, totalHi: total - acc.requiredCents + acc.rangeCents[1], coreTotal: total - acc.requiredCents, accessories: acc, risk, core, benchmark };
            b.score = fastScoreBuild(b, scoreEnv, outerScore, checkCounts);
            builds.push(b);
            stats.completed++;
          }
        }
      }
    }
  }
  const retained = new Set([...cpus, ...gpus, ...boards.values()].flat().filter(Boolean).map(i => i.id));
  const auditById = new Map();
  for (const a of audit) if (!auditById.has(a.id)) auditById.set(a.id, a);
  const candidateLog = items.filter(i => ['CPU', 'GPU', 'MOTHERBOARD'].includes(i.category)).map(i => ({ id: i.id, name: i.name, category: i.category, priceCents: price(i), priceSource: i.priceSource ?? i.estimateBasis, priceObservedAt: i.priceRecord?.observedAt ?? i.priceObservedAt ?? null, retained: retained.has(i.id), exclusion: auditById.get(i.id) ?? (retained.has(i.id) ? null : { reason: 'platform-igpu-quality-or-model-filter' }) }));
  stats.componentRejections = { quality: diagnostics.quality, specification: diagnostics.specification, records: Object.values(diagnostics.records) };
  stats.rejectedTopK = audit.filter(a => a.reason === 'search-width-top-k').length;
  /**
   * 2.2.3：按给定配件重建一套整机（局部替换 / 降功耗方案用）。全量 evaluateBuild、附件成本、风险汇总、评分与枚举阶段完全一致。
   * overrides：{ psu, case, cooler, ram, ssd }（cooler 可为 'STOCK'）；w：工作负载（降功耗方案传 cpuPowerLimitWatts）。返回 null 表示有 FAIL。
   */
  function rebuild(b, overrides = {}, w = workload) {
    const parts = { cpu: b.cpu, gpu: b.gpu, board: b.board, ram: b.ram, ssd: b.ssd, psu: b.psu, case: b.case, cooler: b.cooler, ...overrides };
    const completer = completers[b.igpu];
    const evalW = { ...w, quiet };
    const checks = evaluateBuild({ CPU: parts.cpu, GPU: parts.gpu, MOTHERBOARD: parts.board, RAM: parts.ram, SSD: parts.ssd, PSU: parts.psu, CASE: parts.case, COOLER: parts.cooler === 'STOCK' ? null : parts.cooler },
      { igpu: b.igpu, stockCooler: parts.cooler === 'STOCK', workload: evalW });
    if (checks.some(c => c.status === FAIL)) return { failed: checks.filter(c => c.status === FAIL).map(c => c.id) };
    const acc = completer.accessories(parts.cpu, parts.board, parts.gpu, parts.psu, parts.case, parts.cooler, w);
    const core = price(parts.cpu) + price(parts.board) + (parts.gpu ? price(parts.gpu) : 0) + price(parts.ram) + price(parts.ssd) + price(parts.psu) + price(parts.case) + (parts.cooler === 'STOCK' ? 0 : price(parts.cooler));
    const st = countStats(checks);
    const risk = { physical: statusFromRank(st.physical), safety: statusFromRank(st.safety), blockingChecks: st.blockingIds, needsConfirmation: st.needsConfirmation };
    const nb = { ...b, ...parts, checks, _slices: undefined, total: core + acc.requiredCents, totalHi: core + acc.rangeCents[1], coreTotal: core, accessories: acc, risk };
    const env = w === workload ? scoreEnv : buildScoringEnv({ profile, refs, quiet, workload: w, profileKey: key });
    nb.score = fastScoreBuild(nb, env, precomputeOuterScore({ ...nb, baseChecks: checks }, env), { cond: st.cond, unknownCritical: st.unknownCritical, unknown: st.unknown });
    return nb;
  }

  /** 局部替换的候选池（按价格升序、规格可装）：电源 / 机箱 / 散热器 */
  const poolMemo = new Map();
  const memoPool = (k, fn) => { if (!poolMemo.has(k)) poolMemo.set(k, fn()); return poolMemo.get(k); };
  const repairPoolsRaw = {
    PSU: (b, w) => { const p = powerEstimate(b.cpu.specs, b.igpu ? null : b.gpu?.specs, { igpu: b.igpu, cpuPowerLimitWatts: w.cpuPowerLimitWatts }); const need = p.selectionMinimum; const floor = psuQualityFloor(p, need, quiet);
      return saneItems(items, 'PSU', i => String(Math.round((i.specs.ratedWatts ?? 0) / 100) * 100)).filter(i => i.specs.ratedWatts >= need && psuQuality(i.specs) >= floor && (b.igpu || !b.gpu || gpuPowerCheck(b.gpu.specs, i.specs).status !== FAIL)).sort((x, y) => price(x) - price(y)); },
    CASE: b => saneItems(items, 'CASE', () => 'all').filter(i => boardCaseStatus(b.board.specs, i.specs) === PASS && (b.igpu || !b.gpu?.specs.lengthMm || (i.specs.maxGpuLengthMm ?? 0) >= b.gpu.specs.lengthMm)).sort((x, y) => price(x) - price(y)),
    COOLER: b => ['STOCK', ...saneItems(items, 'COOLER', i => (i.specs.radiatorSizeMm ? `liquid:${i.specs.radiatorSizeMm}` : 'air'))].filter(c => (c === 'STOCK' ? stockCooler(b.cpu) : evaluateBuild({ CPU: { specs: { socket: b.cpu.specs.socket } }, COOLER: { specs: c.specs } }).find(x => x.id === 'coolerSocket')?.status === PASS)).sort((x, y) => (x === 'STOCK' ? 0 : price(x)) - (y === 'STOCK' ? 0 : price(y))),
  };

  const repairPools = {
    PSU: (b, w) => memoPool(`psu|${b.cpu.id}|${b.gpu?.id}|${b.igpu}|${w.cpuPowerLimitWatts ?? ''}`, () => repairPoolsRaw.PSU(b, w)),
    CASE: b => memoPool(`case|${boardFormat(b.board.specs.formFactor)}|${b.igpu ? 0 : b.gpu?.specs.lengthMm ?? 0}`, () => repairPoolsRaw.CASE(b)),
    COOLER: b => memoPool(`cooler|${b.cpu.id}`, () => repairPoolsRaw.COOLER(b)),
  };
  return { builds, profile, profileKey: key, stats, candidateLog, rebuild, repairPools };
}

const TIER_LABELS = { save: '省钱版', balanced: '推荐版', plus: '进阶版' };
const SLOT_LABEL = { CPU: 'CPU', GPU: '显卡', MOTHERBOARD: '主板', RAM: '内存', SSD: '硬盘', PSU: '电源', CASE: '机箱', COOLER: '散热' };

/** 每个配件“为什么选它” */
function reasonsFor(b, profile) {
  const r = {};
  const cg = b.cpu.performance?.gaming?.index; const cb = b.cpu.performance?.blender?.score;
  r.CPU = b.cpu.locked ? '已锁定' : profile.cpuMetric === 'gaming'
    ? (cg != null ? `游戏指数 ${cg}%（1080p，9850X3D = 100）` : '没有游戏指数，按其他条件比较（可信度较低）')
    : (cb != null ? `Blender 多核分 ${cb}` : '没有多核跑分，按其他条件比较（可信度较低）');
  if (b.gpu) {
    const g = b.gpu;
    r.GPU = g.locked ? '已锁定' : profile.gpuMetric === 'ai'
      ? `显存 ${g.specs.capacityGB}GB，NVIDIA（CUDA）${g.performance?.blender ? `，Blender 算力 ${Math.round(g.performance.blender.score)}` : ''}`
      : profile.gpuMetric === 'creator' ? `RTX，Blender 渲染分 ${Math.round(g.performance?.blender?.score ?? 0)}，显存 ${g.specs.capacityGB}GB`
        : g.performance?.gaming ? `2K 游戏指数 ${g.performance.gaming.index}%${g.performance.gaming.label ? `（${g.performance.gaming.label}）` : ''}` : '没有游戏指数（可信度较低）';
  }
  const bios = biosSupport(b.cpu.name, b.board.specs.chipset);
  r.MOTHERBOARD = b.board.locked ? '已锁定' : `${b.board.specs.chipset ?? ''}，${bios.status === PASS ? '原生支持这颗 CPU' : bios.status === CONDITIONAL ? '可能需要更新 BIOS' : 'BIOS 支持待核实'}${b.board.specs.vrmPhases ? `，供电 ${b.board.specs.vrmPhases} 相` : ''}${b.board.specs.pcieGen ? `，PCIe ${b.board.specs.pcieGen}.0` : ''}${b.board.specs.m2Slots != null ? `，${b.board.specs.m2Slots} 个 M.2` : ''}`;
  r.RAM = b.ram.locked ? '已锁定' : `${b.ram.specs.memoryType} ${b.ram.specs.capacityGB}GB${b.ram.specs.modules === 2 ? ' 双通道' : ''}${b.ram.specs.speedMTs ? ` ${b.ram.specs.speedMTs}MT/s` : ''}（用途建议 ${profile.ramGB}GB）`;
  r.SSD = b.ssd.locked ? '已锁定' : `${b.ssd.specs.capacityGB >= 1000 ? `${b.ssd.specs.capacityGB / 1000}TB` : `${b.ssd.specs.capacityGB}GB`}${b.ssd.specs.nand ? ` ${b.ssd.specs.nand}` : ''}${b.ssd.specs.dram === 'dram' ? '、有缓存' : b.ssd.specs.dram === 'hmb' ? '、HMB' : b.ssd.specs.dram === 'none' ? '、无缓存' : ''}`;
  const p = powerEstimate(b.cpu.specs, b.igpu ? null : b.gpu?.specs, { igpu: b.igpu });
  const gp = b.checks.find(c => c.id === 'gpuPower');
  r.PSU = b.psu.locked ? '已锁定' : `需要 ≥ ${p.selectionMinimum}W（计算需求 ${p.calculated ?? '未知'}W，厂商建议 ${p.manufacturer ?? '未提供'}W，采购下限 ${p.policyFloor}W），额定 ${b.psu.specs.ratedWatts}W${b.psu.specs.efficiency ? `，${b.psu.specs.efficiency}` : ''}${b.psu.specs.atxVersion ? `，ATX ${b.psu.specs.atxVersion}` : ''}${gp ? `；供电接口${gp.status === PASS ? '已确认' : gp.status === CONDITIONAL ? '需转接（见兼容性）' : '待核实'}` : ''}；满足品质下限里最便宜`;
  r.CASE = b.case.locked ? '已锁定（仍执行完整检查）' : `明确支持 ${supportedBoardFormats(b.case.specs).join('/')}，已检查已知物理冲突；按整机热负载证据、空间数据完整度及实际价格比较。${b.checks.find(c => c.id === 'caseAirflow')?.detail ?? ''}`;
  if (b.cooler !== 'STOCK') r.COOLER = b.cooler.locked ? '已锁定（仍执行持续散热检查）' : `高度只用于安装检查；${b.checks.find(c => c.id === 'cpuCooling')?.detail ?? '散热能力待核实'}`;
  return r;
}

const materializeChecks = b => (b.checks ??= b._slices.flat());

function toPlan(b, profile, workload = {}) {
  materializeChecks(b);
  const reasons = reasonsFor(b, profile);
  const picks = [['CPU', b.cpu], ['GPU', b.gpu], ['MOTHERBOARD', b.board], ['RAM', b.ram], ['SSD', b.ssd], ['PSU', b.psu], ['CASE', b.case], ['COOLER', b.cooler === 'STOCK' ? null : b.cooler]]
    .filter(([, item]) => item && !item.locked).map(([slot, item]) => ({ slot, item: slot === 'CPU' ? { ...item, specs: { ...item.specs, workload } } : item, reason: reasons[slot] }));
  return {
    picks, totalCents: b.total, coreTotalCents: b.coreTotal ?? b.total,
    // 2.2.2：additionalCosts 与完整总价使用同一份附件模型（accessories.mjs）
    additionalCosts: (b.accessories?.required ?? []).filter(r => r.priceCents > 0).map(r => ({ id: r.id, name: r.name, priceCents: r.priceCents, quantity: r.quantity,
      unitPriceCents: r.unitPriceCents, priceSource: r.priceSource, estimatedRangeCents: r.estimatedRangeCents, basis: r.basis })),
    costBreakdown: b.accessories ? costBreakdown(b.coreTotal ?? b.total, b.accessories) : null, ...(b.peripherals ? { peripherals: b.peripherals, hostTotalCents: b.hostTotal } : {}), igpu: b.igpu, stockCooler: b.cooler === 'STOCK', risk: b.risk,
    compatibility: { overall: overallStatus(b.checks), checks: b.checks },
    score: { ...b.score, version: SCORING_VERSION },
  };
}

/** 档位之间换了哪些配件、多花多少、评分变化 */
function diffNote(prev, cur, prevLabel) {
  const pairs = [['CPU', 'cpu'], ['GPU', 'gpu'], ['MOTHERBOARD', 'board'], ['RAM', 'ram'], ['SSD', 'ssd'], ['PSU', 'psu'], ['CASE', 'case'], ['COOLER', 'cooler']];
  const changed = pairs.filter(([, k]) => (prev[k]?.id ?? prev[k]) !== (cur[k]?.id ?? cur[k])).map(([slot, k]) => {
    const name = v => (v === 'STOCK' ? '原装散热' : v === null ? '核显' : v?.name ?? '—');
    return `${SLOT_LABEL[slot]} ${name(prev[k])} → ${name(cur[k])}`;
  });
  const extra = cur.total - prev.total;
  return `比${prevLabel}${extra >= 0 ? `多花 ${yuan(extra)}` : `省 ${yuan(-extra)}`}，综合评分 ${prev.score.total} → ${cur.score.total}${changed.length ? `：${changed.join('；')}` : ''}。`;
}

/**
 * 相邻两档的核心指标对比（2.2.1）：按实际配置逐项比较，下降的指标写出原值、新值、原因与换来的收益，
 * 以及是否低于用户最低要求。2.2.0 用固定模板“保留显卡核心指标与内存容量”，即使内存从 64GB 降到 32GB 也照写。
 */
export function tradeoffNotes(prev, cur, prevLabel, { minRamGB = 0, minVramGB = 0, minSsdGB = 0 } = {}) {
  const gb = v => (v >= 1000 ? `${+(v / 1000).toFixed(1)}TB` : `${v}GB`);
  const metrics = [
    ['显卡显存', b => b.gpu?.specs.capacityGB ?? 0, gb, minVramGB],
    ['显卡性能指标', b => b.core?.metric ?? null, v => String(Math.round(v)), 0],
    ['CPU 指标', b => b.core?.cpu ?? null, v => String(Math.round(v)), 0],
    ['内存容量', b => b.ram.specs.capacityGB ?? 0, gb, minRamGB],
    ['硬盘容量', b => b.ssd.specs.capacityGB ?? 0, gb, minSsdGB],
  ];
  const ups = []; const downs = [];
  for (const [label, get, fmt, min] of metrics) {
    const a = get(prev); const c = get(cur);
    if (a == null || c == null || a === c) continue;
    (c > a ? ups : downs).push({ label, from: fmt(a), to: fmt(c), belowMinimum: min > 0 && c < min * 0.93, min: min ? fmt(min) : null });
  }
  const extra = cur.total - prev.total;
  const notes = [];
  if (!downs.length) notes.push(`与${prevLabel}相比，核心指标没有下降${ups.length ? `；提升：${ups.map(u => `${u.label} ${u.from} → ${u.to}`).join('、')}` : ''}。`);
  else {
    const gain = ups.length ? `换来 ${ups.map(u => `${u.label} ${u.from} → ${u.to}`).join('、')}` : `综合评分 ${prev.score.total} → ${cur.score.total}`;
    for (const d of downs) notes.push(`${d.label}比${prevLabel}低：${d.from} → ${d.to}。原因：按所选策略在本档预算内整机取舍，${gain}${extra ? `，总价${extra > 0 ? '多' : '少'} ${yuan(Math.abs(extra))}` : ''}。${d.belowMinimum ? `低于用途最低要求 ${d.min}。` : d.min ? `仍满足最低要求 ${d.min}。` : ''}`);
  }
  return { notes, downs, ups };
}

/**
 * CPU 散热证据不足时的降功耗运行方案（2.2.3）：按证据覆盖的功率重新校核散热、整机热负载与电源，并写明 BIOS 设置与未量化的性能影响。
 * 只作为可选方案，不替代主方案，也不把满功耗性能当作降功耗后的确定结果。
 */
function powerLimitPlan(b, rebuild, workload, profile) {
  const cool = b.checks.find(c => c.id === 'cpuCooling');
  const target = cool?.evidence?.powerLimitOptionW;
  if (!cool?.blocking || !target) return null;
  const w = { ...workload, cpuPowerLimitWatts: target };
  const v = rebuild(b, {}, w);
  if (!v || v.failed) return { targetW: target, feasible: false, reason: v?.failed ? `降功耗后仍不兼容：${v.failed.join(',')}` : '无法重建' };
  const intel = /INTEL|酷睿|CORE|ULTRA/i.test(b.cpu.name);
  const gpuW = b.igpu ? 0 : gpuPowerWatts(b.gpu?.specs) ?? 0;
  const psu = powerEstimate(b.cpu.specs, b.igpu ? null : b.gpu?.specs, { igpu: b.igpu, cpuPowerLimitWatts: target });
  return {
    targetW: target, fullPowerW: b.cpu.specs.maxPowerWatts ?? null, feasible: true,
    biosSettings: intel ? [`Long Duration Power Limit（PL1）= ${target}W`, `Short Duration Power Limit（PL2）= ${target}W`, '关闭主板“不限功耗 / 多核增强”类默认设置', '更新 BIOS 或清 CMOS 后重新确认']
      : [`PPT = ${target}W（关闭 PBO 或使用 Eco Mode）`, 'TDC / EDC 保持主板默认或按 PPT 比例下调', '更新 BIOS 或清 CMOS 后重新确认'],
    affectedMetrics: profile.cpuMetric === 'gaming' ? ['持续多核负载性能（游戏通常受影响较小，未实测）'] : ['持续多核性能（渲染、编码、编译时间）', '当前评分使用的 Blender 多核分（满功耗数据）'],
    performanceDelta: null,
    performanceNote: '目录没有该 CPU 在此功耗下的性能数据，降幅未量化；方案评分仍为满功耗数据，不能作为降功耗后的确定结果。',
    thermalLoadW: { cpu: target, gpu: gpuW, total: target + gpuW },
    psuRequirement: { calculated: psu.calculated, selectionMinimum: psu.selectionMinimum, ratedWatts: b.psu.specs.ratedWatts },
    blockingAfter: v.risk.blockingChecks, coolingAfter: v.checks.find(c => c.id === 'cpuCooling')?.status ?? null,
    remainingConditions: ['持续满载温度与噪音仍需实测', '功耗限制须实际在 BIOS 生效（用监控软件确认封装功耗）', ...v.risk.blockingChecks.filter(id => id !== 'cpuCooling').map(id => `仍需核实：${v.checks.find(c => c.id === id)?.label ?? id}`)],
  };
}

/**
 * 三档方案。返回结构与原 recommendPlans 一致（picks / totalCents / notes / compatibility / budget …），另加 score 与升级说明。
 * maxOverPercent：null 不限（尽量不超本档目标，放不下时取最便宜的可行配置并标出）；0 严格；其他为允许超出的比例。
 */
export function optimizePlans(allItems, { budgetCents, scenarios = [], maxOverPercent = null, tierRatios = { save: .8, balanced: 1, plus: 1.2 }, locked = {}, workload: workloadInput = {}, peripherals = [], strategy = 'balanced', allowUsed = false, allowModified = false, accessoryPricing = {} }) {
  if (!STRATEGIES.includes(strategy)) throw new Error('未知推荐策略');
  // 商品状态过滤（2.2.1）：默认只用全新商品；二手 / 翻新需 allowUsed，改装 / 工程样品需 allowModified，状态未知（规格存疑）不进自动推荐
  const statusOf = i => i.productStatus ?? productStatus(i).status;
  const excludedByStatus = allItems.filter(i => !statusAllowed(statusOf(i), { allowUsed, allowModified }));
  const items = excludedByStatus.length ? allItems.filter(i => statusAllowed(statusOf(i), { allowUsed, allowModified })) : allItems;
  const started = performance.now();
  const generatedAt = new Date().toISOString();
  // 数据快照 ID：参与推荐的配件 ID、价格与关键规格的哈希（同一目录、同一价格得到同一 ID）
  const dataSnapshotId = createHash('sha256').update(items.map(i => `${i.id}:${price(i)}:${i.specs?.maxPowerWatts ?? ''}:${i.specs?.ratedWatts ?? ''}`).join('|')).digest('hex').slice(0, 16);
  const key = profileKey(scenarios);
  const workload = { ...validateWorkload(workloadInput, key), quiet: scenarios.includes('quiet') };
  const office = key === 'office';
  const gaming = ['2k', '4k', '1080p'].includes(key);
  const tiers = Object.entries(tierRatios).map(([id, ratio]) => {
    const target = Math.round(budgetCents * ratio / 10000) * 10000;
    return { id, label: TIER_LABELS[id] ?? id, target, limit: maxOverPercent == null ? Infinity : Math.floor(target * (1 + maxOverPercent / 100)) };
  });
  const maxTarget = Math.max(...tiers.map(t => t.target));
  // 剪枝上限放宽到最高目标的 1.6 倍（至少 ¥6,000）：严格预算时也要找到“最低可行配置”，才能告诉用户差多少
  const maxCost = Math.max(maxTarget * 1.6, 600000, ...tiers.map(t => (Number.isFinite(t.limit) ? t.limit : 0)));
  const { builds: baseBuilds, profile, stats, candidateLog, rebuild, repairPools } = enumerateBuilds(items, { scenarios, locked, maxCostCents: maxCost, igpuOnly: office, allowIgpu: gaming && budgetCents < 500000, workload, lazyChecks: true, accessoryPricing });

  const plans = [];
  const tierSearch = new Map();
  const tierTradeoffs = new Map();
  let prevBuild = null; let prevTier = null;
  const peripheralMemo = new Map();
  for (const t of tiers) {
    const builds = !peripherals.length ? baseBuilds : baseBuilds.map(b => {
      const key = `${t.id}|${b.gpu?.id}|${b.igpu}`;
      if (!peripheralMemo.has(key)) peripheralMemo.set(key, recommendPeripherals(items, { scenarios, tier: t.id, igpu: b.igpu, slots: peripherals, gpuIndex: b.gpu?.performance?.gaming?.index ?? null }));
      const extra = peripheralMemo.get(key);
      return { ...b, hostTotal: b.total, total: b.total + extra.totalCents, totalHi: (b.totalHi ?? b.total) + extra.totalCents, peripherals: extra };
    }).filter(b => b.peripherals.picks.length === new Set(peripherals).size);
    const cheapest = builds.reduce((m, b) => (!m || b.total < m.total ? b : m), null);

    // 2.2.3：严格预算按含附件区间上限判断（必要成本未知 / 估算时不能无条件算预算满足）
    const strict = maxOverPercent === 0;
    const budgetTotal = b => (strict ? b.totalHi ?? b.total : b.total);
    const within = builds.filter(b => budgetTotal(b) <= Math.min(t.limit, t.target));
    const search = { all: Map.groupBy(builds, b => b.gpu?.id), within: Map.groupBy(within, b => b.gpu?.id) };
    tierSearch.set(t.id, search);
    let pool = within;
    // 不限模式下本档目标内没有可行配置时，退到允许范围内最便宜的（会标出超出多少）
    if (!pool.length && Number.isFinite(t.limit)) pool = builds.filter(b => budgetTotal(b) <= t.limit);
    if (!pool.length && !Number.isFinite(t.limit) && cheapest) pool = [cheapest];
    const budget = b => ({ inputCents: budgetCents, targetCents: t.target, limitCents: Number.isFinite(t.limit) ? t.limit : null,
      overTargetCents: b ? b.total - t.target : null, overInputCents: b ? b.total - budgetCents : null });
    // 用途最低要求：本档有满足的组合就只在这些里挑；都不满足时用最好的并说明
    const req = MIN_REQUIREMENTS[key] ?? {};
    const minVram = Math.max(req.vramGB ?? 0, workload.minVramGB ?? 0);
    const minSsd = workload.minSsdGB ?? req.ssdGB ?? 0;
    const unmet = b => [
      req.gpuGaming && !b.igpu && (b.gpu?.performance?.gaming?.index ?? 0) < req.gpuGaming && `显卡 2K 游戏指数 ≥ ${req.gpuGaming}`,
      req.gpuGaming && b.igpu && `需要独立显卡`,
      req.discreteGpu && b.igpu && '需要独立显卡（具体游戏目标帧率须实测）',
      minVram > (b.gpu?.specs.capacityGB ?? 0) && `显存 ≥ ${minVram}GB`,
      req.ramGB && (b.ram.specs.capacityGB ?? 0) < req.ramGB(t.target) && `内存 ≥ ${req.ramGB(t.target)}GB`,
      minSsd && (b.ssd.specs.capacityGB ?? 0) < minSsd * 0.93 && `硬盘 ≥ ${minSsd >= 1000 ? `${minSsd / 1000}TB` : `${minSsd}GB`}`,
      workload.targetFps && b.benchmark?.unit === 'fps-average' && b.benchmark.value < workload.targetFps && `同测试组平均 FPS ≥ ${workload.targetFps}`,
    ].filter(Boolean);
    if (!pool.length) {
      const reasons = [];
      if (!builds.length) reasons.push(stats.candidates.cpu === 0 || stats.candidates.gpu === 0
        ? '目录里没有满足用途要求的 CPU 或显卡（如 AI 需要 RTX 30 系及以后的 NVIDIA 显卡）。'
        : '当前有界搜索未找到可配齐的组合。查看各项淘汰原因与锁定配件检查。');
      if (peripherals.length && !builds.length) reasons.push('所选外设无法配齐，或主机加外设总预算不足。');
      if (cheapest) reasons.push(maxOverPercent === 0
        ? `严格预算：当前有界搜索在本档 ${yuan(t.target)} 内未找到完整配置。此次搜索的最低完整候选约 ${yuan(cheapest.total)}。`
        : `允许超出 ${maxOverPercent}%（最多 ${yuan(t.limit)}）。当前有界搜索未找到限额内完整配置。搜索内最低候选约 ${yuan(cheapest.total)}。`);
      const lockedConflict = !builds.length && Object.keys(locked).length ? lockedConflictReason(locked) : null;
      const failureKind = lockedConflict ? 'confirmed-conflict' : cheapest ? 'budget-within-bounded-search' : 'no-combination-in-bounded-search';
      if (lockedConflict) reasons.unshift(lockedConflict);
      plans.push({ id: t.id, label: t.label, targetCents: t.target, budget: budget(null), infeasible: true, reasons,
        partialPicks: SLOTS.map(slot => items.filter(i => i.category === slot && candidateLog.some(c => c.id === i.id && c.retained) && price(i) <= t.target).sort((a, b) => price(a) - price(b))[0]).filter(Boolean).map(item => ({ slot: item.category, item, reason: '仅为不完整配置的候选线索，不是可行推荐' })),
        recommendationStatus: 'infeasible', formalRecommendation: false, failureKind, alternative: cheapest ? { ...toPlan(cheapest, profile, workload), recommendationStatus: 'over_budget_alternative', targetCents: t.target, unmetRequirements: unmet(cheapest),
          assessment: { budget: 'over', requirements: unmet(cheapest).length ? 'unmet' : 'unverified',
            physical: cheapest.risk.physical, safety: cheapest.risk.safety, confidence: cheapest.score.confidence,
            needsConfirmation: true, blockingChecks: cheapest.risk.blockingChecks } } : null,
        minFeasibleCents: cheapest?.total ?? null,
        suggestions: [
          cheapest && `把预算提高到约 ${yuan(Math.ceil(cheapest.total / (tierRatios[t.id] ?? 1) / 10000) * 10000)}（这一档的目标预算就能覆盖）`,
          maxOverPercent === 0 && '关闭严格预算，或允许超出一定比例',
          scenarios.includes('quiet') && '关闭“安静优先”（它要求更好的散热和电源）',
          Object.keys(locked).length && '解锁部分配件，让推荐重新挑',
        ].filter(Boolean),
        picks: [], totalCents: 0, notes: [], igpu: office, stockCooler: false, compatibility: null, score: null });
      continue;
    }
    // 游戏用途：有独显能放下时不考虑核显
    if (gaming && pool.some(b => !b.igpu)) pool = pool.filter(b => !b.igpu);
    const meeting = pool.filter(b => unmet(b).length === 0);

    if (meeting.length) pool = meeting;
    else {
      // Bottleneck first: minimizing demand shortfall precedes optional CPU,
      // RAM or board luxuries, rather than hiding the missing core experience.
      const deficit = b => (req.gpuGaming ? Math.max(0, 1 - (b.gpu?.performance?.gaming?.index ?? 0) / req.gpuGaming) * 3 : 0)
        + (minVram ? Math.max(0, 1 - (b.gpu?.specs.capacityGB ?? 0) / minVram) * 3 : 0)
        + (req.ramGB ? Math.max(0, 1 - b.ram.specs.capacityGB / req.ramGB(t.target)) : 0) + (req.discreteGpu && b.igpu ? 3 : 0)
        + (minSsd ? Math.max(0, 1 - (b.ssd.specs.capacityGB ?? 0) / (minSsd * 0.93)) * 0.5 : 0);
      const minDeficit = Math.min(...pool.map(deficit));
      pool = pool.filter(b => deficit(b) <= minDeficit + .000001);
    }
    search.requirements = Map.groupBy(pool, b => b.gpu?.id);
    const comparable = pool.filter(b => b.benchmark);
    if (comparable.length) pool = comparable;
    search.benchmark = comparable.length ? Map.groupBy(pool, b => b.gpu?.id) : search.requirements;
    // 2.2.1：取消“有无阻断项的组合就只在无阻断项里选”的硬过滤。2.2.0 中机箱缺少显卡高度 / 厚度 / 电源长度等
    // 字段（覆盖率 0%），显卡 ≥250W 的整机全部带阻断项，被一律剔除，高预算只能选到 5060 Ti / RX 9070。
    // FAIL 仍在枚举阶段排除；阻断性的待核实项在评分可信度分项按项扣分，并在方案状态里标为“需核实”。
    search.safety = search.benchmark;
    const requirementPool = pool; // 跨档不回退过滤之前的候选：安全备选从这里选（不受“不低于上一档显存”的限制）
    if (prevBuild && prevBuild.total <= Math.min(t.limit, t.target)) {
      // 2.2.3：性能优先策略的目标是整机核心性能（CPU + 显卡），跨档不回退按 core.value 判断；其他策略仍要求显卡指标不回退。
      // 原规则只比显卡指标：省钱档选了显卡更强、CPU 更弱的组合后，更高档会排除核心性能更高但显卡指标略低的组合。
      const coreOk = b => (strategy === 'performance' ? (b.core.value ?? 0) >= (prevBuild.core.value ?? 0) - CORE_EPSILON : (b.core.metric ?? 0) >= (prevBuild.core.metric ?? 0));
      const noRegression = b => (b.benchmark?.id !== prevBuild.benchmark?.id || coreOk(b))
        && (profile.gpuMetric !== 'ai' || b.core.vram >= prevBuild.core.vram)
        && (profile.gpuMetric !== 'creator' || b.ram.specs.capacityGB >= prevBuild.ram.specs.capacityGB);
      const nonregressing = pool.filter(noRegression);
      if (nonregressing.length && workload.task !== 'blender') pool = nonregressing;
    }
    let best = selectBuild(pool, strategy, t.id, t.target);
    search.final = Map.groupBy(pool, b => b.gpu?.id);
    // 2.2.3：关键风险驱动的局部替换——保留 CPU / 显卡，替换电源 / 机箱 / 散热器并全量重新校核
    materializeChecks(best);
    const tierLimit = Math.max(Math.min(t.limit, t.target), budgetTotal(best));
    const repaired = repairRisks(best, { rebuild, repairPools, workload, locked, budgetLimit: tierLimit, budgetOf: budgetTotal });
    const riskSearch = repaired.log;
    if (repaired.build !== best) { materializeChecks(repaired.build); best = repaired.build; }
    // 安全优先：仍有阻断项时，若候选池里有无阻断项、核心性能相差 ≤3% 的组合，按策略在其中选（安全条件先于最终性能排序，不大幅降档）
    let safeAlternative = null;
    if (best.risk.blockingChecks.length) {
      const coreOf = b => b.core?.value ?? 0;
      // 性能优先策略只容许策略自身的核心性能并列误差；其余策略容许 3%
      const tol = strategy === 'performance' ? CORE_EPSILON : Math.abs(coreOf(best)) * 0.03;
      const gpuOf = b => b.core?.metric ?? null;
      // 核心性能（含 CPU）相差在容差内，且显卡指标不低于原方案 97%（不靠升级 CPU 掩盖显卡降档）
      const nearEqual = pool.filter(b => !b.risk.blockingChecks.length && coreOf(b) >= coreOf(best) - tol && (gpuOf(best) == null || (gpuOf(b) ?? 0) >= gpuOf(best) * 0.97));
      const safe = requirementPool.filter(b => !b.risk.blockingChecks.length);
      if (nearEqual.length) {
        const pick = selectBuild(nearEqual, strategy, t.id, t.target);
        const pl = powerLimitPlan(best, rebuild, workload, profile);
        if (pl) riskSearch.initialPowerLimitOption = pl;
        riskSearch.safetyFirst = { from: riskSearch.final ?? riskSearch.initial, toTotalCents: pick.total, coreChangePercent: coreOf(best) ? +((coreOf(pick) / coreOf(best) - 1) * 100).toFixed(2) : 0, reason: '存在无阻断项、核心性能相差 ≤3% 的组合，按安全优先采用' };
        best = pick; materializeChecks(best);
      } else if (safe.length) {
        safeAlternative = selectBuild(safe, strategy, t.id, t.target); materializeChecks(safeAlternative);
      }
    }
    search.winner = best;
    const notes = [];
    let sameAs;
    // 分别搜索各档，只有独立选出的结果相同才复用提示。
    const sameParts = prevBuild && SLOTS.every(s => {
      const map = { CPU: 'cpu', GPU: 'gpu', MOTHERBOARD: 'board', RAM: 'ram', SSD: 'ssd', PSU: 'psu', CASE: 'case', COOLER: 'cooler' };
      return (prevBuild[map[s]]?.id ?? prevBuild[map[s]]) === (best[map[s]]?.id ?? best[map[s]]);
    });
    if (sameParts && best.total === prevBuild.total) {
      notes.push(`与${prevTier.label}配置相同。本档按所选策略评估了预算内候选。`);
      sameAs = prevTier.id;
    } else if (prevBuild) {
      notes.push(diffNote(prevBuild, best, prevTier.label));
      const absolute = best.score.total - prevBuild.score.total;
      const relative = prevBuild.score.total > 0 ? absolute / prevBuild.score.total * 100 : 0;
      notes.push(`升级价值：评分代理绝对变化 ${absolute.toFixed(1)}、相对变化 ${relative.toFixed(1)}%；额外成本 ${yuan(best.total - prevBuild.total)}。`);
      const tradeoff = tradeoffNotes(prevBuild, best, prevTier.label, { minRamGB: req.ramGB?.(t.target) ?? 0, minVramGB: minVram, minSsdGB: minSsd });
      notes.push(...tradeoff.notes);
      tierTradeoffs.set(t.id, tradeoff);
    }
    const cb = best.accessories;
    if (cb?.required.length) notes.push(`完整可安装总价 ${yuan(best.total)} = 核心八件套 ${yuan(best.coreTotal)} + 必需附件 ${yuan(cb.requiredCents)}（${cb.required.map(r => `${r.name} ×${r.quantity}${r.priceSource === 'estimate' ? `，按估算上限 ${yuan(r.unitPriceCents)}/个` : ''}`).join('；')}）${cb.priceStatus !== 'known' ? `；附件含估算，完整总价区间 ${yuan(best.coreTotal + cb.rangeCents[0])}–${yuan(best.coreTotal + cb.rangeCents[1])}` : ''}。`);
    if (best.total > t.target) notes.push(`当前有界搜索在本档目标 ${yuan(t.target)} 内未找到完整组合。本次搜索所得最低价替代超出 ${yuan(best.total - t.target)}。`);
    if (unmet(best).length) notes.push(`这个价位达不到${profile.label}的最低要求（${unmet(best).join('、')}），${best.total > t.target ? '此替代同时超预算。' : '当前预算内候选未达到使用要求。'}`);
    const upgrades = strongerOptions(within.filter(b => b.benchmark?.id === best.benchmark?.id && !unmet(b).length), best);
    if (upgrades.length) notes.push(`预算内还有 ${upgrades.length} 个核心性能升级选项。当前方案由 ${strategy === 'performance' ? '性能优先' : strategy === 'value' ? '性价比优先' : '均衡推荐'}策略选出。`);
    const powerLimit = powerLimitPlan(best, rebuild, workload, profile);
    if (riskSearch.result !== 'none') notes.push(riskSearch.result === 'resolved' ? `局部替换消除了全部关键风险：${riskSearch.replacements.map(r => `${r.from} → ${r.to}`).join('；')}。` : riskSearch.result === 'reduced' ? `局部替换减少了关键风险（剩余 ${riskSearch.final.blockingChecks.join('、')}）：${riskSearch.replacements.map(r => `${r.from} → ${r.to}`).join('；')}。` : `关键风险局部替换：${riskSearch.reason ?? '没有可用替代'}。`);
    if (riskSearch.safetyFirst) notes.push(`安全优先：${riskSearch.safetyFirst.reason}（核心性能变化 ${riskSearch.safetyFirst.coreChangePercent}%）。`);
    if (safeAlternative) notes.push(`另有无阻断项的独立备选（${yuan(safeAlternative.total)}），核心性能较低，见 safeAlternative；主方案为待核实方案，不是已确认推荐。`);
    if (powerLimit?.feasible) notes.push(`CPU 散热证据不足：可按 ${powerLimit.targetW}W 降功耗运行（BIOS 设置见 powerLimitOption），性能降幅未量化。`);
    const plan = toPlan(best, profile, workload);
    const cpuPerfMissing = cpuMetric(profile)(best.cpu) == null;
    if (cpuPerfMissing) notes.push(`CPU（${best.cpu.name}）缺少${profile.cpuMetric === 'gaming' ? '游戏指数' : '多核跑分'}，作为低预算兜底候选入选；性能无法比较，需核实是否满足使用需求。`);
    const scenarioEvidenceMissing = ((workload.targetFps || workload.benchmarkId || ['4k', 'ai', 'creator'].includes(key)) && !best.benchmark) || cpuPerfMissing;
    const recommendationStatus = best.total > t.target ? 'over_budget_alternative' : unmet(best).length ? 'degraded' : plan.compatibility.overall === UNKNOWN || scenarioEvidenceMissing ? 'verification_required' : plan.compatibility.overall === CONDITIONAL ? 'conditional' : 'feasible';
    notes.push(`性能依据：${plan.score.performanceBasis}；可信度 ${plan.score.confidence}，只可在相同场景与评分版本内比较。`);
    if (best.benchmark) notes.push(`指定测试组 ${best.benchmark.title ?? best.benchmark.game ?? best.benchmark.id}，${best.benchmark.value} ${best.benchmark.unit}。测试条件 ${best.benchmark.conditions}。来源 ${best.benchmark.sourceUrl}`);
    else if (workload.targetFps) notes.push(`${workload.game || '所选游戏'} / ${workload.quality || '未指定画质'}目标 ${workload.targetFps} FPS 缺少匹配测试组，结果待核实。`);
    plans.push({ id: t.id, label: t.label, targetCents: t.target, budget: budget(best), budgetCents: t.target, lockedCents: Object.values(locked).reduce((sum, p) => sum + (p.priceCents ?? 0), 0),
      ...plan, strategy, corePerformance: best.checks.find(c => c.id === 'cpuCooling')?.blocking ? { ...best.core, conditional: 'CPU 散热证据不足：满功耗性能以散热满足为前提，未确认' } : best.core, tradeoffs: tierTradeoffs.get(t.id) ?? null,
      // 2.2.2：预算按含必需附件的完整总价判断；附件价格为估算 / 未知时不标为无条件满足
      assessment: { budget: best.total > t.target ? 'over' : best.accessories?.priceStatus === 'known' || !best.accessories?.required.length ? 'met' : best.accessories.priceStatus === 'unknown' ? 'pending_accessory_price' : 'met_with_estimated_accessories', requirements: unmet(best).length ? 'unmet' : scenarioEvidenceMissing ? 'unverified' : 'met',
        physical: best.risk.physical, safety: best.risk.safety, confidence: plan.score.confidence,
        needsConfirmation: best.risk.needsConfirmation || Boolean(scenarioEvidenceMissing), blockingChecks: best.risk.blockingChecks },
      riskSearch,
      ...(safeAlternative ? { safeAlternative: { ...toPlan(safeAlternative, profile, workload), corePerformance: safeAlternative.core,
        coreChangePercent: best.core?.value ? +((safeAlternative.core.value / best.core.value - 1) * 100).toFixed(1) : null, extraCents: safeAlternative.total - best.total,
        reason: '没有阻断性待核实项的独立备选（核心性能更低，按所选策略在无阻断项组合中选出）；主方案仍需核实关键风险' } } : {}),
      ...(powerLimit ? { powerLimitOption: powerLimit } : {}),
      diagnostics: { generatedAt, softwareVersion: SOFTWARE_VERSION, rulesVersion: SCORING_VERSION, dataSnapshotId, strategy,
        constraints: { budgetCents, tierTargetCents: t.target, tierLimitCents: Number.isFinite(t.limit) ? t.limit : null, scenarios, maxOverPercent, workload, locked: Object.fromEntries(Object.entries(locked).map(([k, v]) => [k, v.name ?? v.id ?? true])), peripherals, allowUsed, allowModified, accessoryPricing },
        risks: best.checks.filter(c => c.blocking || (c.critical && c.status !== PASS && c.status !== NOT_APPLICABLE)).map(c => ({ id: c.id, label: c.label, status: c.status, blocking: c.blocking, severity: c.severity, detail: c.detail })),
        scoreDimensions: best.score.dimensions, performanceBasis: best.score.performanceBasis, performanceIsProxy: !best.benchmark, confidence: best.score.confidence,
        upgradeCandidates: upgrades.length, cpuPerformanceAssumption: best.checks.find(c => c.id === 'cpuCooling')?.blocking ? 'full-power-unverified' : 'full-power' },
      upgrades: upgrades.map(b => ({ ...toPlan(b, profile, workload), id: t.id, label: t.label, targetCents: t.target, corePerformance: b.core,
        extraCents: b.total - best.total, reason: b.risk.blockingChecks.length
          ? `性能指标更高，仍需核实 ${b.risk.blockingChecks.length} 项关键风险` : '性能指标更高，当前策略更重视成本与整机搭配' })),
      ...(sameAs ? { sameAs } : {}),
      recommendationStatus, formalRecommendation: recommendationStatus === 'feasible', unmetRequirements: unmet(best), requirementsEvidence: scenarioEvidenceMissing ? 'UNKNOWN' : 'PROXY_OR_MEASURED', workload,
      notes: [...notes, ...(plan.igpu ? ['核显方案：不配独立显卡，用 CPU 自带核显。'] : []),
        `价格为参考价估算，不是报价。综合评分按“${profile.label}”的权重计算（${SCORING_VERSION}），只用于在候选之间比较，不代表实际帧数或 AI 吞吐。`] });
    prevBuild = best; prevTier = t;
  }
  const gpuAlternatives = [...Map.groupBy(baseBuilds.filter(b => b.gpu), b => b.gpu.id)].map(([id, bs]) => {
    const top = bs.reduce((a, b) => a.score.total > b.score.total ? a : b);
    const selectedBy = plans.filter(p => tierSearch.get(p.id).winner?.gpu?.id === id).map(p => p.id);
    return { id, name: top.gpu.name, gpuPriceCents: price(top.gpu), minimumBuildCents: Math.min(...bs.map(b => b.total)), bestScore: top.score, corePerformance: top.core, blockers: top.risk.blockingChecks, selectedBy, reason: selectedBy.length ? '入选指定档位' : '逐档淘汰依据见 tierDecisions', tierDecisions: plans.map(p => {
      const stage = tierSearch.get(p.id);
      const complete = stage.all.get(id) ?? [];
      const fitting = stage.within.get(id) ?? [];
      const objective = b => selectionValue(b, strategy, p.id, p.targetCents);
      const alternative = fitting.reduce((m, b) => !m || objective(b) > objective(m) ? b : m, null);
      const finalists = stage.final?.get(id) ?? [];
      const finalBest = finalists.length ? selectBuild(finalists, strategy, p.id, p.targetCents) : null;
      const counts = { requirements: stage.requirements?.get(id)?.length ?? 0, comparable: stage.benchmark?.get(id)?.length ?? 0,
        safety: stage.safety?.get(id)?.length ?? 0, final: finalists.length };
      const reason = selectedBy.includes(p.id) ? (fitting.length ? '已入选' : '已入选为超预算替代')
        : !complete.length ? '未形成含所选外设的完整组合'
          : !fitting.length ? `搜索内最低完整成本 ${yuan(Math.min(...complete.map(b => b.total)))} 超过本档目标`
            : !counts.requirements ? '用途门槛或需求缺口排序排除'
              : !counts.comparable ? '缺少指定条件的同组性能实测'
                : !counts.safety ? '当前策略优先采用没有关键待核实项的组合'
                  : !counts.final ? '跨档核心指标和容量下限排除'
                    : '进入最终排序，当前策略的目标值或并列取舍未胜出';
      return { tier: p.id, targetCents: p.targetCents, withinBudget: fitting.length, counts,
        bestWithinBudget: alternative ? { totalCents: alternative.total, score: alternative.score, core: alternative.core,
          blockingChecks: alternative.risk.blockingChecks, objective: objective(alternative) } : null,
        finalistObjective: finalBest ? objective(finalBest) : null, winnerObjective: stage.winner ? objective(stage.winner) : null,
        selectedGpu: stage.winner?.gpu?.id ?? null, reason };
    }) };
  });
  return { plans, meta: { generatedAt, softwareVersion: SOFTWARE_VERSION, dataSnapshotId, profile: key, workload, strategy, stats, candidateLog, gpuAlternatives,
    productStatusFilter: { allowUsed, allowModified, excluded: excludedByStatus.filter(i => ['CPU', 'GPU'].includes(i.category)).map(i => ({ id: i.id, name: i.name, status: statusOf(i), reason: i.productStatusReason ?? productStatus(i).reason })) }, elapsedMs: Math.round(performance.now() - started), scoringVersion: SCORING_VERSION, exportedAt: new Date().toISOString() } };
}

/** 锁定配件之间确认不兼容时说明是哪一项 */
function lockedConflictReason(locked) {
  const parts = Object.fromEntries(SLOTS.map(slot => [slot, locked[slot] && !locked[slot].igpu ? { name: locked[slot].name ?? '', specs: locked[slot].specs ?? {} } : null]));
  const fails = evaluateBuild(parts, { igpu: !!locked.GPU?.igpu }).filter(c => c.status === FAIL);
  return fails.length ? `锁定的配件之间不兼容：${fails.map(c => `${c.label}（${c.detail}）`).join('；')}` : null;
}
