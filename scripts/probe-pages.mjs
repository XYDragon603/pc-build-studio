import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { parseTarget, evaluate } from '../src/normalization.mjs';
import { inspectRetailer } from '../src/retailer.mjs';
import { summarize, markdown } from '../src/report.mjs';

const root = new URL('../', import.meta.url);
const { samples } = JSON.parse(await readFile(new URL('data/observations.json', root), 'utf8'));
const results = [];
for (const sample of samples) {
  const start = performance.now();
  const evidence = await inspectRetailer({ title: sample.evidence.title, url: sample.evidence.url });
  const result = { ...evaluate(parseTarget(sample.category, sample.query), evidence),
    target: sample.query, latencyMs: Math.round(performance.now() - start) };
  results.push(result);
  console.log(JSON.stringify({ url: result.url, status: result.status, latencyMs: result.latencyMs,
    pageState: evidence.pageState, acquisitionError: evidence.acquisitionError ?? null }));
}
const report = { mode: 'direct-page-probe', generatedAt: new Date().toISOString(), summary: summarize(results), results,
  cost: { projectSearchRequests: 0, productPageRequests: samples.length, cacheHits: 0, estimatedGrossUsd: 0 },
  notes: ['此次仅直接读取预先发现的7个商品页，没有调用搜索API。', '当前解析器仅覆盖单一JSON-LD Product/Offer报价，要求SKU和URL明确绑定；没有通过不代表网页不存在其他可提取报价。', '未实现京东动态价格接口或登录态价格提取，不能将此轮结果视为全平台可用率。', '读取失败可能来自网络、页面策略或内容格式；不能据此断定商品已下架。'],
};
await mkdir(new URL('reports/', root), { recursive: true });
await writeFile(new URL('reports/page-probe.json', root), JSON.stringify(report, null, 2), 'utf8');
await writeFile(new URL('reports/page-probe.md', root), markdown(report), 'utf8');
console.log(JSON.stringify({ summary: report.summary, report: 'reports/page-probe.md' }));
