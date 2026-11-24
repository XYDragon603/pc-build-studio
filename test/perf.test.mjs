import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cpuKey, gpuKey } from '../src/perfkeys.mjs';
import { loadPerformance } from '../src/performance.mjs';
import { summarizeSubmission } from '../scripts/import-blender.mjs';

test('型号键：Blender 原始名与中文商品名对得上', () => {
  assert.equal(cpuKey('AMD Ryzen 7 9700X 8-Core Processor'), cpuKey('AMD Ryzen 7 9700X'));
  assert.equal(cpuKey('Intel(R) Core(TM) i5-14600KF'), cpuKey('Intel 酷睿 i5 14600KF'));
  assert.equal(cpuKey('Intel(R) Core(TM) Ultra 7 265K'), cpuKey('Intel 酷睿 Ultra 7 265K'));
  assert.equal(cpuKey('AMD 锐龙 9 9950X3D2'), 'RYZEN 9950X3D2');
  assert.notEqual(cpuKey('AMD Ryzen 5 5600'), cpuKey('AMD Ryzen 5 5600X'));
  assert.equal(gpuKey('NVIDIA GeForce RTX 5060 Ti'), gpuKey('GeForce RTX 5060 Ti'));
  assert.equal(gpuKey('AMD Radeon RX 9070 XT'), 'RX 9070 XT');
  assert.equal(gpuKey('Intel(R) Arc(TM) B580 Graphics'), 'ARC B580');
});

const run = (scene, spm, name = 'AMD Ryzen 7 9700X 8-Core Processor', type = 'CPU', version = '4.5.0') => ({
  blender_version: { version }, scene: { label: scene }, stats: { samples_per_minute: spm },
  device_info: { device_type: type, compute_devices: [{ name, type }] }, system_info: { num_cpu_sockets: 1 },
});

test('一次提交三个场景齐全才计分；显卡只取厂商对应接口', () => {
  const full = { data: [run('monster', 100), run('junkshop', 80), run('classroom', 120)] };
  assert.deepEqual(summarizeSubmission(full, '4.5.0'), { kind: 'cpu', key: 'RYZEN 9700X', name: 'AMD Ryzen 7 9700X 8-Core Processor', api: 'CPU', score: 300 });
  assert.equal(summarizeSubmission({ data: [run('monster', 100), run('junkshop', 80)] }, '4.5.0'), null);
  assert.equal(summarizeSubmission(full, '5.1.0'), null);
  const amdCuda = { data: ['monster', 'junkshop', 'classroom'].map(s => run(s, 1000, 'AMD Radeon RX 9070 XT', 'OPTIX')) };
  assert.equal(summarizeSubmission(amdCuda, '4.5.0'), null);
  const amdHip = { data: ['monster', 'junkshop', 'classroom'].map(s => run(s, 1000, 'AMD Radeon RX 9070 XT', 'HIP')) };
  assert.equal(summarizeSubmission(amdHip, '4.5.0').key, 'RX 9070 XT');
  assert.equal(summarizeSubmission({ data: 'old-format' }, '4.5.0'), null);
});

test('目录条目挂上 Blender 分与游戏指数；显卡游戏表优先按显存精确匹配', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'perf-'));
  t.after(async () => { for (const f of await readdir(dir)) await unlink(join(dir, f)); await rmdir(dir); });
  await writeFile(join(dir, 'blender-scores.json'), JSON.stringify({
    cpus: [{ key: 'RYZEN 9700X', score: 309.3, runs: 439, api: 'CPU' }],
    gpus: [{ key: 'RTX 5060 TI', score: 4309.3, runs: 655, api: 'OPTIX' }],
  }));
  const gamingFile = join(dir, 'gaming.json');
  await writeFile(gamingFile, JSON.stringify({ cpu: null, gpu: { source: 'x', entries: [
    { key: 'RTX 5060 TI 16GB', relative: 100 }, { key: 'RTX 5060 TI 8GB', relative: 93 } ] } }));
  const { attach } = loadPerformance(dir, gamingFile);
  assert.equal(attach({ category: 'CPU', name: 'AMD Ryzen 7 9700X', specs: {} }).performance.blender.score, 309.3);
  const g16 = attach({ category: 'GPU', name: '七彩虹 RTX 5060 Ti', specs: { chipset: 'GeForce RTX 5060 Ti', capacityGB: 16 } });
  const g8 = attach({ category: 'GPU', name: '影驰 RTX 5060 Ti', specs: { chipset: 'GeForce RTX 5060 Ti', capacityGB: 8 } });
  assert.deepEqual([g16.performance.gaming.index, g8.performance.gaming.index], [100, 93]);
  assert.equal(attach({ category: 'RAM', name: 'x', specs: {} }).performance, undefined);
});

test('Intel KF / F 型号对上 K / 无 F 的游戏指数；AMD 不做模糊匹配', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'perf-intel-'));
  t.after(async () => { for (const f of await readdir(dir)) await unlink(join(dir, f)); await rmdir(dir); });
  const gamingFile = join(dir, 'gaming.json');
  await writeFile(gamingFile, JSON.stringify({ gpu: null, cpu: { source: 'x', entries: [
    { key: 'I5-14600K', relative: 72 }, { key: 'I3-14100F', relative: 53.5 }, { key: 'RYZEN 7600X', relative: 72.1 } ] } }));
  const { attach } = loadPerformance(dir, gamingFile);
  assert.equal(attach({ category: 'CPU', name: 'Intel 酷睿 i5 14600KF', specs: {} }).performance.gaming.index, 72);
  assert.equal(attach({ category: 'CPU', name: 'Intel 酷睿 i3 14100', specs: {} }).performance.gaming.index, 53.5);
  assert.equal(attach({ category: 'CPU', name: 'AMD Ryzen 5 7600', specs: {} }).performance, undefined);
});
