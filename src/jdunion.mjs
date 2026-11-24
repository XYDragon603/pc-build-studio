// 京东联盟开放平台：按 SKU 查询推广商品（jd.union.open.goods.promotiongoodsinfo.query）。
// 个人使用。密钥只从环境变量读取，不写入日志、缓存或响应。
//
// 文档确认的部分：系统参数（method / app_key / timestamp / format / v / sign_method / sign）、
// 业务参数 skuIds（逗号分隔，最多 100 个）、返回字段 unitPrice（京东价）、wlUnitPrice（无线京东价，-1 为未查到），
// 以及“不在推广中的 SKU 不会出现在返回结果里”。
// 按京东开放平台通用规则实现、尚待首次真实调用确认的部分：网关 https://api.jd.com/routerjson、
// 业务参数字段名 360buy_param_json、MD5 签名步骤。签名错误时接口会返回验证失败，按报错调整即可。
import { createHash } from 'node:crypto';
import { ApiError, invalid } from './api-error.mjs';
import { LocalStore } from './store.mjs';

const METHOD = 'jd.union.open.goods.promotiongoodsinfo.query';
const ENDPOINT = 'https://api.jd.com/routerjson';
const CACHE_TTL_MS = 30 * 60 * 1000;
const MIN_INTERVAL_MS = 1000;

/** GMT+8 的 yyyy-MM-dd HH:mm:ss */
export function jdTimestamp(date = new Date()) {
  const t = new Date(date.getTime() + 8 * 3600 * 1000).toISOString();
  return `${t.slice(0, 10)} ${t.slice(11, 19)}`;
}

/** 参数按名称排序后拼接 key+value，前后加 secret，MD5 后转大写 */
export function jdSign(params, secret) {
  const body = Object.keys(params).filter(k => k !== 'sign' && params[k] != null && params[k] !== '').sort()
    .map(k => k + params[k]).join('');
  return createHash('md5').update(secret + body + secret, 'utf8').digest('hex').toUpperCase();
}

/** 从京东商品链接或纯数字中取 SKU：item.jd.com/123.html、item.m.jd.com/product/123.html、wareId=123 */
export function extractSku(input) {
  const text = String(input ?? '').trim();
  if (/^\d{4,20}$/.test(text)) return text;
  try {
    const url = new URL(text);
    if (!/(^|\.)jd\.com$/.test(url.hostname)) return null;
    return url.pathname.match(/\/(?:product\/)?(\d{4,20})\.html$/)?.[1] ?? url.searchParams.get('wareId')?.match(/^\d{4,20}$/)?.[0] ?? null;
  } catch {
    return null;
  }
}

const yuanToCents = value => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
};

/** 兼容两种返回：queryResult 为对象，或为 JSON 字符串；data 为数组，或为 { promotionGoodsResp } */
export function parsePromotionResponse(json, observedAt) {
  if (json?.error_response) {
    const e = json.error_response;
    throw new ApiError(502, 'JD_UNION_ERROR', `京东联盟返回错误 ${e.code ?? ''}：${e.zh_desc ?? e.en_desc ?? e.msg ?? '未知错误'}`);
  }
  if (json?.errorMessage || (json?.code && !Object.keys(json).some(k => k.startsWith('jd_union')))) {
    throw new ApiError(502, 'JD_UNION_ERROR', `京东联盟返回错误 ${json.code ?? ''}：${json.errorMessage ?? json.message ?? '未知错误'}`);
  }
  const wrapper = json?.jd_union_open_goods_promotiongoodsinfo_query_responce ?? json?.jd_union_open_goods_promotiongoodsinfo_query_response;
  if (!wrapper) throw new ApiError(502, 'JD_UNION_INVALID_RESPONSE', '京东联盟响应格式无法识别');
  let result = wrapper.queryResult ?? wrapper.result;
  if (typeof result === 'string') {
    try { result = JSON.parse(result); } catch { throw new ApiError(502, 'JD_UNION_INVALID_RESPONSE', '京东联盟响应 queryResult 不是有效 JSON'); }
  }
  const code = Number(result?.code);
  if (code === 403 || code === 2003103) throw new ApiError(403, 'JD_UNION_FORBIDDEN', '当前联盟账号没有这个接口的权限，请在联盟后台申请');
  if (code === 401) throw new ApiError(502, 'JD_UNION_AUTH', '京东联盟验证失败：请检查 AppKey / SecretKey，或签名规则');
  if (code === 429) throw new ApiError(429, 'JD_UNION_RATE_LIMIT', '京东联盟接口调用过于频繁，请稍后再试');
  if (code !== 200 && code !== 2003104) throw new ApiError(502, 'JD_UNION_ERROR', `京东联盟返回 ${result?.code}：${result?.message ?? '未知错误'}`);
  const data = Array.isArray(result.data) ? result.data
    : result.data?.promotionGoodsResp ? [].concat(result.data.promotionGoodsResp) : [];
  return data.map(item => ({
    skuId: String(item.skuId),
    name: String(item.goodsName ?? ''),
    // unitPrice 为京东价；不含优惠券、补贴等条件价格
    unitPriceCents: yuanToCents(item.unitPrice),
    mobilePriceCents: yuanToCents(item.wlUnitPrice),
    url: `https://item.jd.com/${item.skuId}.html`,
    imageUrl: typeof item.imgUrl === 'string' ? item.imgUrl.replace(/^http:/, 'https:') : null,
    isJdSale: Number(item.isJdSale) === 1,
    observedAt,
  }));
}

export class JdUnion {
  constructor({ appKey = process.env.JD_UNION_APP_KEY, appSecret = process.env.JD_UNION_APP_SECRET,
    directory = '.runtime', fetchFn = fetch, now = () => new Date() } = {}) {
    this.appKey = appKey?.trim() || null;
    this.appSecret = appSecret?.trim() || null;
    this.fetchFn = fetchFn;
    this.now = now;
    this.store = new LocalStore(directory);
    this.lastCallAt = 0;
  }

  get configured() {
    return Boolean(this.appKey && this.appSecret);
  }

  /** 返回 { items, missing, cached }；missing 为未返回的 SKU（多半不在推广中，不代表没有价格） */
  async lookup(rawSkus) {
    if (!this.configured) throw new ApiError(503, 'JD_UNION_NOT_CONFIGURED', '未配置京东联盟 AppKey / SecretKey，请在本地 .env 填写 JD_UNION_APP_KEY 与 JD_UNION_APP_SECRET');
    if (!Array.isArray(rawSkus) || rawSkus.length < 1 || rawSkus.length > 100) throw invalid('skuIds 需为 1–100 个京东商品编号或链接');
    const skus = [...new Set(rawSkus.map(extractSku))];
    if (skus.some(s => !s)) throw invalid('有无法识别的京东商品编号或链接');

    const cacheName = `jd-union-${createHash('sha256').update(skus.slice().sort().join(',')).digest('hex').slice(0, 24)}.json`;
    const cached = await this.store.read(cacheName, null);
    if (cached && this.now().getTime() - cached.createdAt < CACHE_TTL_MS) return { ...cached.payload, cached: true };

    const wait = this.lastCallAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    this.lastCallAt = Date.now();

    const params = {
      method: METHOD, app_key: this.appKey, timestamp: jdTimestamp(this.now()), format: 'json', v: '1.0', sign_method: 'md5',
      '360buy_param_json': JSON.stringify({ skuIds: skus.join(',') }),
    };
    params.sign = jdSign(params, this.appSecret);
    let response;
    try {
      response = await this.fetchFn(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', Accept: 'application/json' },
        body: new URLSearchParams(params).toString(),
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      throw new ApiError(502, 'JD_UNION_UNAVAILABLE', '无法连接京东联盟接口');
    }
    const json = await response.json().catch(() => null);
    if (!json) throw new ApiError(502, 'JD_UNION_INVALID_RESPONSE', `京东联盟返回 HTTP ${response.status}，内容不是 JSON`);
    const observedAt = this.now().toISOString();
    const items = parsePromotionResponse(json, observedAt);
    const found = new Set(items.map(i => i.skuId));
    const payload = { items, missing: skus.filter(s => !found.has(s)), observedAt };
    await this.store.write(cacheName, { createdAt: this.now().getTime(), payload });
    return { ...payload, cached: false };
  }
}
