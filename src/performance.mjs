// 性能参考数据：Blender Open Data 渲染跑分（CC0，scripts/import-blender.mjs 生成）
// 与 data/perf-gaming.json 里按评测整理的游戏相对性能（注明出处）。都只作参考。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cpuKey, gpuKey } from './perfkeys.mjs';

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

export function loadPerformance(directory, dataFile = new URL('../data/perf-gaming.json', import.meta.url)) {
  const blender = directory === null ? null : readJson(join(directory, 'blender-scores.json'), null);
  const gaming = readJson(dataFile, { cpu: null, gpu: null });
  const index = list => new Map((list ?? []).map(r => [r.key, r]));
  const blenderCpu = index(blender?.cpus);
  const blenderGpu = index(blender?.gpus);
  const gamingCpu = index(gaming.cpu?.entries);
  const gamingGpu = index(gaming.gpu?.entries);

  const meta = {
    blender: blender ? { source: blender.source, url: blender.url, license: blender.license, version: blender.blenderVersion, snapshot: blender.snapshot } : null,
    gamingCpu: gaming.cpu ? { source: gaming.cpu.source, url: gaming.cpu.url, resolution: gaming.cpu.resolution, baseline: gaming.cpu.baseline, date: gaming.cpu.date } : null,
    gamingGpu: gaming.gpu ? { source: gaming.gpu.source, url: gaming.gpu.url, resolution: gaming.gpu.resolution, baseline: gaming.gpu.baseline, date: gaming.gpu.date } : null,
  };

  /** 给 CPU / 显卡条目加上 performance 字段；对不上的保持原样 */
  function attach(item) {
    let key = null;
    let b = null;
    let g = null;
    if (item.category === 'CPU') {
      key = cpuKey(item.name) ?? cpuKey(item.mpn) ?? item.aliases?.map(cpuKey).find(Boolean) ?? null;
      b = key && blenderCpu.get(key);
      g = key && gamingCpu.get(key);
    } else if (item.category === 'GPU') {
      key = gpuKey(item.specs?.chipset) ?? gpuKey(item.name);
      b = key && blenderGpu.get(key);
      // 游戏表可按显存区分（如 RTX 5060 TI 16GB），优先精确匹配
      g = key && (gamingGpu.get(`${key} ${item.specs?.capacityGB}GB`) ?? gamingGpu.get(key));
    }
    if (!b && !g) return item;
    return {
      ...item,
      performance: {
        key,
        blender: b ? { score: b.score, runs: b.runs, api: b.api } : null,
        gaming: g ? { index: g.relative, label: g.label ?? null } : null,
      },
    };
  }

  return { attach, meta };
}
