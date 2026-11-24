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
export type EstimateBasis = 'reference' | 'model' | 'chip-median' | 'spec-median' | 'class-median' | 'series-low';

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
}

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
  plans: (body: { budgetCents: number; scenarios: string[] }) =>
    call<{ plans: PlanResult[] }>('/plans', { method: 'POST', body, timeoutMs: 30000 }).then(r => r.plans),
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
