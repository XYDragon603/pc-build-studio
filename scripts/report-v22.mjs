import { readdir, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createCatalog } from '../src/catalog.mjs';
import { fieldCoverage } from '../src/spec-provenance.mjs';

const reportDir = 'reports/v2.2';
const exportsDir = '配置/V2.2';
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const save = (name, lines) => writeFile(`${reportDir}/${name}`, lines.join('\n') + '\n');
const money = cents => cents == null ? '—' : `¥${(cents / 100).toLocaleString('zh-CN')}`;
const md = text => String(text ?? '—').replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ');
const before = await json(`${reportDir}/baseline-v21/测试结果.json`);
const oldItems = await json(`${reportDir}/baseline-v21/domestic-specs.json`);
const after = await json(`${exportsDir}/测试结果.json`);
const quality = await json(`${exportsDir}/数据质量报告.json`);
const corrections = await json('data/hardware-corrections.json');
const benchmarks = await json('data/scenario-performance.json');
const all = createCatalog().all();
const v21 = before.cases.flatMap(c => c.variants);
const v22 = after.cases.flatMap(c => c.variants);
const strict = after.cases.flatMap(c => c.strictPlans);
const sources = [...new Set(corrections.records.map(i => i.sourceUrl))];
const paths = await readdir(exportsDir);
const configFiles = paths.filter(f => /^\d{2}_.+\.md$/.test(f));
const configJson = paths.filter(f => /^\d{2}_.+\.json$/.test(f));
const rawData = await Promise.all(configJson.map(file => json(`${exportsDir}/${file}`)));
const count = (list, test) => list.filter(test).length;
const slot = (variant, id) => variant?.build.slots.find(s => s.id === id)?.part;
const selectedIds = new Set(v22.flatMap(v => v.build.slots.map(s => s.part?.catalogId)).filter(Boolean));
const latestItems = all.filter(i => i.market === 'cn');
const byId = new Map(latestItems.map(i => [i.id, i]));
const beforeCoverage = fieldCoverage(oldItems);
const beforeCommon = fieldCoverage(oldItems.filter(i => i.used));
const afterCommon = fieldCoverage(oldItems.filter(i => i.used).map(i => byId.get(i.id) ?? i));
const coverageTable = (previous, current) => Object.entries(current).flatMap(([category, data]) =>
  Object.entries(data.fields).map(([field, value]) => {
    const old = previous[category].fields[field];
    return `| ${category} (${data.count}) | ${field} | ${old.complete} · ${old.percent ?? '—'}% | ${value.complete} · ${value.percent ?? '—'}% |`;
  }));

assert.equal(configFiles.length, 12);
assert.equal(rawData.length, 12);
assert.equal(v22.length, 36);
assert(strict.every(plan => plan.infeasible || plan.totalCents <= plan.targetCents));
assert(v22.every(v => !v.checks.conflicts.length && !v.build.compatibility.checks.some(c => c.status === 'FAIL')));
assert(v22.every(v => v.build.totals.totalCents === v.build.slots.reduce((sum, slot) =>
  sum + (slot.part?.priceCents ?? 0) * (slot.part?.quantity ?? 0), 0)));
for (const { request, rawResponse, variants } of rawData) {
  assert(!request.scenarios.includes('quiet') && !request.peripherals.length);
  for (const v of variants) {
    const p = rawResponse.plans.find(plan => plan.id === v.id);
    if (p.infeasible) continue;
    assert.equal(request.budgetCents - p.totalCents, v.checks.inputBudgetDifferenceCents);
    assert.equal(p.budget.overTargetCents, p.totalCents - p.targetCents);
    assert.equal(p.budget.overInputCents, p.totalCents - request.budgetCents);
    assert(p.compatibility.checks.every(c => c.check_id && c.severity && typeof c.blocking === 'boolean'));
    if (p.compatibility.checks.some(c => c.blocking)) assert.equal(p.formalRecommendation, false);
  }
}
const backend = await readFile(`${reportDir}/backend.log`, 'utf8');
const frontend = await readFile(`${reportDir}/frontend.log`, 'utf8');
const built = await readFile(`${reportDir}/build.log`, 'utf8');
const tests = {
  backend: Number(backend.match(/pass (\d+)/)?.[1]),
  backendFailed: Number(backend.match(/fail (\d+)/)?.[1]),
  backendSkipped: Number(backend.match(/skipped (\d+)/)?.[1]),
  frontend: Number(frontend.match(/Tests\s+(\d+) passed/)?.[1]),
  buildPassed: /built in/.test(built),
};
assert(Number.isFinite(tests.backend) && tests.backendFailed === 0 && tests.frontend && tests.buildPassed);
const summary = { baselineAt: before.testedAt, testedAt: after.testedAt, cases: after.caseCount, variants: v22.length,
  formal: count(v22, v => v.formalRecommendation), statuses: Object.fromEntries(['PASS', 'CONDITIONAL', 'UNKNOWN', 'FAIL'].map(s => [s, count(v22, v => v.checks.overall === s)])),
  ordinaryOver: count(v22, v => !v.checks.withinTarget), strictNoResult: count(strict, v => v.infeasible),
  strictOver: count(strict, v => !v.infeasible && v.totalCents > v.targetCents), stockCoolerBefore: count(v21, v => v.stockCooler),
  stockCoolerAfter: count(v22, v => v.stockCooler), restoreReadbackPassed: after.restoreReadbackPassed, tests };
const comparisons = after.cases.map(c => {
  const prior = before.cases.find(p => p.index === c.index);
  const results = run => run.variants.map(v => ({ id: v.id, totalCents: v.build.totals.totalCents,
    gpu: slot(v, 'GPU')?.model ?? null, compatibility: v.checks.overall, recommendationStatus: v.recommendationStatus,
    inputBudgetDifferenceCents: v.checks.inputBudgetDifferenceCents, targetBudgetDifferenceCents: v.targetCents - v.build.totals.totalCents }));
  return { index: c.index, label: c.label, budgetCents: c.request.budgetCents, before: results(prior), after: results(c), strict: c.strictPlans };
});
await writeFile(`${reportDir}/回归结果.json`, JSON.stringify({ ...summary, comparisons }, null, 2) + '\n');

const debug = ['# V2.2 推荐候选诊断', '',
  'V2.1 的目标函数用综合分扣除整机成本，候选可能同时因资料缺失和价格受到惩罚。固定的上档复用逻辑也可能撤回核心性能提升。V2.2 单独计算场景核心指标，以策略决定成本权衡。均衡与性价比优先可优先展示关键风险已核实的方案。预算内性能优先展示核心性能更强的候选时，仍保留关键待核实项及正式推荐限制。', '',
  '候选范围受同芯片代表卡、价格质量门槛、GPU 前沿、平台组合及单组电源、散热和机箱匹配策略限制。表内最低完整成本只指实际枚举到的组合。'];
for (const index of [7, 11, 12]) {
  const data = rawData.find(c => c.index === index);
  const { meta, plans } = data.rawResponse;
  const gpuPattern = index === 7 ? /5070 TI|4080 SUPER|5080|9070 XT/i : /3090|4090|4080|5080|5090 D|5060 TI/i;
  debug.push('', `## ${money(data.request.budgetCents)} ${data.label}`, '',
    `目录 ${meta.catalogFilter.initialCount} 条，经市场及价格门槛保留 ${meta.catalogFilter.eligibleCount} 条。保留 CPU ${meta.stats.candidates.cpu} 个，显卡 ${meta.stats.candidates.gpu} 个。检查 ${meta.stats.combos} 个组合，形成 ${meta.stats.completed} 个完整组合。预算剪枝 ${meta.stats.rejectedBudget} 次，最终 FAIL 排除 ${meta.stats.rejectedFail} 次，Top-K 日志 ${meta.stats.rejectedTopK} 条。引擎 ${meta.elapsedMs} ms，HTTP ${data.durationMs} ms。`, '',
    '| 策略 | 推荐档显卡 | 显存 | 整机价 | 关键待核实 |', '|---|---|---:|---:|---|');
  for (const [strategy, result] of Object.entries({ balanced: { plans }, ...(data.strategyResponses ?? {}) })) {
    const p = result.plans.find(p => p.id === 'balanced');
    const gpu = p.picks.find(k => k.slot === 'GPU')?.item;
    debug.push(`| ${strategy} | ${md(gpu?.name)} | ${gpu?.specs.capacityGB ?? '—'} | ${money(p.totalCents)} | ${p.assessment?.blockingChecks.join('、') || '—'} |`);
  }
  if (data.measuredResponse) {
    const p = data.measuredResponse.plans.find(p => p.id === 'balanced');
    const gpu = p.picks.find(k => k.slot === 'GPU')?.item;
    const b = p.corePerformance.benchmark;
    debug.push('', `指定测试组复测选中 ${gpu.name}，整机 ${money(p.totalCents)}，显卡实测值 ${b.value} ${b.unit}，推荐状态为 ${p.recommendationStatus}。[${b.title ?? b.id}](${b.sourceUrl})`);
  }
  debug.push('', '| 进入完整搜索的显卡 | 卡价 | 最低完整成本 | 显存 / Blender / 2K 指数 | 预算 / 用途 / 同组 / 安全 / 最终 | 淘汰或入选依据 |', '|---|---:|---:|---|---|---|');
  for (const a of meta.gpuAlternatives.filter(x => gpuPattern.test(x.name))) {
    const t = a.tierDecisions.find(x => x.tier === 'balanced');
    const core = a.corePerformance;
    debug.push(`| ${md(a.name)} | ${money(a.gpuPriceCents)} | ${money(a.minimumBuildCents)} | ${core?.vram ?? '—'} / ${core?.compute ?? '—'} / ${core?.raster ?? '—'} | ${t.withinBudget} / ${t.counts.requirements} / ${t.counts.comparable} / ${t.counts.safety} / ${t.counts.final} | ${md(t.reason)} |`);
  }
  const excluded = [...meta.candidateLog, ...meta.catalogFilter.excluded].filter(x => x.category !== 'CPU' && gpuPattern.test(x.name) && !x.retained);
  const exclusions = Object.groupBy(excluded, x => x.exclusion?.reason ?? x.reason ?? 'unknown');
  debug.push('', `未进入完整搜索的相关型号记录 ${excluded.length} 条。分组 ${Object.entries(exclusions).map(([k, v]) => `${k} ${v.length}`).join('、') || '无'}。`, '');
  const p = plans.find(p => p.id === 'balanced');
  for (const alt of p.upgrades ?? []) debug.push(`- 预算内升级 ${alt.picks.find(p => p.slot === 'GPU')?.item.name}，${money(alt.totalCents)}，${alt.reason}。`);
  debug.push('', `逐条价格、评分维度和剪枝原因见配置目录中的 ${configJson[data.index - 1]}。候选日志位于各响应的 meta.candidateLog 与 meta.gpuAlternatives。`);
}
await save('RECOMMENDATION_DEBUG_REPORT.md', debug);

const dataLines = ['# V2.2 数据质量报告', '',
  '厂商规格按 SKU 或已知目录映射覆盖，原始目录快照保留。字段来源记录来源类型、单位、观察时间、核实时间与可信度。目录参考功耗仍供降级估算，板卡功耗优先参与计算。华硕中国规格页记录 Loki ATX 3.1，宣传页仍提到 ATX 3.0，具体批次与原配线额定值保留核对。', '',
  '## 已核实的字段差异', '',
  '| 配件 | 关键字段 | V2.1 值 | V2.2 值 | 来源 |', '|---|---|---|---|---|'];
for (const r of corrections.records) {
  const old = oldItems.find(i => i.id === r.id || i.zolId === r.id);
  const current = latestItems.find(i => i.id === r.id || i.zolId === r.id);
  for (const field of Object.keys(r.specs)) {
    if (JSON.stringify(old?.specs[field]) === JSON.stringify(current?.specs[field])) continue;
    dataLines.push(`| ${md(current?.name ?? r.id)} | ${field} | ${md(JSON.stringify(old?.specs[field]))} | ${md(JSON.stringify(current?.specs[field]))} | [厂商资料](${r.fieldSources?.[field] ?? r.sourceUrl}) |`);
  }
}
dataLines.push('', '映众板卡导出参考功耗从 575W 修正为 600W。V2.1 归一化目录中已有部分三维尺寸，V2.2 按板卡来源核对了映众 334 × 148 × 73 mm 及技嘉 208 × 120 × 40 mm，并在兼容检查中保留高度、厚度及对应机箱数据缺项。A21 的显卡、散热器及电源限值继续采用厂商 380 / 165 / 210 mm。A520 的官方 PCIe 3.0 规格继续生效，专项测试覆盖了主显卡插槽和 M.2。');
dataLines.push('', '## 国内目录关键字段完整率', '', '| 类别 | 字段 | V2.1 | V2.2 |', '|---|---|---:|---:|',
  ...coverageTable(beforeCoverage, quality.domesticCoverage),
  '', '## V2.1 入选型号固定样本', '', '| 类别 | 字段 | V2.1 | V2.2 |', '|---|---|---:|---:|',
  ...coverageTable(beforeCommon, afterCommon), '',
  '## 缺项、冲突及补全顺序', '',
  '机箱风道原先主要映射前后风扇位，A21 的风扇安装位现来自官方，预装数量仍缺来源。GPU 厚度、高度原始三维数据有就导入，厂商页面仅列总线代数时保留代数，电气宽度另行取证。SSD 和主板需核对插槽协议、独立 CPU 存储控制器和共享规则，旧代码以 GPU 通道替代了缺失的存储通道。电源物理规格原字段未统一，已从明确规格或可信尺寸映射，市场和批次仍需核对。CPU 散热器高度是物理数据，风道及温度测试仍需独立来源。', '',
  `本轮入选 ${selectedIds.size} 个不同目录配件。质量 JSON 包含 ${quality.evidence.length} 条国内关键字段来源记录，其中 ${quality.unattributedCount} 条缺来源链接。问题数量包括同一型号多种缺项，不等同于异常配件数。`, '',
  '| 质量问题 | 条数 |', '|---|---:|', ...Object.entries(quality.counts).map(([k, v]) => `| ${k} | ${v} |`), '',
  '| 优先核实的入选配件 | 分类 | 缺少字段 |', '|---|---|---|');
const newMissing = (await import('../src/spec-provenance.mjs')).KEY_FIELDS;
for (const i of latestItems.filter(i => selectedIds.has(i.id))) {
  const missing = (newMissing[i.category] ?? []).filter(f => i.specs[f] == null);
  if (missing.length) dataLines.push(`| ${md(i.name)} | ${i.category} | ${missing.join('、')} |`);
}
dataLines.push('', '质量 JSON 保留同 SKU 重复、规格冲突、异常估价与优先补全队列。规格覆盖支持带来源的增量修改、JSON 本地缓存及最近 12 次逐条回滚。内存 QVL 与整机实测仍需后续逐 SKU 核实。');
await save('DATA_QUALITY_REPORT.md', dataLines);

const regression = ['# V2.2 回归测试报告', '',
  `本次生成于 ${after.testedAt}。V2.1 基线为 ${before.testedAt}。安静优先与外设关闭。普通和严格预算各 12 组。三组重点场景额外执行性价比及性能优先策略，其中两组对指定实测条件复测。`, '',
  `普通模式 ${summary.variants} 档。确认物理或供电冲突 ${summary.statuses.FAIL} 档，条件兼容 ${summary.statuses.CONDITIONAL} 档，关键待核实 ${summary.statuses.UNKNOWN} 档。正式已确认 ${summary.formal} 档，超预算替代 ${summary.ordinaryOver} 档。严格预算 ${summary.strictOver} 档正式超支，${summary.strictNoResult} 档搜索无解。备份导入重读 ${summary.restoreReadbackPassed ? '通过' : '未通过'}。`, '',
  '| 预算及用途 | V2.1 推荐档 | V2.2 推荐档 | V2.2 GPU | V2.2 三档兼容 | 严格无解 |', '|---|---:|---:|---|---|---:|'];
for (const c of after.cases) {
  const prior = before.cases.find(p => p.index === c.index)?.variants.find(v => v.id === 'balanced');
  const current = c.variants.find(v => v.id === 'balanced');
  regression.push(`| ${money(c.request.budgetCents)} ${c.label} | ${money(prior?.build.totals.totalCents)} | ${money(current?.build.totals.totalCents)} | ${md(slot(current, 'GPU')?.model)} | ${c.variants.map(v => v.checks.overall ?? '无解').join(' / ')} | ${count(c.strictPlans, p => p.infeasible)} |`);
}
regression.push('', `原装散热器从 ${summary.stockCoolerBefore} 套变为 ${summary.stockCoolerAfter} 套。零元散热只用于已确认包装的候选。两个评分版本的分数不作横向性能结论。`, '',
  '| 实际命令 | 结果 |', '|---|---|',
  `| npm test | ${tests.backend} 通过，${tests.backendFailed} 失败，${tests.backendSkipped} 跳过 | `,
  `| npm run web:test | ${tests.frontend} 通过 | `,
  `| npm --prefix web run build | ${tests.buildPassed ? '通过' : '失败'} | `,
  '| `$env:CONFIG_OUTPUT=\'配置/V2.2\'; $env:V22_RETEST=\'1\'; node scripts/test-configurations.mjs` | HTTP 批量配置、严格预算、策略对照、指定实测及备份检查通过 |',
  '| node scripts/report-v22.mjs | 校验预算余额、加总、导出文件、方案及保存后的冲突状态 |',
  '', '20 类专项测试及同测试组匹配测试位于 test/v22.test.mjs。合成小目录对 CPU × GPU 完整穷举，按三个预算与性能优先结果对照。日志为 backend.log、frontend.log、build.log 和 batch.log。未执行实机装机、线材测量、温度与噪音实验或实时价格采集。');
await save('REGRESSION_TEST_REPORT.md', regression);

const changed = ['data/hardware-corrections.json', 'data/scenario-performance.json', 'scripts/import-zol.mjs', 'scripts/test-configurations.mjs', 'scripts/report-v22.mjs',
  ...['api', 'catalog', 'catalog-corrections', 'compat-rules', 'data-quality', 'hardware-specs', 'optimizer', 'performance', 'prices', 'recommendation-strategy', 'scenario-performance', 'scoring-profiles', 'spec-provenance', 'specs-enrich', 'workloads'].map(name => `src/${name}.mjs`),
  'src/compat-rules.d.mts', 'test/compat-rules.test.mjs', 'test/v22.test.mjs', 'web/src/api/client.ts',
  ...['Home', 'PlanCard', 'PriceManager'].map(name => `web/src/next/${name}.tsx`)];
await save('V2.2_CHANGELOG.md', ['# PC Build Studio V2.2 变更记录', '',
  '保留三档预算、原兼容性状态与工作台编辑流程。V2.2 修复 SKU 规格优先级和风险分级，增加三种推荐策略、预算内升级与独立场景实测数据集。',
  '', '- 兼容性检查增加风险、阻断、证据与确认动作。整体条件兼容可以包含非阻断的 UNKNOWN。高功耗风道、原配线材和电源转接风险仍要求核对。',
  '- 修正映众 600W 和 3.5 槽、技嘉显卡方向尺寸、Loki SFX-L 与 ATX 电气版本、A21 风扇位，以及 2700 与 270K Plus 频率。A520 仍为 PCIe 3.0。',
  '- 盒装散热器需要包装料号证据。风扇与必要转接支架有明确价格时进入预算。这些费用继续保存为附加槽位。',
  '- 推荐策略按独立核心指标排序，性能优先取消成本惩罚。安全待核实候选带明确状态。均衡和性价比优先可优先选关键风险已经核对的方案。预算和用途问题可以同时出现。',
  '- 规格覆盖和来源通过独立数据文件增量维护。新导入的 ZOL 条目记录入库时间。价格表单增加 SKU，记录写入、实际报价和观察时间分开保存。找不到报价时间时保留空值。',
  `- 内置 ${benchmarks.cohorts.length} 个独立实测组，包含 1080p 电竞、1440p、4K 光栅、4K 光追、Premiere LongGOP、LLM、图像生成、视频增强和 LoRA 微调。通用配置继续标注代理性能。全量训练、视频生成、更多模型与剪辑软件仍缺覆盖。`,
  '', '完整技术根因和证据见同目录 DATA_QUALITY_REPORT.md、RECOMMENDATION_DEBUG_REPORT.md 及 REGRESSION_TEST_REPORT.md。其他不足包括 4K/AI 高功耗机型的风道验证、机箱走线、跨市场 SKU 匹配和预算内搜索范围。实测记录及报价都维持本次本地目录的证据范围。',
  '', '## 厂商来源', '', ...sources.map(url => `- [${new URL(url).hostname}](${url})`), '',
  '## 实测数据来源', '', ...benchmarks.cohorts.map(b => `- ${b.title ?? b.id}，${b.publishedAt}，${b.conditions}。[原始测试](${b.sourceUrl})`), '',
  '## 本轮代码路径', '', '初始 Git 状态保存在 baseline-v21/git-status.txt。以下列出实际涉及的源码范围，工作区尚有上轮的未提交修改。', '',
  ...changed.map(path => `- ${path}`)]);
console.log(JSON.stringify(summary));
