// V2.2.1 批量测试：走真实 POST /api/v1/plans（隔离存储、本机目录），不需要逐一点击页面。
//   基础矩阵：12 组场景 × 3 种策略（value / balanced / performance）× 每组三档 = 108 套
//   额外测试：严格预算、锁定显卡、锁定主板、安静优先、包含外设、手动改价、指定 SSD 最低容量、指定 AI 显存、
//            仅全新商品（与允许改装对照）、极端低预算与高预算
// 每套方案检查不变量（兼容无 FAIL、总价 = 配件 + 附加费用 + 外设、商品状态、升级说明与实际配置一致……），
// 结果写入 <输出目录>/batch-results.json（机器可读）与 batch-summary.md。
// 用法：node scripts/batch-test.mjs [输出目录，默认 配置/批量测试_<日期>]
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApiServer } from '../src/api.mjs';
import { summarizePlans } from './summarize-results.mjs';

const CASES = [
  [2000, 'office', '办公学习'], [3500, '1080p', '1080p 电竞'], [5000, '2k', '2K 游戏'], [6000, '2k', '2K 游戏'], [8000, '2k', '2K 游戏'],
  [10000, '4k', '4K 光追游戏'], [15000, '4k', '4K 光追游戏'], [6000, 'creator', '视频剪辑 设计'], [10000, 'creator', '视频剪辑 设计'],
  [8000, 'ai', 'AI 机器学习'], [20000, 'ai', 'AI 机器学习'], [30000, 'ai', 'AI 机器学习'],
];
const STRATEGIES = ['value', 'balanced', 'performance'];
const output = resolve(process.argv[2] ?? join('配置', `批量测试_${new Date().toISOString().slice(0, 10)}`));
await mkdir(output, { recursive: true });

const server = createApiServer({ directory: await mkdtemp(join(tmpdir(), 'pc-batch-')), catalogDirectory: resolve('.runtime') });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/api/v1`;
const call = async (path, body, method = 'POST') => {
  const res = await fetch(base + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: res.status === 204 ? null : await res.json() };
};

const SLOT_KEYS = ['CPU', 'GPU', 'MOTHERBOARD', 'RAM', 'SSD', 'PSU', 'CASE', 'COOLER'];
const pick = (p, slot) => p.picks?.find(x => x.slot === slot)?.item;
const cap = (p, slot) => pick(p, slot)?.specs?.capacityGB ?? 0;

/** 每套方案的不变量；返回失败说明列表 */
function invariants(plan, prev, request) {
  const fails = [];
  if (plan.infeasible) {
    if (!plan.reasons?.length) fails.push('无解但没有原因');
    return fails;
  }
  const checks = plan.compatibility?.checks ?? [];
  if (checks.some(c => c.status === 'FAIL')) fails.push(`含不兼容项：${checks.filter(c => c.status === 'FAIL').map(c => c.id).join(',')}`);
  const parts = (plan.picks ?? []).reduce((s, x) => s + (x.item.estimatedPriceCents ?? 0), 0);
  const extra = (plan.additionalCosts ?? []).reduce((s, x) => s + x.priceCents, 0);
  const peripherals = plan.peripherals?.totalCents ?? 0;
  const locked = Object.values(request.locked ?? {}).reduce((s, x) => s + (x.priceCents ?? 0), 0);
  if (plan.totalCents !== parts + extra + peripherals + locked) fails.push(`总价 ${plan.totalCents} ≠ 配件 ${parts} + 附加 ${extra} + 外设 ${peripherals} + 锁定 ${locked}`);
  if (request.maxOverPercent === 0 && plan.totalCents > plan.targetCents) fails.push('严格预算下超出本档目标');
  for (const x of plan.picks ?? []) {
    const status = x.item.productStatus ?? 'new';
    if (status !== 'new' && !((status === 'used' || status === 'refurbished') && request.allowUsed) && !((status === 'modified' || status === 'engineering_sample') && request.allowModified)) fails.push(`${x.slot} 商品状态 ${status} 未被允许`);
  }
  for (const slot of Object.keys(request.locked ?? {})) if (pick(plan, slot)) fails.push(`锁定的 ${slot} 被替换`);
  const text = (plan.notes ?? []).join('\n');
  if (/保留显卡核心指标与内存容量/.test(text)) fails.push('仍使用固定升级说明模板');
  if (prev && !prev.infeasible && !plan.sameAs) {
    for (const [label, slot] of [['内存容量', 'RAM'], ['硬盘容量', 'SSD'], ['显卡显存', 'GPU']]) {
      if (cap(plan, slot) && cap(prev, slot) && cap(plan, slot) < cap(prev, slot) && !new RegExp(`${label}比${prev.label}低`).test(text)) fails.push(`${label}下降但说明未写明`);
    }
  }
  const minSsd = request.workload?.minSsdGB;
  if (minSsd && cap(plan, 'SSD') < minSsd * 0.93 && !(plan.unmetRequirements ?? []).some(r => /硬盘/.test(r))) fails.push('低于指定 SSD 容量却未标明');
  const minVram = request.workload?.minVramGB;
  if (minVram && cap(plan, 'GPU') < minVram && !(plan.unmetRequirements ?? []).some(r => /显存/.test(r))) fails.push('低于指定显存却未标明');
  return fails;
}

const runs = [];
async function run(group, label, request, extraChecks = () => []) {
  const started = performance.now();
  const { status, data } = await call('/plans', request);
  const durationMs = Math.round(performance.now() - started);
  const plans = data?.plans ?? [];
  const failures = status !== 200 ? [`HTTP ${status}: ${JSON.stringify(data).slice(0, 200)}`] : plans.flatMap((p, i) => invariants(p, plans[i - 1], request).map(f => `${p.id}: ${f}`));
  failures.push(...(status === 200 ? extraChecks(plans, data) : []));
  const record = { group, label, request, status, durationMs, passed: failures.length === 0, failures,
    plans: plans.map(p => ({ tier: p.id, infeasible: !!p.infeasible, recommendationStatus: p.recommendationStatus, totalCents: p.totalCents, targetCents: p.targetCents,
      overall: p.compatibility?.overall ?? null, blockingChecks: p.assessment?.blockingChecks ?? [], score: p.score?.total ?? null, core: p.corePerformance?.value ?? null,
      sameAs: p.sameAs ?? null, unmet: p.unmetRequirements ?? [], parts: Object.fromEntries(SLOT_KEYS.map(s => [s, pick(p, s) ? { id: pick(p, s).id, name: pick(p, s).name, priceCents: pick(p, s).estimatedPriceCents, capacityGB: pick(p, s).specs?.capacityGB ?? null } : null])),
      stockCooler: !!p.stockCooler, igpu: !!p.igpu, additionalCosts: p.additionalCosts ?? [], notes: p.notes })) };
  runs.push({ ...record, raw: plans });
  console.log(`${record.passed ? '✓' : '✗'} [${group}] ${label} ${durationMs}ms${failures.length ? ` — ${failures.slice(0, 3).join('；')}` : ''}`);
  return { plans, data };
}

const req = (yuan, scenario, extra = {}) => ({ budgetCents: yuan * 100, scenarios: [scenario], peripherals: [], ...extra });

// 1. 基础矩阵 12 × 3
const baseByCase = {};
for (const [i, [yuan, scenario, label]] of CASES.entries()) {
  baseByCase[i] = {};
  for (const strategy of STRATEGIES) baseByCase[i][strategy] = (await run('base', `${String(i + 1).padStart(2, '0')} ${label} ¥${yuan} ${strategy}`, req(yuan, scenario, { strategy }))).plans;
  // 同一快照、同一场景、同一预算下三种策略的关系：性能优先核心 ≥ 均衡；性价比总价 ≤ 均衡
  const s = baseByCase[i];
  const rel = [];
  for (const tier of ['save', 'balanced', 'plus']) {
    const v = s.value.find(p => p.id === tier); const b = s.balanced.find(p => p.id === tier); const p = s.performance.find(x => x.id === tier);
    if ([v, b, p].some(x => !x || x.infeasible)) continue;
    if ((p.corePerformance?.value ?? 0) + 1e-9 < (b.corePerformance?.value ?? 0)) rel.push(`${tier}: 性能优先核心 < 均衡`);
    if (v.totalCents > b.totalCents) rel.push(`${tier}: 性价比总价 > 均衡`);
  }
  runs.push({ group: 'strategy-relation', label: `${String(i + 1).padStart(2, '0')} ${label} ¥${yuan}`, passed: rel.length === 0, failures: rel, plans: [] });
  console.log(`${rel.length ? '✗' : '✓'} [strategy-relation] ${label} ¥${yuan}${rel.length ? ` — ${rel.join('；')}` : ''}`);
}

// 2. 严格预算（12 组）
for (const [i, [yuan, scenario, label]] of CASES.entries()) await run('strict', `${label} ¥${yuan}`, req(yuan, scenario, { maxOverPercent: 0 }));

// 3. 锁定显卡 / 锁定主板：锁定均衡推荐版选出的配件，再要求更高预算，锁定件不得被替换且整机重新校核
for (const i of [4, 6, 11]) {
  const [yuan, scenario, label] = CASES[i];
  const b = baseByCase[i].balanced.find(p => p.id === 'balanced');
  for (const slot of ['GPU', 'MOTHERBOARD']) {
    const item = pick(b, slot);
    if (!item) continue;
    await run(`locked-${slot.toLowerCase()}`, `${label} ¥${yuan * 1.3} 锁定 ${item.name.slice(0, 30)}`,
      req(Math.round(yuan * 1.3), scenario, { locked: { [slot]: { name: item.name, priceCents: item.estimatedPriceCents, specs: item.specs } } }),
      plans => plans.filter(p => !p.infeasible).flatMap(p => (p.compatibility.checks.length < 8 ? [`${p.id}: 锁定后兼容检查项过少`] : [])));
  }
}

// 4. 安静优先
for (const i of [3, 6, 8, 11]) { const [yuan, scenario, label] = CASES[i]; await run('quiet', `${label} ¥${yuan}`, { ...req(yuan, scenario), scenarios: [scenario, 'quiet'] }); }

// 5. 包含外设
for (const i of [3, 6]) { const [yuan, scenario, label] = CASES[i]; await run('peripherals', `${label} ¥${yuan}`, req(yuan, scenario, { peripherals: ['MONITOR', 'KEYBOARD', 'MOUSE'] }),
  plans => plans.filter(p => !p.infeasible && !p.peripherals?.picks?.length).map(p => `${p.id}: 没有外设`)); }

// 6. 手动修改配件价格：把 2K ¥8000 推荐版显卡改成高价，再看是否重新搜索；最后删除记录
{
  const before = baseByCase[4].balanced.find(p => p.id === 'balanced');
  const g = pick(before, 'GPU');
  const added = await call('/prices', { componentId: g.id, priceCents: g.estimatedPriceCents * 3, sourceName: '批量测试：手动改价' });
  await run('manual-price', `2K ¥8000 ${g.name.slice(0, 24)} 改为 3 倍价`, req(8000, '2k', { priceMode: 'manual' }),
    plans => (pick(plans.find(p => p.id === 'balanced'), 'GPU')?.id === g.id ? ['改价后仍选同一显卡（未重新搜索）'] : []));
  await call(`/prices/${added.data.id}`, null, 'DELETE');
}

// 7. 指定 SSD 最低容量 / AI 显存
await run('min-ssd', '2K ¥6000 最低 2TB', req(6000, '2k', { workload: { minSsdGB: 2000 } }));
await run('min-ssd', '办公 ¥3000 最低 1TB', req(3000, 'office', { workload: { minSsdGB: 1000 } }));
await run('min-vram', 'AI ¥20000 显存 ≥24GB', req(20000, 'ai', { workload: { minVramGB: 24 } }));
await run('min-vram', 'AI ¥8000 显存 ≥24GB（预算不足，应标明未达）', req(8000, 'ai', { workload: { minVramGB: 24 } }));

// 8. 商品状态：默认仅全新 vs 允许改装
await run('new-only', 'AI ¥30000 默认（仅全新）', req(30000, 'ai'), (plans, data) => {
  const excluded = data.meta?.productStatusFilter?.excluded ?? [];
  return excluded.some(x => /48GB/.test(x.name)) ? [] : ['改装 48GB 显卡未被默认排除'];
});
await run('allow-modified', 'AI ¥30000 允许改装（对照）', req(30000, 'ai', { allowModified: true }));

// 9. 极端预算
await run('extreme', '办公 ¥1000（最低）', req(1000, 'office'));
await run('extreme', '4K ¥3000（远低于需求）', req(3000, '4k'));
await run('extreme', 'AI ¥100000', req(100000, 'ai'));
await run('extreme', '4K ¥60000', req(60000, '4k', { strategy: 'performance' }));

server.close();

const base108 = runs.filter(r => r.group === 'base').flatMap(r => r.raw.map(plan => ({ case: r.label.slice(0, 2), label: r.label, budgetCents: r.request.budgetCents, strategy: r.request.strategy, plan })));
const summary = {
  testedAt: new Date().toISOString(), runs: runs.length, passed: runs.filter(r => r.passed).length, failed: runs.filter(r => !r.passed).length,
  basePlans: base108.length, byGroup: Object.fromEntries([...new Set(runs.map(r => r.group))].map(g => [g, { runs: runs.filter(r => r.group === g).length, failed: runs.filter(r => r.group === g && !r.passed).length }])),
  base: summarizePlans(base108),
  byStrategy: Object.fromEntries(STRATEGIES.map(s => [s, summarizePlans(base108.filter(x => x.strategy === s))])),
};
await writeFile(join(output, 'batch-results.json'), JSON.stringify({ summary, runs: runs.map(({ raw, ...r }) => r) }, null, 2) + '\n');
const md = ['# V2.2.1 批量测试结果', '', `测试时间：${summary.testedAt}。命令：\`node scripts/batch-test.mjs\`。`, '',
  `共 ${summary.runs} 次请求，通过 ${summary.passed}，失败 ${summary.failed}；基础矩阵 ${summary.basePlans} 套方案。`, '',
  '| 测试组 | 请求数 | 失败 |', '|---|---:|---:|', ...Object.entries(summary.byGroup).map(([g, v]) => `| ${g} | ${v.runs} | ${v.failed} |`), '',
  '## 失败明细', '', ...runs.filter(r => !r.passed).flatMap(r => [`- [${r.group}] ${r.label}：${r.failures.join('；')}`]), runs.every(r => r.passed) ? '无' : '', ''];
await writeFile(join(output, 'batch-summary.md'), md.join('\n'));
console.log(JSON.stringify({ runs: summary.runs, passed: summary.passed, failed: summary.failed, basePlans: summary.basePlans, output }));
