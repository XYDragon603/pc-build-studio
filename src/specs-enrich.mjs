// 从 ZOL 参数表（rawParams）补全兼容性与品质评价需要的字段。目录加载时运行，不联网、不改原始数据。
//
// 原则：只解析写得明确的值；解析不出来就不写（交给兼容性规则判定为 UNKNOWN），不按型号名或价格推断。
// 例如“金河田智能芯680 GT版”的额定功率取“额定功率 = 500W”，不从名字里的 680 推断。

const count = value => {
  const m = String(value ?? '').match(/(\d+)\s*个/);
  return m ? Number(m[1]) : undefined;
};
const firstNumber = value => {
  const m = String(value ?? '').match(/\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : undefined;
};

/**
 * 显卡供电接口：“8pin+8pin” → { pin8: 2 }；“16pin / 12VHPWR / 12V-2x6 / 12+4pin” → { pin16: 1 }；
 * “无外接电源接口” → { none: true }。认不出返回 undefined。
 */
export function parseGpuPower(text) {
  const t = String(text ?? '').toUpperCase().replace(/\s+/g, '');
  if (!t) return undefined;
  if (/无外接|无需外接|无/.test(t) && !/PIN/.test(t)) return { pin6: 0, pin8: 0, pin16: 0, none: true };
  // 12VHPWR / 12V-2x6 / 12+4pin / 16pin 都是同一种 16 针接口
  // 同一个接口常写两种名字（“新版12V-2x6 16Pin”），只算一个；消费级显卡没有双 16pin
  if (/12VHPWR|12V-?2X6|12\+4PIN|12PIN\+4PIN|16PIN/.test(t)) return { pin6: 0, pin8: 0, pin16: 1 };
  // “2×8pin”“8pin×2”“8pin+8pin+8pin”“6pin+8pin”
  let pin8 = 0;
  let pin6 = 0;
  for (const m of t.matchAll(/(?:(\d)[×X*])?([68])PIN(?:[×X*](\d))?/g)) {
    const n = Number(m[1] ?? m[3] ?? 1);
    if (m[2] === '8') pin8 += n; else pin6 += n;
  }
  return pin8 || pin6 ? { pin6, pin8, pin16: 0 } : undefined;
}

/** 显卡尺寸“304×126×50mm”：长 × 高 × 厚；只采用合理范围内的值 */
export function parseGpuSize(text) {
  const dims = String(text ?? '').match(/\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  if (dims.length < 3) return {};
  const [length, height, thickness] = dims;
  return {
    ...(length >= 100 && length <= 450 ? { lengthMm: length } : {}),
    ...(height >= 60 && height <= 200 ? { heightMm: height } : {}),
    ...(thickness >= 15 && thickness <= 100 ? { thicknessMm: thickness } : {}),
  };
}

/** 电源 12V 输出：“12V输出电流 = 62.5A”或分路“12V1 = 22A、12V2 = 22A”（分路只记录、不相加当成总输出） */
function psu12v(raw) {
  const single = firstNumber(raw['12V输出电流']);
  const rails = Object.entries(raw).filter(([k]) => /^12V\d输出电流$/.test(k)).map(([, v]) => firstNumber(v)).filter(Boolean);
  return {
    ...(single ? { rail12vAmps: single } : {}),
    // 多路 12V：单路电流有上限，显卡与 CPU 分在不同路上，不能简单相加
    ...(rails.length ? { rail12vSplitAmps: rails } : {}),
  };
}

/** 芯片组名：“Intel B760”“AMD B650” → “B760”“B650” */
export const chipsetOf = text => String(text ?? '').toUpperCase().match(/\b([ABHQXZ]\d{3}E?)\b/)?.[1];

/** 按类目补字段；返回新的 specs（不修改传入对象） */
export function enrichSpecs(item) {
  const raw = item.rawParams;
  const s = { ...(item.specs ?? {}) };
  const keep = (field, value) => { if (value !== undefined && value !== null && s[field] === undefined) s[field] = value; };
  if (!raw) return s;

  switch (item.category) {
    case 'GPU': {
      const power = parseGpuPower(raw['电源接口']);
      if (power) keep('powerPins', power);
      for (const [k, v] of Object.entries(parseGpuSize(raw['产品尺寸']))) keep(k, v);
      const slots = firstNumber(raw['插槽']);
      if (slots && slots <= 5) keep('slotWidth', slots);
      // 整卡最大功耗（厂商标注），比同芯片 TDP 中位数更准
      const watts = firstNumber(raw['最大功耗']);
      if (watts && watts >= 20 && watts <= 800) keep('boardPowerWatts', watts);
      if (/Arc/i.test(raw['显卡芯片'] ?? s.chipset ?? '')) keep('needsResizableBar', true);
      break;
    }
    case 'PSU': {
      keep('pcie8Count', count(raw['显卡接口（8Pin）']));
      keep('pcie6Count', count(raw['显卡接口（6pin）']));
      keep('pin16Count', count(raw['12VHPWR 16pin接口']));
      const atx = String(raw['电源版本'] ?? '').match(/ATX\s*(?:12V\s*)?(\d\.\d+)/i)?.[1];
      if (atx) keep('atxVersion', atx);
      for (const [k, v] of Object.entries(psu12v(raw))) keep(k, v);
      const protections = String(raw['保护功能'] ?? '').match(/OVP|UVP|OCP|OPP|OTP|SCP|OLP/g);
      if (protections) keep('protections', [...new Set(protections)]);
      keep('warrantyYears', firstNumber(raw['质保时间']));
      // 原始字段明确写了 16pin 接口数量时，以它为准（原来的全文匹配可能误判）
      if (s.pin16Count !== undefined) s.native16Pin = s.pin16Count > 0;
      break;
    }
    case 'MOTHERBOARD': {
      keep('chipset', chipsetOf(raw['主芯片组']) ?? chipsetOf(s.chipset));
      const video = String(raw['视频接口'] ?? '');
      if (video) keep('videoOutputs', /HDMI|DisplayPort|Display Port|DP|VGA|DVI|USB4|雷电|Type-C/i.test(video));
      const pcie = String(raw['PCI-E标准'] ?? '').match(/\d\.0/g)?.map(Number);
      if (pcie?.length) keep('pcieGen', Math.max(...pcie));
      const m2 = String(raw['存储接口'] ?? '').match(/(\d+)\s*×\s*M\.2/i);
      if (m2) keep('m2Slots', Number(m2[1]));
      else if (/SATA/.test(raw['存储接口'] ?? '')) keep('m2Slots', 0);
      const phases = String(raw['供电模式'] ?? '').match(/\d+/g)?.map(Number);
      if (phases?.length) keep('vrmPhases', phases[0]);
      break;
    }
    case 'SSD': {
      const nand = String(raw['闪存架构'] ?? '').toUpperCase().match(/\b(SLC|MLC|TLC|QLC)\b|^(SLC|MLC|TLC|QLC)/)?.slice(1).find(Boolean);
      if (nand) keep('nand', nand);
      const cache = String(raw['缓存'] ?? '');
      if (/无缓存/.test(cache)) keep('dram', 'none');
      else if (/HMB/i.test(cache)) keep('dram', 'hmb');
      else if (/\d+\s*(MB|GB)/i.test(cache)) keep('dram', 'dram');
      const tbw = String(raw['其它性能'] ?? '').match(/(\d+)\s*TBW|TBW[：:]\s*(\d+)/i);
      if (tbw) keep('tbw', Number(tbw[1] ?? tbw[2]));
      break;
    }
    default:
  }
  return s;
}
