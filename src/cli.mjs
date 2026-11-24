import { parseArgs } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseTarget } from './normalization.mjs';
import { BraveSearch } from './search.mjs';
import { searchQuotes } from './quotes.mjs';
import { markdown } from './report.mjs';

async function main() {
  const { values } = parseArgs({ options: {
    category: { type: 'string' }, query: { type: 'string' },
    output: { type: 'string', default: 'reports/live' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('npm run search -- --category CPU --query "9700X 盒装"\nnpm run search -- --category GPU --query "RTX 5060 Ti 16GB"');
    return;
  }
  const target = parseTarget(values.category, values.query);
  const report = { ...await searchQuotes(target, new BraveSearch()),
    notes: ['当前仅支持京东详情页，最多检查10个搜索结果；不绕过登录或验证码。', '型号与价格规则不提供性能评分或整机兼容性结论。'],
  };
  const prefix = path.resolve(values.output);
  await mkdir(path.dirname(prefix), { recursive: true });
  await writeFile(`${prefix}.json`, JSON.stringify(report, null, 2), 'utf8');
  await writeFile(`${prefix}.md`, markdown(report), 'utf8');
  console.log(JSON.stringify({ summary: report.summary, cost: report.cost, report: `${prefix}.md` }, null, 2));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
