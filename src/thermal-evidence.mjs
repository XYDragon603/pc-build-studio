// CPU 散热能力证据（2.2.2）。
//
// 2.2.1 的 coolerSizeClass / coolingClassFor 按塔高、冷排尺寸推断散热能力（≥155mm 塔 = 250W 档），
// 导致 270K Plus（250W）配 ¥129 的 CQ125、7700X3D（162W）配玄冰400 也被标为“工程判断足以覆盖”。
// 塔高只决定能否装进机箱，不代表散热能力：同为 155mm 的散热器，热管数、鳍片面积、风扇、底座工艺都不同。
//
// 本模块把散热能力与安装尺寸分开，只认以下证据（等级从高到低）：
//   measured        第三方 / 厂商实验室实测：持续功耗、CPU、插槽、环境温度、CPU 温度、时长、来源 URL
//   vendor_rating   厂商官方标称散热功率（有来源）。只用于 ≤200W；更高持续负载必须有实测
//   engineering     低功耗工程判断：只看结构（热管数量、冷排尺寸），不看塔高；≤125W（≥4 热管或 ≥240 冷排）、≤65W（≥2 热管或任意冷排）
//   stock           盒装原装散热器，按该 CPU 默认功耗限制设计（只用于 ≤95W，另由 stockCooler 判定包装）
// 没有任何证据覆盖持续负载时：不声称足够，给出“待验证”及可选的降功耗运行条件（限制到证据覆盖的功率）。

export const VENDOR_RATING_MAX_W = 200;
export const ENGINEERING_LIMITS = [
  { watts: 125, basis: '≥4 根热管单塔风冷或 ≥240mm 一体式水冷', test: p => (p.heat_pipes ?? 0) >= 4 || (p.radiator_size_mm ?? 0) >= 240 },
  { watts: 65, basis: '≥2 根热管风冷或一体式水冷', test: p => (p.heat_pipes ?? 0) >= 2 || (p.radiator_size_mm ?? 0) >= 120 },
];

const https = url => typeof url === 'string' && /^https:\/\//.test(url);

/** 规范化的散热器证据档案（字段名与 V2.2.2 数据规格一致） */
export function coolerProfile(specs = {}) {
  const tests = (specs.thermalTests ?? []).filter(t => t && t.kind === 'measured').map(t => ({
    tested_power_w: t.powerWatts ?? t.tested_power_w ?? null,
    tested_cpu: t.cpu ?? t.tested_cpu ?? null,
    tested_socket: t.cpuSocket ?? t.tested_socket ?? null,
    ambient_temperature_c: t.ambientC ?? t.ambient_temperature_c ?? null,
    cpu_temperature_c: t.maxTempC ?? t.cpu_temperature_c ?? null,
    temperature_limit_c: t.tempLimitC ?? null,
    noise_dba: t.noiseDbA ?? t.noise_dba ?? null,
    sustained_test_duration: t.durationMinutes ?? t.sustained_test_duration ?? null,
    power_limit: t.powerLimitWatts ?? t.power_limit ?? null,
    source_url: t.sourceUrl ?? t.source_url ?? null,
    evidence_confidence: t.confidence ?? 'medium',
  }));
  return {
    cooling_type: specs.radiatorSizeMm ? 'aio' : specs.coolingType ?? (specs.heightMm || specs.heatPipes ? 'air' : 'unknown'),
    cooler_height_mm: specs.heightMm ?? null,
    radiator_size_mm: specs.radiatorSizeMm ?? null,
    radiator_thickness_mm: specs.radiatorThicknessMm ?? null,
    heat_pipes: specs.heatPipes ?? null,
    vendor_rating_w: specs.vendorCoolingWatts ?? null,
    vendor_source_url: specs.coolingEvidence?.sourceUrl ?? null,
    tests,
  };
}

/**
 * 某散热器能被证据支持的持续功耗。返回 { watts, level, basis, sourceUrl, confidence }，watts 为 0 表示没有任何依据。
 * opts.quiet：安静优先只认实测（需有噪音数据）或给 30% 余量。
 */
export function coolingCapacity(coolerSpecs, { stock = false, cpu = {}, quiet = false, maxNoiseDbA = 35 } = {}) {
  if (stock) return { watts: 95, level: 'stock', basis: '盒装原装散热器，按该 CPU 默认功耗限制设计', sourceUrl: null, confidence: 'low' };
  const p = coolerProfile(coolerSpecs ?? {});
  const usable = p.tests.filter(t => https(t.source_url) && t.tested_power_w > 0 && t.sustained_test_duration >= 10 &&
    (t.temperature_limit_c == null || t.cpu_temperature_c == null || t.cpu_temperature_c < t.temperature_limit_c) &&
    (!quiet || (t.noise_dba != null && t.noise_dba <= maxNoiseDbA)));
  if (usable.length) {
    const best = usable.reduce((a, b) => (b.tested_power_w > a.tested_power_w ? b : a));
    const sameSocket = best.tested_socket && cpu.socket && String(best.tested_socket).toUpperCase() === String(cpu.socket).toUpperCase();
    return { watts: best.tested_power_w, level: 'measured', basis: `实测：${best.tested_cpu ?? '未注明 CPU'}（${best.tested_socket ?? '插槽未注明'}）持续 ${best.tested_power_w}W、${best.sustained_test_duration} 分钟${best.cpu_temperature_c != null ? `、CPU ${best.cpu_temperature_c}°C` : ''}${best.ambient_temperature_c != null ? `（环境 ${best.ambient_temperature_c}°C）` : ''}`,
      sourceUrl: best.source_url, confidence: sameSocket ? 'high' : 'medium', test: best };
  }
  if (p.vendor_rating_w && https(p.vendor_source_url)) {
    const watts = quiet ? Math.floor(p.vendor_rating_w / 1.3) : p.vendor_rating_w;
    return { watts, level: 'vendor_rating', basis: `厂商标称 ${p.vendor_rating_w}W${quiet ? '（安静优先按 30% 余量折算）' : ''}；标称不是持续温度实测，只用于 ≤${VENDOR_RATING_MAX_W}W`, sourceUrl: p.vendor_source_url, confidence: 'low' };
  }
  const eng = ENGINEERING_LIMITS.find(l => l.test(p));
  if (eng) {
    const watts = quiet ? Math.floor(eng.watts / 1.3) : eng.watts;
    return { watts, level: 'engineering', basis: `低功耗工程判断（${eng.basis}，不按塔高推断）`, sourceUrl: null, confidence: 'low' };
  }
  return { watts: 0, level: 'none', basis: '没有实测、厂商标称或可用的结构数据（热管数量 / 冷排尺寸）', sourceUrl: null, confidence: 'none' };
}

/** 证据能否“覆盖”该持续负载：厂商标称最多用于 200W，更高功耗只认实测 */
export function capacityCovers(cap, watts) {
  if (!cap || !(watts > 0)) return false;
  if (cap.level === 'vendor_rating' && watts > VENDOR_RATING_MAX_W) return false;
  return cap.watts >= watts;
}

/** 证据可支持的降功耗运行上限（覆盖不了满负载时）；不足 CPU 基础功耗时没有意义 */
export function powerLimitOption(cap, cpu = {}) {
  const usable = cap.level === 'vendor_rating' ? Math.min(cap.watts, VENDOR_RATING_MAX_W) : cap.watts;
  const base = cpu.basePowerWatts ?? 0;
  return usable > 0 && usable >= base ? usable : null;
}
