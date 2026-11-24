// 从 Blender Open Data（CC0）快照汇总 CPU / 显卡的 Blender 渲染跑分。
//
//   curl -o .runtime/blender-opendata/opendata-latest.zip https://opendata.blender.org/snapshots/opendata-latest.zip
//   （解压到 .runtime/blender-opendata/extracted/）
//   node scripts/import-blender.mjs [--version 4.5.0]
//
// 跑分 = 同一次提交里 monster + junkshop + classroom 三个场景每分钟采样数之和（与官网一致）。
// 只取同一个 Blender 版本，按型号取中位数，至少 3 次提交。显卡按厂商取对应接口：
// NVIDIA → OPTIX，AMD → HIP，Intel → ONEAPI。
// 注意：这是渲染性能，不是游戏性能；显卡跨厂商比较会明显偏向 NVIDIA（RT 核心加速）。
import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { LocalStore } from '../src/store.mjs';
import { cpuKey, gpuKey } from '../src/perfkeys.mjs';

export { cpuKey, gpuKey };

const SCENES = ['monster', 'junkshop', 'classroom'];
const GPU_API = { NVIDIA: 'OPTIX', AMD: 'HIP', INTEL: 'ONEAPI' };

const vendorOf = name => (/NVIDIA|GEFORCE|RTX|GTX/i.test(name) ? 'NVIDIA' : /AMD|RADEON/i.test(name) ? 'AMD' : /INTEL|ARC/i.test(name) ? 'INTEL' : null);

const median = values => {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/** 汇总一条提交：三个场景齐全时返回 { kind, key, name, api, score } */
export function summarizeSubmission(record, version) {
  // 早期格式的 data 不是数组，直接跳过
  const runs = (Array.isArray(record.data) ? record.data : []).filter(d => d.blender_version?.version === version && d.stats?.samples_per_minute > 0);
  if (!runs.length) return null;
  const first = runs[0];
  const type = first.device_info?.device_type;
  const name = first.device_info?.compute_devices?.[0]?.name ?? '';
  const byScene = new Map(runs.map(r => [r.scene?.label, r.stats.samples_per_minute]));
  if (!SCENES.every(s => byScene.has(s))) return null;
  // 同一次提交的三个场景必须是同一设备、同一接口
  if (runs.some(r => r.device_info?.device_type !== type || r.device_info?.compute_devices?.[0]?.name !== name)) return null;
  const score = SCENES.reduce((sum, s) => sum + byScene.get(s), 0);
  if (type === 'CPU') {
    // 多路 CPU 的结果不代表单颗性能
    if ((first.system_info?.num_cpu_sockets ?? 1) !== 1) return null;
    const key = cpuKey(name);
    return key ? { kind: 'cpu', key, name, api: 'CPU', score } : null;
  }
  const vendor = vendorOf(name);
  if (!vendor || GPU_API[vendor] !== type) return null;
  // 多卡渲染的结果不代表单卡
  if ((first.device_info?.compute_devices?.length ?? 1) !== 1) return null;
  const key = gpuKey(name);
  return key ? { kind: 'gpu', key, name, api: type, score } : null;
}

async function main() {
  const { values } = parseArgs({ options: { version: { type: 'string', default: '4.5.0' }, dir: { type: 'string', default: '.runtime/blender-opendata/extracted' } } });
  const dir = path.resolve(values.dir);
  const file = (await readdir(dir)).find(f => /^opendata-.*\.jsonl$/.test(f));
  if (!file) throw new Error(`没有找到 ${dir}/opendata-*.jsonl，请先下载并解压快照`);
  const groups = new Map();
  let lines = 0, used = 0, broken = 0;
  const rl = createInterface({ input: createReadStream(path.join(dir, file)), crlfDelay: Infinity });
  for await (const line of rl) {
    lines++;
    let record;
    try { record = JSON.parse(line); } catch { broken++; continue; }
    const s = summarizeSubmission(record, values.version);
    if (!s) continue;
    used++;
    const id = `${s.kind}:${s.key}`;
    const g = groups.get(id) ?? { kind: s.kind, key: s.key, api: s.api, names: new Map(), scores: [] };
    g.scores.push(s.score);
    g.names.set(s.name, (g.names.get(s.name) ?? 0) + 1);
    groups.set(id, g);
    if (lines % 50000 === 0) process.stdout.write(`\r已读 ${lines} 行，采用 ${used} 次提交`);
  }
  process.stdout.write('\n');
  const rows = [...groups.values()].filter(g => g.scores.length >= 3).map(g => ({
    kind: g.kind,
    key: g.key,
    // 出现最多的原始设备名，便于核对
    name: [...g.names].sort((a, b) => b[1] - a[1])[0][0],
    api: g.api,
    score: Math.round(median(g.scores) * 10) / 10,
    runs: g.scores.length,
  })).sort((a, b) => b.score - a.score);
  const out = {
    source: 'Blender Open Data', url: 'https://opendata.blender.org/', license: 'CC0 1.0',
    snapshot: file, blenderVersion: values.version, generatedAt: new Date().toISOString(),
    note: 'monster + junkshop + classroom 每分钟采样数之和，按型号取中位数（≥3 次提交）。渲染性能，不是游戏性能；显卡跨厂商比较偏向 NVIDIA。',
    cpus: rows.filter(r => r.kind === 'cpu').map(({ kind, ...r }) => r),
    gpus: rows.filter(r => r.kind === 'gpu').map(({ kind, ...r }) => r),
  };
  await new LocalStore().write('blender-scores.json', out);
  console.log(JSON.stringify({ lines, broken, usedSubmissions: used, cpus: out.cpus.length, gpus: out.gpus.length }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
