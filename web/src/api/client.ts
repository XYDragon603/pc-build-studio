/**
 * 本地 API v1 客户端（docs/api.md）。开发与预览时由 Vite 代理 /api 到 127.0.0.1:4310。
 */
const BASE = '/api/v1';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export interface ApiSpecs {
  socket?: string;
  memoryType?: string;
  maxPowerWatts?: number;
  ratedWatts?: number;
}

export interface ApiPart {
  model: string;
  catalogId?: string | null;
  spec?: string;
  priceCents: number | null;
  quantity: number;
  priceSource: 'manual' | 'demo' | 'estimate';
  note: string;
  url: string | null;
  specs: ApiSpecs;
}

export interface ApiSlot {
  id: string;
  label: string;
  locked: boolean;
  part: ApiPart | null;
}

export interface ApiBuildInput {
  name: string;
  budgetCents: number;
  scenarios: string[];
  slots: ApiSlot[];
}

export interface ApiDraft {
  build: ApiBuildInput;
  serverId?: string;
  version?: number;
}

export interface BuildBackup {
  format: 1;
  builds: Omit<ApiBuild, 'totals'>[];
}

export interface ApiTotals {
  totalCents: number;
  remainingCents: number;
  unknownPriceCount: number;
  filledStandardSlots: number;
}

export interface ApiBuild extends ApiBuildInput {
  id: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  totals: ApiTotals;
}

export type ApiTemplate = ApiBuildInput & { totals: ApiTotals };

export interface ApiBuildSummary {
  id: string;
  name: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  budgetCents: number;
  totals: ApiTotals;
}

export type QuoteMode = 'replay' | 'live';

export interface Quote {
  title: string;
  category: 'CPU' | 'GPU';
  model: string | null;
  capacityGB: number | null;
  priceCents: number | null;
  currency: string | null;
  observedAt: string | null;
  sku: string | null;
  status: 'accepted' | 'review' | 'rejected';
  autoEligible: boolean;
  reasonCodes: string[];
  reasons: string[];
  method: string;
  url: string | null;
}

export interface QuoteReport {
  mode: QuoteMode;
  generatedAt: string;
  evidenceAsOf?: string;
  target: { category: string; query: string; model: string; capacityGB: number | null; packaging: string | null };
  summary: { total: number; accepted: number; review: number; rejected: number };
  results: Quote[];
  cost: { projectSearchRequests: number; productPageRequests: number; cacheHits: number; estimatedGrossUsd: number | null };
}

/** 估算依据，由准到粗：ZOL 参考价、同型号、同芯片中位价、同规格中位价、同类粗估、ZOL 系列起价 */
export type EstimateBasis = 'reference' | 'model' | 'chip-median' | 'spec-median' | 'class-median' | 'series-low' | 'manual' | 'verified';

/** 用户价格记录（与规格分开存放，见 /prices） */
export type PriceCondition = 'new' | 'used' | 'refurbished' | 'old-stock' | 'oem';
export interface PriceRecord {
  id: string;
  componentId: string;
  sku: string | null;
  priceCents: number;
  currency: 'CNY';
  sourceName: string;
  sourceUrl: string | null;
  observedAt: string;
  condition: PriceCondition;
  stockStatus: 'in_stock' | 'out_of_stock' | 'unknown';
  shippingCents: number;
  priceType: 'reference' | 'verified' | 'manual' | 'estimate';
  confidence: 'high' | 'medium' | 'low';
  note: string;
}
export type PriceRecordInput = Partial<Omit<PriceRecord, 'id'>> & { componentId: string; priceCents: number };
/** estimate = 参考估算；manual = 优先我的价格 */
export type PriceMode = 'estimate' | 'manual';

export interface CatalogItem {
  id: string;
  category: string;
  name: string;
  manufacturer: string | null;
  mpn: string | null;
  summary: string;
  aliases: string[];
  specs: Record<string, string | number | boolean | string[] | undefined>;
  imageUrl: string | null;
  sourceUrl: string;
  dataSource?: 'buildcores' | 'zol';
  market?: 'cn' | 'global';
  compatibility?: 'pass' | 'conflict' | 'unknown';
  zolId?: string;
  /** ZOL 参考价，非实时 */
  referencePriceCents?: number | null;
  priceObservedAt?: string | null;
  estimatedPriceCents?: number;
  estimateBasis?: EstimateBasis;
  /** ZOL 系列产品的价格区间（最低档 ~ 最高档容量） */
  priceRangeCents?: [number, number];
  /** ZOL 参考价明显低于同规格其他型号，可能是涨价前的旧价（估算价已改用同规格中位价） */
  possiblyStale?: boolean;
  /** 缺数据时估算出来的规格字段（如显卡 tdpWatts 取同芯片中位数） */
  estimatedSpecs?: string[];
  /** 服务器 / 工作站 / 龙芯 CPU：需要专用主板，自动方案不选 */
  workstation?: boolean;
  /** 联想搜索的匹配分 */
  matchScore?: number;
  estimateSamples?: number;
  /** 参考价走势：最近一次变价与记录到的最低价 */
  priceTrend?: PriceTrend;
  /** 性能参考：Blender 渲染跑分（CC0）与按评测整理的游戏指数 */
  performance?: Performance;
  /** 价格可信度（来源数、价格区间宽度） */
  priceConfidence?: 'high' | 'medium' | 'low';
  /** 价格来自哪里：目录参考价 / 我的价格记录（“优先我的价格”模式） */
  priceSource?: 'catalog' | 'user';
  priceRecord?: PriceRecord;
  /** 目录价超过 14 天、我的价格超过 30 天未更新 */
  priceStale?: boolean;
}

export interface Performance {
  key: string;
  blender: { score: number; runs: number; api: string } | null;
  gaming: { index: number; label: string | null } | null;
}

export interface PriceTrend {
  previousCents: number | null;
  changedAt: string | null;
  lowestCents: number;
  since: string;
  points: number;
}

export interface CatalogPage {
  items: CatalogItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface JdLookup {
  items: { skuId: string; name: string; unitPriceCents: number | null; mobilePriceCents: number | null; url: string; imageUrl: string | null; isJdSale: boolean; observedAt: string }[];
  /** 未返回的 SKU：多半不在联盟推广中，不代表没有价格 */
  missing: string[];
  observedAt: string;
  cached: boolean;
}

export interface RecommendResult {
  budgetCents: number;
  totalCents: number;
  lockedCents: number;
  picks: { slot: string; reason: string; item: CatalogItem }[];
  notes: string[];
}

/** POST /plans 返回的一套方案（省钱版 / 推荐版 / 进阶版） */
export interface PlanResult extends RecommendResult {
  id: 'save' | 'balanced' | 'plus';
  label: string;
  targetCents: number;
  /** 核显方案：不配独立显卡 */
  igpu: boolean;
  /** 盒装 CPU 自带散热器，不另买 */
  stockCooler: boolean;
  /** 预算明细：输入预算、本档目标、允许上限（严格预算时）、与两者的差额 */
  budget?: { inputCents: number; targetCents: number; limitCents: number | null; overTargetCents: number; overInputCents: number };
  /** 整机兼容性（统一规则） */
  compatibility?: { overall: 'PASS' | 'FAIL' | 'CONDITIONAL' | 'UNKNOWN'; checks: { id: string; label: string; status: string; detail: string; critical: boolean }[] };
  /** 这一档没有可行方案：原因、最低可行预算、调整建议（picks 为空） */
  infeasible?: boolean;
  reasons?: string[];
  minFeasibleCents?: number | null;
  suggestions?: string[];
  /** 和哪一档配置相同（预算再加也选不出更值得的升级） */
  sameAs?: 'save' | 'balanced' | 'plus';
  /** 整机综合评分（0–100）与分项（0–100），bottleneck 为 CPU 拖后腿扣分 */
  score?: { total: number; bottleneck: number; parts: Partial<Record<ScorePart, number>>; version: string } | null;
  /** 请求了外设时：按这套方案的显卡和档位挑的显示器 / 键盘 / 鼠标（不占主机预算） */
  peripherals?: { picks: RecommendResult['picks']; totalCents: number };
}

export type ScorePart = 'gpu' | 'cpu' | 'memory' | 'storage' | 'quality' | 'noise' | 'trust';

export interface PlanRequest {
  budgetCents: number;
  scenarios: string[];
  peripherals?: ('MONITOR' | 'KEYBOARD' | 'MOUSE')[];
  maxOverPercent?: number | null;
  priceMode?: PriceMode;
  allowUsed?: boolean;
  /** 锁定的配件（硬约束），按服务端槽位名 */
  locked?: Record<string, { priceCents: number; specs: object; name?: string; igpu?: boolean }>;
}

export interface PriceMeta { mode: PriceMode; allowUsed: boolean; userPriced: number }

export interface Health {
  status: 'ok';
  apiVersion: string;
  quotes: { liveConfigured: boolean; modes: QuoteMode[]; categories: string[]; jdUnionConfigured?: boolean };
}

async function call<T>(path: string, init: { method?: string; body?: unknown; timeoutMs?: number; keepalive?: boolean; signal?: AbortSignal } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      method: init.method ?? 'GET',
      headers: init.body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      keepalive: init.keepalive,
      signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(init.timeoutMs ?? 15000)]) : AbortSignal.timeout(init.timeoutMs ?? 15000),
    });
  } catch (e) {
    const timeout = e instanceof DOMException && e.name === 'TimeoutError';
    throw new ApiError(0, timeout ? 'TIMEOUT' : 'NETWORK', timeout ? '请求超时，请稍后重试' : '无法连接本地服务');
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    // 代理在后端未启动时返回 5xx 且没有 JSON 错误体
    if (!data?.error) throw new ApiError(res.status, 'NETWORK', '无法连接本地服务');
    throw new ApiError(res.status, data.error.code, data.error.message);
  }
  return data as T;
}

export const api = {
  health: () => call<Health>('/health', { timeoutMs: 4000 }),
  template: () => call<ApiTemplate>('/templates/demo'),
  listBuilds: () => call<{ items: ApiBuildSummary[] }>('/builds').then(r => r.items),
  loadDraft: () => call<{ draft: ApiDraft | null }>('/draft').then(r => r.draft),
  saveDraft: (input: ApiDraft) => call<void>('/draft', { method: 'PUT', body: input, keepalive: true }),
  backupBuilds: () => call<BuildBackup>('/builds/backup'),
  restoreBuilds: (backup: unknown) => call<{ restored: number; skipped: number }>('/builds/backup', { method: 'POST', body: backup }),
  getBuild: (id: string) => call<ApiBuild>(`/builds/${id}`),
  createBuild: (input: ApiBuildInput) => call<ApiBuild>('/builds', { method: 'POST', body: input }),
  updateBuild: (id: string, input: ApiBuildInput & { version: number }) => call<ApiBuild>(`/builds/${id}`, { method: 'PUT', body: input }),
  deleteBuild: (id: string, version: number) => call<void>(`/builds/${id}`, { method: 'DELETE', body: { version } }),
  jdPrices: (skuIds: string[]) => call<JdLookup>('/quotes/jd', { method: 'POST', body: { skuIds }, timeoutMs: 15000 }),
  plans: (body: PlanRequest) =>
    call<{ plans: PlanResult[]; priceMeta?: PriceMeta }>('/plans', { method: 'POST', body, timeoutMs: 30000 }).then(r => r.plans),
  prices: (componentId?: string) => call<{ records: PriceRecord[] }>(`/prices${componentId ? `?componentId=${encodeURIComponent(componentId)}` : ''}`).then(r => r.records),
  addPrice: (input: PriceRecordInput) => call<PriceRecord>('/prices', { method: 'POST', body: input }),
  deletePrice: (id: string) => call<void>(`/prices/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  importPrices: (format: 'csv' | 'json', content: string) =>
    call<{ imported: number; errors: { row: number; message: string }[] }>('/prices/import', { method: 'POST', body: { format, content }, timeoutMs: 30000 }),
  exportPricesJson: () => call<{ version: number; exportedAt: string; records: PriceRecord[] }>('/prices/export'),
  exportPricesCsv: async () => {
    const res = await fetch(BASE + '/prices/export?format=csv', { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new ApiError(res.status, 'EXPORT_FAILED', '导出失败');
    return res.text();
  },
  recommend: (body: { budgetCents: number; scenarios: string[]; locked: Record<string, { priceCents: number; specs: object }> }) =>
    call<RecommendResult>('/recommend', { method: 'POST', body, timeoutMs: 20000 }),
  catalogItem: (id: string) => call<CatalogItem>(`/catalog/${encodeURIComponent(id)}`),
  catalogPage: (params: URLSearchParams, signal?: AbortSignal) => call<CatalogPage>(`/catalog?${params}`, { signal }),
  catalogSuggest: (params: URLSearchParams, signal?: AbortSignal) => call<{ items: CatalogItem[] }>(`/catalog/suggest?${params}`, { signal }),
  catalog: (category: string, q: string, limit = 24, market: 'cn' | 'global' | 'all' = 'all') =>
    call<CatalogPage>(`/catalog?${new URLSearchParams({ category, q: q.trim().slice(0, 120), limit: String(limit), market })}`),
  // 实时检索会逐个读取商品页（每页最多 10 秒），给足时间
  searchQuotes: (category: 'CPU' | 'GPU', query: string, mode: QuoteMode) =>
    call<QuoteReport>('/quotes/search', { method: 'POST', body: { category, query, mode }, timeoutMs: mode === 'live' ? 150000 : 15000 }),
};
