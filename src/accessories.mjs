// 整机必需附件成本模型（2.2.2）。
//
// 2.2.1 的兼容检查会写“至少需要 3 个进风 + 1 个排风风扇……不足时需另购（未计入总价）”，而总价只加
// 机箱记录里的 requiredFanCostCents（目录覆盖 0/230），30/36 套方案的风扇费用都没有进预算；
// 20000 元 AI 推荐版只剩 27 元。现在预算、选件、兼容说明和导出共用这里的一个模型：
//   核心八件套价格  coreCents
//   必需附件        required（机箱风扇、电源转接支架）→ requiredCents（按保守上限计入完整总价）
//   可选升级附件    optional（不计入总价）
//   完整可安装总价  completeCents = core + required；estimatedRangeCents 为 [下限, 上限]
// 价格来源：机箱记录的另购费用 > 用户填写的单价 > 工程估算区间（标为估算，不是报价）。

export const FAN_UNIT_ESTIMATE_CENTS = [1500, 3000]; // 普通 120mm 机箱风扇，工程估算区间（非报价）
export const FAN_HUB_ESTIMATE_CENTS = [2000, 4000]; // PWM 风扇集线器，工程估算区间（非报价）
export const FAN_SPEC = '120mm 4pin PWM 机箱风扇（具体型号未指定，目录无风扇商品）';

/** 按整机持续热负载给出机箱风扇需求（工程规则，不是实测）：进风 / 排风数量 */
export function requiredCaseFans(cpuW = 0, gpuW = 0) {
  const total = (cpuW ?? 0) + (gpuW ?? 0);
  if (total <= 150) return { total, intake: 0, exhaust: 1, optionalTopExhaust: false };
  if (total <= 250) return { total, intake: 1, exhaust: 1, optionalTopExhaust: false };
  if (total <= 450) return { total, intake: 2, exhaust: 1, optionalTopExhaust: false };
  return { total, intake: 3, exhaust: 1, optionalTopExhaust: true };
}

/** 机箱已知风扇位数量（来自规格解析的 fanMounts）；未知返回 null */
export function fanMountCapacity(pc = {}) {
  if (!Array.isArray(pc.fanMounts) || !pc.fanMounts.length) return null;
  // 同一位置不同尺寸是“二选一”（前置 3×120 或 2×140），取该位置最大数量，不相加
  const at = pos => Math.max(0, ...pc.fanMounts.filter(m => m.position === pos).map(m => m.count));
  const sum = positions => positions.reduce((s, p) => s + at(p), 0);
  return { intake: sum(['front', 'side', 'bottom']), exhaust: sum(['rear', 'top']) };
}

/**
 * 计算一台整机的必需附件。
 * pricing：{ fanUnitCents?: 用户确认的风扇单价, includedFans?: 用户确认的机箱预装风扇数 }
 */
export function accessoryCost({ cpuW, gpuW, pc = {}, psu = {}, board = {}, cooler = null, stock = null, pricing = {} } = {}) {
  const need = requiredCaseFans(cpuW, gpuW);
  const fansNeeded = need.intake + need.exhaust;
  const includedKnown = pricing.includedFans ?? pc.includedFans;
  const included = includedKnown ?? 0;
  const additional = Math.max(0, fansNeeded - included);
  const required = [];
  const optional = [];
  let status = 'known';
  if (additional > 0 || pc.requiredFanCostCents > 0) {
    let unit; let range; let priceSource;
    if (pc.requiredFanCostCents > 0 && pricing.fanUnitCents == null) {
      unit = Math.round(pc.requiredFanCostCents / Math.max(1, additional)); range = [pc.requiredFanCostCents, pc.requiredFanCostCents]; priceSource = 'case-record';
    } else if (pricing.fanUnitCents != null) {
      unit = pricing.fanUnitCents; range = [unit * additional, unit * additional]; priceSource = 'user';
    } else {
      unit = FAN_UNIT_ESTIMATE_CENTS[1]; range = FAN_UNIT_ESTIMATE_CENTS.map(c => c * additional); priceSource = 'estimate'; status = 'estimated';
    }
    const total = priceSource === 'case-record' ? pc.requiredFanCostCents : unit * additional;
    // 安装位置：先补进风（前置 / 侧 / 底），再补排风（后置 / 顶）；预装风扇假定装在排风位以外的位置时不影响数量
    const positions = [...Array(Math.max(0, need.intake - Math.max(0, included - need.exhaust))).fill('进风（前置优先）'), ...Array(Math.max(0, need.exhaust - Math.min(included, need.exhaust))).fill('排风（后置）')].slice(0, additional);
    required.push({ id: 'case-fans', name: '机箱额外风扇（120mm）', spec: FAN_SPEC, sizeMm: 120, positions, modelStatus: 'unspecified', quantity: additional, unitPriceCents: unit, priceCents: total, estimatedRangeCents: range, priceSource,
      basis: `整机约 ${need.total}W：需 ${need.intake} 进风 + ${need.exhaust} 排风，${includedKnown == null ? '预装数量未公布，按 0 个保守计价' : `预装 ${included} 个`}，另购 ${additional} 个` });
  }
  if (includedKnown == null && fansNeeded > 0 && !(pc.requiredFanCostCents > 0)) status = 'estimated';
  if (need.optionalTopExhaust) optional.push({ id: 'top-exhaust', name: '顶部排风风扇（建议）', quantity: 1, unitPriceCents: pricing.fanUnitCents ?? FAN_UNIT_ESTIMATE_CENTS[1], priceSource: pricing.fanUnitCents != null ? 'user' : 'estimate' });
  const bracket = ['SFX', 'SFX-L'].includes(psu.psuFormFactor) && !pc.supportedPsuFormats?.includes(psu.psuFormFactor) && !psu.psuAtxBracketIncluded;
  if (bracket) {
    const c = pc.requiredPsuBracketCostCents;
    if (c == null) status = 'unknown';
    required.push({ id: 'psu-bracket', name: '电源转接支架', quantity: 1, unitPriceCents: c ?? null, priceCents: c ?? 0, estimatedRangeCents: c == null ? [null, null] : [c, c], priceSource: c == null ? 'unknown' : 'case-record', basis: 'SFX 电源装 ATX 机箱需要转接支架' });
  }
  // 2.2.3：主板风扇接口容量。需要的接口 = 机箱风扇（预装 + 另购）+ 散热器风扇（+ 水冷泵）；接口不足需集线器 / 分线器。
  const coolerFans = cooler ? (cooler.radiatorSizeMm ? Math.round(cooler.radiatorSizeMm / 120) + 1 : cooler.fanCount ?? 1) : stock ? 1 : 0;
  const headersNeeded = included + additional + coolerFans;
  const headers = board?.fanHeaders ?? null;
  if (headers == null || headersNeeded > headers) {
    const known = headers != null;
    const c = pricing.hubCents;
    required.push({ id: 'fan-hub', name: '风扇集线器 / 分线器', quantity: 1, unitPriceCents: known ? c ?? FAN_HUB_ESTIMATE_CENTS[1] : 0,
      priceCents: known ? c ?? FAN_HUB_ESTIMATE_CENTS[1] : 0, estimatedRangeCents: known ? (c != null ? [c, c] : FAN_HUB_ESTIMATE_CENTS) : [0, FAN_HUB_ESTIMATE_CENTS[1]],
      priceSource: known ? (c != null ? 'user' : 'estimate') : 'contingency', headersNeeded, boardFanHeaders: headers,
      basis: known ? `需要 ${headersNeeded} 个风扇接口，主板 ${headers} 个` : `需要约 ${headersNeeded} 个风扇接口，主板风扇接口数量未录入；若不足需另购集线器（只计入区间上限，不计入估算总价）` });
    if (!known) status = status === 'unknown' ? status : 'estimated';
    else if (c == null) status = status === 'unknown' ? status : 'estimated';
  }
  // 原装散热：只有所购 SKU 明确在附带散热器的零售料号列表中才算确认；否则记备用散热器区间
  if (stock && !stock.confirmed) {
    required.push({ id: 'stock-cooler-contingency', name: '备用散热器（原装散热待确认）', quantity: 1, unitPriceCents: 0, priceCents: 0,
      estimatedRangeCents: [0, stock.fallbackCents ?? 0], priceSource: 'contingency',
      basis: `按盒装附带原装散热计 0 元；具体包装 SKU 未确认，若实际不含散热器需另购（参考最便宜可用散热器 ${stock.fallbackCents != null ? `¥${Math.round(stock.fallbackCents / 100)}` : '未知'}）` });
    status = status === 'unknown' ? status : 'estimated';
  }
  const requiredCents = required.reduce((s, r) => s + (r.priceCents ?? 0), 0);
  const lo = required.reduce((s, r) => s + (r.estimatedRangeCents?.[0] ?? 0), 0);
  const hi = required.reduce((s, r) => s + (r.estimatedRangeCents?.[1] ?? 0), 0);
  return {
    requiredFans: need, includedFans: includedKnown ?? null, additionalFans: additional,
    required, optional, requiredCents, rangeCents: [lo, hi],
    priceStatus: status, // known：全部有确定价格；estimated：含估算；unknown：有必需附件价格未知
  };
}

/** 汇总成方案里的成本分解 */
export function costBreakdown(coreCents, acc) {
  const by = srcs => acc.required.filter(r => srcs.includes(r.priceSource));
  return {
    // 2.2.3：已确认 / 估算 / 未知（只在区间内）三类附件成本分开
    confirmedAccessoriesCents: by(['case-record', 'user']).reduce((s, r) => s + r.priceCents, 0),
    estimatedAccessoriesCents: by(['estimate']).reduce((s, r) => s + r.priceCents, 0),
    contingentAccessoriesMaxCents: by(['contingency', 'unknown']).reduce((s, r) => s + (r.estimatedRangeCents?.[1] ?? 0), 0),
    totalLabel: '含必要附件的估算总价（可安装性待验证）',
    coreCents, requiredAccessoriesCents: acc.requiredCents, optionalAccessoriesCents: acc.optional.reduce((s, o) => s + (o.unitPriceCents ?? 0) * o.quantity, 0),
    completeBuildCents: coreCents + acc.requiredCents, estimatedRangeCents: [coreCents + acc.rangeCents[0], coreCents + acc.rangeCents[1]],
    accessoryPriceStatus: acc.priceStatus, requiredAccessories: acc.required, optionalAccessories: acc.optional,
    requiredFans: acc.requiredFans, includedFans: acc.includedFans, additionalFans: acc.additionalFans,
  };
}
