import { STRATEGY_COST_PENALTY } from './scoring-profiles.mjs';

export const STRATEGIES = ['value', 'balanced', 'performance'];

export function corePerformance(build, profile) {
  const ai = profile.gpuMetric === 'ai';
  const gaming = profile.gpuMetric === 'gaming';
  const gpu = build.gpu;
  const vram = gpu?.specs.capacityGB ?? 0;
  const compute = gpu?.performance?.blender?.score ?? null;
  const raster = gpu?.performance?.gaming?.index ?? null;
  const cpu = profile.cpuMetric === 'gaming' ? build.cpu.performance?.gaming?.index : build.cpu.performance?.blender?.score;
  const metric = gaming ? raster : compute;
  const gpuUtility = metric == null ? 0 : Math.log1p(metric / (gaming ? 20 : 900));
  const cpuUtility = Math.log1p((cpu ?? 0) / (profile.cpuMetric === 'gaming' ? 30 : 100));
  const value = profile.gpuMetric === 'none' ? cpuUtility
    : ai ? gpuUtility + 1.5 * Math.log1p(vram / 8) + .10 * cpuUtility
      : gpuUtility + (gaming ? .30 : .65) * cpuUtility;
  return { value, vram, compute, raster, cpu: cpu ?? null, metric, proxy: profile.gpuMetric === 'none' ? 'Blender CPU' : gaming ? '2K 光栅指数' : 'Blender 渲染分' };
}

/**
 * 目标函数（2.2.1）。2.2.0 用“核心性能 − 成本”，硬盘、内存、主板、散热都不进目标，结果永远选最便宜的硬盘 / 散热器。
 *   value / balanced：场景综合评分（含硬盘容量、内存、品质、可信度）− λ × 100 × 总价 / 本档目标
 *   performance：返回 [核心性能, 均衡目标]，selectBuild 按字典序比较——先最大化用户工作负载的核心性能，
 *                核心性能相同（同一 CPU / 显卡）再按均衡目标挑其余配件，不会为了“性能优先”买最便宜的硬盘。
 */
export function selectionValue(build, strategy, tier, target) {
  const lambda = (STRATEGY_COST_PENALTY[strategy] ?? STRATEGY_COST_PENALTY.balanced)[tier] ?? 0.12;
  const value = build.score.total - lambda * 100 * (build.total / Math.max(1, target));
  return strategy === 'performance' ? build.core.value * 1000 + value / 1000 : value;
}

// 核心性能视为相同的容差（对数刻度，约 0.5%）：同 CPU / 显卡的组合核心值完全相同；不同型号差异小于测量精度时不强行区分
export const CORE_EPSILON = 0.005;

export function selectBuild(pool, strategy, tier, target) {
  const lambda = (STRATEGY_COST_PENALTY[strategy] ?? STRATEGY_COST_PENALTY.balanced)[tier] ?? 0.12;
  const objective = b => b.score.total - lambda * 100 * (b.total / Math.max(1, target));
  let candidates = pool;
  if (strategy === 'performance' && pool.length) {
    const top = Math.max(...pool.map(b => b.core.value));
    candidates = pool.filter(b => b.core.value >= top - CORE_EPSILON);
  }
  return candidates.reduce((best, build) => {
    if (!best) return build;
    const diff = objective(build) - objective(best);
    if (Math.abs(diff) > 1e-9) return diff > 0 ? build : best;
    if (build.total !== best.total) return build.total < best.total ? build : best;
    return build.score.total > best.score.total ? build : best;
  }, null);
}

export function strongerOptions(pool, current, limit = 3) {
  const byHardware = new Map();
  for (const build of pool) {
    if (build.core.metric == null && build.gpu) continue;
    if (build.core.value <= current.core.value || build.total < current.total) continue;
    const key = build.gpu?.id ?? build.cpu.id;
    if (key === (current.gpu?.id ?? current.cpu.id)) continue;
    const previous = byHardware.get(key);
    if (!previous || build.total < previous.total) byHardware.set(key, build);
  }
  let best = current.core.value;
  return [...byHardware.values()].sort((a, b) => a.total - b.total || b.core.value - a.core.value).filter(build => {
    if (build.core.value <= best) return false;
    best = build.core.value;
    return true;
  }).slice(-limit);
}
