// 使用场景（用途）：首页下拉框、配置页标签、出方案时传给后端的 scenario。
// 后端 src/recommend.mjs 的 PROFILES 按同样的 scenario 决定预算分配和挑选规则。

export type Purpose = 'game' | '4k' | '1080p' | 'ai' | 'creator' | 'office';

export const PURPOSES: { id: Purpose; scenario: string; label: string; hint: string }[] = [
  { id: 'game', scenario: '2k', label: '2K 游戏', hint: '主流游戏，2K 中高画质' },
  { id: '4k', scenario: '4k', label: '4K / 光追游戏', hint: '显卡分得更多' },
  { id: '1080p', scenario: '1080p', label: '1080p 电竞', hint: '高帧率，CPU 分得更多' },
  { id: 'ai', scenario: 'ai', label: 'AI / 机器学习', hint: '显存优先，NVIDIA（CUDA），内存硬盘更大' },
  { id: 'creator', scenario: 'creator', label: '视频剪辑 / 设计', hint: '多核 CPU、RTX 显卡、大内存' },
  { id: 'office', scenario: 'office', label: '办公学习', hint: '核显，够用就好' },
];

export const purposeScenario = (purpose: Purpose) => PURPOSES.find(p => p.id === purpose)?.scenario ?? '2k';

/** 方案的 scenarios 里对应的用途（标签显示用）；旧方案没有就返回 null */
export const purposeOfScenarios = (scenarios: string[]) => PURPOSES.find(p => scenarios.includes(p.scenario)) ?? null;

/** AI 方案：按显存给一句能跑多大模型的粗略参考（4-bit 量化） */
export function vramHint(gb: number | undefined): string | null {
  if (!gb) return null;
  if (gb >= 24) return '本地大约能跑 30B 左右的模型（4-bit 量化）';
  if (gb >= 16) return '本地大约能跑 14B–20B 的模型（4-bit 量化）';
  if (gb >= 12) return '本地大约能跑 7B–14B 的模型（4-bit 量化）';
  return '本地大约能跑 7B 左右的小模型（4-bit 量化）';
}
