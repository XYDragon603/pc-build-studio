// 商品状态（2.2.1）：new / used / refurbished / modified / engineering_sample / unknown。
//
// 背景：30000 元 AI 的升级候选里出现“RTX 4090 48GB 涡轮”。NVIDIA 官方 RTX 4090 只有 24GB GDDR6X
// （https://www.nvidia.com/en-us/geforce/graphics-cards/40-series/rtx-4090.html），48GB 为非原厂改装，
// 2.2.0 把它与全新零售卡无差别地放进默认推荐。
//
// 判定（按顺序，命中即停）：
//   1. 条目明确写了 productStatus → 用它
//   2. 标题含“工程样品 / ES 版 / QS 版” → engineering_sample；“改装 / 魔改 / 改版显存” → modified；“翻新” → refurbished；“二手 / 拆机” → used
//   3. 显卡显存不在该芯片的官方显存配置里 → modified（官方配置见下表；不在表里的芯片不判）
//   4. 其余 → new（目录来自零售商品列表）。只凭标题像官方型号，不等于已确认是官方 SKU。
// 默认推荐只用 new；used / refurbished 需打开“接受二手价”，modified / engineering_sample 需明确允许，并展示保修、稳定性、功耗与规格验证风险。

export const PRODUCT_STATUSES = ['new', 'used', 'refurbished', 'modified', 'engineering_sample', 'unknown'];

// 官方显存配置（GB）。NVIDIA / AMD / Intel 产品规格页。按名称长度降序匹配，避免 “4070” 吃掉 “4070 Ti SUPER”。
const OFFICIAL_VRAM = Object.entries({
  'RTX 3050': [6, 8], 'RTX 3060': [8, 12], 'RTX 3060 TI': [8], 'RTX 3070': [8], 'RTX 3070 TI': [8], 'RTX 3080': [10, 12], 'RTX 3080 TI': [12], 'RTX 3090': [24], 'RTX 3090 TI': [24],
  'RTX 4060': [8], 'RTX 4060 TI': [8, 16], 'RTX 4070': [12], 'RTX 4070 SUPER': [12], 'RTX 4070 TI': [12], 'RTX 4070 TI SUPER': [16], 'RTX 4080': [16], 'RTX 4080 SUPER': [16], 'RTX 4090': [24], 'RTX 4090 D': [24],
  'RTX 5050': [8], 'RTX 5060': [8], 'RTX 5060 TI': [8, 16], 'RTX 5070': [12], 'RTX 5070 TI': [16], 'RTX 5080': [16], 'RTX 5090': [32], 'RTX 5090 D': [32], 'RTX 5090 D V2': [24],
  'GTX 1650': [4], 'GTX 1650 SUPER': [4], 'GTX 1660': [6], 'GTX 1660 SUPER': [6], 'GTX 1660 TI': [6],
  'RX 6400': [4], 'RX 6500 XT': [4, 8], 'RX 6600': [8], 'RX 6600 XT': [8], 'RX 6650 XT': [8], 'RX 6700 XT': [12], 'RX 6750 XT': [12], 'RX 6750 GRE': [10, 12], 'RX 6800': [16], 'RX 6800 XT': [16], 'RX 6900 XT': [16], 'RX 6950 XT': [16],
  'RX 7600': [8], 'RX 7600 XT': [16], 'RX 7650 GRE': [8], 'RX 7700 XT': [12], 'RX 7800 XT': [16], 'RX 7900 GRE': [16], 'RX 7900 XT': [20], 'RX 7900 XTX': [24],
  'RX 9060 XT': [8, 16], 'RX 9070': [16], 'RX 9070 XT': [16], 'RX 9070 GRE': [12],
  'ARC A380': [6], 'ARC A580': [8], 'ARC A750': [8], 'ARC A770': [8, 16], 'ARC B570': [10], 'ARC B580': [12],
}).sort((a, b) => b[0].length - a[0].length);

const normChip = text => ` ${String(text ?? '').toUpperCase().replace(/GEFORCE|RADEON|INTEL|NVIDIA|AMD/g, ' ').replace(/(\d)\s*GB?\b/g, ' ').replace(/\s+/g, ' ')} `;

/** 显卡芯片的官方显存配置；芯片不在表里返回 null */
export function officialVram(chipset) {
  const n = normChip(chipset);
  const hit = OFFICIAL_VRAM.find(([chip]) => new RegExp(`[ -]${chip.replace(/ /g, '\\s*')}(?=[ -]|$)`).test(n));
  return hit ? { chip: hit[0], capacities: hit[1] } : null;
}

/** 返回 { status, reason } */
export function productStatus(item) {
  const explicit = item?.specs?.productStatus ?? item?.productStatus;
  if (PRODUCT_STATUSES.includes(explicit)) return { status: explicit, reason: '条目明确标注' };
  const title = String(item?.name ?? '');
  if (/工程样品|工程版|\bES\b版?|\bQS\b版?|engineering\s*sample/i.test(title)) return { status: 'engineering_sample', reason: '标题标注工程 / 测试样品' };
  if (/改装|魔改|改版|扩容/.test(title)) return { status: 'modified', reason: '标题标注改装' };
  if (/翻新|refurb/i.test(title)) return { status: 'refurbished', reason: '标题标注翻新' };
  if (/二手|拆机|used/i.test(title)) return { status: 'used', reason: '标题标注二手 / 拆机' };
  if (item?.category === 'GPU' && item.specs?.capacityGB) {
    const official = officialVram(item.specs.chipset ?? item.name);
    if (official && !official.capacities.includes(Number(item.specs.capacityGB))) {
      // 标题自己写明了非官方显存（如“4090 48G 涡轮”）→ 改装；标题没写或写的是官方显存、只有目录规格不符 → 数据冲突，状态未知
      const titleCap = Number(title.match(/(\d{1,2})\s*G(?:B)?(?![a-z])/i)?.[1]);
      if (titleCap && !official.capacities.includes(titleCap)) {
        return { status: 'modified', reason: `${official.chip} 官方显存为 ${official.capacities.join(' / ')}GB，此商品标称 ${titleCap}GB，判定为非原厂改装（保修、稳定性、功耗与规格均需另行核实）` };
      }
      return { status: 'unknown', reason: `目录显存 ${item.specs.capacityGB}GB 与 ${official.chip} 官方配置（${official.capacities.join(' / ')}GB）不符，规格存疑，待核实具体型号` };
    }
  }
  return { status: 'new', reason: '零售商品列表（未逐一核实为官方 SKU）' };
}

/** 默认推荐允许的状态 */
export function statusAllowed(status, { allowUsed = false, allowModified = false } = {}) {
  if (status === 'new') return true;
  if (status === 'used' || status === 'refurbished') return allowUsed;
  if (status === 'modified' || status === 'engineering_sample') return allowModified;
  return false;
}
