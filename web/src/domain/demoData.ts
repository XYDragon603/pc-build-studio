import type { Build, Candidate, Part, SlotId } from './types';

/**
 * 演示数据：所有价格与“手动已确认”状态都是示意，不代表真实行情，
 * 也不代表项目已取得经过自动验证的报价。
 */
const jd = (keyword: string) => `https://search.jd.com/Search?keyword=${encodeURIComponent(keyword)}`;

export const DEMO_CANDIDATES: Candidate[] = [
  // CPU
  { source: 'demo', id: 'cpu-9700x', slot: 'cpu', name: 'AMD Ryzen 7 9700X', spec: 'AM5 · 盒装 · 8 核 16 线程', store: 'jd', storeLabel: '京东', condition: 'new',
    priceCents: 145000, state: 'confirmed', url: jd('9700X 盒装'), specs: { socket: 'AM5', maxPowerWatts: 88 } },
  { source: 'demo', id: 'cpu-9600x', slot: 'cpu', name: 'AMD Ryzen 5 9600X', spec: 'AM5 · 盒装 · 6 核 12 线程', store: 'jd', storeLabel: '京东', condition: 'new',
    priceCents: null, state: 'review', reviewNote: '需登录确认', url: jd('9600X 盒装'), specs: { socket: 'AM5', maxPowerWatts: 88 } },
  { source: 'demo', id: 'cpu-14600kf', slot: 'cpu', name: 'Intel Core i5-14600KF', spec: 'LGA1700 · 盒装 · 14 核 20 线程', store: 'jd', storeLabel: '京东', condition: 'new',
    priceCents: 129900, state: 'confirmed', url: jd('14600KF 盒装'), specs: { socket: 'LGA1700', maxPowerWatts: 181 } },

  // GPU
  { source: 'demo', id: 'gpu-galax', slot: 'gpu', name: '影驰 RTX 5060 Ti 16GB', spec: '金属大师 · 16GB GDDR7', store: 'jd', storeLabel: '京东', condition: 'new', capacityGB: 16,
    priceCents: 399900, state: 'confirmed', url: jd('影驰 RTX 5060 Ti 16GB'), specs: { maxPowerWatts: 180, lengthMm: 300 },
    art: { fans: 3, accent: '#8a9199', body: '#3a3f45' } },
  { source: 'demo', id: 'gpu-asus', slot: 'gpu', name: '华硕 RTX 5060 Ti 16GB', spec: 'TUF GAMING · 16GB GDDR7', store: 'jd', storeLabel: '京东', condition: 'new', capacityGB: 16,
    priceCents: null, state: 'review', reviewNote: '需登录确认', url: jd('华硕 RTX 5060 Ti 16GB'), specs: { maxPowerWatts: 180, lengthMm: 300 },
    art: { fans: 3, accent: '#b0b4b8', body: '#4a4e52' } },
  { source: 'demo', id: 'gpu-colorful', slot: 'gpu', name: '七彩虹 RTX 5060 Ti 16GB', spec: '战斧 · 16GB GDDR7', store: 'jd', storeLabel: '京东', condition: 'new', capacityGB: 16,
    priceCents: null, state: 'missing', url: jd('七彩虹 RTX 5060 Ti 16GB'), specs: { maxPowerWatts: 180, lengthMm: 250 },
    art: { fans: 2, accent: '#b8323a', body: '#2e3236' } },
  { source: 'demo', id: 'gpu-maxsun-8g', slot: 'gpu', name: '铭瑄 RTX 5060 Ti 8GB', spec: '电竞之心 · 8GB GDDR7', store: 'jd', storeLabel: '京东', condition: 'new', capacityGB: 8,
    priceCents: 289900, state: 'confirmed', url: jd('铭瑄 RTX 5060 Ti 8GB'), specs: { maxPowerWatts: 180, lengthMm: 245 },
    art: { fans: 2, accent: '#5f8fbf', body: '#33373b' } },

  // 主板
  { source: 'demo', id: 'board-b650m', slot: 'board', name: 'B650M WIFI', spec: 'AM5 · DDR5 · mATX', store: 'jd', storeLabel: '京东', condition: 'new',
    priceCents: 79900, state: 'confirmed', url: jd('B650M WIFI'), specs: { socket: 'AM5', memoryType: 'DDR5', formFactor: 'MICRO ATX' } },
  { source: 'demo', id: 'board-b850m', slot: 'board', name: 'B850M WIFI', spec: 'AM5 · DDR5 · mATX', store: 'jd', storeLabel: '京东', condition: 'new',
    priceCents: null, state: 'missing', url: jd('B850M WIFI'), specs: { socket: 'AM5', memoryType: 'DDR5', formFactor: 'MICRO ATX' } },
  { source: 'demo', id: 'board-b760m', slot: 'board', name: 'B760M D4', spec: 'LGA1700 · DDR4 · mATX', store: 'jd', storeLabel: '京东', condition: 'new',
    priceCents: 69900, state: 'confirmed', url: jd('B760M D4'), specs: { socket: 'LGA1700', memoryType: 'DDR4', formFactor: 'MICRO ATX' } },

  // 内存
  { source: 'demo', id: 'ram-6000-32', slot: 'ram', name: 'DDR5 6000 32GB', spec: '16GB × 2 · CL30', summarySpec: '16GB × 2', store: 'jd', storeLabel: '京东', condition: 'new',
    priceCents: 49900, state: 'confirmed', url: jd('DDR5 6000 32GB'), specs: { memoryType: 'DDR5' } },
  { source: 'demo', id: 'ram-6000-64', slot: 'ram', name: 'DDR5 6000 64GB', spec: '32GB × 2 · CL30', store: 'jd', storeLabel: '京东', condition: 'new',
    priceCents: null, state: 'review', reviewNote: '券后价待确认', url: jd('DDR5 6000 64GB'), specs: { memoryType: 'DDR5' } },

  // 硬盘
  { source: 'demo', id: 'ssd-1t', slot: 'ssd', name: 'NVMe SSD 1TB', summarySpec: '', spec: 'PCIe 4.0 · M.2 2280', store: 'jd', storeLabel: '京东', condition: 'new',
    priceCents: 39900, state: 'confirmed', url: jd('NVMe SSD 1TB PCIe4.0') },
  { source: 'demo', id: 'ssd-2t', slot: 'ssd', name: 'NVMe SSD 2TB', spec: 'PCIe 4.0 · M.2 2280', store: 'jd', storeLabel: '京东', condition: 'new',
    priceCents: 69900, state: 'confirmed', url: jd('NVMe SSD 2TB PCIe4.0') },

  // 电源
  { source: 'demo', id: 'psu-650', slot: 'psu', name: '650W 金牌全模组', summarySpec: '', spec: 'ATX 3.1 · 80 PLUS 金牌', store: 'jd', storeLabel: '京东', condition: 'new',
    priceCents: 39900, state: 'confirmed', url: jd('650W 金牌全模组'), specs: { ratedWatts: 650 } },
  { source: 'demo', id: 'psu-750', slot: 'psu', name: '750W 金牌全模组', spec: 'ATX 3.1 · 80 PLUS 金牌', store: 'jd', storeLabel: '京东', condition: 'new',
    priceCents: 49900, state: 'confirmed', url: jd('750W 金牌全模组'), specs: { ratedWatts: 750 } },

  // 机箱
  { source: 'demo', id: 'case-matx-quiet', slot: 'case', name: 'mATX 静音机箱', summarySpec: '', spec: '隔音棉 · 显卡限长 360mm · 散热限高 165mm', store: 'jd', storeLabel: '京东', condition: 'new',
    priceCents: 24900, state: 'confirmed', url: jd('mATX 静音机箱'), specs: { maxGpuLengthMm: 360, maxCoolerHeightMm: 165, maxBoardFormFactor: 'MICRO ATX' } },
  { source: 'demo', id: 'case-matx-glass', slot: 'case', name: 'mATX 海景房机箱', spec: '双面玻璃 · 显卡限长 380mm · 散热限高 160mm', store: 'jd', storeLabel: '京东', condition: 'new',
    priceCents: null, state: 'review', reviewNote: '含补贴价', url: jd('mATX 海景房机箱'), specs: { maxGpuLengthMm: 380, maxCoolerHeightMm: 160, maxBoardFormFactor: 'MICRO ATX' } },

  // 散热
  { source: 'demo', id: 'cooler-dual-tower', slot: 'cooler', name: '双塔风冷散热器', summarySpec: '', spec: '6 热管 · 双 120mm 风扇 · 高 158mm', store: 'jd', storeLabel: '京东', condition: 'new',
    priceCents: 14900, state: 'confirmed', url: jd('双塔风冷散热器'), specs: { heightMm: 158 } },
  { source: 'demo', id: 'cooler-aio-240', slot: 'cooler', name: '240 一体式水冷', spec: '240mm 冷排 · AM5/LGA1700', store: 'jd', storeLabel: '京东', condition: 'new',
    priceCents: null, state: 'missing', url: jd('240 一体式水冷') },
];

export const candidateById = (id: string | undefined) => DEMO_CANDIDATES.find(c => c.id === id);

export function partFromCandidate(c: Candidate, priceCents: number | null, priceSource: Part['priceSource'] = 'manual', note = ''): Part {
  return {
    name: c.name.slice(0, 160),
    spec: c.summarySpec ?? c.spec.split(' · ').slice(0, 2).join(' · '),
    priceCents,
    quantity: 1,
    priceSource,
    catalogId: c.catalogId ?? null,
    note,
    url: c.url,
    specs: c.specs ?? {},
  };
}

/** 与设计稿一致的初始方案：7/8 件、合计 ¥3,944、剩余 ¥4,056。 */
export function demoBuild(): Build {
  const fill = (id: string, locked = false) => {
    const c = candidateById(id)!;
    return { part: partFromCandidate(c, c.priceCents, 'demo'), locked };
  };
  const slots: Build['slots'] = {
    cpu: fill('cpu-9700x', true),
    gpu: { part: null, locked: false },
    board: fill('board-b650m'),
    ram: fill('ram-6000-32'),
    ssd: fill('ssd-1t'),
    psu: fill('psu-650'),
    case: fill('case-matx-quiet'),
    cooler: fill('cooler-dual-tower'),
  };
  return {
    id: 'demo-2k',
    name: '2K 游戏主机',
    budgetCents: 800000,
    scenarios: ['2k', 'quiet'],
    slots,
    custom: [],
    updatedAt: new Date().toISOString(),
  };
}

export const DEFAULT_QUERY: Record<SlotId, string> = {
  cpu: '9700X 盒装', gpu: 'RTX 5060 Ti 16GB', board: '', ram: 'DDR5', ssd: 'NVMe', psu: '', case: 'mATX', cooler: '',
};
