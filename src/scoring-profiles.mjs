// 场景评分配置：整机综合评分的权重与容量目标（配置化，避免散落在代码各处）。
//
// 评分 0–100，由以下分项加权：
//   gpu      显卡（游戏用 2K 游戏指数；AI 用“显存为主 + 算力”；剪辑用渲染算力）
//   cpu      CPU（游戏用 1080p 游戏指数；AI / 剪辑 / 办公用 Blender 多核分）
//   memory   内存容量相对用途目标
//   storage  硬盘容量与品质（剪辑 / AI 重视 TLC、有缓存）
//   quality  电源、主板、散热的品质与余量
//   noise    噪音（安静优先时加权）
//   trust    数据可信度：价格可信度、兼容性条件项与待核实项
// gpuCurve：显卡分 = (指数 / 参照)^gpuCurve。4K 吃显卡用线性；2K、电竞用 <1 的指数，体现边际收益递减。
// 性能指标都是“同一目录里的相对值”，只用于在候选之间比较，不代表实际帧数或 AI 吞吐。
//
// 数据来源与置信度：
//   游戏指数   data/perf-gaming.json（TechPowerUp / TechSpot 汇总图，部分换算或按比例估算，条目标注 label / converted / estimated）
//   Blender    Blender Open Data（CC0），中位数，≥3 次提交
//   显存、功耗  目录规格（ZOL 参数页 / BuildCores）

export const SCORING_VERSION = '2026-11-26';

const W = (gpu, cpu, memory, storage, quality, noise, trust) => ({ gpu, cpu, memory, storage, quality, noise, trust });

export const SCORING_PROFILES = {
  '2k': { label: '2K 游戏', weights: W(0.50, 0.18, 0.07, 0.05, 0.10, 0.02, 0.08), gpuMetric: 'gaming', cpuMetric: 'gaming', ramGB: 32, ssdGB: 1000, gpuCurve: 0.7 },
  '4k': { label: '4K / 光追游戏', weights: W(0.60, 0.12, 0.06, 0.05, 0.09, 0.02, 0.06), gpuMetric: 'gaming', cpuMetric: 'gaming', ramGB: 32, ssdGB: 2000, gpuCurve: 1 },
  '1080p': { label: '1080p 电竞', weights: W(0.40, 0.30, 0.07, 0.04, 0.09, 0.02, 0.08), gpuMetric: 'gaming', cpuMetric: 'gaming', ramGB: 32, ssdGB: 1000, gpuCurve: 0.6 },
  ai: { label: 'AI / 机器学习', weights: W(0.52, 0.08, 0.14, 0.07, 0.10, 0.01, 0.08), gpuMetric: 'ai', cpuMetric: 'multicore', ramGB: 64, ssdGB: 2000 },
  creator: { label: '视频剪辑 / 设计', weights: W(0.22, 0.32, 0.15, 0.12, 0.10, 0.01, 0.08), gpuMetric: 'creator', cpuMetric: 'multicore', ramGB: 64, ssdGB: 2000 },
  office: { label: '办公学习', weights: W(0.00, 0.35, 0.15, 0.15, 0.15, 0.08, 0.12), gpuMetric: 'none', cpuMetric: 'multicore', ramGB: 16, ssdGB: 512 },
};

/**
 * 各档的“花钱惩罚”λ：目标函数 = 评分 − λ × 100 × (总价 / 本档目标预算)。
 * 省钱版 λ 大（同样的评分要更便宜），进阶版 λ 小（愿意为提升多花钱）。
 * λ 递减 + 可选范围递增 ⇒ 预算越高的档位综合评分不会更低。
 */
export const TIER_COST_PENALTY = { save: 0.22, balanced: 0.12, plus: 0.06 };

/**
 * 用途的最低要求（软约束：本档有满足的组合时只在这些里挑；都不满足时用最好的并说明没达到哪一项）。
 * gpuGaming：2K 游戏指数下限；vramGB：AI 显存下限；ramGB(target)：按本档目标预算给内存下限。
 */
export const MIN_REQUIREMENTS = {
  '2k': { gpuGaming: 30, ramGB: t => (t >= 600000 ? 32 : 16) },
  '4k': { gpuGaming: 45, ramGB: t => (t >= 600000 ? 32 : 16) },
  '1080p': { gpuGaming: 25, ramGB: t => (t >= 600000 ? 32 : 16) },
  ai: { vramGB: 12, ramGB: t => (t >= 1000000 ? 64 : 32) },
  creator: { vramGB: 8, ramGB: t => (t >= 1200000 ? 64 : t >= 500000 ? 32 : 16) },
  office: { ramGB: () => 16 },
};

/**
 * 游戏用途的 CPU / 显卡搭配：建议 CPU 游戏指数 ≥ base + perGpu × 显卡游戏指数（如 9070 GRE 64 → 约 66），
 * 每差 1 点扣 penalty 分。避免为了堆显卡把 CPU 降到拖后腿。
 */
export const CPU_BALANCE = { base: 40, perGpu: 0.4, penalty: 0.4 };

/** 上一代产品（priceFlags 含 legacy）每件扣的可信度分（0–1 标度） */
export const LEGACY_TRUST_PENALTY = 0.05;

/** 进阶版 / 推荐版相对上一档的评分提升不到这个值，就不强行堆料，沿用上一档并说明 */
export const MIN_TIER_GAIN = 2;

/** 安静优先：噪音分项的权重提高到这个值（从其他分项按比例挪） */
export const QUIET_NOISE_WEIGHT = 0.12;
