// 硬件与价格数据质量报告：缺失字段、价格可信度、价格异常、性能数据缺口与版本不符。
//
//   node scripts/data-quality.mjs            # 写 reports/data-quality.local.md（含型号与 ZOL 参考价，只留本地）
//
// 只读目录，不改数据、不联网。报告列出的是“需要人工核实”的条目，不代表这些数据一定错。
import { mkdir, writeFile } from 'node:fs/promises';
import { createCatalog } from '../src/catalog.mjs';

const catalog = createCatalog('.runtime');
const all = catalog.all();
const cn = all.filter(i => i.market === 'cn');
const yuan = cents => `¥${Math.round(cents / 100).toLocaleString('zh-CN')}`;
const pct = (n, d) => `${n}/${d}（${d ? Math.round((n / d) * 100) : 0}%）`;
const median = values => { const s = [...values].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

/** 兼容性规则需要的关键字段（缺了就只能判 UNKNOWN） */
const CRITICAL = {
  CPU: ['socket', 'maxPowerWatts'],
  GPU: ['chipset', 'capacityGB', 'lengthMm', 'powerPins'],
  MOTHERBOARD: ['socket', 'chipset', 'memoryType', 'formFactor', 'm2Slots', 'videoOutputs'],
  RAM: ['memoryType', 'capacityGB', 'modules', 'speedMTs'],
  SSD: ['capacityGB', 'interface'],
  PSU: ['ratedWatts', 'pcie8Count'],
  CASE: ['maxGpuLengthMm', 'maxCoolerHeightMm'],
  COOLER: ['sockets'],
};
const QUALITY = {
  PSU: ['efficiency', 'atxVersion', 'rail12vAmps', 'protections', 'warrantyYears'],
  SSD: ['nand', 'dram', 'tbw'],
  MOTHERBOARD: ['vrmPhases', 'pcieGen'],
  GPU: ['thicknessMm', 'boardPowerWatts'],
};

const lines = ['# 数据质量报告', '', `生成时间：${new Date().toLocaleString('zh-CN', { hour12: false })}。只读目录，不改数据。`, '',
  '“需要核实”不代表数据一定错：参考价来自中关村在线列表页，观察时间是抓取时间，不是价格最后变动的时间。', ''];

lines.push('## 1. 国内条目关键字段完整度', '', '| 类目 | 条目 | 关键字段（兼容性必需） | 缺失最多的字段 | 品质字段覆盖 |', '|---|---:|---|---|---|');
const summary = { categories: {} };
for (const [cat, fields] of Object.entries(CRITICAL)) {
  const xs = cn.filter(i => i.category === cat);
  const complete = xs.filter(i => fields.every(f => i.specs?.[f] != null)).length;
  const missing = fields.map(f => [f, xs.filter(i => i.specs?.[f] == null).length]).sort((a, b) => b[1] - a[1]).filter(([, n]) => n);
  const quality = (QUALITY[cat] ?? []).map(f => `${f} ${pct(xs.filter(i => i.specs?.[f] != null).length, xs.length)}`).join('；') || '—';
  summary.categories[cat] = { total: xs.length, complete };
  lines.push(`| ${cat} | ${xs.length} | ${pct(complete, xs.length)} | ${missing.slice(0, 3).map(([f, n]) => `${f} 缺 ${n}`).join('、') || '—'} | ${quality} |`);
}

const priced = cn.filter(i => i.estimatedPriceCents > 0);
const conf = { high: 0, medium: 0, low: 0 };
const flags = {};
for (const i of priced) { conf[i.priceConfidence ?? 'medium']++; for (const f of i.priceFlags ?? []) flags[f] = (flags[f] ?? 0) + 1; }
summary.priced = priced.length; summary.confidence = conf; summary.flags = flags;
lines.push('', '## 2. 价格可信度（国内有价条目）', '', `- 有价条目：${priced.length}；无价：${cn.length - priced.length}`,
  `- 可信度：高 ${conf.high}、中 ${conf.medium}、低 ${conf.low}`,
  `- 标记：单一来源 ${flags['single-source'] ?? 0}、同规格价差 3 倍以上 ${flags['wide-range'] ?? 0}、上一代产品 ${flags.legacy ?? 0}、疑似旧价 ${priced.filter(i => i.possiblyStale).length}`, '');

// 指定复核的型号：价格依据、来源数量、价格分布
lines.push('## 3. 重点复核型号', '', '| 型号组 | 条目 | 最低 | 中位 | 最高 | 依据 | 可信度 | 标记 |', '|---|---:|---:|---:|---:|---|---|---|');
const review = [
  ['RTX 3050 6GB', i => i.category === 'GPU' && /3050/.test(i.specs.chipset ?? '') && i.specs.capacityGB === 6],
  ['RTX 3050 8GB', i => i.category === 'GPU' && /3050/.test(i.specs.chipset ?? '') && i.specs.capacityGB === 8],
  ['RTX 3060 12GB', i => i.category === 'GPU' && /RTX 3060$/i.test(i.specs.chipset ?? '') && i.specs.capacityGB === 12],
  ['RTX 3090', i => i.category === 'GPU' && /3090(?! TI)/i.test(i.specs.chipset ?? '')],
  ['RTX 4090', i => i.category === 'GPU' && /RTX 4090$/i.test(i.specs.chipset ?? '')],
  ['RTX 5070 Ti', i => i.category === 'GPU' && /5070 TI/i.test(i.specs.chipset ?? '')],
  ['RTX 5080', i => i.category === 'GPU' && /5080/i.test(i.specs.chipset ?? '')],
  ['Ryzen 3 3100', i => i.category === 'CPU' && /Ryzen 3 3100/i.test(i.name)],
  ['Ryzen 3 3300X', i => i.category === 'CPU' && /3300X/i.test(i.name)],
  ['Ryzen 5 5600G', i => i.category === 'CPU' && /5600G\b/i.test(i.name)],
  ['DDR4 32GB 双条', i => i.category === 'RAM' && i.specs.memoryType === 'DDR4' && i.specs.capacityGB === 32 && i.specs.modules === 2],
  ['DDR4 16GB 双条', i => i.category === 'RAM' && i.specs.memoryType === 'DDR4' && i.specs.capacityGB === 16 && i.specs.modules === 2],
];
for (const [label, test] of review) {
  const xs = priced.filter(test);
  if (!xs.length) { lines.push(`| ${label} | 0 | — | — | — | — | — | — |`); continue; }
  const p = xs.map(i => i.estimatedPriceCents).sort((a, b) => a - b);
  const count = key => Object.entries(xs.reduce((m, i) => ({ ...m, [i[key] ?? '—']: (m[i[key] ?? '—'] ?? 0) + 1 }), {})).map(([k, n]) => `${k} ${n}`).join('、');
  const fl = [...new Set(xs.flatMap(i => i.priceFlags ?? []))].join('、') || '—';
  lines.push(`| ${label} | ${xs.length} | ${yuan(p[0])} | ${yuan(median(p))} | ${yuan(p.at(-1))} | ${count('estimateBasis')} | ${count('priceConfidence')} | ${fl} |`);
}
lines.push('', '说明：RTX 3090 与 4090 的价差、5070 Ti 与 5080 的价差要按中位价比较；最低价往往是单个商品页的特价或旧价。数据库没有被这份报告修改。', '');

// 同规格价差过大的组
lines.push('## 4. 同规格价差 3 倍以上的组（前 20）', '', '| 类目 | 规格组 | 条目 | 最低 | 最高 |', '|---|---|---:|---:|---:|');
const wide = new Map();
for (const i of priced.filter(i => i.priceFlags?.includes('wide-range'))) {
  const key = i.category === 'GPU' ? `${i.specs.chipset} ${i.specs.capacityGB}GB` : i.category === 'RAM' ? `${i.specs.memoryType} ${i.specs.capacityGB}GB×${i.specs.modules}` : i.summary;
  if (!wide.has(`${i.category}|${key}`)) wide.set(`${i.category}|${key}`, []);
  wide.get(`${i.category}|${key}`).push(i.estimatedPriceCents);
}
for (const [k, v] of [...wide].sort((a, b) => b[1].length - a[1].length).slice(0, 20)) {
  const [cat, key] = k.split('|');
  lines.push(`| ${cat} | ${key} | ${v.length} | ${yuan(Math.min(...v))} | ${yuan(Math.max(...v))} |`);
}

// 性能数据
const gpus = cn.filter(i => i.category === 'GPU' && i.estimatedPriceCents > 0);
const cpus = cn.filter(i => i.category === 'CPU' && i.estimatedPriceCents > 0);
const variant = gpus.filter(i => i.performance?.note);
summary.performance = { gpu: [gpus.filter(i => i.performance?.gaming).length, gpus.length], cpu: [cpus.filter(i => i.performance?.gaming).length, cpus.length], variantMismatch: variant.length };
lines.push('', '## 5. 性能数据', '', `- 显卡游戏指数：${pct(summary.performance.gpu[0], gpus.length)}；CPU 游戏指数：${pct(summary.performance.cpu[0], cpus.length)}`,
  `- 显存版本与评测版本不同、未套用分数的显卡：${variant.length} 款（如 ${[...new Set(variant.map(i => `${i.performance.key} ${i.specs.capacityGB}GB`))].slice(0, 8).join('、')}）`,
  '- 换算来源与条件见 data/perf-gaming.json 的 note 与每条的 label / converted / estimated 字段；不同测试条件的数据没有混在一起比较。', '');

// 可能的规格冲突：同料号不同关键规格
const byMpn = new Map();
for (const i of cn) { if (!i.mpn) continue; const k = `${i.category}:${i.mpn.toUpperCase()}`; if (!byMpn.has(k)) byMpn.set(k, []); byMpn.get(k).push(i); }
const conflicts = [...byMpn.values()].filter(list => list.length > 1 && new Set(list.map(i => JSON.stringify([i.specs.capacityGB, i.specs.socket, i.specs.chipset]))).size > 1);
summary.specConflicts = conflicts.length;
lines.push('## 6. 同料号规格不一致', '', conflicts.length ? conflicts.slice(0, 20).map(list => `- ${list[0].mpn}：${list.map(i => `${i.name}（${i.specs.capacityGB ?? '—'}GB / ${i.specs.socket ?? i.specs.chipset ?? '—'}）`).join('；')}`).join('\n') : '没有发现。', '');

await mkdir('reports', { recursive: true });
await writeFile('reports/data-quality.local.md', lines.join('\n') + '\n');
console.log(JSON.stringify(summary, null, 2));
console.log('已写入 reports/data-quality.local.md');
