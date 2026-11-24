import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseTarget, evaluate } from '../src/normalization.mjs';
import { markdown, summarize } from '../src/report.mjs';

const root = new URL('../', import.meta.url);
const data = JSON.parse(await readFile(new URL('data/observations.json', root), 'utf8'));
const results = data.samples.map(sample => ({
  ...evaluate(parseTarget(sample.category, sample.query), {
    ...sample.evidence, observedAt: data.capturedAt,
  }, { now: Date.parse(data.capturedAt) }), target: sample.query,
}));
const report = {
  mode: 'replay', generatedAt: new Date().toISOString(), evidenceAsOf: data.capturedAt,
  summary: summarize(results), results,
  cost: { projectSearchRequests: 0, productPageRequests: 0, cacheHits: 0, estimatedGrossUsd: null },
  notes: [
    data.provenance,
    '本次回放不联网；判定新鲜度使用原始采集时刻，不能把回放生成时间当作重新查价时间。',
    '原始实查由助手工具完成，其调用费用不可归因到项目API；本轮未验证Brave的中文商品检索质量、延迟或实际账单。',
    '7个页面是小规模定向样本，不能用其通过率估计整个市场的可用率。',
    '下一步先评估可提供明确SKU、库存和报价时间的数据源；当前记录不支持无人审核自动入槽。',
  ],
};
await mkdir(new URL('reports/', root), { recursive: true });
await writeFile(new URL('reports/validation.json', root), JSON.stringify(report, null, 2), 'utf8');
await writeFile(new URL('reports/validation.md', root), markdown(report), 'utf8');
console.log(JSON.stringify({ summary: report.summary, report: fileURLToPath(new URL('reports/validation.md', root)) }, null, 2));
