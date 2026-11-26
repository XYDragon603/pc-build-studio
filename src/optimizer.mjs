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
import { biosSupport, cpuHasIgpu, CONDITIONAL, evaluateBuild, FAIL, gpuPowerCheck, overallStatus, PASS, powerEstimate, UNKNOWN } from './compat-rules.mjs';
import { cpuKey } from './perfkeys.mjs';
import { CPU_BALANCE, LEGACY_TRUST_PENALTY, MIN_REQUIREMENTS, QUIET_NOISE_WEIGHT, SCORING_PROFILES, SCORING_VERSION } from './scoring-profiles.mjs';
import { boardCaseStatus, coolerSizeClass, coolingClassFor, supportedBoardFormats, sustainedPower, stockCooler } from './hardware-specs.mjs';
import { riskSummary } from './compat-rules.mjs';
import { validateWorkload, workloadProfile } from './workloads.mjs';
import { STRATEGIES, corePerformance, selectionValue, selectBuild, strongerOptions } from './recommendation-strategy.mjs';
import { matchingBenchmark } from './scenario-performance.mjs';
import { recommendPeripherals } from './peripherals.mjs';
import { productStatus, statusAllowed } from './product-status.mjs';

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
  return list.filter(i => { const g = groups.get(bucket(i)); return g.length < 3 || price(i) >= median(g) * 0.5; });
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
    return sockets.flatMap(socket => paretoByPrice(measured.filter(i => i.specs.socket === socket), metric, 6, audit));
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
  if (spec.nand === 'TLC' || spec.nand === 'MLC') q += 0.25; else if (spec.nand === 'QLC') q -= 0.1;
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

function makeCompleter(items, { igpu, quiet, locked, workload = {}, diagnostics }) {
  const psus = saneItems(items, 'PSU', i => String(Math.round((i.specs.ratedWatts ?? 0) / 100) * 100)).filter(i => i.specs.ratedWatts);
  const coolers = saneItems(items, 'COOLER', i => (i.specs.radiatorSizeMm ? `liquid:${i.specs.radiatorSizeMm}` : 'air'));
  const cases = saneItems(items, 'CASE', () => 'all').filter(i => i.specs.maxGpuLengthMm);
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
        return { item: i, rank, q: psuQuality(i.specs) };
      }).filter(x => { if (x.rank >= 9) rejected(x.item, 'specification', '电源接口、额定功率或 12V 检查失败'); return x.rank < 9; });
      if (!graded.length) return null;
      const load = p.load ?? need / 1.25;
      const floor = (load > 500 ? 0.55 : load > 300 ? 0.4 : 0.15) + (quiet ? 0.12 : 0);
      for (const x of graded.filter(x => x.q < floor)) rejected(x.item, 'quality', `供电品质 ${x.q.toFixed(2)} 低于当前负载下限 ${floor.toFixed(2)}`);
      const eligible = graded.filter(x => x.q >= floor);
      if (!eligible.length) return null;
      const bestRank = Math.min(...eligible.map(x => x.rank));
      return eligible.filter(x => x.rank === bestRank).sort((a, b) => price(a.item) - price(b.item))[0].item;
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
      // 证据等级：同平台持续实测 0 > 有来源的厂商标称 1 > 无 2。
      // 2.2.1：证据等级只在价格相同时区分。2.2.0 先按证据等级排序再比价格，而全目录只有 2 款散热器有厂商标称，
      // 玄冰500（¥99）因此在 36 套测试里全部入选，与 CPU 热负载无关。
      const rank = c => c.specs.thermalTests?.some(t => t.kind === 'measured' && /^https:\/\//.test(t.sourceUrl ?? '') && t.cpuSocket === cpu.specs.socket && t.durationMinutes >= 20 && t.ambientC >= (workload.ambientC ?? 25) && t.maxTempC <= t.tempLimitC && t.powerWatts >= peak && (!quiet || t.noiseDbA <= 35)) ? 0
        : c.specs.vendorCoolingWatts >= peak && c.specs.coolingEvidence?.sourceUrl ? 1 : 2;
      // 能力：厂商标称已知时须 ≥ 负载；尺寸档须 ≥ 负载所需（未知功耗按 120W 档）；安静优先再高一档
      const need = Math.min(4, coolingClassFor(peak ?? 120) + (quiet ? 1 : 0));
      const capable = fits.filter(c => {
        if (c.specs.vendorCoolingWatts && c.specs.vendorCoolingWatts < (peak ?? 0)) { rejected(c, 'quality', `厂商标称 ${c.specs.vendorCoolingWatts}W 低于待校核 ${peak}W`); return false; }
        if (coolerSizeClass(c.specs) < need) { rejected(c, 'quality', `尺寸档 ${coolerSizeClass(c.specs)} 低于 ${peak ?? '未知'}W${quiet ? '（安静优先）' : ''} 所需的 ${need} 档`); return false; }
        return true;
      });
      const pool = capable.length ? capable : fits.filter(c => coolerSizeClass(c.specs) >= coolingClassFor(peak ?? 120));
      return pool.sort((a, b) => price(a) - price(b) || rank(a) - rank(b) || a.id.localeCompare(b.id))[0] ?? null;
    });
  }

  /** 机箱：装得下主板、显卡（留 10mm）、散热器 / 冷排；没有风道数据，不按价格当品质——满足条件里最便宜 */
  function pcCase(cpu, board, gpu, cool, psu) {
    if (locked.CASE) return locked.CASE;
    const len = igpu || !gpu ? 0 : gpu.specs.lengthMm ?? 0;
    const c = cool && cool !== 'STOCK' ? cool.specs : {};
    const key = `case|${cpu.id}|${board.id}|${gpu?.id}|${cool?.id ?? cool}|${psu.id}|${quiet}`;
    // 静态尺寸筛选只取决于主板与尺寸，单独缓存并按价格排序（2.2.1 性能：原来每个组合都对全部机箱重算）
    const fitKey = `casefit|${board.id}|${len}|${c.radiatorSizeMm ?? 0}|${c.heightMm ?? 0}`;
    const fitting = cached(fitKey, () => cases.filter(i => {
      if (boardCaseStatus(board.specs, i.specs) !== PASS) { rejected(i, 'specification', '主板板型冲突或没有明确的支持规格集合'); return false; }
      if (len && i.specs.maxGpuLengthMm < len + 10) { rejected(i, 'specification', '显卡长度加 10mm 安装余量超过机箱限长'); return false; }
      if (c.radiatorSizeMm && (i.specs.maxRadiatorMm ?? 0) < c.radiatorSizeMm) { rejected(i, 'specification', '冷排不满足机箱支持上限'); return false; }
      if (!c.radiatorSizeMm && c.heightMm && (i.specs.maxCoolerHeightMm ?? 0) < c.heightMm) { rejected(i, 'specification', '散热器高度不满足机箱上限'); return false; }
      return true;
    }).sort((a, b) => price(a) - price(b) || a.id.localeCompare(b.id)));
    // 排序（2.2.1）：阻断性待核实项数量 → 风道依据（实测 PASS / 工程判断 CONDITIONAL / 未知）→ 价格。
    // 按价格从低到高评估，遇到“无阻断项且风道依据已达目录可能的最好等级”即停：与全量排序结果相同。
    return cached(key, () => {
      let best = null;
      for (const item of fitting) {
        const checks = evaluateBuild({ CPU: cpu, GPU: gpu, MOTHERBOARD: board, COOLER: cool === 'STOCK' ? null : cool, PSU: psu, CASE: item }, { igpu, stockCooler: cool === 'STOCK', workload: { ...workload, quiet } });
        if (checks.some(x => x.status === FAIL)) { rejected(item, 'specification', '补齐电源、散热器、显卡后最终物理或供电检查失败'); continue; }
        const thermal = checks.find(x => x.id === 'caseAirflow');
        const cand = { item, blocking: checks.filter(x => x.blocking).length, rank: thermal?.status === PASS ? 0 : thermal?.status === CONDITIONAL ? 1 : 2 };
        if (!best || cand.blocking < best.blocking || (cand.blocking === best.blocking && cand.rank < best.rank)) best = cand;
        if (best.blocking === 0 && best.rank <= bestAirflowRank) break;
      }
      return best?.item ?? null;
    });
  }

  return { psu, cooler, pcCase };
}

// ---------- 评分 ----------

const CONF = { high: 1, medium: 0.7, low: 0.3 };

function scoreBuild(b, ctx) {
  const { profile, refs, quiet, workload = {}, profileKey: key } = ctx;
  const w = { ...profile.weights };
  if (quiet) {
    const extra = QUIET_NOISE_WEIGHT - w.noise;
    const others = Object.keys(w).filter(k => k !== 'noise');
    const sum = others.reduce((s, k) => s + w[k], 0);
    for (const k of others) w[k] -= extra * (w[k] / sum);
    w.noise = QUIET_NOISE_WEIGHT;
  }
  const parts = {};
  // 显卡
  if (profile.gpuMetric === 'none') parts.gpu = 0;
  else if (!b.gpu) parts.gpu = 0.03;
  else if (profile.gpuMetric === 'ai') {
    const compute = b.gpu.performance?.blender?.score;
    // 2.2.1：恢复 2.1 的线性截断 + 开方（2.2.0 的 x/(x+0.25) 饱和曲线把 5060 Ti 与 5090 D 的差距压到很小，高预算选不到高端卡）
    // AI：显存是“能否装下模型”的容量门槛，线性计分（不开方）；75% 显存（32GB 满分）+ 25% 算力
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
  // CPU
  const cm = cpuMetric(profile)(b.cpu);
  const cpuRatio = cm / (profile.cpuMetric === 'gaming' ? refs.cpuGaming : refs.cpuBlender);
  parts.cpu = cm != null ? Math.sqrt(clamp(cpuRatio)) : 0;
  // 内存、硬盘
  const ramGB = b.ram.specs.capacityGB ?? 0;
  parts.memory = clamp(Math.sqrt(ramGB / profile.ramGB)) * (profile.cpuMetric === 'gaming' && up(b.ram.specs.memoryType) === 'DDR5' && (b.ram.specs.speedMTs ?? 0) >= 6000 ? 1 : 0.95);
  parts.storage = 0.75 * clamp(Math.sqrt((b.ssd.specs.capacityGB ?? 0) / profile.ssdGB)) + 0.25 * ssdQuality(b.ssd);
  // 品质：电源、主板、散热余量
  const evidenceScore = id => ({ PASS: 1, CONDITIONAL: .4, UNKNOWN: 0, FAIL: 0 })[b.checks.find(c => c.id === id)?.status] ?? 0;
  parts.quality = (psuQuality(b.psu.specs) + boardQuality(b.board) + evidenceScore('cpuCooling') + evidenceScore('caseAirflow')) / 4;
  // Only measured whole-build noise can earn a noise score. Fan vendor dBA
  // cannot be added together or substituted for case/load measurements.
  const noise = b.case.specs.thermalTests?.find(t => t.kind === 'measured' && t.sourceUrl && t.cpuWatts >= sustainedPower(b.cpu.specs, b.board.specs, workload) && t.gpuWatts >= (b.gpu?.specs.boardPowerWatts ?? b.gpu?.specs.tdpWatts ?? 0) && t.noiseDbA != null);
  // 噪音分只来自整机实测（没有实测记 0，不用规格近似冒充测量）。“安静优先”通过补件器生效：散热器要求高一档、电源品质下限更高。
  parts.noise = noise ? clamp((50 - noise.noiseDbA) / 25) : 0;
  parts.balance = b.gpu && b.cpu.performance?.gaming ? clamp(b.cpu.performance.gaming.index / (CPU_BALANCE.base + CPU_BALANCE.perGpu * (b.gpu.performance?.gaming?.index ?? 0))) : .3;
  parts.upgrade = ((b.board.specs.memorySlots ?? 0) > (b.ram.specs.modules ?? 0) ? .3 : 0) + ((b.board.specs.m2Slots ?? 0) > 1 ? .3 : 0) + (['AM5', 'LGA1851'].includes(up(b.board.specs.socket)) ? .4 : 0);
  // 数据可信度：价格可信度均值，兼容性条件项小扣分、待核实大扣分
  const items = [b.cpu, b.gpu, b.board, b.ram, b.ssd, b.psu, b.case, b.cooler === 'STOCK' ? null : b.cooler].filter(Boolean);
  const conf = items.reduce((s, i) => s + (CONF[i.priceConfidence] ?? .3), 0) / items.length;
  const cond = b.checks.filter(c => c.status === CONDITIONAL).length;
  const unknownCritical = b.checks.filter(c => c.status === UNKNOWN && c.critical).length;
  const unknown = b.checks.filter(c => c.status === UNKNOWN && !c.critical).length;
  const legacy = items.filter(i => i.priceFlags?.includes('legacy')).length;
  parts.trust = clamp(conf - 0.03 * cond - 0.15 * unknownCritical - 0.05 * unknown - LEGACY_TRUST_PENALTY * legacy);
  const proxy = !measuredScenario && key !== 'office';
  if (proxy) parts.trust = Math.min(parts.trust, ['4k', 'ai', 'creator'].includes(key) ? .4 : .65);
  let total = 100 * Object.entries(w).reduce((s, [k, v]) => s + v * (parts[k] ?? 0), 0);
  // 游戏：CPU 拖后腿扣分（显卡越强，需要的 CPU 游戏指数越高）
  let bottleneck = 0;
  if (profile.cpuMetric === 'gaming' && b.gpu?.performance?.gaming && cm != null) {
    const need = CPU_BALANCE.base + CPU_BALANCE.perGpu * b.gpu.performance.gaming.index;
    bottleneck = Math.max(0, need - cm) * CPU_BALANCE.penalty;
    total -= bottleneck;
  }
  return { total: Math.round(total * 10) / 10, bottleneck: Math.round(bottleneck * 10) / 10,
    scope: key, workload: workload.task, performanceBasis: measuredScenario ? '同一测试组的显卡型号实测，整机表现仍受搭配影响' : profile.gpuMetric === 'gaming' ? '2K 光栅指数代理；不代表 1080p FPS、4K 光追、超分或帧生成结果' : 'Blender 渲染代理；不代表剪辑编码、LLM 或训练吞吐', confidence: proxy ? 'low' : 'medium',
    dimensions: { core: Math.round((parts.gpu * (profile.gpuMetric === 'none' ? 0 : .65) + parts.cpu * (profile.gpuMetric === 'none' ? 1 : .35)) * 100), balance: Math.round(parts.balance * 100), memoryStorage: Math.round((parts.memory + parts.storage) * 50), reliability: Math.round(parts.quality * 100), upgrade: Math.round(parts.upgrade * 100), noiseEfficiency: Math.round(parts.noise * 100), trust: Math.round(parts.trust * 100) },
    parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, Math.round(v * 100)])) };
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
export function enumerateBuilds(items, { scenarios = [], locked: lockedInput = {}, maxCostCents = Infinity, igpuOnly = false, allowIgpu = false, workload = {} }) {
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
  const completers = { true: makeCompleter(items, { igpu: true, quiet, locked, workload, diagnostics }), false: makeCompleter(items, { igpu: false, quiet, locked, workload, diagnostics }) };
  const builds = [];
  const stats = { initialCandidates: Object.fromEntries(SLOTS.map(s => [s, items.filter(i => i.category === s).length])), candidates: { cpu: cpus.length, gpu: gpus.length, board: [...boards.values()].flat().length, ram: [...rams.values()].flat().length, ssd: ssds.length }, combos: 0, completed: 0, rejectedBudget: 0, rejectedFail: 0, incomplete: 0, rejectedByRule: {}, searchBounded: true, globalOptimalityProven: false };
  for (const cpu of cpus) {
    const socket = up(cpu.specs.socket);
    const boardList = locked.MOTHERBOARD ? boards.get('*') : boards.get(socket) ?? [];
    for (const board of boardList) {
      if (!locked.MOTHERBOARD && up(board.specs.socket) !== socket) continue;
      const bios = biosSupport(cpu.name, board.specs.chipset);
      if (bios.status === FAIL) continue;
      for (const gpu of gpus) {
        const igpu = gpu === null;
        if (igpu && !cpuHasIgpu(cpu.name, cpu.specs)) continue;
        if (igpu && board.specs.videoOutputs === false) continue;
        const ramList = locked.RAM ? rams.get('*') : rams.get(up(board.specs.memoryType)) ?? [];
        const base = price(cpu) + price(board) + (gpu ? price(gpu) : 0);
        if (base > maxCostCents) { stats.rejectedBudget++; continue; }
        const { psu: pickPsu, cooler: pickCooler, pcCase } = completers[igpu];
        const cool = pickCooler(cpu, board);
        if (cool === null) { stats.incomplete++; continue; }
        const psu = pickPsu(cpu, gpu);
        if (!psu) { stats.incomplete++; continue; }
        const pc = pcCase(cpu, board, gpu, cool, psu);
        if (!pc) { stats.incomplete++; continue; }
        const fanCost = pc.specs.requiredFanCostCents ?? 0;
        const bracketCost = ['SFX', 'SFX-L'].includes(psu.specs.psuFormFactor) &&
          !pc.specs.supportedPsuFormats?.includes(psu.specs.psuFormFactor) && !psu.specs.psuAtxBracketIncluded
          ? pc.specs.requiredPsuBracketCostCents ?? 0 : 0;
        const fixed = base + price(psu) + price(pc) + (cool === 'STOCK' ? 0 : price(cool)) + fanCost + bracketCost;
        for (const ram of ramList) {
          for (const ssd of ssds) {
            stats.combos++;
            const total = fixed + price(ram) + price(ssd);
            if (total > maxCostCents) { stats.rejectedBudget++; continue; }
            if (board.specs.m2Slots === 0 && /M\.2/i.test(ssd.specs.interface ?? '')) continue;
            const parts = { CPU: cpu, GPU: gpu, MOTHERBOARD: board, RAM: ram, SSD: ssd, PSU: psu, CASE: pc, COOLER: cool === 'STOCK' ? null : cool };
            const checks = evaluateBuild(Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, v ? { name: v.name, specs: v.specs } : null])), { igpu, stockCooler: cool === 'STOCK', workload: { ...workload, quiet } });
            if (checks.some(c => c.status === FAIL)) { stats.rejectedFail++; for (const c of checks.filter(c => c.status === FAIL)) stats.rejectedByRule[c.id] = (stats.rejectedByRule[c.id] ?? 0) + 1; continue; }
            const b = { cpu, gpu, board, ram, ssd, psu, case: pc, cooler: cool, igpu, checks, total, fanCost, bracketCost,
              risk: riskSummary(checks) };
            b.core = corePerformance(b, profile);
            b.benchmark = matchingBenchmark(gpu, workload);
            if (b.benchmark) b.core = { ...b.core, proxy: null, metric: b.benchmark.value,
              value: Math.log1p(b.benchmark.value / (b.benchmark.reference ?? 20)), benchmark: b.benchmark };
            b.score = scoreBuild(b, { profile, refs, quiet, workload, profileKey: key });
            builds.push(b);
            stats.completed++;
          }
        }
      }
    }
  }
  const retained = new Set([...cpus, ...gpus, ...boards.values()].flat().filter(Boolean).map(i => i.id));
  const candidateLog = items.filter(i => ['CPU', 'GPU', 'MOTHERBOARD'].includes(i.category)).map(i => ({ id: i.id, name: i.name, category: i.category, priceCents: price(i), priceSource: i.priceSource ?? i.estimateBasis, priceObservedAt: i.priceRecord?.observedAt ?? i.priceObservedAt ?? null, retained: retained.has(i.id), exclusion: audit.find(a => a.id === i.id) ?? (retained.has(i.id) ? null : { reason: 'platform-igpu-quality-or-model-filter' }) }));
  stats.componentRejections = { quality: diagnostics.quality, specification: diagnostics.specification, records: Object.values(diagnostics.records) };
  stats.rejectedTopK = audit.filter(a => a.reason === 'search-width-top-k').length;
  return { builds, profile, profileKey: key, stats, candidateLog };
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

function toPlan(b, profile, workload = {}) {
  const reasons = reasonsFor(b, profile);
  const picks = [['CPU', b.cpu], ['GPU', b.gpu], ['MOTHERBOARD', b.board], ['RAM', b.ram], ['SSD', b.ssd], ['PSU', b.psu], ['CASE', b.case], ['COOLER', b.cooler === 'STOCK' ? null : b.cooler]]
    .filter(([, item]) => item && !item.locked).map(([slot, item]) => ({ slot, item: slot === 'CPU' ? { ...item, specs: { ...item.specs, workload } } : item, reason: reasons[slot] }));
  return {
    picks, totalCents: b.total, additionalCosts: [
      ...(b.fanCost > 0 ? [{ id: 'case-fans', name: '机箱额外风扇', priceCents: b.fanCost }] : []),
      ...(b.bracketCost > 0 ? [{ id: 'psu-bracket', name: '电源转接支架', priceCents: b.bracketCost }] : []),
    ], ...(b.peripherals ? { peripherals: b.peripherals, hostTotalCents: b.hostTotal } : {}), igpu: b.igpu, stockCooler: b.cooler === 'STOCK', risk: b.risk,
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
 * 三档方案。返回结构与原 recommendPlans 一致（picks / totalCents / notes / compatibility / budget …），另加 score 与升级说明。
 * maxOverPercent：null 不限（尽量不超本档目标，放不下时取最便宜的可行配置并标出）；0 严格；其他为允许超出的比例。
 */
export function optimizePlans(allItems, { budgetCents, scenarios = [], maxOverPercent = null, tierRatios = { save: .8, balanced: 1, plus: 1.2 }, locked = {}, workload: workloadInput = {}, peripherals = [], strategy = 'balanced', allowUsed = false, allowModified = false }) {
  if (!STRATEGIES.includes(strategy)) throw new Error('未知推荐策略');
  // 商品状态过滤（2.2.1）：默认只用全新商品；二手 / 翻新需 allowUsed，改装 / 工程样品需 allowModified，状态未知（规格存疑）不进自动推荐
  const statusOf = i => i.productStatus ?? productStatus(i).status;
  const excludedByStatus = allItems.filter(i => !statusAllowed(statusOf(i), { allowUsed, allowModified }));
  const items = excludedByStatus.length ? allItems.filter(i => statusAllowed(statusOf(i), { allowUsed, allowModified })) : allItems;
  const started = performance.now();
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
  const { builds: baseBuilds, profile, stats, candidateLog } = enumerateBuilds(items, { scenarios, locked, maxCostCents: maxCost, igpuOnly: office, allowIgpu: gaming && budgetCents < 500000, workload });

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
      return { ...b, hostTotal: b.total, total: b.total + extra.totalCents, peripherals: extra };
    }).filter(b => b.peripherals.picks.length === new Set(peripherals).size);
    const cheapest = builds.reduce((m, b) => (!m || b.total < m.total ? b : m), null);

    const within = builds.filter(b => b.total <= Math.min(t.limit, t.target));
    const search = { all: Map.groupBy(builds, b => b.gpu?.id), within: Map.groupBy(within, b => b.gpu?.id) };
    tierSearch.set(t.id, search);
    let pool = within;
    // 不限模式下本档目标内没有可行配置时，退到允许范围内最便宜的（会标出超出多少）
    if (!pool.length && Number.isFinite(t.limit)) pool = builds.filter(b => b.total <= t.limit);
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
    if (prevBuild && prevBuild.total <= Math.min(t.limit, t.target)) {
      const noRegression = b => (b.benchmark?.id !== prevBuild.benchmark?.id || (b.core.metric ?? 0) >= (prevBuild.core.metric ?? 0))
        && (profile.gpuMetric !== 'ai' || b.core.vram >= prevBuild.core.vram)
        && (profile.gpuMetric !== 'creator' || b.ram.specs.capacityGB >= prevBuild.ram.specs.capacityGB);
      const nonregressing = pool.filter(noRegression);
      if (nonregressing.length && workload.task !== 'blender') pool = nonregressing;
    }
    const best = selectBuild(pool, strategy, t.id, t.target);
    search.final = Map.groupBy(pool, b => b.gpu?.id);
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
    if (best.total > t.target) notes.push(`当前有界搜索在本档目标 ${yuan(t.target)} 内未找到完整组合。本次搜索所得最低价替代超出 ${yuan(best.total - t.target)}。`);
    if (unmet(best).length) notes.push(`这个价位达不到${profile.label}的最低要求（${unmet(best).join('、')}），${best.total > t.target ? '此替代同时超预算。' : '当前预算内候选未达到使用要求。'}`);
    const upgrades = strongerOptions(within.filter(b => b.benchmark?.id === best.benchmark?.id && !unmet(b).length), best);
    if (upgrades.length) notes.push(`预算内还有 ${upgrades.length} 个核心性能升级选项。当前方案由 ${strategy === 'performance' ? '性能优先' : strategy === 'value' ? '性价比优先' : '均衡推荐'}策略选出。`);
    const plan = toPlan(best, profile, workload);
    const scenarioEvidenceMissing = (workload.targetFps || workload.benchmarkId || ['4k', 'ai', 'creator'].includes(key)) && !best.benchmark;
    const recommendationStatus = best.total > t.target ? 'over_budget_alternative' : unmet(best).length ? 'degraded' : plan.compatibility.overall === UNKNOWN || scenarioEvidenceMissing ? 'verification_required' : plan.compatibility.overall === CONDITIONAL ? 'conditional' : 'feasible';
    notes.push(`性能依据：${plan.score.performanceBasis}；可信度 ${plan.score.confidence}，只可在相同场景与评分版本内比较。`);
    if (best.benchmark) notes.push(`指定测试组 ${best.benchmark.title ?? best.benchmark.game ?? best.benchmark.id}，${best.benchmark.value} ${best.benchmark.unit}。测试条件 ${best.benchmark.conditions}。来源 ${best.benchmark.sourceUrl}`);
    else if (workload.targetFps) notes.push(`${workload.game || '所选游戏'} / ${workload.quality || '未指定画质'}目标 ${workload.targetFps} FPS 缺少匹配测试组，结果待核实。`);
    plans.push({ id: t.id, label: t.label, targetCents: t.target, budget: budget(best), budgetCents: t.target, lockedCents: Object.values(locked).reduce((sum, p) => sum + (p.priceCents ?? 0), 0),
      ...plan, strategy, corePerformance: best.core, tradeoffs: tierTradeoffs.get(t.id) ?? null,
      assessment: { budget: best.total <= t.target ? 'met' : 'over', requirements: unmet(best).length ? 'unmet' : scenarioEvidenceMissing ? 'unverified' : 'met',
        physical: best.risk.physical, safety: best.risk.safety, confidence: plan.score.confidence,
        needsConfirmation: best.risk.needsConfirmation || Boolean(scenarioEvidenceMissing), blockingChecks: best.risk.blockingChecks },
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
  return { plans, meta: { profile: key, workload, strategy, stats, candidateLog, gpuAlternatives,
    productStatusFilter: { allowUsed, allowModified, excluded: excludedByStatus.filter(i => ['CPU', 'GPU'].includes(i.category)).map(i => ({ id: i.id, name: i.name, status: statusOf(i), reason: i.productStatusReason ?? productStatus(i).reason })) }, elapsedMs: Math.round(performance.now() - started), scoringVersion: SCORING_VERSION, exportedAt: new Date().toISOString() } };
}

/** 锁定配件之间确认不兼容时说明是哪一项 */
function lockedConflictReason(locked) {
  const parts = Object.fromEntries(SLOTS.map(slot => [slot, locked[slot] && !locked[slot].igpu ? { name: locked[slot].name ?? '', specs: locked[slot].specs ?? {} } : null]));
  const fails = evaluateBuild(parts, { igpu: !!locked.GPU?.igpu }).filter(c => c.status === FAIL);
  return fails.length ? `锁定的配件之间不兼容：${fails.map(c => `${c.label}（${c.detail}）`).join('；')}` : null;
}
