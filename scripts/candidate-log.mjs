// 候选决策日志：对指定用例，输出每张显卡在每一档的最低完整成本、显存、核心指标、评分、目标值、阻断项、是否入选与淘汰原因。
// 数据来自正式接口 /plans 返回的 meta.gpuAlternatives（与界面同一次搜索）。也可读取测试输出目录里保存的原始响应做前后对比。
// 用法：node scripts/candidate-log.mjs <预算> <用途> [策略] [--from <测试输出 JSON>]
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApiServer } from '../src/api.mjs';

export async function candidateLog({ budget, scenario, strategy = 'balanced', from }) {
  let data;
  if (from) data = JSON.parse(await readFile(from, 'utf8')).rawResponse;
  else {
    const server = createApiServer({ directory: await mkdtemp(join(tmpdir(), 'pc-log-')), catalogDirectory: resolve('.runtime') });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/plans`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ budgetCents: budget * 100, scenarios: [scenario], strategy }) });
    data = await res.json();
    server.close();
  }
  const y = c => (c == null ? '—' : `¥${Math.round(c / 100).toLocaleString('zh-CN')}`);
  const rows = [];
  for (const a of (data.meta?.gpuAlternatives ?? []).sort((x, z) => z.gpuPriceCents - x.gpuPriceCents)) {
    for (const d of a.tierDecisions) {
      rows.push({ gpu: a.name, vramGB: a.corePerformance?.vram ?? null, compute: a.corePerformance?.compute ?? null, tier: d.tier, targetCents: d.targetCents,
        minimumBuildCents: a.minimumBuildCents, bestWithinBudgetCents: d.bestWithinBudget?.totalCents ?? null, score: d.bestWithinBudget?.score?.total ?? null,
        trust: d.bestWithinBudget?.score?.parts?.trust ?? null, core: d.bestWithinBudget?.core?.value ?? null, objective: d.bestWithinBudget?.objective ?? null,
        winnerObjective: d.winnerObjective, blocking: d.bestWithinBudget?.blockingChecks ?? a.blockers ?? [], selected: d.reason.startsWith('已入选'), reason: d.reason });
    }
  }
  const md = rows.map(r => `| ${r.gpu.slice(0, 34)} | ${r.vramGB ?? '—'}GB | ${r.tier} | ${y(r.targetCents)} | ${y(r.minimumBuildCents)} | ${y(r.bestWithinBudgetCents)} | ${r.score ?? '—'} | ${r.trust ?? '—'} | ${r.core?.toFixed?.(3) ?? '—'} | ${r.objective?.toFixed?.(2) ?? '—'} / ${r.winnerObjective?.toFixed?.(2) ?? '—'} | ${r.blocking.join(', ') || '无'} | ${r.selected ? '**入选**' : r.reason} |`);
  return { rows, markdown: ['| 显卡 | 显存 | 档位 | 本档目标 | 最低完整成本 | 预算内最优组合 | 评分 | 可信度 | 核心指标 | 目标值 / 胜出者 | 阻断项 | 结果 / 未入选原因 |', '|---|---:|---|---:|---:|---:|---:|---:|---:|---|---|---|', ...md].join('\n'), plans: data.plans };
}

if (process.argv[1]?.endsWith('candidate-log.mjs')) {
  const [budget, scenario, strategy = 'balanced'] = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const fromIdx = process.argv.indexOf('--from');
  const { markdown } = await candidateLog({ budget: Number(budget), scenario, strategy, from: fromIdx > 0 ? process.argv[fromIdx + 1] : undefined });
  console.log(markdown);
}
