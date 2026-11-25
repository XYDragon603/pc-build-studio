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
import { biosSupport, cpuHasIgpu, CONDITIONAL, evaluateBuild, FAIL, overallStatus, PASS, powerEstimate, UNKNOWN } from './compat-rules.mjs';
import { cpuKey } from './perfkeys.mjs';
import { CPU_BALANCE, LEGACY_TRUST_PENALTY, MIN_REQUIREMENTS, MIN_TIER_GAIN, QUIET_NOISE_WEIGHT, SCORING_PROFILES, SCORING_VERSION, TIER_COST_PENALTY } from './scoring-profiles.mjs';

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
function paretoByPrice(list, metric, max = 14) {
  const sorted = [...list].sort((a, b) => price(a) - price(b) || metric(b) - metric(a));
  const front = [];
  let best = -Infinity;
  for (const c of sorted) if (metric(c) > best) { front.push(c); best = metric(c); }
  if (front.length <= max) return front;
  const step = (front.length - 1) / (max - 1);
  return [...new Set(Array.from({ length: max }, (_, k) => front[Math.round(k * step)]))];
}

const gpuGroupKey = i => `${up(i.specs.chipset).replace(/^(GEFORCE|RADEON)\s*/, '')} ${i.specs.capacityGB}GB`;
const isNvidiaRtx = i => /RTX/i.test(i.specs.chipset ?? '');
const aiReady = i => /RTX\s*[345]\d{3}/i.test(i.specs.chipset ?? '');

function cpuCandidates(items, profile, { igpu, locked }) {
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
  if (measured.length >= 3) return paretoByPrice(measured, metric);
  return [...models].sort((a, b) => price(a) - price(b)).slice(0, 14);
}

const cpuMetric = profile => (profile.cpuMetric === 'gaming'
  ? i => i.performance?.gaming?.index ?? null
  : i => i.performance?.blender?.score ?? null);

function gpuMetric(profile) {
  if (profile.gpuMetric === 'ai') return i => (aiReady(i) && i.performance?.blender ? i.specs.capacityGB * 1000 + i.performance.blender.score / 10 : null);
  if (profile.gpuMetric === 'creator') return i => (isNvidiaRtx(i) && i.specs.capacityGB >= 8 && i.performance?.blender ? i.performance.blender.score : null);
  return i => i.performance?.gaming?.index ?? null;
}

function gpuCandidates(items, profile, { locked, allowIgpu }) {
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
    return [...(complete.length ? complete : sane.length ? sane : list)].sort((a, b) => price(a) - price(b))[0];
  });
  const metric = gpuMetric(profile);
  const measured = reps.filter(i => metric(i) != null);
  const front = measured.length >= 3 ? paretoByPrice(measured, metric, 16) : reps.sort((a, b) => price(a) - price(b)).slice(0, 16);
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

function makeCompleter(items, { igpu, quiet, locked }) {
  const psus = saneItems(items, 'PSU', i => String(Math.round((i.specs.ratedWatts ?? 0) / 100) * 100)).filter(i => i.specs.ratedWatts);
  const coolers = saneItems(items, 'COOLER', i => (i.specs.radiatorSizeMm ? `liquid:${i.specs.radiatorSizeMm}` : 'air'));
  const cases = saneItems(items, 'CASE', () => 'all').filter(i => i.specs.maxGpuLengthMm);
  const memo = new Map();
  const cached = (key, fn) => { if (!memo.has(key)) memo.set(key, fn()); return memo.get(key); };

  /** 电源：功率 ≥ 需求；供电接口、12V 不能 FAIL；按负载设品质下限（高负载要金牌级、ATX 3.x 更好），满足的里面挑最便宜 */
  function psu(cpu, gpu) {
    if (locked.PSU) return locked.PSU;
    const g = gpu?.specs ?? {};
    const p = powerEstimate(cpu.specs, igpu ? null : g, { igpu });
    const need = Math.max(p.recommended ?? 0, igpu ? 300 : 450);
    const pinsKey = JSON.stringify(g.powerPins ?? null);
    const key = `psu|${need}|${pinsKey}|${p.gpuW}|${p.cpuW}|${quiet}`;
    return cached(key, () => {
      const graded = psus.filter(i => i.specs.ratedWatts >= need).map(i => {
        const checks = evaluateBuild({ CPU: { specs: cpu.specs }, GPU: igpu || !gpu ? null : { specs: g }, PSU: { specs: i.specs } }, { igpu })
          .filter(c => ['gpuPower', 'psu12v', 'psuWatts'].includes(c.id));
        const rank = Math.max(0, ...checks.map(c => (c.status === FAIL ? 9 : c.status === UNKNOWN ? 2 : c.status === CONDITIONAL ? 1 : 0)));
        return { item: i, rank, q: psuQuality(i.specs) };
      }).filter(x => x.rank < 9);
      if (!graded.length) return null;
      const load = p.load ?? need / 1.25;
      const floor = (load > 500 ? 0.55 : load > 300 ? 0.4 : 0.15) + (quiet ? 0.12 : 0);
      const bestRank = Math.min(...graded.map(x => x.rank));
      const ranked = graded.filter(x => x.rank === bestRank);
      const ok = ranked.filter(x => x.q >= floor).sort((a, b) => price(a.item) - price(b.item))[0];
      return (ok ?? ranked.sort((a, b) => b.q - a.q || price(a.item) - price(b.item))[0]).item;
    });
  }

  /** 散热：按 CPU 持续功耗要求散热能力；合格风冷可参与；AMD 盒装非 X 型号低预算可用原装散热 */
  function cooler(cpu) {
    if (locked.COOLER) return locked.COOLER;
    const peak = cpu.specs.maxPowerWatts ?? 120;
    const stockOk = !quiet && /盒/.test(cpu.specs.packaging ?? '') && /RYZEN/i.test(cpu.name ?? '') && !/\d{4}X/i.test(cpu.name ?? '') && peak <= 95;
    const key = `cooler|${up(cpu.specs.socket)}|${Math.ceil(peak / 30)}|${quiet}|${stockOk}`;
    return cached(key, () => {
      if (stockOk) return 'STOCK';
      const fits = coolers.filter(c => evaluateBuild({ CPU: { specs: { socket: cpu.specs.socket } }, COOLER: { specs: c.specs } }).find(x => x.id === 'coolerSocket')?.status === PASS);
      // 散热能力用尺寸作近似：冷排越大、塔越高越强（没有统一的散热功率数据）
      const capable = c => {
        const r = c.specs.radiatorSizeMm ?? 0; const h = c.specs.heightMm ?? 0;
        if (peak <= 120) return r > 0 || h >= 120;
        if (peak <= 180) return r >= 240 || h >= 145;
        if (peak <= 250) return r >= 240 || h >= 155;
        return r >= 280 || h >= 158;
      };
      const quietOk = c => !quiet || (c.specs.radiatorSizeMm ?? 0) >= 240 || (c.specs.heightMm ?? 0) >= 150;
      const ok = fits.filter(c => capable(c) && quietOk(c)).sort((a, b) => price(a) - price(b));
      return ok[0] ?? fits.filter(capable).sort((a, b) => price(a) - price(b))[0] ?? null;
    });
  }

  /** 机箱：装得下主板、显卡（留 10mm）、散热器 / 冷排；没有风道数据，不按价格当品质——满足条件里最便宜 */
  function pcCase(board, gpu, cool) {
    if (locked.CASE) return locked.CASE;
    const size = BOARD_RANK[up(board.specs.formFactor)] ?? 2;
    const len = igpu || !gpu ? 0 : gpu.specs.lengthMm ?? 0;
    const c = cool && cool !== 'STOCK' ? cool.specs : {};
    const key = `case|${size}|${Math.ceil(len / 10)}|${c.radiatorSizeMm ?? 0}|${Math.ceil((c.heightMm ?? 0) / 5)}`;
    return cached(key, () => cases.filter(i => {
      const max = BOARD_RANK[up(i.specs.maxBoardFormFactor)] ?? (/MICRO ATX/i.test(i.specs.formFactor ?? '') ? 2 : /ATX/i.test(i.specs.formFactor ?? '') ? 3 : null);
      if (!max || max < size) return false;
      if (len && i.specs.maxGpuLengthMm < len + 10) return false;
      if (c.radiatorSizeMm) return (i.specs.maxRadiatorMm ?? 0) >= c.radiatorSizeMm;
      if (c.heightMm) return (i.specs.maxCoolerHeightMm ?? 0) >= c.heightMm;
      return true;
    }).sort((a, b) => price(a) - price(b))[0] ?? null);
  }

  return { psu, cooler, pcCase };
}

// ---------- 评分 ----------

const CONF = { high: 1, medium: 0.7, low: 0.3 };

function scoreBuild(b, ctx) {
  const { profile, refs, quiet } = ctx;
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
    parts.gpu = 0.75 * clamp(b.gpu.specs.capacityGB / 24) + 0.25 * (compute ? clamp(compute / refs.gpuCompute) : 0.3);
  } else if (profile.gpuMetric === 'creator') {
    const compute = b.gpu.performance?.blender?.score;
    parts.gpu = (compute ? clamp(compute / refs.gpuCompute) : 0.3) * (b.gpu.specs.capacityGB >= 12 ? 1 : 0.9);
  } else {
    const idx = b.gpu.performance?.gaming?.index;
    parts.gpu = idx ? clamp(idx / refs.gpuGaming) ** (profile.gpuCurve ?? 0.5) : 0.3;
  }
  if (profile.gpuMetric === 'ai' || profile.gpuMetric === 'creator') parts.gpu = Math.sqrt(clamp(parts.gpu));
  // CPU
  const cm = cpuMetric(profile)(b.cpu);
  parts.cpu = cm != null ? Math.sqrt(clamp(cm / (profile.cpuMetric === 'gaming' ? refs.cpuGaming : refs.cpuBlender))) : 0.45;
  // 内存、硬盘
  const ramGB = b.ram.specs.capacityGB ?? 0;
  parts.memory = clamp(Math.sqrt(ramGB / profile.ramGB)) * (profile.cpuMetric === 'gaming' && up(b.ram.specs.memoryType) === 'DDR5' && (b.ram.specs.speedMTs ?? 0) >= 6000 ? 1 : 0.95);
  parts.storage = 0.75 * clamp(Math.sqrt((b.ssd.specs.capacityGB ?? 0) / profile.ssdGB)) + 0.25 * ssdQuality(b.ssd);
  // 品质：电源、主板、散热余量
  const coolerOk = b.cooler === 'STOCK' ? 0.6 : 0.9;
  parts.quality = (psuQuality(b.psu.specs) + boardQuality(b.board) + coolerOk) / 3;
  // 噪音：散热越强、电源能效越高越安静（没有实测分贝，按规格近似）
  const coolerQuiet = b.cooler === 'STOCK' ? 0.35 : (b.cooler.specs.radiatorSizeMm ?? 0) >= 240 ? 0.85 : (b.cooler.specs.heightMm ?? 0) >= 150 ? 0.8 : 0.55;
  parts.noise = (coolerQuiet + clamp(psuQuality(b.psu.specs) + 0.2)) / 2;
  // 数据可信度：价格可信度均值，兼容性条件项小扣分、待核实大扣分
  const items = [b.cpu, b.gpu, b.board, b.ram, b.ssd, b.psu, b.case, b.cooler === 'STOCK' ? null : b.cooler].filter(Boolean);
  const conf = items.reduce((s, i) => s + (CONF[i.priceConfidence] ?? (i.locked ? 1 : 0.7)), 0) / items.length;
  const cond = b.checks.filter(c => c.status === CONDITIONAL).length;
  const unknownCritical = b.checks.filter(c => c.status === UNKNOWN && c.critical).length;
  const unknown = b.checks.filter(c => c.status === UNKNOWN && !c.critical).length;
  const legacy = items.filter(i => i.priceFlags?.includes('legacy')).length;
  parts.trust = clamp(conf - 0.03 * cond - 0.15 * unknownCritical - 0.05 * unknown - LEGACY_TRUST_PENALTY * legacy);
  let total = 100 * Object.entries(w).reduce((s, [k, v]) => s + v * (parts[k] ?? 0), 0);
  // 游戏：CPU 拖后腿扣分（显卡越强，需要的 CPU 游戏指数越高）
  let bottleneck = 0;
  if (profile.cpuMetric === 'gaming' && b.gpu?.performance?.gaming && cm != null) {
    const need = CPU_BALANCE.base + CPU_BALANCE.perGpu * b.gpu.performance.gaming.index;
    bottleneck = Math.max(0, need - cm) * CPU_BALANCE.penalty;
    total -= bottleneck;
  }
  return { total: Math.round(total * 10) / 10, bottleneck: Math.round(bottleneck * 10) / 10,
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
export function enumerateBuilds(items, { scenarios = [], locked: lockedInput = {}, maxCostCents = Infinity, igpuOnly = false, allowIgpu = false }) {
  const key = profileKey(scenarios);
  const profile = SCORING_PROFILES[key];
  const quiet = scenarios.includes('quiet');
  const locked = lockedItems(lockedInput);
  const igpuLocked = !!lockedInput.GPU?.igpu;
  const cpus = cpuCandidates(items, profile, { igpu: igpuOnly || igpuLocked, locked });
  const gpus = igpuOnly || igpuLocked ? [null] : gpuCandidates(items, profile, { locked, allowIgpu });
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
  const completers = { true: makeCompleter(items, { igpu: true, quiet, locked }), false: makeCompleter(items, { igpu: false, quiet, locked }) };
  const builds = [];
  const stats = { candidates: { cpu: cpus.length, gpu: gpus.length, ram: [...rams.values()].flat().length, ssd: ssds.length }, combos: 0, completed: 0, rejectedFail: 0, incomplete: 0 };
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
        if (base > maxCostCents) continue;
        const { psu: pickPsu, cooler: pickCooler, pcCase } = completers[igpu];
        const cool = pickCooler(cpu);
        if (cool === null) { stats.incomplete++; continue; }
        const psu = pickPsu(cpu, gpu);
        if (!psu) { stats.incomplete++; continue; }
        const pc = pcCase(board, gpu, cool);
        if (!pc) { stats.incomplete++; continue; }
        const fixed = base + price(psu) + price(pc) + (cool === 'STOCK' ? 0 : price(cool));
        for (const ram of ramList) {
          for (const ssd of ssds) {
            stats.combos++;
            const total = fixed + price(ram) + price(ssd);
            if (total > maxCostCents) continue;
            if (board.specs.m2Slots === 0 && /M\.2/i.test(ssd.specs.interface ?? '')) continue;
            const parts = { CPU: cpu, GPU: gpu, MOTHERBOARD: board, RAM: ram, SSD: ssd, PSU: psu, CASE: pc, COOLER: cool === 'STOCK' ? null : cool };
            const checks = evaluateBuild(Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, v ? { name: v.name, specs: v.specs } : null])), { igpu, stockCooler: cool === 'STOCK' });
            if (checks.some(c => c.status === FAIL)) { stats.rejectedFail++; continue; }
            const b = { cpu, gpu, board, ram, ssd, psu, case: pc, cooler: cool, igpu, checks, total };
            b.score = scoreBuild(b, { profile, refs, quiet });
            builds.push(b);
            stats.completed++;
          }
        }
      }
    }
  }
  return { builds, profile, profileKey: key, stats };
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
  r.PSU = b.psu.locked ? '已锁定' : `需要 ≥ ${Math.max(p.recommended ?? 0, b.igpu ? 300 : 450)}W，额定 ${b.psu.specs.ratedWatts}W${b.psu.specs.efficiency ? `，${b.psu.specs.efficiency}` : ''}${b.psu.specs.atxVersion ? `，ATX ${b.psu.specs.atxVersion}` : ''}${gp ? `；供电接口${gp.status === PASS ? '已确认' : gp.status === CONDITIONAL ? '需转接（见兼容性）' : '待核实'}` : ''}；满足品质下限里最便宜`;
  r.CASE = b.case.locked ? '已锁定' : `能装下主板${b.gpu ? `、${b.gpu.specs.lengthMm}mm 显卡` : ''}${b.cooler !== 'STOCK' && b.cooler?.specs.radiatorSizeMm ? `、${b.cooler.specs.radiatorSizeMm}mm 冷排` : ''}，满足条件里最便宜（没有风道数据，不按价格评品质）`;
  if (b.cooler !== 'STOCK') r.COOLER = b.cooler.locked ? '已锁定' : `CPU 峰值约 ${b.cpu.specs.maxPowerWatts ?? '?'}W，${b.cooler.specs.radiatorSizeMm ? `${b.cooler.specs.radiatorSizeMm}mm 水冷` : `风冷 ${b.cooler.specs.heightMm ?? '?'}mm`}，满足散热要求里最便宜`;
  return r;
}

function toPlan(b, profile) {
  const reasons = reasonsFor(b, profile);
  const picks = [['CPU', b.cpu], ['GPU', b.gpu], ['MOTHERBOARD', b.board], ['RAM', b.ram], ['SSD', b.ssd], ['PSU', b.psu], ['CASE', b.case], ['COOLER', b.cooler === 'STOCK' ? null : b.cooler]]
    .filter(([, item]) => item && !item.locked).map(([slot, item]) => ({ slot, item, reason: reasons[slot] }));
  return {
    picks, totalCents: b.total, igpu: b.igpu, stockCooler: b.cooler === 'STOCK',
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
 * 三档方案。返回结构与原 recommendPlans 一致（picks / totalCents / notes / compatibility / budget …），另加 score 与升级说明。
 * maxOverPercent：null 不限（尽量不超本档目标，放不下时取最便宜的可行配置并标出）；0 严格；其他为允许超出的比例。
 */
export function optimizePlans(items, { budgetCents, scenarios = [], maxOverPercent = null, tierRatios, locked = {} }) {
  const started = performance.now();
  const key = profileKey(scenarios);
  const office = key === 'office';
  const gaming = ['2k', '4k', '1080p'].includes(key);
  const tiers = Object.entries(tierRatios).map(([id, ratio]) => {
    const target = Math.round(budgetCents * ratio / 10000) * 10000;
    return { id, label: TIER_LABELS[id] ?? id, target, limit: maxOverPercent == null ? Infinity : Math.floor(target * (1 + maxOverPercent / 100)) };
  });
  const maxTarget = Math.max(...tiers.map(t => t.target));
  // 剪枝上限放宽到最高目标的 1.6 倍（至少 ¥6,000）：严格预算时也要找到“最低可行配置”，才能告诉用户差多少
  const maxCost = Math.max(maxTarget * 1.6, 600000, ...tiers.map(t => (Number.isFinite(t.limit) ? t.limit : 0)));
  const { builds, profile, stats } = enumerateBuilds(items, { scenarios, locked, maxCostCents: maxCost, igpuOnly: office, allowIgpu: gaming && budgetCents < 500000 });
  const cheapest = builds.reduce((m, b) => (!m || b.total < m.total ? b : m), null);

  const plans = [];
  let prevBuild = null; let prevTier = null;
  for (const t of tiers) {
    const lambda = TIER_COST_PENALTY[t.id] ?? 0.1;
    const within = builds.filter(b => b.total <= Math.min(t.limit, t.target));
    let pool = within;
    // 不限模式下本档目标内没有可行配置时，退到允许范围内最便宜的（会标出超出多少）
    if (!pool.length && Number.isFinite(t.limit)) pool = builds.filter(b => b.total <= t.limit);
    if (!pool.length && !Number.isFinite(t.limit) && cheapest) pool = [cheapest];
    const budget = b => ({ inputCents: budgetCents, targetCents: t.target, limitCents: Number.isFinite(t.limit) ? t.limit : null,
      overTargetCents: (b?.total ?? 0) - t.target, overInputCents: (b?.total ?? 0) - budgetCents });
    if (!pool.length) {
      const reasons = [];
      if (!builds.length) reasons.push(stats.candidates.cpu === 0 || stats.candidates.gpu === 0
        ? '目录里没有满足用途要求的 CPU 或显卡（如 AI 需要 RTX 30 系及以后的 NVIDIA 显卡）。'
        : '找不到兼容且配齐的组合（锁定的配件之间可能不兼容，或缺少满足兼容性的电源 / 散热 / 机箱）。');
      else reasons.push(maxOverPercent === 0
        ? `严格预算：本档目标 ${yuan(t.target)} 内找不到兼容的完整配置，能找到的最低约 ${yuan(cheapest.total)}。`
        : `允许超出 ${maxOverPercent}%（最多 ${yuan(t.limit)}）仍放不下，能找到的最低约 ${yuan(cheapest.total)}。`);
      const lockedConflict = !builds.length && Object.keys(locked).length ? lockedConflictReason(locked) : null;
      if (lockedConflict) reasons.unshift(lockedConflict);
      plans.push({ id: t.id, label: t.label, targetCents: t.target, budget: budget(null), infeasible: true, reasons,
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
    // 用途最低要求：本档有满足的组合就只在这些里挑；都不满足时用最好的并说明
    const req = MIN_REQUIREMENTS[key] ?? {};
    const unmet = b => [
      req.gpuGaming && !b.igpu && (b.gpu?.performance?.gaming?.index ?? 0) < req.gpuGaming && `显卡 2K 游戏指数 ≥ ${req.gpuGaming}`,
      req.gpuGaming && b.igpu && `需要独立显卡`,
      req.vramGB && (b.gpu?.specs.capacityGB ?? 0) < req.vramGB && `显存 ≥ ${req.vramGB}GB`,
      req.ramGB && (b.ram.specs.capacityGB ?? 0) < req.ramGB(t.target) && `内存 ≥ ${req.ramGB(t.target)}GB`,
    ].filter(Boolean);
    // 游戏用途：有独显能放下时不考虑核显
    if (gaming && pool.some(b => !b.igpu)) pool = pool.filter(b => !b.igpu);
    const meeting = pool.filter(b => unmet(b).length === 0);
    const shortfall = meeting.length ? null : pool;
    if (meeting.length) pool = meeting;
    let best = pool.reduce((m, b) => {
      const v = b.score.total - lambda * 100 * (b.total / t.target);
      return !m || v > m.v || (v === m.v && b.total < m.b.total) ? { b, v } : m;
    }, null).b;
    const notes = [];
    let sameAs;
    // 提升不明显：沿用上一档（上一档的配置在本档也可行），说明原因
    if (prevBuild && prevBuild.total <= Math.min(t.limit, Math.max(t.target, prevBuild.total)) && best.score.total < prevBuild.score.total + MIN_TIER_GAIN) {
      notes.push(best !== prevBuild
        ? `和${prevTier.label}配置相同：多花钱能换到的提升不到 ${MIN_TIER_GAIN} 分（${prevBuild.score.total} → ${best.score.total}），不强行堆料。`
        : `和${prevTier.label}配置相同：在${yuan(t.target)}的目标预算下，没有找到比${prevTier.label}更值得多花钱的组合。`);
      best = prevBuild;
      sameAs = prevTier.id;
    } else if (prevBuild) {
      notes.push(diffNote(prevBuild, best, prevTier.label));
    }
    if (best.total > t.target) notes.push(`本档目标 ${yuan(t.target)} 内没有兼容的完整配置，这是能找到的最低价配置，超出 ${yuan(best.total - t.target)}。`);
    if (shortfall && unmet(best).length) notes.push(`这个价位达不到${profile.label}的最低要求（${unmet(best).join('、')}），这是预算内最好的配置，建议提高预算。`);
    // 剩余预算：再多花一些能换到什么
    if (!sameAs && best.total < t.target * 0.9) {
      const next = builds.filter(b => b.total > best.total && b.score.total >= best.score.total + 3).sort((a, b) => a.total - b.total)[0];
      notes.push(next
        ? `预算还剩 ${yuan(t.target - best.total)}：再加 ${yuan(next.total - best.total)} 可以把评分从 ${best.score.total} 提到 ${next.score.total}（${diffNote(best, next, '当前').replace(/^比当前多花 [^，]+，/, '')}），性价比不如当前配置。`
        : `预算还剩 ${yuan(t.target - best.total)}：目录里没有能明显提升评分的升级，当前配置已接近这个用途的最优性价比。`);
    }
    const plan = toPlan(best, profile);
    plans.push({ id: t.id, label: t.label, targetCents: t.target, budget: budget(best), budgetCents: t.target, lockedCents: 0,
      ...plan, ...(sameAs ? { sameAs } : {}),
      notes: [...notes, ...(plan.igpu ? ['核显方案：不配独立显卡，用 CPU 自带核显。'] : []),
        `价格为参考价估算，不是报价。综合评分按“${profile.label}”的权重计算（${SCORING_VERSION}），只用于在候选之间比较，不代表实际帧数或 AI 吞吐。`] });
    prevBuild = best; prevTier = t;
  }
  const elapsedMs = Math.round(performance.now() - started);
  return { plans, meta: { profile: key, stats, elapsedMs, scoringVersion: SCORING_VERSION } };
}

/** 锁定配件之间确认不兼容时说明是哪一项 */
function lockedConflictReason(locked) {
  const parts = Object.fromEntries(SLOTS.map(slot => [slot, locked[slot] && !locked[slot].igpu ? { name: locked[slot].name ?? '', specs: locked[slot].specs ?? {} } : null]));
  const fails = evaluateBuild(parts, { igpu: !!locked.GPU?.igpu }).filter(c => c.status === FAIL);
  return fails.length ? `锁定的配件之间不兼容：${fails.map(c => `${c.label}（${c.detail}）`).join('；')}` : null;
}
