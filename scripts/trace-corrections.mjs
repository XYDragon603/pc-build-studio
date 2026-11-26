// 数据治理核对：逐条检查 data/hardware-corrections.json 是否进入运行时目录、推荐引擎与兼容检查。
// 输出：每条修正记录 → 目录 ID 是否存在 → 运行时字段是否与修正值一致 → 是否在 forPlans（自动配置）候选内。
// 用法：node scripts/trace-corrections.mjs [--json]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createCatalog } from '../src/catalog.mjs';

const corrections = JSON.parse(readFileSync(new URL('../data/hardware-corrections.json', import.meta.url), 'utf8'));
const catalog = createCatalog(fileURLToPath(new URL('../.runtime', import.meta.url)));
const byId = new Map(catalog.all().map(i => [i.id, i]));
const forPlans = i => i.market === 'cn' && !i.possiblyStale && !i.workstation && i.estimateBasis !== 'series-low' && i.estimateBasis !== 'class-median';
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const rows = corrections.records.map(r => {
  const item = byId.get(r.id) ?? (r.mpn ? catalog.all().find(i => i.mpn && r.mpn.some(sku => sku.toUpperCase() === String(i.mpn).toUpperCase())) : undefined);
  const fields = Object.entries(r.specs).map(([k, v]) => ({ field: k, corrected: v, runtime: item?.specs?.[k] ?? null, applied: item ? same(item.specs?.[k], v) : false }));
  return { id: r.id, name: item?.name ?? null, category: item?.category ?? null, inCatalog: !!item, inPlanPool: item ? forPlans(item) : false,
    priced: !!item?.estimatedPriceCents, source: r.sourceUrl, fields, notApplied: fields.filter(f => !f.applied).map(f => f.field) };
});
const summary = { records: rows.length, missingFromCatalog: rows.filter(r => !r.inCatalog).map(r => r.id), notInPlanPool: rows.filter(r => r.inCatalog && !r.inPlanPool).map(r => `${r.id} ${r.name}`),
  fieldsTotal: rows.reduce((s, r) => s + r.fields.length, 0), fieldsNotApplied: rows.flatMap(r => r.notApplied.map(f => `${r.id}.${f}`)) };
if (process.argv.includes('--json')) console.log(JSON.stringify({ summary, rows }, null, 2));
else {
  console.log(JSON.stringify(summary, null, 1));
  for (const r of rows) console.log(`${r.inCatalog ? '✓' : '✗'} ${r.inPlanPool ? 'pool' : '    '} ${r.id} ${r.category ?? ''} ${(r.name ?? '（目录中不存在）').slice(0, 40)} · ${r.fields.length} 字段${r.notApplied.length ? ` · 未生效：${r.notApplied.join(',')}` : ''}`);
}
