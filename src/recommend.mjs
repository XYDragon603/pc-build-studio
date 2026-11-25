// 按预算自动配一套：从型号目录里挑兼容、总价在预算内的配件。
//
// 没有性能跑分数据，档次用估算价代表，因此每一项都附带“为什么这样选”，便于人工判断。
// 只使用有估算价、且兼容性所需规格齐全的目录条目；已锁定的配件保留不动。
// 规格与价格均来自目录（估算价不是报价）。

export const SLOTS = ['CPU', 'GPU', 'MOTHERBOARD', 'RAM', 'SSD', 'PSU', 'CASE', 'COOLER'];

/** 2K 游戏的基础分配；“安静优先”从显卡挪一点给散热、机箱、电源 */
const BASE_SHARES = { GPU: 0.40, CPU: 0.17, MOTHERBOARD: 0.11, RAM: 0.07, SSD: 0.06, PSU: 0.07, CASE: 0.06, COOLER: 0.06 };
const QUIET_SHIFT = { GPU: -0.04, COOLER: 0.02, CASE: 0.01, PSU: 0.01 };
/** 非游戏用途显卡少分一些 */
const GENERAL_SHIFT = { GPU: -0.12, CPU: 0.06, RAM: 0.03, SSD: 0.03 };

/**
 * 用途档案：预算分配、CPU / 显卡怎么比、内存与硬盘容量。
 * - cpu：gaming = 游戏指数优先；multicore = Blender 多核分优先（渲染、编译、数据处理）
 * - gpu：gaming = 2K 游戏指数；ai = 先比显存、再比算力，优先 NVIDIA（CUDA）；creator = 优先 NVIDIA，按渲染算力比
 * - ramGB / ssdGB：按预算给容量，null 用默认规则
 */
export const PROFILES = {
  '2k': { label: '2K 游戏', shares: BASE_SHARES, cpu: 'gaming', gpu: 'gaming' },
  '4k': { label: '4K / 光追游戏', shares: { GPU: 0.48, CPU: 0.15, MOTHERBOARD: 0.09, RAM: 0.06, SSD: 0.06, PSU: 0.07, CASE: 0.05, COOLER: 0.04 },
    cpu: 'gaming', gpu: 'gaming', ramGB: () => 32 },
  // 高帧率吃 CPU：显卡少分一点给 CPU
  '1080p': { label: '1080p 电竞', shares: { GPU: 0.33, CPU: 0.22, MOTHERBOARD: 0.11, RAM: 0.08, SSD: 0.06, PSU: 0.07, CASE: 0.07, COOLER: 0.06 },
    cpu: 'gaming', gpu: 'gaming' },
  // 显存决定能跑多大的模型：一半预算给显卡；内存、硬盘要大（数据集、模型文件）
  ai: { label: 'AI / 机器学习', shares: { GPU: 0.50, CPU: 0.12, MOTHERBOARD: 0.08, RAM: 0.10, SSD: 0.07, PSU: 0.07, CASE: 0.03, COOLER: 0.03 },
    cpu: 'multicore', gpu: 'ai', ramGB: b => (b >= 1000000 ? 64 : 32), ssdGB: b => (b >= 800000 ? 2000 : 1000) },
  creator: { label: '视频剪辑 / 设计', shares: { GPU: 0.28, CPU: 0.26, MOTHERBOARD: 0.10, RAM: 0.11, SSD: 0.09, PSU: 0.06, CASE: 0.05, COOLER: 0.05 },
    cpu: 'multicore', gpu: 'creator', ramGB: b => (b >= 1200000 ? 64 : 32), ssdGB: b => (b >= 700000 ? 2000 : 1000) },
  office: { label: '办公学习', shares: Object.fromEntries(Object.entries(BASE_SHARES).map(([k, v]) => [k, v + (GENERAL_SHIFT[k] ?? 0)])),
    cpu: 'gaming', gpu: 'gaming' },
};

/** 场景里第一个认识的用途；都不认识时按通用（办公）处理，与原来“非游戏显卡少分”的规则一致 */
export function profileOf(scenarios = []) {
  const key = scenarios.find(s => s !== 'office' && PROFILES[s]) ?? (scenarios.includes('office') ? 'office' : null);
  return key ? { key, ...PROFILES[key] } : { key: 'general', ...PROFILES.office };
}

const isNvidia = key => /^(RTX|GTX)\b/.test(key);
/** AI 只考虑 RTX 30 系及以后（更老的卡没有新的 Tensor Core、显存小） */
const AI_READY = key => /^RTX\s*[345]\d{3}/.test(key);

const BOARD_RANK = { 'MINI-ITX': 1, 'MICRO ATX': 2, ATX: 3, EATX: 4 };
const up = v => String(v ?? '').trim().toUpperCase();
const yuan = cents => `¥${Math.round(cents / 100).toLocaleString('zh-CN')}`;
const price = item => item.estimatedPriceCents;

/** BuildCores 机箱的 formFactor 是外形（如 “Micro ATX Mini Tower”），从中取最大板型 */
function caseMaxBoard(specs) {
  const explicit = up(specs.maxBoardFormFactor);
  if (BOARD_RANK[explicit]) return explicit;
  const t = up(specs.formFactor);
  if (t.startsWith('EATX') || t.startsWith('E-ATX')) return 'EATX';
  if (t.startsWith('MICRO ATX')) return 'MICRO ATX';
  if (t.startsWith('MINI ITX') || t.startsWith('MINI-ITX')) return 'MINI-ITX';
  if (t.startsWith('ATX')) return 'ATX';
  return null;
}

/** 散热器插槽列表可能写作 LGA115X、AM4/AM5 等；只要列出 CPU 插槽即视为支持 */
const coolerFitsSocket = (cooler, socket) =>
  Array.isArray(cooler.specs.sockets) && cooler.specs.sockets.map(up).includes(up(socket));

export function shares(scenarios = []) {
  const s = { ...profileOf(scenarios).shares };
  if (scenarios.includes('quiet')) for (const [k, d] of Object.entries(QUIET_SHIFT)) s[k] += d;
  return s;
}

/** 在预算上限内挑价格最高的（档次代理）；没有满足的就挑最便宜的并标记超出 */
function bestWithin(pool, cap) {
  const within = pool.filter(i => price(i) <= cap).sort((a, b) => price(b) - price(a));
  if (within.length) return { item: within[0], over: false };
  const cheapest = [...pool].sort((a, b) => price(a) - price(b))[0];
  return cheapest ? { item: cheapest, over: true } : null;
}

const cheapestOf = pool => [...pool].sort((a, b) => price(a) - price(b))[0] ?? null;

/** CPU 性能分：游戏指数与 Blender 多核分量级不同，同一次比较只用其中一种 */
const cpuGaming = item => item.performance?.gaming?.index ?? null;
const cpuBlender = item => item.performance?.blender?.score ?? null;

/** 预算内性能分最高的；同分取更便宜的。没有性能数据的条目不参与 */
function bestPerfWithin(pool, cap, perf) {
  const within = pool.filter(i => price(i) <= cap && perf(i) != null)
    .sort((a, b) => perf(b) - perf(a) || price(a) - price(b));
  return within[0] ?? null;
}

/** 当前平台与当代显卡芯片：用价格代表档次时，停产型号的参考价常常没更新，优先在这些里挑 */
const CURRENT_SOCKETS = /^(AM5|LGA1700|LGA1851)$/;
const CURRENT_GPU = /RTX\s*50\d0|RX\s*9\d{3}|ARC\s*B\d{3}/i;

/** 同类同规格里比中位价低一半以上的估算价视为数据错误（如标价 ¥149 的 750W 金牌电源） */
const BUCKETS = {
  CPU: i => up(i.specs.socket),
  GPU: i => `${up(i.specs.chipset)}:${i.specs.capacityGB}`,
  MOTHERBOARD: i => `${up(i.specs.socket)}:${up(i.specs.memoryType)}`,
  RAM: i => `${up(i.specs.memoryType)}:${i.specs.capacityGB}`,
  SSD: i => String(i.specs.capacityGB),
  PSU: i => String(Math.round((i.specs.ratedWatts ?? 0) / 100) * 100),
  CASE: () => 'all',
  COOLER: i => (i.specs.radiatorSizeMm ? `liquid:${i.specs.radiatorSizeMm}` : 'air'),
};

function dropPriceOutliers(category, pool) {
  const groups = new Map();
  for (const i of pool) {
    const key = BUCKETS[category](i);
    groups.set(key, [...(groups.get(key) ?? []), price(i)]);
  }
  const medians = new Map([...groups].map(([k, v]) => {
    const sorted = [...v].sort((a, b) => a - b);
    return [k, sorted.length >= 3 ? sorted[Math.floor(sorted.length / 2)] : null];
  }));
  return pool.filter(i => {
    const m = medians.get(BUCKETS[category](i));
    return !m || price(i) >= m * 0.5;
  });
}

/**
 * @param items  目录条目（含 estimatedPriceCents）
 * @param input  { budgetCents, scenarios, locked: { [SLOT]: { priceCents, specs } } }
 */
/** 带核显的 CPU：ZOL 标注了集成显卡，或 AMD G 系列 / Intel 非 F 型号 */
export function hasIntegratedGraphics(item) {
  const name = up(item.name);
  // ZOL 对 F 系列写的是“不支持”，不能只看字段有没有值
  const igpu = item.specs?.integratedGraphics;
  if (igpu != null && igpu !== '') return !/不支持|^无|^否|none|n\/a/i.test(String(igpu));
  if (/RYZEN.*\d{4}G(T|E)?\b/.test(name)) return true;
  if (/INTEL|酷睿|CORE/.test(name) && !/\d{3,5}K?F\b|KF\b/.test(name)) return true;
  return false;
}

/**
 * 超预算时整体收紧：按“预算 ÷ 估算总价”缩小各项分配后重挑，最多 4 轮，取不超预算里最贵的一次；都超就取最便宜的。
 */
export function recommend(items, input) {
  let scale = 1;
  const tries = [];
  for (let i = 0; i < 5; i++) {
    const r = recommendOnce(items, { ...input, capScale: scale });
    tries.push(r);
    if (r.totalCents <= input.budgetCents || !r.picks.length) break;
    scale *= (input.budgetCents / r.totalCents) * 0.97;
  }
  const fitting = tries.filter(r => r.totalCents <= input.budgetCents);
  const best = fitting.length ? fitting.sort((a, b) => b.totalCents - a.totalCents)[0] : tries.sort((a, b) => a.totalCents - b.totalCents)[0];
  if (best !== tries[0] && best.totalCents <= input.budgetCents) best.notes.unshift('初选超出预算，已整体降低各项档次以控制在预算内。');
  return best;
}

function recommendOnce(items, { budgetCents, scenarios = [], locked: lockedInput = {}, igpu = false, capScale = 1 }) {
  // 核显方案：显卡当作已确定、价格为 0，预算全部分给其他配件
  const locked = igpu ? { ...lockedInput, GPU: { priceCents: 0, specs: {}, igpu: true } } : lockedInput;
  const pools = Object.fromEntries(SLOTS.map(s => {
    const valid = dropPriceOutliers(s, items.filter(i => i.category === s && price(i) > 0
      // 明显错误的显卡长度（如 128mm）不参与挑选
      && (s !== 'GPU' || ((i.specs.lengthMm ?? 0) >= 150 && i.specs.lengthMm <= 380))));
    // 有商品图的足够多时只用有图的，方案里每一项都能配图
    const withImage = valid.filter(i => i.imageUrl);
    return [s, withImage.length >= 8 ? withImage : valid];
  }));
  const notes = [];
  const picks = {};
  let stockCoolerNote = null;
  const lockedCents = Object.values(locked).reduce((sum, p) => sum + (p.priceCents ?? 0), 0);
  const open = SLOTS.filter(s => !locked[s]);
  const profile = profileOf(scenarios);
  const weights = shares(scenarios);
  const weightSum = open.reduce((sum, s) => sum + weights[s], 0) || 1;
  const available = budgetCents - lockedCents;
  if (available <= 0) return { picks: [], totalCents: lockedCents, budgetCents, notes: ['已锁定配件已用完预算，没有可分配的金额。'] };
  const cap = slot => Math.round((available * weights[slot] * capScale) / weightSum);

  /** 已选（含锁定）配件的规格 */
  const specsOf = slot => locked[slot]?.specs ?? picks[slot]?.item.specs ?? null;
  const set = (slot, item, reason) => { picks[slot] = { item, reason }; };

  // CPU
  if (!locked.CPU) {
    // 办公：够用就好，CPU 最多 ¥1,200、按多核挑；预算再高也不买游戏 CPU（X3D 对办公没用），省下的钱留着
    const officeLike = ['office', 'general'].includes(profile.key);
    const cpuCap = officeLike ? Math.min(cap('CPU'), 120000) : cap('CPU');
    const all = pools.CPU.filter(i => i.specs.socket && /^(AM5|AM4|LGA1700|LGA1851)$/.test(up(i.specs.socket))
      && (!igpu || hasIntegratedGraphics(i)));
    const current = all.filter(i => CURRENT_SOCKETS.test(up(i.specs.socket)));
    const currentFits = current.some(i => price(i) <= cpuCap);
    const pool = currentFits ? current : all;
    const platform = currentFits ? '优先 AM5 / LGA1700 / LGA1851 平台，' : '当前平台超出分配，放宽到 AM4，';
    // 游戏用途：预算内有游戏指数的型号就只按游戏指数比，否则按 Blender 多核分；
    // AI / 剪辑：反过来，多核分优先（渲染、编译、数据预处理吃核心数）
    const multicore = profile.cpu === 'multicore' || officeLike;
    const byGaming = multicore ? null : bestPerfWithin(pool, cpuCap, cpuGaming);
    const byBlender = multicore ? bestPerfWithin(pool, cpuCap, cpuBlender) : null;
    const byPerf = byGaming ?? byBlender ?? bestPerfWithin(pool, cpuCap, multicore ? cpuGaming : cpuBlender);
    if (byPerf) {
      const usedGaming = cpuGaming(byPerf) != null && (byGaming || (multicore && !byBlender));
      set('CPU', byPerf, usedGaming
        ? `分配 ${yuan(cap('CPU'))}，${platform}选预算内游戏指数最高的（${cpuGaming(byPerf)}%，1080p，9850X3D = 100）`
        : `分配 ${yuan(cpuCap)}${officeLike && cpuCap < cap('CPU') ? '（办公够用就好，最多 ¥1,200）' : ''}，${platform}${multicore ? `${profile.label}看多核，` : '预算内没有游戏指数数据，'}选 Blender 多核分最高的（${cpuBlender(byPerf)}）`);
    } else {
      const r = bestWithin(pool, cpuCap);
      if (r) set('CPU', r.item, `分配 ${yuan(cpuCap)}，${platform}没有性能数据，选预算内估算价最高的${r.over ? '（预算不足，取最便宜的）' : ''}`);
    }
  }
  const socket = up(specsOf('CPU')?.socket);

  // 主板：插槽一致；优先 Micro ATX，预算内估算价最高
  if (!locked.MOTHERBOARD && socket) {
    const pool = pools.MOTHERBOARD.filter(i => up(i.specs.socket) === socket && i.specs.memoryType && BOARD_RANK[up(i.specs.formFactor)]);
    const matx = pool.filter(i => up(i.specs.formFactor) === 'MICRO ATX');
    const r = bestWithin(matx.length ? matx : pool, cap('MOTHERBOARD'));
    if (r) set('MOTHERBOARD', r.item, `插槽 ${socket}，优先 Micro ATX，分配 ${yuan(cap('MOTHERBOARD'))} 内估算价最高`);
  }
  const memoryType = up(specsOf('MOTHERBOARD')?.memoryType);

  // 内存：同代际；预算 ≥ ¥6,000 选 32GB，否则 16GB；双条优先；DDR5 要求 ≥ 6000 MT/s；挑最便宜
  if (!locked.RAM && memoryType) {
    // 低预算 16GB；¥6,000 以上 32GB；AI / 剪辑按用途档案（如 AI ¥10,000 以上 64GB）
    const wantGB = profile.ramGB?.(budgetCents) ?? (budgetCents >= 600000 ? 32 : 16);
    const sized = gb => pools.RAM.filter(i => up(i.specs.memoryType) === memoryType && i.specs.capacityGB === gb);
    // 目标容量在这个平台上没货时退一档（64 → 32 → 16）
    const targetGB = [wantGB, 32, 16].find(gb => gb <= wantGB && sized(gb).length) ?? wantGB;
    let pool = sized(targetGB);
    const dual = pool.filter(i => i.specs.modules === 2);
    if (dual.length) pool = dual;
    const fast = pool.filter(i => memoryType !== 'DDR5' || (i.specs.speedMTs ?? 0) >= 6000);
    const item = cheapestOf(fast.length ? fast : pool);
    if (item) set('RAM', item, `${memoryType} ${targetGB}GB${dual.length ? ' 双条' : ''}${fast.length && memoryType === 'DDR5' ? ' ≥6000MT/s' : ''}，满足条件里最便宜`);
  }

  // 显卡：按芯片 + 显存分组，取中位价在预算内最高的一档，再挑这一档里最便宜、长度已知的卡
  const gpuGroups = (() => {
    const groups = new Map();
    for (const i of pools.GPU) {
      if (!i.specs.chipset || !i.specs.capacityGB || !i.specs.lengthMm) continue;
      const key = `${up(i.specs.chipset).replace(/^(GEFORCE|RADEON)\s*/, '')} ${i.specs.capacityGB}GB`;
      groups.set(key, [...(groups.get(key) ?? []), i]);
    }
    const all = [...groups.entries()].filter(([, list]) => list.length >= 2).map(([key, list]) => {
      const sorted = list.map(price).sort((a, b) => a - b);
      const gaming = list.find(i => i.performance?.gaming)?.performance.gaming.index ?? null;
      // Blender 显卡分主要跑 CUDA / OptiX，可当作 AI、渲染的算力参考
      const compute = list.find(i => i.performance?.blender)?.performance.blender.score ?? null;
      return { key, list, median: sorted[Math.floor(sorted.length / 2)], current: CURRENT_GPU.test(key), gaming, compute,
        vram: list[0].specs.capacityGB, nvidia: isNvidia(key) };
    })
      // 有游戏指数的档次按指数排序（同指数按价格），否则按中位价排序
      .sort((a, b) => (a.gaming ?? -1) - (b.gaming ?? -1) || a.median - b.median);
    // 当代芯片里有在分配内的，就只在当代芯片里升降档；否则才考虑上代
    const capGpu = locked.GPU ? 0 : cap('GPU');
    if (profile.gpu === 'ai' || profile.gpu === 'creator') {
      // AI：RTX 30 系及以后的 NVIDIA（CUDA 生态，PyTorch 等开箱即用）；剪辑 / 设计：RTX（编码、渲染加速）
      // 剪辑只要 RTX（GTX 16 系没有新版编码器、RT 核心）且 ≥ 8GB 显存
      const preferred = all.filter(g => (profile.gpu === 'ai' ? AI_READY(g.key) : /^RTX\b/.test(g.key) && g.vram >= 8) && g.compute != null);
      // 硬要求：有符合条件的显卡就只在这些里挑（超分配时由整体收紧去压其他配件），目录里一张都没有才放宽
      const base = preferred.length ? preferred : all;
      // AI 先比显存（决定能跑多大的模型），再比算力；剪辑按算力；同分按价格
      return [...base].sort((a, b) => (profile.gpu === 'ai' ? a.vram - b.vram : 0)
        || (a.compute ?? -1) - (b.compute ?? -1) || a.median - b.median);
    }
    // 有游戏指数的档次里有在分配内的，就只在这些档次里比（指数与价格不能混排）
    const withGaming = all.filter(g => g.gaming != null);
    const base = withGaming.some(g => g.median <= capGpu) ? withGaming : all;
    const current = base.filter(g => g.current);
    return current.some(g => g.median <= capGpu) ? current : base;
  })();
  let gpuTier = -1;
  const pickGpu = tier => {
    const g = gpuGroups[tier];
    // 挑这一档里最便宜的，但不低于中位价的 75%：明显偏低的多半是旧价或错价（如中位 ¥16,999 的卡标 ¥10,999）
    const item = cheapestOf(g.list.filter(i => price(i) >= g.median * 0.75)) ?? cheapestOf(g.list);
    const detail = profile.gpu === 'ai'
      ? `显存 ${g.vram}GB${g.nvidia ? '，NVIDIA（CUDA）' : ''}${g.compute != null ? `，Blender 算力 ${Math.round(g.compute)}` : ''}`
      : profile.gpu === 'creator'
        ? `${g.nvidia ? 'NVIDIA，' : ''}${g.compute != null ? `Blender 渲染分 ${Math.round(g.compute)}` : '没有渲染分'}`
        : `${g.gaming != null ? `2K 游戏性能 ${g.gaming}%` : ''}${g.current ? `${g.gaming != null ? '，' : ''}当代芯片` : ''}`;
    set('GPU', item, `档次 ${g.key}（${g.list.length} 款中位价 ${yuan(g.median)}${detail ? `，${detail}` : ''}），选这一档里最便宜的一款`);
  };
  if (!locked.GPU && gpuGroups.length) {
    const c = cap('GPU');
    // 预算内性能最高的一档（有游戏指数时就是指数最高、中位价不超分配的那档）
    const byGaming = gpuGroups.some(g => g.gaming != null);
    // 列表已按（游戏指数，中位价）或中位价升序：取分配内最后一个，即性能最高的一档
    if (!byGaming && profile.gpu === 'gaming') gpuGroups.sort((a, b) => a.median - b.median);
    gpuTier = gpuGroups.reduce((best, g, idx) => (g.median <= c ? idx : best), -1);
    if (gpuTier < 0) gpuTier = 0;
    pickGpu(gpuTier);
  }

  // 电源 / 散热 / 机箱 / 硬盘依赖前面的结果，封装成函数便于显卡升降档后重算
  const fillRest = () => {
    // 电源：额定功率 ≥ max(显卡建议电源, (CPU 峰值 + 显卡功耗 + 75) × 1.25)；安静优先选金牌；挑最便宜
    if (!locked.PSU) {
      const gpu = specsOf('GPU') ?? {};
      const cpu = specsOf('CPU') ?? {};
      const est = cpu.maxPowerWatts && (gpu.maxPowerWatts ?? gpu.tdpWatts) ? Math.ceil((cpu.maxPowerWatts + (gpu.maxPowerWatts ?? gpu.tdpWatts) + 75) * 1.25) : 0;
      // 核显机功耗低，300W 起；独显机 450W 起
      // 显卡完全没有功耗数据时不能当 0W：按游戏指数保守估（旗舰级 1000W、高端 850W、中端 650W）
      const gpuIndex = picks.GPU?.item.performance?.gaming?.index ?? null;
      const unknownGpuPower = !igpu && picks.GPU && !(gpu.maxPowerWatts ?? gpu.tdpWatts) && !gpu.recommendedPsuWatts;
      const guess = !unknownGpuPower ? 0 : gpuIndex >= 100 ? 1000 : gpuIndex >= 65 ? 850 : 650;
      const need = Math.max(gpu.recommendedPsuWatts ?? 0, est, guess, igpu ? 300 : 450);
      let pool = pools.PSU.filter(i => (i.specs.ratedWatts ?? 0) >= need);
      const gold = pool.filter(i => /金|GOLD|白金|PLATINUM|钛金|TITANIUM/i.test(i.specs.efficiency ?? ''));
      if (scenarios.includes('quiet') && gold.length) pool = gold;
      const item = cheapestOf(pool);
      if (item) set('PSU', item, `需要 ≥ ${need}W${scenarios.includes('quiet') && gold.length ? '，安静优先选金牌及以上' : ''}，满足条件里最便宜`);
    }

    // 原装散热：AMD 盒装、非 X / X3D 的型号自带散热器，¥5,000 以下且不要求安静时不再另买
    const cpuItem = picks.CPU?.item;
    const stockCooler = cpuItem && budgetCents < 500000 && !scenarios.includes('quiet')
      && /盒/.test(cpuItem.specs.packaging ?? '') && /RYZEN/i.test(cpuItem.name) && !/\d{4}X/i.test(cpuItem.name);
    if (!locked.COOLER && stockCooler) {
      delete picks.COOLER;
      stockCoolerNote = `${cpuItem.name} 盒装自带散热器，低预算方案不再另买散热器。`;
    }
    // 散热：CPU 峰值 ≥ 150W 选 240/360 水冷，否则风冷塔式；插槽需支持；安静优先在预算内选最好的，否则最便宜
    if (!locked.COOLER && socket && !stockCooler) {
      const peak = specsOf('CPU')?.maxPowerWatts ?? 0;
      const wantLiquid = peak >= 150;
      const fitting = pools.COOLER.filter(i => coolerFitsSocket(i, socket));
      const liquidPool = fitting.filter(i => (i.specs.radiatorSizeMm ?? 0) >= 240);
      // 没有支持该插槽的 240mm 以上水冷时，退回风冷塔式
      const liquid = wantLiquid && liquidPool.length > 0;
      const pool = liquid ? liquidPool : fitting.filter(i => i.specs.heightMm);
      if (wantLiquid && !liquid) notes.push(`CPU 峰值约 ${peak}W，目录里没有支持 ${socket} 的 240mm 以上水冷，暂配风冷，建议手动核对散热能力。`);
      const r = scenarios.includes('quiet') ? bestWithin(pool, cap('COOLER')) : (cheapestOf(pool) ? { item: cheapestOf(pool), over: false } : null);
      if (r) set('COOLER', r.item, `${liquid ? `CPU 峰值约 ${peak}W，选 240mm 以上水冷` : '风冷塔式'}，支持 ${socket}${scenarios.includes('quiet') ? '，安静优先在预算内选最好的' : '，最便宜的一款'}`);
    }

    // 机箱：能装下主板、显卡（留 10mm 余量）、散热器或冷排；预算内估算价最高
    if (!locked.CASE) {
      const board = BOARD_RANK[up(specsOf('MOTHERBOARD')?.formFactor)] ?? 2;
      const gpuLen = specsOf('GPU')?.lengthMm ?? 0;
      const cooler = specsOf('COOLER') ?? {};
      const pool = pools.CASE.filter(i => {
        const max = BOARD_RANK[caseMaxBoard(i.specs)];
        if (!max || max < board) return false;
        if (!i.specs.maxGpuLengthMm || i.specs.maxGpuLengthMm < gpuLen + 10) return false;
        if (cooler.radiatorSizeMm) return (i.specs.maxRadiatorMm ?? 0) >= cooler.radiatorSizeMm;
        if (cooler.heightMm) return (i.specs.maxCoolerHeightMm ?? 0) >= cooler.heightMm;
        return true;
      });
      const r = bestWithin(pool, cap('CASE'));
      if (r) set('CASE', r.item, `能装下主板、${gpuLen ? `${gpuLen}mm 显卡（留 10mm）` : '显卡'}${cooler.radiatorSizeMm ? `、${cooler.radiatorSizeMm}mm 冷排` : cooler.heightMm ? `、${cooler.heightMm}mm 散热器` : ''}，预算内估算价最高`);
    }

    // 硬盘：预算 ≥ ¥10,000 选 2TB，否则 1TB；优先 PCIe 4.0 以上、读 ≥ 5000MB/s；挑最便宜
    if (!locked.SSD) {
      const near = gb => pools.SSD.filter(i => Math.abs((i.specs.capacityGB ?? 0) - gb) <= gb * 0.05);
      // ¥3,500 以下 512GB，¥10,000 以上 2TB，其余 1TB；目标容量没货时就近退一档
      let targetGB = profile.ssdGB?.(budgetCents) ?? (budgetCents >= 1000000 ? 2000 : budgetCents < 350000 ? 512 : 1000);
      let pool = near(targetGB);
      if (!pool.length && targetGB === 2000) { targetGB = 1000; pool = near(1000); }
      if (!pool.length && targetGB === 512) { targetGB = 500; pool = near(500); }
      if (!pool.length && targetGB <= 512) { targetGB = 1000; pool = near(1000); }
      const fast = pool.filter(i => /PCIE\s*[45]/i.test(i.specs.interface ?? '') && (i.specs.readMBs ?? 0) >= 5000);
      const item = cheapestOf(fast.length ? fast : pool);
      if (item) set('SSD', item, `${targetGB >= 1000 ? `${targetGB / 1000}TB` : `${targetGB}GB`}${fast.length ? ' PCIe 4.0+、读 ≥5000MB/s' : ''}，满足条件里最便宜`);
    }
  };
  fillRest();

  const total = () => lockedCents + Object.values(picks).reduce((sum, p) => sum + price(p.item), 0);

  // 超预算降显卡档次；富余超过 7% 且升一档仍在预算内则升档
  if (gpuTier >= 0) {
    while (total() > budgetCents && gpuTier > 0) {
      gpuTier--;
      pickGpu(gpuTier);
      fillRest();
    }
    while (gpuTier < gpuGroups.length - 1 && total() < budgetCents * 0.93) {
      const before = { tier: gpuTier, picks: { ...picks } };
      gpuTier++;
      pickGpu(gpuTier);
      fillRest();
      if (total() > budgetCents) {
        gpuTier = before.tier;
        Object.assign(picks, before.picks);
        break;
      }
    }
  }

  // 显卡升不上去还剩 10% 以上预算时，把余量给 CPU：同插槽（主板不用换），按用途的性能指标挑预算内最好的一颗；
  // 换了以后电源、散热会重算，总价超预算就撤回
  // 办公不升级：够用就好，省下的钱不硬花
  if (!locked.CPU && picks.CPU && total() < budgetCents * 0.9 && !['office', 'general'].includes(profile.key)) {
    const current = picks.CPU;
    const metric = profile.cpu === 'multicore' ? cpuBlender : cpuGaming;
    const limit = price(current.item) + (budgetCents - total());
    const better = bestPerfWithin(pools.CPU.filter(i => up(i.specs.socket) === socket && (!igpu || hasIntegratedGraphics(i))), limit, metric);
    if (better && better.id !== current.item.id && metric(better) > (metric(current.item) ?? -1)) {
      const before = { ...picks };
      set('CPU', better, `${current.reason}；预算还有余量，同插槽升级到${profile.cpu === 'multicore' ? `多核分 ${cpuBlender(better)}` : `游戏指数 ${cpuGaming(better)}%`}的这颗`);
      fillRest();
      if (total() > budgetCents) Object.assign(picks, before);
    }
  }

  if (stockCoolerNote) notes.push(stockCoolerNote);
  if (igpu) notes.push('核显方案：不配独立显卡，用 CPU 自带核显，适合办公、网课、轻度网游；之后想玩大型游戏可以再加显卡。');
  for (const slot of open) if (!picks[slot] && !(slot === 'COOLER' && stockCoolerNote)) notes.push(`${slot} 没有找到同时满足兼容性和价格数据的型号，请手动选择。`);
  if (total() > budgetCents) notes.push(`估算总价 ${yuan(total())} 超出预算 ${yuan(total() - budgetCents)}，可提高预算或手动降低某项。`);
  const usedGaming = gpuGroups.some(g => g.gaming != null);
  const gpuBasis = profile.gpu === 'ai' ? '先比显存再比算力（优先 NVIDIA RTX 30 系及以后）'
    : profile.gpu === 'creator' ? '按渲染算力（优先 NVIDIA）' : usedGaming ? '按 2K 游戏指数' : '按估算价';
  const cpuBasis = profile.cpu === 'multicore' ? 'Blender 多核分' : picks.CPU?.item.performance?.gaming ? '游戏指数' : ' Blender 多核渲染分';
  notes.push(`价格为参考价估算，不是报价。CPU 按${cpuBasis}挑选；显卡${gpuBasis}判断档次。`);
  if (profile.gpu === 'ai' && picks.GPU) {
    // 4-bit 量化大约每 10 亿参数 0.6GB，再留出上下文缓存：粗略对照，具体看模型和框架
    const vram = picks.GPU.item.specs.capacityGB;
    const fits = vram >= 24 ? '30B 左右的模型（4-bit 量化）' : vram >= 16 ? '14B–20B 的模型（4-bit 量化）' : vram >= 12 ? '7B–14B 的模型（4-bit 量化）' : '7B 左右的小模型（4-bit 量化）';
    notes.push(`显存 ${vram}GB：本地推理大约能跑 ${fits}；训练和微调更吃显存，同样的显存能训练的模型要小得多。数字只是粗略参考。`);
    if (!isNvidia(up(picks.GPU.item.specs.chipset).replace(/^(GEFORCE|RADEON)\s*/, ''))) notes.push('这个预算里放不下合适的 NVIDIA 显卡，用的是 AMD / Intel：多数 AI 框架对它们的支持不如 CUDA 完善，建议提高预算。');
  }

  return {
    budgetCents,
    totalCents: total(),
    lockedCents,
    igpu,
    stockCooler: !!stockCoolerNote,
    picks: SLOTS.filter(s => picks[s]).map(slot => ({ slot, reason: picks[slot].reason, item: picks[slot].item })),
    notes: [...new Set(notes)],
  };
}

/**
 * 一次出三套：省钱版 / 推荐版 / 进阶版。
 * ¥3,500 以下或“办公”用途时，省钱版为核显方案；办公用途三套都不配独显。
 */
export function recommendPlans(items, { budgetCents, scenarios = [] }) {
  const office = scenarios.includes('office');
  const lowBudget = budgetCents < 350000;
  const variants = [
    { id: 'save', label: '省钱版', budget: Math.round(budgetCents * 0.8 / 10000) * 10000, igpu: office || lowBudget },
    { id: 'balanced', label: '推荐版', budget: budgetCents, igpu: office },
    { id: 'plus', label: '进阶版', budget: Math.round(budgetCents * 1.2 / 10000) * 10000, igpu: office },
  ];
  const plans = variants.map(v => {
    let r = recommend(items, { budgetCents: v.budget, scenarios, igpu: v.igpu });
    // 预算放不下独显（超出 10% 以上）时改用核显方案
    if (!v.igpu && r.totalCents > v.budget * 1.1) {
      const ig = recommend(items, { budgetCents: v.budget, scenarios, igpu: true });
      if (ig.totalCents < r.totalCents) {
        ig.notes.unshift(`这个预算放不下独立显卡（最低约 ${yuan(r.totalCents)}），改用核显方案。`);
        r = ig;
      }
    }
    return { id: v.id, label: v.label, targetCents: v.budget, ...r };
  });
  // 进阶版与推荐版配置一样时（预算再加也选不出更好的），不重复展示
  const sameAs = (a, b) => a.picks.map(p => p.item.id).join() === b.picks.map(p => p.item.id).join();
  return plans.filter((p, i) => i === 0 || !sameAs(p, plans[i - 1]));
}
