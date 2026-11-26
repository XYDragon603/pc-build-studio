// 逐套列出测试输出：用例、档位、总价 / 目标、显卡、CPU、SSD、散热、评分、状态、阻断项
// 用法：node scripts/plan-table.mjs <目录>
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const [dir] = process.argv.slice(2);
const y = c => `¥${Math.round(c / 100)}`;
for (const f of readdirSync(dir).filter(f => /^\d\d_.*\.json$/.test(f)).sort()) {
  const r = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  for (const p of r.rawResponse.plans) {
    const pick = s => p.picks?.find(x => x.slot === s)?.item;
    const name = (s, n = 22) => (pick(s)?.name ?? (s === 'GPU' && p.igpu ? '核显' : s === 'COOLER' && p.stockCooler ? '原装' : '—')).slice(0, n);
    console.log([`${String(r.index).padStart(2)} ${r.label.padEnd(8)} ${p.id.padEnd(8)}`, `${y(p.totalCents)}/${y(p.targetCents)}`, name('GPU', 26), name('CPU', 20),
      `${pick('SSD')?.specs?.capacityGB ?? '?'}GB`, name('COOLER', 14), `s=${p.score?.total}`, p.recommendationStatus, (p.assessment?.blockingChecks ?? []).join(',')].join(' | '));
  }
}
