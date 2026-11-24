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
  const s = { ...BASE_SHARES };
  if (!scenarios.includes('2k') && !scenarios.includes('4k')) for (const [k, d] of Object.entries(GENERAL_SHIFT)) s[k] += d;
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

/**
 * @param items  目录条目（含 estimatedPriceCents）
 * @param input  { budgetCents, scenarios, locked: { [SLOT]: { priceCents, specs } } }
 */
export function recommend(items, { budgetCents, scenarios = [], locked = {} }) {
  const pools = Object.fromEntries(SLOTS.map(s => [s, items.filter(i => i.category === s && price(i) > 0)]));
  const notes = [];
  const picks = {};
  const lockedCents = Object.values(locked).reduce((sum, p) => sum + (p.priceCents ?? 0), 0);
  const open = SLOTS.filter(s => !locked[s]);
  const weights = shares(scenarios);
  const weightSum = open.reduce((sum, s) => sum + weights[s], 0) || 1;
  const available = budgetCents - lockedCents;
  if (available <= 0) return { picks: [], totalCents: lockedCents, budgetCents, notes: ['已锁定配件已用完预算，没有可分配的金额。'] };
  const cap = slot => Math.round((available * weights[slot]) / weightSum);

  /** 已选（含锁定）配件的规格 */
  const specsOf = slot => locked[slot]?.specs ?? picks[slot]?.item.specs ?? null;
  const set = (slot, item, reason) => { picks[slot] = { item, reason }; };

  // CPU
  if (!locked.CPU) {
    const pool = pools.CPU.filter(i => i.specs.socket && /^(AM5|AM4|LGA1700|LGA1851)$/.test(up(i.specs.socket)));
    const r = bestWithin(pool, cap('CPU'));
    if (r) set('CPU', r.item, `分配 ${yuan(cap('CPU'))}，选预算内估算价最高的 CPU${r.over ? '（预算不足，取最便宜的）' : ''}`);
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
    const targetGB = budgetCents >= 600000 ? 32 : 16;
    let pool = pools.RAM.filter(i => up(i.specs.memoryType) === memoryType && i.specs.capacityGB === targetGB);
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
    return [...groups.entries()].filter(([, list]) => list.length >= 2).map(([key, list]) => {
      const sorted = list.map(price).sort((a, b) => a - b);
      return { key, list, median: sorted[Math.floor(sorted.length / 2)] };
    }).sort((a, b) => a.median - b.median);
  })();
  let gpuTier = -1;
  const pickGpu = tier => {
    const g = gpuGroups[tier];
    const item = cheapestOf(g.list);
    set('GPU', item, `档次 ${g.key}（${g.list.length} 款中位价 ${yuan(g.median)}），选这一档里最便宜的一款`);
  };
  if (!locked.GPU && gpuGroups.length) {
    const c = cap('GPU');
    gpuTier = gpuGroups.reduce((best, g, idx) => (g.median <= c ? idx : best), 0);
    pickGpu(gpuTier);
  }

  // 电源 / 散热 / 机箱 / 硬盘依赖前面的结果，封装成函数便于显卡升降档后重算
  const fillRest = () => {
    // 电源：额定功率 ≥ max(显卡建议电源, (CPU 峰值 + 显卡功耗 + 75) × 1.25)；安静优先选金牌；挑最便宜
    if (!locked.PSU) {
      const gpu = specsOf('GPU') ?? {};
      const cpu = specsOf('CPU') ?? {};
      const est = cpu.maxPowerWatts && (gpu.maxPowerWatts ?? gpu.tdpWatts) ? Math.ceil((cpu.maxPowerWatts + (gpu.maxPowerWatts ?? gpu.tdpWatts) + 75) * 1.25) : 0;
      const need = Math.max(gpu.recommendedPsuWatts ?? 0, est, 450);
      let pool = pools.PSU.filter(i => (i.specs.ratedWatts ?? 0) >= need);
      const gold = pool.filter(i => /金|GOLD|白金|PLATINUM|钛金|TITANIUM/i.test(i.specs.efficiency ?? ''));
      if (scenarios.includes('quiet') && gold.length) pool = gold;
      const item = cheapestOf(pool);
      if (item) set('PSU', item, `需要 ≥ ${need}W${scenarios.includes('quiet') && gold.length ? '，安静优先选金牌及以上' : ''}，满足条件里最便宜`);
    }

    // 散热：CPU 峰值 ≥ 150W 选 240/360 水冷，否则风冷塔式；插槽需支持；安静优先在预算内选最好的，否则最便宜
    if (!locked.COOLER && socket) {
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
      const targetGB = budgetCents >= 1000000 ? 2000 : 1000;
      const pool = pools.SSD.filter(i => Math.abs((i.specs.capacityGB ?? 0) - targetGB) <= targetGB * 0.05);
      const fast = pool.filter(i => /PCIE\s*[45]/i.test(i.specs.interface ?? '') && (i.specs.readMBs ?? 0) >= 5000);
      const item = cheapestOf(fast.length ? fast : pool);
      if (item) set('SSD', item, `${targetGB >= 1000 ? `${targetGB / 1000}TB` : `${targetGB}GB`}${fast.length ? ' PCIe 4.0+、读 ≥5000MB/s' : ''}，满足条件里最便宜`);
    }
  };
  fillRest();

  const total = () => lockedCents + Object.values(picks).reduce((sum, p) => sum + price(p.item), 0);

  // 超预算降显卡档次；富余超过 15% 且升一档仍在预算内则升档
  if (gpuTier >= 0) {
    while (total() > budgetCents && gpuTier > 0) {
      gpuTier--;
      pickGpu(gpuTier);
      fillRest();
    }
    while (gpuTier < gpuGroups.length - 1 && total() < budgetCents * 0.85) {
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

  for (const slot of open) if (!picks[slot]) notes.push(`${slot} 没有找到同时满足兼容性和价格数据的型号，请手动选择。`);
  if (total() > budgetCents) notes.push(`估算总价 ${yuan(total())} 超出预算 ${yuan(total() - budgetCents)}，可提高预算或手动降低某项。`);
  notes.push('价格为参考价估算，不是报价；档次按估算价判断，没有使用性能跑分。');

  return {
    budgetCents,
    totalCents: total(),
    lockedCents,
    picks: SLOTS.filter(s => picks[s]).map(slot => ({ slot, reason: picks[slot].reason, item: picks[slot].item })),
    notes: [...new Set(notes)],
  };
}
