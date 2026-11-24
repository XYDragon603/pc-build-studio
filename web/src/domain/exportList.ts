import { totals } from './build';
import { compatibility } from './compat';
import { formatYuan } from './money';
import { SCENARIOS } from './scenarios';
import { SLOTS } from './slots';
import type { Build } from './types';

const price = (c: number | null, estimate = false) =>
  c == null ? '价格未知' : c === 0 ? '已有（¥0）' : estimate ? `约 ${formatYuan(c)}（估算）` : formatYuan(c);

export function buildMarkdown(b: Build, demo: boolean): string {
  const t = totals(b);
  const scen = SCENARIOS.filter(s => b.scenarios.includes(s.key)).map(s => s.label).join('、') || '未设置';
  const lines = [
    `# ${b.name || '未命名方案'}`,
    '',
    demo ? '> 演示模式：价格为演示数据，不代表实时行情。' : '',
    '',
    `- 预算：${formatYuan(b.budgetCents)}`,
    `- 使用场景：${scen}`,
    `- 导出时间：${new Date().toLocaleString('zh-CN')}`,
    '',
    '| 部件 | 型号 | 规格 | 价格 | 锁定 |',
    '|---|---|---|---|---|',
    ...SLOTS.map(({ id, label }) => {
      const s = b.slots[id];
      return s.part
        ? `| ${label} | ${s.part.name} | ${s.part.spec || '—'} | ${price(s.part.priceCents, s.part.priceSource === 'estimate')} | ${s.locked ? '是' : ''} |`
        : `| ${label} | 待选择 | — | — | |`;
    }),
    ...b.custom.map(c => `| 自定义 | ${c.name} | ${c.spec || '—'} | ${price(c.priceCents)} | |`),
    '',
    `**已选合计 ${formatYuan(t.totalCents)}** · ${t.remainingCents >= 0 ? `剩余预算 ${formatYuan(t.remainingCents)}` : `超出预算 ${formatYuan(-t.remainingCents)}`}`,
    t.missing.length ? `尚未选择：${t.missing.map(id => SLOTS.find(s => s.id === id)!.label).join('、')}` : '',
    t.unknownPriceCount ? `${t.unknownPriceCount} 项价格未知，未计入合计。` : '',
    t.estimateCount ? `${t.estimateCount} 项为参考价估算，实际价格以下单为准。` : '',
    '',
    '## 兼容性提示',
    '',
    ...compatibility(b).map(c => `- ${c.level === 'ok' ? '✓' : c.level === 'warn' ? '!' : '✗'} ${c.label}：${c.detail}`),
    '',
  ];
  return lines.filter((l, i, arr) => !(l === '' && arr[i - 1] === '')).join('\n');
}

export function downloadText(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
