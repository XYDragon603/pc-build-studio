// 关键风险驱动的局部替换搜索（2.2.3）。
//
// 2.2.2 能识别阻断性风险（如 16pin 线材额定未知、供电线空间未知、CPU 散热证据不足），但每套整机的电源 / 机箱 / 散热器
// 由补件器各自独立挑一次，挑完不再回头：最终方案保留了风险，也没有说明是否存在能消除风险的替代配件。
//
// 流程：初始整机 → 全量检查 → 提取阻断项及涉及的配件槽 → 保留 CPU / 显卡（核心性能）与用户锁定的配件 →
// 对涉及的槽逐个替换（其余不变），再对每槽前几名做联合搜索 → 每个组合重新执行完整兼容检查与完整成本 →
// 按“阻断项数 → 关键待核实数 → 完整成本”选出，记录每个候选的淘汰原因。不改 CPU / 显卡，因此不会靠降低显卡档位消除风险。

/** 阻断检查 → 可以通过替换解决的配件槽 */
export const RISK_SLOTS = {
  gpuPower: ['PSU'], psuWatts: ['PSU'], psu12v: ['PSU'], psuFormat: ['PSU', 'CASE'], psuLength: ['PSU', 'CASE'], psuCable: ['PSU', 'CASE'],
  gpuCable: ['CASE'], gpuHeight: ['CASE'], gpuLength: ['CASE'], gpuThickness: ['CASE'], gpuSlots: ['CASE'], boardFit: ['CASE'],
  caseAirflow: ['CASE'], coolerHeight: ['COOLER', 'CASE'], radiator: ['COOLER', 'CASE'], radiatorLayout: ['COOLER', 'CASE'],
  cpuCooling: ['COOLER'], coolerSocket: ['COOLER'],
};
const SLOT_KEY = { PSU: 'psu', CASE: 'case', COOLER: 'cooler' };
const LIMITS = { PSU: 16, CASE: 24, COOLER: 16 };
const JOINT_TOP = 5;
const name = v => (v === 'STOCK' ? '原装散热' : v?.name ?? '—');
const idOf = v => (v === 'STOCK' ? 'STOCK' : v?.id);

/**
 * @param best    已选出的整机（optimizer 内部 build 对象）
 * @param ctx     { rebuild, repairPools, workload, locked, budgetLimit }
 * @returns { build, log }：build 为替换后的整机（无改进时为原整机），log 为完整替换记录
 */
export function repairRisks(best, { rebuild, repairPools, workload = {}, locked = {}, budgetLimit = Infinity, budgetOf = b => b.total }) {
  const blocking = best.risk?.blockingChecks ?? [];
  const log = { initial: summary(best), blockingChecks: blocking, slots: {}, combosEvaluated: 0, result: 'none', replacements: [] };
  if (!blocking.length) return { build: best, log };
  const slots = [...new Set(blocking.flatMap(id => RISK_SLOTS[id] ?? []))].filter(s => !locked[s]);
  const unfixable = blocking.filter(id => !(RISK_SLOTS[id] ?? []).some(s => !locked[s]));
  log.searchedSlots = slots; log.notReplaceable = unfixable;
  if (!slots.length) { log.result = 'unresolved'; log.reason = '阻断项不涉及可替换的电源 / 机箱 / 散热器（或相关配件已锁定）'; return { build: best, log }; }
  const key = b => [b.risk.blockingChecks.length, b.checks.filter(c => c.status === 'UNKNOWN' && c.critical).length, b.total];
  const better = (a, b) => { const x = key(a); const y = key(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i]; return false; };
  const evalCount = () => log.combosEvaluated++;

  // 阶段 1：单槽替换。候选因与另一配件冲突而 FAIL（如换机箱后散热器超高）时，把那个配件槽也加入搜索（关联配件）
  const ranked = {};
  const failSlots = new Set();
  for (let si = 0; si < slots.length; si++) {
    const slot = slots[si];
    const current = best[SLOT_KEY[slot]];
    const pool = repairPools[slot](best, workload).slice(0, LIMITS[slot]);
    if (!pool.some(p => idOf(p) === idOf(current))) pool.push(current);
    const rec = { candidates: pool.length, eliminated: {}, improving: 0 };
    const results = [];
    const linkedFails = []; // 只因其他配件槽冲突而 FAIL 的候选：留给联合搜索
    for (const cand of pool) {
      if (idOf(cand) === idOf(current)) { results.push({ cand, b: best }); continue; }
      evalCount();
      const nb = rebuild(best, { [SLOT_KEY[slot]]: cand }, workload);
      if (nb.failed) {
        bump(rec.eliminated, `不兼容：${nb.failed.join(',')}`);
        const others = nb.failed.flatMap(id => (RISK_SLOTS[id] ?? []).filter(s => s !== slot && !locked[s]));
        for (const s of others) if (!slots.includes(s)) failSlots.add(s);
        if (nb.failed.every(id => (RISK_SLOTS[id] ?? []).some(s => s !== slot && !locked[s]))) linkedFails.push(cand);
        continue;
      }
      if (budgetOf(nb) > budgetLimit) { bump(rec.eliminated, '超出本档预算'); continue; }
      const left = nb.risk.blockingChecks;
      if (left.length >= blocking.length) bump(rec.eliminated, left.length ? `仍有阻断项：${left.join(',')}` : '没有改善');
      else rec.improving++;
      results.push({ cand, b: nb });
    }
    results.sort((x, y) => (better(x.b, y.b) ? -1 : better(y.b, x.b) ? 1 : 0));
    ranked[slot] = [...results.slice(0, JOINT_TOP).map(r => r.cand), ...linkedFails.slice(0, JOINT_TOP)];
    rec.bestSingle = results[0] ? { part: name(results[0].cand), blockingChecks: results[0].b.risk.blockingChecks, totalCents: results[0].b.total } : null;
    log.slots[slot] = rec;
    if (si === slots.length - 1 && failSlots.size) { for (const s of failSlots) slots.push(s); log.linkedSlots = [...(log.linkedSlots ?? []), ...failSlots]; failSlots.clear(); }
  }

  // 阶段 2：涉及多个槽时，对每槽前几名联合搜索（电源长度 × 机箱、散热器高度 × 机箱等存在交互）
  let winner = best;
  const combos = cartesian(slots.map(s => ranked[s].map(c => [s, c])));
  for (const combo of combos) {
    const overrides = Object.fromEntries(combo.map(([s, c]) => [SLOT_KEY[s], c]));
    if (combo.every(([s, c]) => idOf(c) === idOf(best[SLOT_KEY[s]]))) continue;
    evalCount();
    const nb = rebuild(best, overrides, workload);
    if (nb.failed || budgetOf(nb) > budgetLimit) continue;
    if (better(nb, winner)) winner = nb;
  }
  log.replacements = Object.values(SLOT_KEY).filter(k => idOf(winner[k]) !== idOf(best[k])).map(k => ({ slot: k, from: name(best[k]), to: name(winner[k]), fromCents: best[k] === 'STOCK' ? 0 : best[k]?.estimatedPriceCents ?? null, toCents: winner[k] === 'STOCK' ? 0 : winner[k]?.estimatedPriceCents ?? null }));
  const left = winner.risk.blockingChecks;
  log.result = !log.replacements.length ? 'unresolved' : !left.length ? 'resolved' : left.length < blocking.length ? 'reduced' : 'cost-only';
  if (log.result === 'cost-only') { winner = best; log.replacements = []; log.result = 'unresolved'; }
  log.final = summary(winner);
  if (log.result === 'unresolved') log.reason = `在 ${slots.join(' / ')} 的 ${Object.values(log.slots).reduce((s, r) => s + r.candidates, 0)} 个候选与 ${log.combosEvaluated} 个组合中没有能减少阻断项的替代（主要原因见各槽淘汰统计，多为目录缺少对应字段，例如机箱 16pin 供电线空间、电源线材额定）`;
  return { build: winner, log };
}

function summary(b) {
  return { totalCents: b.total, coreTotalCents: b.coreTotal ?? b.total, blockingChecks: b.risk?.blockingChecks ?? [],
    parts: { CPU: name(b.cpu), GPU: b.igpu ? '核显' : name(b.gpu), MOTHERBOARD: name(b.board), RAM: name(b.ram), SSD: name(b.ssd), PSU: name(b.psu), CASE: name(b.case), COOLER: name(b.cooler) } };
}
const bump = (o, k) => { o[k] = (o[k] ?? 0) + 1; };
const cartesian = lists => lists.reduce((acc, list) => acc.flatMap(a => list.map(x => [...a, x])), [[]]);
