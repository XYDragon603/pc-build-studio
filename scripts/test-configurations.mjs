import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import { createApiServer } from '../src/api.mjs';
import { calculateBuild, normalizeBuild, slotTypes } from '../src/builds.mjs';
import { hasIntegratedGraphics } from '../src/recommend.mjs';

// Exercise the same endpoint and catalog as the home screen; keep exports separate
// from the user's saved plans and draft. No quote/search requests are made.
const cases = [
  [2000, 'office', '办公学习'], [3500, '1080p', '1080p 电竞'],
  [5000, '2k', '2K 游戏'], [6000, '2k', '2K 游戏'], [8000, '2k', '2K 游戏'],
  [10000, '4k', '4K 光追游戏'], [15000, '4k', '4K 光追游戏'],
  [6000, 'creator', '视频剪辑 设计'], [10000, 'creator', '视频剪辑 设计'],
  [8000, 'ai', 'AI 机器学习'], [20000, 'ai', 'AI 机器学习'], [30000, 'ai', 'AI 机器学习'],
];
const output = resolve(process.env.CONFIG_OUTPUT ?? '配置');
await mkdir(output, { recursive: true });
// Reuse the actual UI conversion (including conservative size/power rounding).
const requireWeb = createRequire(new URL('../web/package.json', import.meta.url));
const esbuild = requireWeb('esbuild');
const compiled = await esbuild.build({ stdin: { contents: "export { planToBuild } from './web/src/domain/plan.ts'; export { toApiInput } from './web/src/api/mapping.ts';", resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', write: false });
const { planToBuild, toApiInput } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const testedAt = new Date().toISOString();
const money = cents => `¥${(cents / 100).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`;
const cell = text => String(text ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
const labels = { cpuSocket: 'CPU 插槽', memoryType: '内存代际', bios: 'BIOS', power: '电源功率', gpuClearance: '显卡长度', coolerClearance: '风冷高度', radiatorClearance: '水冷排尺寸', boardFit: '主板板型', gpuPowerConnector: '显卡供电接口' };
const results = [];
const backup = { format: 1, builds: [] };
const server = createApiServer({ directory: join(output, '.test-store', randomUUID()), catalogDirectory: resolve('.runtime') });
await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
const base = `http://127.0.0.1:${server.address().port}/api/v1`;
try {
  for (const [index, [yuan, scenario, label]] of cases.entries()) {
    const request = { budgetCents: yuan * 100, scenarios: [scenario], peripherals: [] };
    const start = performance.now();
    const response = await fetch(`${base}/plans`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
    assert.equal(response.status, 200);
    const rawResponse = await response.json();
    assert.ok(rawResponse.plans.length > 0);
    const durationMs = Math.round(performance.now() - start);
    const filename = `${String(index + 1).padStart(2, '0')}_${yuan}元_${label.replaceAll(' ', '_')}`;
    const variants = [];
    const markdown = [`# ${yuan} 元 · ${label}`, '', '安静优先：关闭；顺带配外设：关闭。', '', '以下为本地目录估算价，不是实时商城报价。省钱版和进阶版使用程序各自的目标预算，另列与输入预算的差额。', ''];
    for (const plan of rawResponse.plans) {
      assert.equal(plan.peripherals, undefined);
      assert.ok(plan.picks.every(p => p.item.market === 'cn'));
      const input = toApiInput(planToBuild(plan, request.budgetCents, request.scenarios));
      input.name = `${String(index + 1).padStart(2, '0')} · ${yuan}元 · ${label} · ${plan.label}`;
      const build = calculateBuild({ ...normalizeBuild(input), id: randomUUID(), version: 1, createdAt: testedAt, updatedAt: testedAt });
      assert.equal(build.totals.totalCents, plan.totalCents);
      assert.equal(build.totals.peripheralCents, 0);
      assert.equal(build.totals.unknownPriceCount, 0);
      assert.deepEqual(build.scenarios, [scenario]);
      const missing = build.slots.filter(s => !s.part).map(s => s.label);
      // 统一兼容性规则（五态）：方案本身的结果，以及转成可保存配置后再算一遍（前后端同一套规则，应一致）
      const planChecks = plan.compatibility?.checks ?? [];
      const byStatus = status => planChecks.filter(c => c.status === status).map(c => c.label);
      const conflicts = byStatus('FAIL'), conditional = byStatus('CONDITIONAL'), unknowns = byStatus('UNKNOWN');
      const savedOverall = build.compatibility.overall ?? null;
      assert.ok(!planChecks.some(c => c.status === 'FAIL'));
      if (!plan.infeasible) assert.ok(!build.compatibility.checks.some(c => c.status === 'FAIL'));
      const cpu = plan.picks.find(p => p.slot === 'CPU')?.item;
      if (plan.igpu && cpu && !hasIntegratedGraphics(cpu)) conflicts.push('核显方案 CPU 没有核显');
      const withinTarget = plan.totalCents <= plan.targetCents;
      const infeasible = !!plan.infeasible;
      const constraintsSatisfied = !infeasible && !missing.length && !conflicts.length && withinTarget;
      const passed = constraintsSatisfied && plan.compatibility?.overall === 'PASS' && !(plan.unmetRequirements?.length);
      const checks = { passed, constraintsSatisfied, infeasible, complete: !missing.length, missing, withinTarget, withinInputBudget: plan.totalCents <= request.budgetCents,
        inputBudgetDifferenceCents: request.budgetCents - plan.totalCents, overall: plan.compatibility?.overall ?? null, savedOverall, conflicts, conditional, unknowns,
        score: plan.score?.total ?? null, sameAs: plan.sameAs ?? null };
      const variant = { id: plan.id, label: plan.label, targetCents: plan.targetCents, igpu: plan.igpu, stockCooler: plan.stockCooler, recommendationStatus: plan.recommendationStatus, assessment: plan.assessment, corePerformance: plan.corePerformance, formalRecommendation: plan.formalRecommendation, checks, build };
      variants.push(variant);
      if (infeasible) {
        markdown.push(`## ${plan.label}`, '', `目标预算：${money(plan.targetCents)}。**这一档没有可行方案。**`, '', ...(plan.reasons ?? []).map(r => `- ${r}`),
          plan.minFeasibleCents ? `
能找到的最低完整配置约 ${money(plan.minFeasibleCents)}。` : '', ...(plan.suggestions ?? []).map(r => `- 建议：${r}`), '');
        continue;
      }
      backup.builds.push(build);
      const statusText = { PASS: '已确认通过', CONDITIONAL: '条件通过，需满足指定条件', UNKNOWN: '数据不足，待核实', FAIL: '不兼容' }[checks.overall] ?? '无结论';
      markdown.push(`## ${plan.label}`, '', `目标预算：${money(plan.targetCents)}；估算合计：${money(plan.totalCents)}；输入预算余额：${money(checks.inputBudgetDifferenceCents)}；本档目标预算余额：${money(plan.targetCents - plan.totalCents)}。`, '', `方案类别：${plan.recommendationStatus}；正式已确认推荐：${plan.formalRecommendation ? '是' : '否'}。`, '', '| 配件 | 型号 | 估算价格 |', '|---|---|---:|', ...build.slots.map(s => `| ${s.label} | ${cell(s.part?.model ?? '缺失')} | ${s.part ? money(s.part.priceCents) : '—'} |`), '', `综合评分：${plan.score?.total ?? '—'}${plan.sameAs ? '（与上一档相同）' : ''}；规则版本：${plan.score?.version ?? '未知'}（版本号，不是数据采集日期）。`, '', `兼容性：${checks.overall} — ${statusText}。${!withinTarget ? '超出本档目标预算，仅为替代方案。' : ''}${conflicts.length ? `不兼容：${conflicts.join('、')}。` : ''}`, '', `需满足条件：${conditional.join('、') || '无'}。待核实：${unknowns.join('、') || '无'}。`, '', '| 检查项目 | 状态 | 风险 | 需先核实 | 证据 / 条件 |', '|---|---|---|---|---|', ...planChecks.map(c => `| ${c.label} | ${c.status} | ${c.severity ?? '—'} | ${c.blocking ? '是' : '—'} | ${cell(c.detail)} |`), '', ...plan.notes.map(n => `- ${n}`), '', '选件依据及价格观察时间：', '', ...plan.picks.map(p => `- ${slotTypes.find(s => s.id === p.slot)?.label ?? p.slot}：${p.reason}；价格观察时间 ${p.item.priceObservedAt ?? '未知'}；性能数据日期 ${p.item.performance?.gaming?.observedAt ?? p.item.performance?.blender?.observedAt ?? '未标注，见数据来源快照'}。`), '');
    }
    const strictResponse = await fetch(`${base}/plans`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...request, maxOverPercent: 0 }) }).then(r => r.json());
    assert.ok(Array.isArray(strictResponse.plans));
    assert.ok(strictResponse.plans.every(p => p.infeasible || p.totalCents <= p.targetCents));
    assert.ok(strictResponse.plans.every(p => !p.compatibility?.checks.some(c => c.status === 'FAIL')));
    const strategyResponses = {};
    if (process.env.V22_RETEST && [6, 10, 11].includes(index)) {
      for (const strategy of ['value', 'performance']) {
        const response = await fetch(`${base}/plans`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...request, strategy, maxOverPercent: 0 }) });
        assert.equal(response.status, 200);
        strategyResponses[strategy] = await response.json();
        assert.ok(strategyResponses[strategy].plans.every(p => p.infeasible || p.totalCents <= p.targetCents));
      }
    }
    let measuredResponse;
    if (process.env.V22_RETEST && [6, 10].includes(index)) {
      const workload = index === 6 ? { task: 'rayTracing', benchmarkId: 'gn-2025-wukong-4k-rt-upscaled' }
        : { task: 'llm', benchmarkId: 'puget-2025-llamacpp-phi3-generation', model: 'Phi-3 Mini Q4_K_M' };
      const response = await fetch(`${base}/plans`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...request, strategy: 'performance', workload, maxOverPercent: 0 }) });
      assert.equal(response.status, 200);
      const { plans, meta } = await response.json();
      const comparable = plans.find(p => p.id === 'balanced').corePerformance.benchmark;
      assert.equal(comparable.id, workload.benchmarkId);
      assert.ok(plans.every(p => p.infeasible || (p.totalCents <= p.targetCents && (!p.corePerformance?.benchmark || p.corePerformance.benchmark.id === workload.benchmarkId))));
      measuredResponse = { plans, strategy: meta.strategy, workload: meta.workload, elapsedMs: meta.elapsedMs };
    }
    const result = { index: index + 1, label, testedAt, request, durationMs, rawResponse, strictResponse, strategyResponses, measuredResponse, variants };
    results.push(result);
    await writeFile(join(output, `${filename}.json`), JSON.stringify(result, null, 2) + '\n');
    if (process.env.V22_RETEST) {
      markdown.splice(2, 0, `生成时间 ${testedAt}`, '');
      for (const plan of rawResponse.plans.filter(p => !p.infeasible)) {
        if (plan.assessment) markdown.push(`- ${plan.label} · 预算 ${plan.assessment.budget} · 需求 ${plan.assessment.requirements} · 物理 ${plan.assessment.physical} · 安全 ${plan.assessment.safety}`);
        for (const option of plan.upgrades ?? []) markdown.push(`- 预算内升级 ${option.picks.find(p => p.slot === 'GPU')?.item.name ?? option.picks[0]?.item.name} · ${money(option.totalCents)} · ${option.reason}`);
      }
    }
    await writeFile(join(output, `${filename}.md`), markdown.join('\n'));
    await mkdir(join(output, '候选日志'), { recursive: true });
    await writeFile(join(output, '候选日志', `${filename}.json`), JSON.stringify(rawResponse.meta, null, 2) + '\n');
    console.log(JSON.stringify({ case: index + 1, budget: yuan, scenario, durationMs, variants: variants.map(v => ({ tier: v.id, total: v.build.totals.totalCents / 100, ...v.checks })) }));
  }
  // Validate actual restore/read/backup behavior in an isolated store.
  const restoredResponse = await fetch(`${base}/builds/backup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(backup) });
  assert.equal(restoredResponse.status, 200);
  const restored = await restoredResponse.json();
  assert.equal(restored.restored, backup.builds.length);
  const readback = await fetch(`${base}/builds/backup`).then(r => r.json());
  assert.deepEqual(readback.builds.map(b => normalizeBuild(b)), backup.builds.map(b => normalizeBuild(b)));
  const quality = await fetch(`${base}/catalog/quality-report`).then(r => r.json());
  await writeFile(join(output, '数据质量报告.json'), JSON.stringify(quality, null, 2) + '\n');
  const sourceFiles = ['.runtime/zol-catalog.json', '.runtime/buildcores-catalog.json', '.runtime/blender-scores.json', 'data/perf-gaming.json', 'data/hardware-corrections.json', 'data/scenario-performance.json', 'src/hardware-specs.mjs', 'src/recommend.mjs', 'src/optimizer.mjs', 'src/scoring-profiles.mjs', 'src/compat-rules.mjs', 'src/catalog.mjs', 'src/api.mjs', 'web/src/domain/plan.ts', 'web/src/domain/catalog.ts', 'web/src/api/mapping.ts'];
  const fingerprints = [];
  for (const file of sourceFiles) fingerprints.push({ file, sha256: createHash('sha256').update(await readFile(file)).digest('hex') });
  const all = results.flatMap(r => r.variants);
  const summary = { testedAt, timezone: 'Asia/Bangkok', caseCount: results.length, variantCount: all.length, passedCount: all.filter(v => v.checks.passed).length, constraintsSatisfiedCount: all.filter(v => v.checks.constraintsSatisfied).length, unknownCount: all.filter(v => v.checks.overall === 'UNKNOWN').length, conditionalCount: all.filter(v => v.checks.overall === 'CONDITIONAL').length, failedCount: all.filter(v => !v.checks.constraintsSatisfied).length, strictBudgetPassed: true, quiet: false, peripherals: false, restoreReadbackPassed: true, fingerprints, cases: results.map(({ rawResponse, strictResponse, strategyResponses, ...r }) => ({ ...r, strictPlans: strictResponse.plans.map(p => ({ id: p.id, infeasible: !!p.infeasible, totalCents: p.totalCents, targetCents: p.targetCents, recommendationStatus: p.recommendationStatus })) })) };
  await writeFile(join(output, '全部方案_可导入备份.json'), JSON.stringify(backup, null, 2) + '\n');
  await writeFile(join(output, '测试结果.json'), JSON.stringify(summary, null, 2) + '\n');
  const report = ['# 12 组装机配置测试', '', `测试时间：${new Date(testedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Bangkok', hour12: false })}（Asia/Bangkok）。`, '', '安静优先：全部关闭。顺带配外设：全部关闭。', '', `使用首页实际 POST /api/v1/plans 接口和本机目录，12 组输入共返回 ${all.length} 套方案；${summary.passedCount} 套已确认 PASS，${summary.unknownCount} 套 UNKNOWN，${summary.conditionalCount} 套 CONDITIONAL；${summary.failedCount} 套另有预算或配件问题。全部方案已通过备份导入和重读一致性检查。`, '', '“已确认通过”仅接受兼容性 PASS、预算内且达到最低需求。无已知冲突不等于已确认通过；CONDITIONAL（需满足条件，如开 XMP / EXPO、BIOS 需更新）与 UNKNOWN（规格缺失待核实）单独列出。未进行实机装配、帧率、AI 性能或实时商城价格测试。', '', '每组 Markdown 含全部返回档位的配件清单与选件依据；同名 JSON 含请求、原始响应、可保存配置及检查结果。全部方案_可导入备份.json 可在工作台“我的方案”中恢复。测试存储放在 .test-store，现有方案和草稿未改动。', '', '进阶版目标预算通常比输入预算高 20%，省钱版约为 80%；下表同时标明两个预算，避免把进阶版误当作输入预算内方案。', '', '| 序号 | 输入预算 / 用途 | 版本 | 目标预算 | 估算合计 | 评分 | 兼容性 | 检查 | 需满足条件 / 待核实 |', '|---|---|---|---:|---:|---:|---|---|---|'];
  for (const r of results) for (const v of r.variants) report.push(v.checks.infeasible
    ? `| ${r.index} | ${money(r.request.budgetCents)} / ${r.label} | ${v.label} | ${money(v.targetCents)} | — | — | — | 无可行方案 | |`
    : `| ${r.index} | ${money(r.request.budgetCents)} / ${r.label} | ${v.label} | ${money(v.targetCents)} | ${money(v.build.totals.totalCents)} | ${v.checks.score ?? '—'}${v.checks.sameAs ? '（同上一档）' : ''} | ${v.checks.overall} | ${v.checks.passed ? '已确认通过' : [v.checks.overall,...v.checks.missing.map(s => `缺${s}`), ...v.checks.conflicts, ...(!v.checks.withinTarget ? ['超目标预算'] : [])].join('、')} | ${[...v.checks.conditional, ...v.checks.unknowns].join('、')} |`);
  report.push('', '12 组输入另执行严格预算测试：全部满足不超目标预算或独立显示无解；原始响应保存在各组 JSON 的 strictResponse。', '', '重新运行：在项目根目录执行 `node scripts/test-configurations.mjs`。这会更新本目录的同名测试输出。', '');
  await writeFile(join(output, '测试汇总.md'), report.join('\n'));
  console.log(JSON.stringify({ cases: summary.caseCount, variants: summary.variantCount, passed: summary.passedCount, failed: summary.failedCount, restoreReadbackPassed: true }));
} finally {
  await new Promise(done => server.close(done));
}
