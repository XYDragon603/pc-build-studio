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
const output = resolve('配置');
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
      const cpu = plan.picks.find(p => p.slot === 'CPU')?.item;
      if (plan.igpu && cpu && !hasIntegratedGraphics(cpu)) conflicts.push('核显方案 CPU 没有核显');
      const withinTarget = plan.totalCents <= plan.targetCents;
      const infeasible = !!plan.infeasible;
      const passed = !infeasible && !missing.length && !conflicts.length && withinTarget;
      const checks = { passed, infeasible, complete: !missing.length, missing, withinTarget, withinInputBudget: plan.totalCents <= request.budgetCents,
        inputBudgetDifferenceCents: request.budgetCents - plan.totalCents, overall: plan.compatibility?.overall ?? null, savedOverall, conflicts, conditional, unknowns,
        score: plan.score?.total ?? null, sameAs: plan.sameAs ?? null };
      const variant = { id: plan.id, label: plan.label, targetCents: plan.targetCents, igpu: plan.igpu, stockCooler: plan.stockCooler, checks, build };
      variants.push(variant);
      if (infeasible) {
        markdown.push(`## ${plan.label}`, '', `目标预算：${money(plan.targetCents)}。**这一档没有可行方案。**`, '', ...(plan.reasons ?? []).map(r => `- ${r}`),
          plan.minFeasibleCents ? `
能找到的最低完整配置约 ${money(plan.minFeasibleCents)}。` : '', ...(plan.suggestions ?? []).map(r => `- 建议：${r}`), '');
        continue;
      }
      backup.builds.push(build);
      markdown.push(`## ${plan.label}`, '', `目标预算：${money(plan.targetCents)}；估算合计：${money(plan.totalCents)}；输入预算余额：${money(checks.inputBudgetDifferenceCents)}。`, '', '| 配件 | 型号 | 估算价格 |', '|---|---|---:|', ...build.slots.map(s => `| ${s.label} | ${cell(s.part?.model ?? '缺失')} | ${s.part ? money(s.part.priceCents) : '—'} |`), '', `综合评分：${plan.score?.total ?? '—'}${plan.sameAs ? `（与${plan.sameAs === 'save' ? '省钱版' : plan.sameAs === 'balanced' ? '推荐版' : '进阶版'}相同）` : ''}；兼容性：${checks.overall}。`, '', `检查：${passed ? '通过' : '存在问题'}。${missing.length ? `缺件：${missing.join('、')}。` : ''}${!withinTarget ? '超出本档目标预算。' : ''}${conflicts.length ? `不兼容：${conflicts.join('、')}。` : ''}`, '', `需满足条件：${conditional.join('、') || '无'}。待核实：${unknowns.join('、') || '无'}。`, '', ...plan.notes.map(n => `- ${n}`), '', '选件依据：', '', ...plan.picks.map(p => `- ${slotTypes.find(s => s.id === p.slot)?.label ?? p.slot}：${p.reason}`), '');
    }
    const result = { index: index + 1, label, testedAt, request, durationMs, rawResponse, variants };
    results.push(result);
    await writeFile(join(output, `${filename}.json`), JSON.stringify(result, null, 2) + '\n');
    await writeFile(join(output, `${filename}.md`), markdown.join('\n'));
    console.log(JSON.stringify({ case: index + 1, budget: yuan, scenario, durationMs, variants: variants.map(v => ({ tier: v.id, total: v.build.totals.totalCents / 100, ...v.checks })) }));
  }
  // Validate actual restore/read/backup behavior in an isolated store.
  const restoredResponse = await fetch(`${base}/builds/backup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(backup) });
  assert.equal(restoredResponse.status, 200);
  const restored = await restoredResponse.json();
  assert.equal(restored.restored, backup.builds.length);
  const readback = await fetch(`${base}/builds/backup`).then(r => r.json());
  assert.deepEqual(readback.builds.map(b => normalizeBuild(b)), backup.builds.map(b => normalizeBuild(b)));
  const sourceFiles = ['.runtime/zol-catalog.json', '.runtime/buildcores-catalog.json', '.runtime/blender-scores.json', 'data/perf-gaming.json', 'src/recommend.mjs', 'src/optimizer.mjs', 'src/scoring-profiles.mjs', 'src/compat-rules.mjs', 'src/catalog.mjs', 'src/api.mjs', 'web/src/domain/plan.ts', 'web/src/domain/catalog.ts', 'web/src/api/mapping.ts'];
  const fingerprints = [];
  for (const file of sourceFiles) fingerprints.push({ file, sha256: createHash('sha256').update(await readFile(file)).digest('hex') });
  const all = results.flatMap(r => r.variants);
  const summary = { testedAt, timezone: 'Asia/Bangkok', caseCount: results.length, variantCount: all.length, passedCount: all.filter(v => v.checks.passed).length, failedCount: all.filter(v => !v.checks.passed).length, quiet: false, peripherals: false, restoreReadbackPassed: true, fingerprints, cases: results.map(({ rawResponse, ...r }) => r) };
  await writeFile(join(output, '全部方案_可导入备份.json'), JSON.stringify(backup, null, 2) + '\n');
  await writeFile(join(output, '测试结果.json'), JSON.stringify(summary, null, 2) + '\n');
  const report = ['# 12 组装机配置测试', '', `测试时间：${new Date(testedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Bangkok', hour12: false })}（Asia/Bangkok）。`, '', '安静优先：全部关闭。顺带配外设：全部关闭。', '', `使用首页实际 POST /api/v1/plans 接口和本机目录，12 组输入共返回 ${all.length} 套方案；${summary.passedCount} 套通过已知条件检查，${summary.failedCount} 套存在问题。全部方案已通过备份导入和重读一致性检查。`, '', '“通过”要求无缺件、统一兼容规则下无 FAIL（不兼容）且不超本档目标预算；CONDITIONAL（需满足条件，如开 XMP / EXPO、BIOS 需更新）与 UNKNOWN（规格缺失待核实）单独列出。未进行实机装配、帧率、AI 性能或实时商城价格测试。', '', '每组 Markdown 含全部返回档位的配件清单与选件依据；同名 JSON 含请求、原始响应、可保存配置及检查结果。全部方案_可导入备份.json 可在工作台“我的方案”中恢复。测试存储放在 .test-store，现有方案和草稿未改动。', '', '进阶版目标预算通常比输入预算高 20%，省钱版约为 80%；下表同时标明两个预算，避免把进阶版误当作输入预算内方案。', '', '| 序号 | 输入预算 / 用途 | 版本 | 目标预算 | 估算合计 | 评分 | 兼容性 | 检查 | 需满足条件 / 待核实 |', '|---|---|---|---:|---:|---:|---|---|---|'];
  for (const r of results) for (const v of r.variants) report.push(v.checks.infeasible
    ? `| ${r.index} | ${money(r.request.budgetCents)} / ${r.label} | ${v.label} | ${money(v.targetCents)} | — | — | — | 无可行方案 | |`
    : `| ${r.index} | ${money(r.request.budgetCents)} / ${r.label} | ${v.label} | ${money(v.targetCents)} | ${money(v.build.totals.totalCents)} | ${v.checks.score ?? '—'}${v.checks.sameAs ? '（同上一档）' : ''} | ${v.checks.overall} | ${v.checks.passed ? '通过' : [...v.checks.missing.map(s => `缺${s}`), ...v.checks.conflicts, ...(!v.checks.withinTarget ? ['超目标预算'] : [])].join('、')} | ${[...v.checks.conditional, ...v.checks.unknowns].join('、')} |`);
  report.push('', '重新运行：在项目根目录执行 `node scripts/test-configurations.mjs`。这会更新本目录的同名测试输出。', '');
  await writeFile(join(output, '测试汇总.md'), report.join('\n'));
  console.log(JSON.stringify({ cases: summary.caseCount, variants: summary.variantCount, passed: summary.passedCount, failed: summary.failedCount, restoreReadbackPassed: true }));
} finally {
  await new Promise(done => server.close(done));
}
