// 外设推荐：显示器、键盘、鼠标。返回独立小计，由组合优化器纳入整机总预算。
//
// 规则：
// - 显示器：办公 24 寸 1080p（进阶版 27 寸 2K）；游戏看显卡，游戏指数 ≥ 35 配 27 寸 2K ≥144Hz，
//   较弱的显卡或核显配 1080p（游戏要高刷）。显卡带不动 2K 高刷时宁可推 1080p。
// - 键盘：游戏要机械键盘；办公优先无线薄膜。鼠标：游戏要 ≥ 8000 DPI；办公要无线、非游戏鼠标。
// - 同一组里按价格分位挑：省钱版 20%、推荐版 45%、进阶版 70%（办公 15% / 30% / 50%），避开最便宜的杂牌和最贵的旗舰。
// - 只用较可靠的价格：疑似旧价、同类粗估、系列起价不选；有图优先。

export const PERIPHERAL_SLOTS = ['MONITOR', 'KEYBOARD', 'MOUSE'];

const PERCENTILE = { save: 0.2, balanced: 0.45, plus: 0.7 };
// 办公外设够用就好，整体挑低一些
const OFFICE_PERCENTILE = { save: 0.15, balanced: 0.3, plus: 0.5 };

const reliable = item => item.estimatedPriceCents > 0 && !item.possiblyStale
  && !['class-median', 'series-low'].includes(item.estimateBasis);

/** 按价格分位挑；有图的优先（同分位附近 ±2 名里找有图的） */
function pickAt(candidates, percentile) {
  if (!candidates.length) return null;
  const sorted = [...candidates].sort((a, b) => a.estimatedPriceCents - b.estimatedPriceCents);
  const index = Math.min(sorted.length - 1, Math.floor(percentile * sorted.length));
  const nearby = [0, 1, -1, 2, -2].map(d => sorted[index + d]).filter(Boolean);
  return nearby.find(item => item.imageUrl) ?? sorted[index];
}

/** 显示器的目标规格与说明 */
export function monitorTarget({ office, work = false, uhd = false, esports = false, tier, gpuIndex, igpu }) {
  const strongGpu = !igpu && gpuIndex != null && gpuIndex >= 35;
  // AI / 剪辑：屏幕要大、分辨率高（代码、时间线、预览），刷新率不重要
  if (work) {
    return tier === 'save'
      ? { size: [23.5, 24.5], height: 1080, minHz: 60, why: '省钱版：24 寸 1080p' }
      : { size: [26.5, 27.5], height: 1440, minHz: 60, why: '27 寸 2K：代码、时间线一屏放得下' };
  }
  // 办公方案都是核显，核显带 2K 桌面没问题，所以办公只看档位
  if (office) {
    return tier === 'plus'
      ? { size: [26.5, 27.5], height: 1440, minHz: 60, why: '办公进阶：27 寸 2K，字更清楚' }
      : { size: [23.5, 24.5], height: 1080, minHz: 60, why: '办公：24 寸 1080p 够用' };
  }
  // 游戏方案预算不够独显、退到核显时：1080p 就好
  if (igpu) return { size: [23.5, 24.5], height: 1080, minHz: 60, why: '核显方案配 24 寸 1080p' };
  // 4K 游戏：显卡很强（指数 ≥ 65）才配 4K 高刷，否则退回 2K 高刷
  if (uhd && !igpu && gpuIndex != null && gpuIndex >= 65) return { size: [26.5, 32.5], height: 2160, minHz: 144, why: '显卡能带 4K：27–32 寸 4K ≥144Hz' };
  // 电竞：小一点、刷新率高
  if (esports) return { size: [23.5, 25.5], height: 1080, minHz: 165, why: '电竞：24–25 寸 1080p ≥165Hz，帧数优先' };
  if (strongGpu) return { size: [26.5, 27.5], height: 1440, minHz: 144, why: '显卡能带 2K 高刷：27 寸 2K ≥144Hz' };
  return { size: [23.5, 27.5], height: 1080, minHz: 144, why: '显卡更适合 1080p：24–27 寸 1080p 高刷' };
}

export function recommendPeripherals(items, { scenarios = [], tier = 'balanced', gpuIndex = null, igpu = false, slots = PERIPHERAL_SLOTS } = {}) {
  const office = scenarios.includes('office');
  // AI / 剪辑：键鼠按办公思路（无线、不要游戏外设），显示器单独规则
  const work = scenarios.includes('ai') || scenarios.includes('creator');
  const uhd = scenarios.includes('4k');
  const esports = scenarios.includes('1080p');
  const percentile = (office ? OFFICE_PERCENTILE : PERCENTILE)[tier] ?? PERCENTILE.balanced;
  const pool = category => items.filter(item => item.category === category && item.market !== 'global' && reliable(item));
  const picks = [];

  if (slots.includes('MONITOR')) {
    const target = monitorTarget({ office, work, uhd, esports, tier, gpuIndex, igpu });
    const match = pool('MONITOR').filter(({ specs: s = {} }) =>
      s.sizeInch >= target.size[0] && s.sizeInch <= target.size[1] && s.heightPx === target.height
      && Math.abs(s.widthPx / s.heightPx - 16 / 9) < 0.05 && (s.refreshHz ?? 60) >= target.minHz && !s.curved);
    const item = pickAt(match, percentile);
    if (item) picks.push({ slot: 'MONITOR', item, reason: `${target.why}；同类 ${match.length} 款里挑价位居中偏${tier === 'plus' ? '上' : tier === 'save' ? '下' : '中'}的` });
  }
  if (slots.includes('KEYBOARD')) {
    // 少于 60 键的是数字小键盘 / 宏键盘，不算键盘
    const all = pool('KEYBOARD').filter(i => !(i.specs?.keys < 60));
    // 办公优先无线薄膜键盘（安静、便宜），不够 3 款再放宽到无线
    const quietWireless = all.filter(i => i.specs?.wireless && !i.specs?.mechanical);
    // AI / 剪辑：无线即可（机械、薄膜都行），长时间打字的人常选机械
    const wanted = office ? (quietWireless.length >= 3 ? quietWireless : all.filter(i => i.specs?.wireless))
      : work ? all.filter(i => i.specs?.wireless) : all.filter(i => i.specs?.mechanical);
    const item = pickAt(wanted.length >= 3 ? wanted : all, percentile);
    if (item) picks.push({ slot: 'KEYBOARD', item, reason: office ? '办公：无线键盘，桌面清爽' : work ? '无线键盘' : '游戏：机械键盘' });
  }
  if (slots.includes('MOUSE')) {
    const all = pool('MOUSE');
    // 办公不需要游戏鼠标：无线、DPI 低于 8000（或没标）
    const wanted = office || work ? all.filter(i => i.specs?.wireless && (i.specs?.dpi ?? 0) < 8000) : all.filter(i => (i.specs?.dpi ?? 0) >= 8000);
    const item = pickAt(wanted.length >= 3 ? wanted : all, percentile);
    if (item) picks.push({ slot: 'MOUSE', item, reason: office || work ? '无线鼠标' : '游戏：≥ 8000 DPI 游戏鼠标' });
  }
  return { picks, totalCents: picks.reduce((sum, p) => sum + p.item.estimatedPriceCents, 0) };
}
