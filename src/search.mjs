import { createHash } from 'node:crypto';
import { LocalStore } from './store.mjs';
import { ApiError } from './api-error.mjs';

export class BraveSearch {
  constructor({ apiKey = process.env.BRAVE_SEARCH_API_KEY,
    directory = '.runtime', fetchFn = fetch, now = Date.now,
    dailyLimit = Number(process.env.DAILY_SEARCH_LIMIT || 20),
    ttlMinutes = Number(process.env.CACHE_TTL_MINUTES || 60),
    unitCost = process.env.SEARCH_COST_USD_PER_REQUEST?.trim() ? Number(process.env.SEARCH_COST_USD_PER_REQUEST) : null } = {}) {
    if (!Number.isSafeInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 10000) throw new Error('DAILY_SEARCH_LIMIT 必须为 1–10000 的整数');
    if (!Number.isFinite(ttlMinutes) || ttlMinutes < 30 || ttlMinutes > 120) throw new Error('CACHE_TTL_MINUTES 必须为 30–120');
    if (unitCost !== null && (!Number.isFinite(unitCost) || unitCost < 0)) throw new Error('单次调用价格必须为非负数或留空');
    this.apiKey = apiKey; this.fetchFn = fetchFn; this.now = now;
    this.dailyLimit = dailyLimit; this.ttlMs = ttlMinutes * 60000; this.unitCost = unitCost;
    this.store = new LocalStore(directory); this.pending = new Map();
  }

  async search(target) {
    const query = `site:item.jd.com ${target.query} ${target.category === 'CPU' ? '处理器' : '显卡'} 价格`;
    const key = createHash('sha256').update(JSON.stringify({ provider: 'brave-v1', query, region: target.region, currency: target.currency })).digest('hex');
    if (this.pending.has(key)) return this.pending.get(key);
    const work = this.perform(query, key);
    this.pending.set(key, work);
    try { return await work; } finally { this.pending.delete(key); }
  }

  async perform(query, key) {
    const cached = await this.store.read(`search-${key}.json`, null);
    if (cached && Number.isFinite(cached.createdAt) && this.now() >= cached.createdAt && this.now() - cached.createdAt < this.ttlMs) {
      return { ...cached.payload, cached: true, attemptedRequests: 0, estimatedGrossUsd: 0 };
    }
    if (!this.apiKey?.trim()) throw new ApiError(503, 'SEARCH_NOT_CONFIGURED', '未配置 BRAVE_SEARCH_API_KEY。实时检索需在本地 .env 配置密钥。');
    const usage = await this.store.reserveRequest({ limit: this.dailyLimit, unitCost: this.unitCost, now: this.now() });
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.search = new URLSearchParams({ q: query, country: 'CN', search_lang: 'zh-hans', count: '10' });
    let response;
    try {
      response = await this.fetchFn(url, { headers: { Accept: 'application/json', 'X-Subscription-Token': this.apiKey },
        redirect: 'error', signal: AbortSignal.timeout(15000) });
    } catch { throw new ApiError(502, 'SEARCH_UNAVAILABLE', '搜索网络请求失败；本次尝试已计入每日限额。'); }
    if (!response.ok) {
      throw new ApiError(response.status === 429 ? 429 : 502, 'SEARCH_UPSTREAM_ERROR',
        `搜索服务返回 HTTP ${response.status}；本次尝试已计入限额。`);
    }
    const data = await response.json().catch(() => null);
    if (!Array.isArray(data?.web?.results)) {
      throw new ApiError(502, 'SEARCH_INVALID_RESPONSE', '搜索响应格式无效，未缓存；本次尝试已计入限额。');
    }
    const observedAt = new Date(this.now()).toISOString();
    const payload = { provider: 'brave', query, cached: false, attemptedRequests: 1,
      estimatedGrossUsd: this.unitCost, usage,
      results: data.web.results.slice(0, 10).map(item => ({
        title: String(item.title ?? '').slice(0, 1000), url: String(item.url ?? ''),
        excerpt: String(item.description ?? '').slice(0, 4000), observedAt,
        method: 'search-snippet', currency: null,
      })) };
    await this.store.write(`search-${key}.json`, { createdAt: this.now(), payload });
    return payload;
  }
}
