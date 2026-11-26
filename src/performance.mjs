// 性能参考数据：Blender Open Data 渲染跑分（CC0，scripts/import-blender.mjs 生成）
// 与 data/perf-gaming.json 里按评测整理的游戏相对性能（注明出处）。都只作参考。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cpuKey, gpuKey } from './perfkeys.mjs';
import { loadScenarioPerformance } from './scenario-performance.mjs';

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

export function loadPerformance(directory, dataFile = new URL('../data/perf-gaming.json', import.meta.url)) {
  const blender = directory === null ? null : readJson(join(directory, 'blender-scores.json'), null);
  const gaming = readJson(dataFile, { cpu: null, gpu: null });
  const scenario = loadScenarioPerformance(directory);
  const index = list => new Map((list ?? []).map(r => [r.key, r]));
  const blenderCpu = index(blender?.cpus);
  const blenderGpu = index(blender?.gpus);
  const gamingCpu = index(gaming.cpu?.entries);
  const gamingGpu = index(gaming.gpu?.entries);

  const meta = {
    scenarioCohorts: scenario.metadata,
    blender: blender ? { source: blender.source, url: blender.url, license: blender.license, version: blender.blenderVersion, snapshot: blender.snapshot, snapshotGeneratedAt: blender.generatedAt ?? null } : null,
    gamingCpu: gaming.cpu ? { source: gaming.cpu.source, url: gaming.cpu.url, resolution: gaming.cpu.resolution, baseline: gaming.cpu.baseline, date: gaming.cpu.date } : null,
    gamingGpu: gaming.gpu ? { source: gaming.gpu.source, url: gaming.gpu.url, resolution: gaming.gpu.resolution, baseline: gaming.gpu.baseline, date: gaming.gpu.date } : null,
  };

  /** 给 CPU / 显卡条目加上 performance 字段；对不上的保持原样 */
  function attach(item) {
    let key = null;
    let b = null;
    let g = null;
    let variantNote = null;
    if (item.category === 'CPU') {
      key = cpuKey(item.name) ?? cpuKey(item.mpn) ?? item.aliases?.map(cpuKey).find(Boolean) ?? null;
      b = key && blenderCpu.get(key);
      // Intel 的 K / KF、F / 无 F 是同一颗芯片去掉核显，游戏性能视为相同；AMD 的 F 型号是不同芯片，不做模糊匹配
      const intelAlt = key && /^(I\d|ULTRA)/.test(key) ? [key.replace(/F$/, ''), `${key}F`] : [];
      g = key && [key, ...intelAlt].map(k => gamingCpu.get(k)).find(Boolean);
      if (!b && intelAlt.length) b = intelAlt.map(k => blenderCpu.get(k)).find(Boolean);
    } else if (item.category === 'GPU') {
      key = gpuKey(item.specs?.chipset) ?? gpuKey(item.name);
      b = key && blenderGpu.get(key);
      // 游戏表可按显存区分（如 RTX 5060 TI 16GB），优先精确匹配
      const exact = key && gamingGpu.get(`${key} ${item.specs?.capacityGB}GB`);
      g = key && (exact ?? gamingGpu.get(key));
      // 评测用的是另一种显存版本（如 3050 8GB 的分数不能给 3050 6GB）：没有单独数据就不套用
      if (g && !exact && g.memoryGB && item.specs?.capacityGB && item.specs.capacityGB !== g.memoryGB) {
        variantNote = `${key} ${item.specs.capacityGB}GB 与评测版本（${g.memoryGB}GB）的核心 / 位宽可能不同，没有单独的测试数据`;
        g = null;
      }
      // 国内特供 D 版（如 RTX 5090 D、4090 D）游戏性能与标准版基本一致，沿用标准版并注明
      if (!g && key && / D$/.test(key)) {
        const base = gamingGpu.get(key.replace(/ D$/, ''));
        if (base) g = { ...base, label: `按 ${key.replace(/ D$/, '')} 计` };
      }
    }
    const benchmarks = item.category === 'GPU' && key ? scenario.forGpu(key, item.specs?.capacityGB) : [];
    if (!b && !g && !benchmarks.length) return variantNote ? { ...item, performance: { key, blender: null, gaming: null, note: variantNote } } : item;
    return {
      ...item,
      performance: {
        key,
        ...item.performance,
        ...(benchmarks.length ? { benchmarks } : {}),
        blender: b ? { score: b.score, runs: b.runs, api: b.api, sourceUrl: blender.url, snapshotGeneratedAt: blender.generatedAt ?? null } : null,
        gaming: g ? { index: g.relative, label: g.label ?? null, sourceUrl: (item.category === 'CPU' ? gaming.cpu : gaming.gpu)?.url ?? null, observedAt: (item.category === 'CPU' ? gaming.cpu : gaming.gpu)?.date ?? null, confidence: g.estimated ? 'low' : g.converted ? 'medium' : 'medium' } : null,
        ...(variantNote ? { note: variantNote } : {}),
      },
    };
  }

  return { attach, meta };
}
