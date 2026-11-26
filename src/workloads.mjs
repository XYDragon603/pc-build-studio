export const WORKLOAD_TASKS = {
  '1080p': ['esports'], '2k': ['raster'], '4k': ['raster4k', 'rayTracing', 'native4k', 'upscaling', 'frameGeneration'],
  creator: ['premiere', 'resolve', 'capcut', 'blender'], ai: ['llm', 'comfyui', 'aiImage', 'aiVideo', 'videoEnhancement', 'training', 'finetuning'], office: ['office'],
};
export function validateWorkload(input = {}, scenario = 'office') {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('workload 必须为对象');
  const task = input.task ?? WORKLOAD_TASKS[scenario]?.[0] ?? 'office';
  if (!WORKLOAD_TASKS[scenario]?.includes(task)) throw new Error('细分任务与一级场景不匹配');
  const out = { task };
  for (const k of ['game', 'quality', 'material', 'model', 'benchmarkId']) if (input[k] != null) { if (typeof input[k] !== 'string' || input[k].length > 100) throw new Error(`${k} 无效`); out[k] = input[k]; }
  for (const [k, lo, hi] of [['targetFps', 1, 1000], ['minVramGB', 1, 512], ['minSsdGB', 128, 16000], ['minRamGB', 4, 1024], ['ambientC', 0, 50], ['cpuPowerLimitWatts', 10, 1000], ['maxNoiseDbA', 15, 60]]) if (input[k] != null) {
    if (!Number.isFinite(input[k]) || input[k] < lo || input[k] > hi) throw new Error(`${k} 无效`); out[k] = input[k];
  }
  return out;
}

// Explicit heuristic preferences, not software benchmark claims. Corresponding
// measured performance may replace the proxy, but missing results stay unknown.
export function workloadProfile(base, key, workload) {
  const p = { ...base, weights: { ...base.weights }, evidenceBasis: 'heuristic-preferences' };
  if (key === 'creator' && workload.task === 'resolve') {
    const shift = .10; p.weights.gpu += shift; p.weights.cpu -= shift;
  }
  if (key === 'creator' && workload.material === '8K') { p.ramGB = 128; p.ssdGB = 4000; }
  if (key === 'ai' && ['training', 'finetuning', 'aiVideo'].includes(workload.task)) { p.ramGB = 128; p.vramRefGB = 48; }
  if (key === 'ai' && ['comfyui', 'aiImage'].includes(workload.task)) { p.vramRefGB = 24; }
  return p;
}
