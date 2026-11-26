// 两轮 12 组配置测试的统计对比（V2.2.2）：机箱 / 散热器 / 电源分布、推荐状态、阻断项、附件成本、预算余量、关键检查状态。
// 用法：node scripts/compare-runs.mjs <基线目录> <新目录> [--json]
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const load = dir => readdirSync(dir).filter(f => /^\d\d_.*\.json$/.test(f)).sort().flatMap(f => {
  const j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  return j.rawResponse.plans.map(p => ({ file: f, ...(p.infeasible ? { ...p.alternative, id: p.id, recommendationStatus: 'over_budget_alternative', targetCents: p.targetCents } : p) }));
});
const name = (p, slot) => p.picks?.find(x => x.slot === slot)?.item?.name ?? (slot === 'COOLER' && p.stockCooler ? '原装散热' : slot === 'GPU' && p.igpu ? '核显' : '—');
const count = (list, f) => Object.entries(list.reduce((m, x) => { const k = f(x); m[k] = (m[k] ?? 0) + 1; return m; }, {})).sort((a, b) => b[1] - a[1]);
function stats(plans) {
  const check = (p, id) => p.compatibility?.checks?.find(c => c.id === id);
  const fanText = p => (p.compatibility?.checks ?? []).some(c => /另购.*未计入|未计入总价）/.test(c.detail));
  const extra = p => (p.additionalCosts ?? []).reduce((s, x) => s + x.priceCents, 0);
  return {
    plans: plans.length,
    status: Object.fromEntries(count(plans, p => p.recommendationStatus)),
    overall: Object.fromEntries(count(plans, p => p.compatibility?.overall)),
    withBlocking: plans.filter(p => p.compatibility?.checks?.some(c => c.blocking)).length,
    blockingChecks: Object.fromEntries(count(plans.flatMap(p => (p.compatibility?.checks ?? []).filter(c => c.blocking).map(c => ({ id: c.id }))), x => x.id)),
    cases: count(plans, p => name(p, 'CASE')), coolers: count(plans, p => name(p, 'COOLER')), psus: count(plans, p => name(p, 'PSU')).slice(0, 6),
    cpuCooling: Object.fromEntries(count(plans, p => `${check(p, 'cpuCooling')?.status}/${check(p, 'cpuCooling')?.evidence?.level ?? (/尺寸|塔高/.test(check(p, 'cpuCooling')?.detail ?? '') ? 'size-inference' : 'n/a')}`)),
    gpuCable: Object.fromEntries(count(plans.filter(p => check(p, 'gpuCable')), p => check(p, 'gpuCable').status)),
    gpuPower: Object.fromEntries(count(plans, p => check(p, 'gpuPower')?.status ?? 'n/a')),
    ssdPcie: Object.fromEntries(count(plans, p => check(p, 'ssdPcie')?.status ?? 'n/a')),
    memorySpeed: Object.fromEntries(count(plans, p => check(p, 'memorySpeed')?.status ?? 'n/a')),
    fanCostTextNotCounted: plans.filter(fanText).length,
    withAccessoryCost: plans.filter(p => extra(p) > 0).length,
    accessoryTotalYuan: plans.reduce((s, p) => s + extra(p), 0) / 100,
    within100OfTarget: plans.filter(p => p.targetCents - p.totalCents >= 0 && p.targetCents - p.totalCents < 10000).length,
  };
}
const [a, b] = process.argv.slice(2);
const A = load(a); const B = load(b);
const out = { baseline: { dir: a, ...stats(A) }, current: { dir: b, ...stats(B) },
  balanced: A.filter(p => p.id === 'balanced').map((p, i) => { const q = B.filter(x => x.id === 'balanced')[i]; return { case: p.file.slice(0, 2), before: { total: p.totalCents / 100, gpu: name(p, 'GPU'), cpu: name(p, 'CPU'), cooler: name(p, 'COOLER'), case: name(p, 'CASE') }, after: { total: q.totalCents / 100, core: (q.coreTotalCents ?? q.totalCents) / 100, gpu: name(q, 'GPU'), cpu: name(q, 'CPU'), cooler: name(q, 'COOLER'), case: name(q, 'CASE'), blocking: q.compatibility.checks.filter(c => c.blocking).map(c => c.id) } }; }) };
if (process.argv.includes('--json')) console.log(JSON.stringify(out, null, 2));
else console.log(JSON.stringify(out, null, 1));
