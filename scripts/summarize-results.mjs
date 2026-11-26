// 汇总一个测试输出目录（scripts/test-configurations.mjs 或 scripts/batch-test.mjs 的结果）：
// 推荐状态、整机兼容状态、各类配件选择分布、UNKNOWN 检查项分布、预算使用率。
// 用法：node scripts/summarize-results.mjs <目录> [--json]
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function summarize(dir) {
  const files = readdirSync(dir).filter(f => /^\d\d_.*\.json$/.test(f)).sort();
  const plans = [];
  for (const f of files) {
    const r = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    for (const p of r.rawResponse.plans) plans.push({ case: r.index, label: r.label, budgetCents: r.request.budgetCents, strategy: r.request.strategy ?? 'balanced', plan: p });
  }
  return summarizePlans(plans);
}

export function summarizePlans(plans) {
  const count = (list, key) => list.reduce((m, x) => { const k = key(x); if (k != null) m[k] = (m[k] ?? 0) + 1; return m; }, {});
  const sorted = m => Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]));
  const feasible = plans.filter(x => !x.plan.infeasible);
  const pick = (x, slot) => x.plan.picks?.find(p => p.slot === slot)?.item;
  const parts = {};
  for (const slot of ['CPU', 'GPU', 'MOTHERBOARD', 'RAM', 'SSD', 'PSU', 'CASE', 'COOLER']) {
    parts[slot] = sorted(count(feasible, x => (slot === 'COOLER' && x.plan.stockCooler ? 'CPU 原装散热器' : slot === 'GPU' && x.plan.igpu ? 'CPU 核显' : pick(x, slot)?.name ?? '—')));
  }
  const unknown = {};
  for (const x of feasible) for (const c of x.plan.compatibility?.checks ?? []) if (c.status === 'UNKNOWN') unknown[c.label] = (unknown[c.label] ?? 0) + 1;
  const ssdGB = sorted(count(feasible, x => `${pick(x, 'SSD')?.specs?.capacityGB ?? '?'}GB`));
  return {
    plans: plans.length,
    infeasible: plans.length - feasible.length,
    recommendationStatus: sorted(count(plans, x => x.plan.recommendationStatus ?? (x.plan.infeasible ? 'infeasible' : 'n/a'))),
    overall: sorted(count(feasible, x => x.plan.compatibility?.overall)),
    blockingPlans: feasible.filter(x => x.plan.assessment?.blockingChecks?.length).length,
    sameAs: feasible.filter(x => x.plan.sameAs).length,
    overTarget: feasible.filter(x => x.plan.totalCents > x.plan.targetCents).length,
    budgetUse: feasible.map(x => ({ case: x.case, label: x.label, strategy: x.strategy, tier: x.plan.id, totalCents: x.plan.totalCents, targetCents: x.plan.targetCents, inputUse: +(x.plan.totalCents / x.budgetCents).toFixed(3), score: x.plan.score?.total ?? null })),
    ssdCapacity: ssdGB,
    distinct: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, Object.keys(v).length])),
    parts,
    unknownChecks: sorted(unknown),
  };
}

if (import.meta.url === `file:///${process.argv[1].replaceAll('\\', '/')}` || process.argv[1]?.endsWith('summarize-results.mjs')) {
  const [dir] = process.argv.slice(2);
  const s = summarize(dir);
  if (process.argv.includes('--json')) console.log(JSON.stringify(s, null, 2));
  else {
    const { budgetUse, parts, ...head } = s;
    console.log(JSON.stringify(head, null, 1));
    for (const [slot, m] of Object.entries(parts)) console.log(slot, JSON.stringify(Object.entries(m).slice(0, 4)));
  }
}
