import { REASONS } from './normalization.mjs';

const cell = value => String(value ?? '—').replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ');
const labels = { accepted: '可自动入槽', review: '待核实', rejected: '已过滤' };

export function summarize(results) {
  const summary = { total: results.length, accepted: 0, review: 0, rejected: 0 };
  for (const result of results) summary[result.status]++;
  return summary;
}

export function markdown(report) {
  const s = report.summary;
  const timestamp = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Bangkok',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(report.generatedAt));
  const modeDescription = report.mode === 'replay' ? '这是固定实查记录的回放，不是本次实时搜索。'
    : report.mode === 'direct-page-probe' ? '这是对已知商品链接的直接读取，没有进行搜索。'
    : '这是本次检索与商品页验证的结果。';
  return [
    '# CPU / GPU 查价验证结果', '',
    `生成时间：${timestamp}（Asia/Bangkok）。${modeDescription}`, '',
    `共 ${s.total} 条；可自动入槽 ${s.accepted} 条；待核实 ${s.review} 条；已过滤 ${s.rejected} 条。`, '',
    '报价仅表示证据中的观测值；待核实项不会进入配置总价。金额未知用空值，不能用零代替。', '',
    '| 目标 | 商品标题 | 参考价 | 状态 | 原因 |', '|---|---|---:|---|---|',
    ...report.results.map(r => `| ${cell(r.target)} | ${cell(r.title)} | ${r.priceCents === null ? '未知' : `${r.currency ?? '币种未确认'} ${(r.priceCents / 100).toFixed(2)}`} | ${labels[r.status]} | ${r.reasons.map(cell).join('；')} |`), '',
    '## 来源与证据', '',
    ...report.results.map((r, i) => `${i + 1}. ${cell(r.title)}：${r.url.startsWith('https://') ? `<${r.url.replaceAll('>', '%3E')}>` : cell(r.url)}；采集时间 ${r.observedAt ?? '未知'}；方法 ${r.method}${r.latencyMs !== undefined ? `；请求耗时 ${r.latencyMs}ms` : ''}${r.evidence.acquisitionError ? `；请求错误 ${cell(r.evidence.acquisitionError)}` : ''}。`), '',
    '## 调用与成本', '',
    `项目搜索API尝试次数：${report.cost.projectSearchRequests}；商品页请求次数：${report.cost.productPageRequests}；缓存命中：${report.cost.cacheHits}。`,
    `本轮搜索估算费用（USD，未扣抵扣额度）：${report.cost.estimatedGrossUsd === null ? '未知，未配置合同单价或实查来自助手工具' : report.cost.estimatedGrossUsd.toFixed(6)}。`,
    '外部搜索服务的实际账单以提供商为准。失败尝试保守计入每日上限，不代表提供商一定收费。', '',
    ...(report.notes ?? []).map(note => `- ${note}`), '',
    '## 判定规则', '',
    ...Object.entries(REASONS).map(([code, description]) => `- \`${code}\`：${description}`), '',
  ].join('\n');
}
