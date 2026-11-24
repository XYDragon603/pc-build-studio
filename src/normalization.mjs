const compact = text => String(text ?? '').normalize('NFKC').toUpperCase();

export function identify(text, category) {
  const input = compact(text);
  const models = new Set();
  if (category === 'CPU') {
    for (const m of input.matchAll(/(?<![A-Z0-9])([579]\d{3}(?:X3D|XT|X|G|F))(?![A-Z0-9])/g)) models.add(`RYZEN ${m[1]}`);
    for (const m of input.matchAll(/\bI([3579])\s*[- ]?\s*(\d{4,5}[A-Z]{0,2})(?![A-Z0-9])/g)) models.add(`CORE I${m[1]}-${m[2]}`);
    for (const m of input.matchAll(/\b(?:CORE\s+)?ULTRA\s*([579])\s*[- ]?\s*(\d{3}[A-Z]{0,2})(?![A-Z0-9])/g)) models.add(`CORE ULTRA ${m[1]} ${m[2]}`);
  } else if (category === 'GPU') {
    for (const m of input.matchAll(/\b(RTX|GTX|RX)\s*[- ]?\s*(\d{4})(?:\s*(TI|SUPER|XT|XTX|GRE))?(?:\s*(SUPER))?(?![A-Z0-9])/g)) {
      models.add([m[1], m[2], m[3], m[4]].filter(Boolean).join(' '));
    }
  } else throw new Error('仅支持 CPU 或 GPU');
  const capacities = category === 'GPU'
    ? [...new Set([...input.matchAll(/(?<!\d)(?:O)?(\d{1,2})\s*G(?:B)?(?![A-Z0-9])/g)].map(m => Number(m[1])))].sort((a, b) => a - b)
    : [];
  return { models: [...models], capacities };
}

export function parseTarget(category, query) {
  category = compact(category);
  if (!['CPU', 'GPU'].includes(category)) throw new Error('category 必须为 CPU 或 GPU');
  if (typeof query !== 'string' || !query.trim() || query.length > 200) throw new Error('query 必须为 1–200 字符');
  const identity = identify(query, category);
  if (identity.models.length !== 1 || identity.capacities.length > 1) throw new Error('请指定一个明确型号，例如 9700X 或 RTX 5060 Ti 16GB');
  const packaging = /盒装/.test(query) ? 'boxed' : /散片/.test(query) ? 'tray' : null;
  return { category, query: query.trim(), model: identity.models[0], capacityGB: identity.capacities[0] ?? null, packaging, region: 'CN', currency: 'CNY' };
}

export function merchantUrl(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return null;
    if (!['item.jd.com', 'ic-item.jd.com', 'item.m.jd.com'].includes(url.hostname)) return null;
    if (url.hostname === 'item.m.jd.com') {
      if (url.pathname !== '/ware/view.action' || !/^\d+$/.test(url.searchParams.get('wareId') ?? '')) return null;
      return `https://item.m.jd.com/ware/view.action?wareId=${url.searchParams.get('wareId')}`;
    }
    if (!/^\/(?:\d+|product\/[A-Za-z0-9_-]+)\.html$/.test(url.pathname)) return null;
    return `${url.origin}${url.pathname}`;
  } catch { return null; }
}

export function money(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const text = String(value).trim();
  if (!/^\d+(?:,\d{3})*(?:\.\d{1,2})?$/.test(text)) return null;
  const n = Number(text.replaceAll(',', ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
}

export function priceMentions(text) {
  const prices = [...compact(text).matchAll(/(?:[¥￥]\s*(\d[\d,]*(?:\.\d{1,2})?)|(\d[\d,]*(?:\.\d{1,2})?)\s*元)/g)]
    .map(m => money(m[1] ?? m[2])).filter(n => n !== null);
  return [...new Set(prices)];
}

export const REASONS = {
  unsupported_source: '来源不是已支持的京东商品详情链接',
  accessory: '标题指向配件、包装、维修服务或不含本体',
  used: '标题包含二手、拆机、矿卡或翻新信息',
  bundle: '标题包含板U套装、整机或组合商品',
  model_mismatch: '标题型号与检索目标不一致',
  model_ambiguous: '标题含多个型号或型号不明确',
  memory_mismatch: '显存容量与目标不一致',
  memory_ambiguous: '显存容量缺失或包含多个选项',
  target_memory_missing: '检索目标未指定显存容量',
  packaging_mismatch: '盒装或散片与检索要求不一致或尚未确认',
  conditional_price: '价格依赖登录、优惠券、会员、补贴、定金或其他条件',
  price_missing: '没有可归属到当前商品的价格',
  price_ambiguous: '有多个价格，无法确定当前SKU的实际价格',
  price_sanity: '价格超出宽泛的人工审核范围，需要核实',
  currency_unknown: '未确认人民币价格',
  sku_unverified: '尚未将价格绑定到明确SKU',
  stock_unknown: '库存状态未确认',
  condition_unknown: '商品是否为新品未确认',
  stale: '证据已过期、时间无效或采集时间在未来',
  snippet_only: '只有搜索摘要，未验证商品页',
  page_blocked: '商品页返回访问限制或浏览器验证提示',
  page_fetch_failed: '页面请求失败，需区分网络环境与商家页面限制',
  unstructured_page: '页面缺少可验证的单商品结构化报价',
  recommendation_prices: '只能看到推荐商品价格，不能作为当前商品报价',
  manual_observation: '人工浏览记录，只供验证回放',
};

export function evaluate(target, evidence, { now = Date.now(), ttlMs = 60 * 60 * 1000 } = {}) {
  const title = String(evidence.title ?? '');
  const text = compact(`${title} ${evidence.excerpt ?? ''}`);
  const productTitle = compact(title).replace(/非矿卡|非二手|不含支架/g, '');
  const identity = identify(title, target.category);
  const reject = [], review = [];
  const url = merchantUrl(evidence.url);
  if (!url) reject.push('unsupported_source');
  if (/显卡支架|延长线|转接线|包装盒|空盒|维修|散热膏|导热硅脂|不含(?:显卡|CPU|处理器)|仅(?:包装|风扇|外壳)/.test(productTitle)) reject.push('accessory');
  if (/二手|拆机|矿卡|翻新|\d{1,2}新|展机/.test(productTitle)) reject.push('used');
  if (/板U|套装|套餐|整机|组装机|电脑主机|主机配置|搭配主板|组合|\d{4}[XKF]+\s*\+\s*(?:B\d{3}|主板)/.test(productTitle)) reject.push('bundle');
  if (identity.models.length === 0 || identity.models.length > 1 || /\d{4}\s*(?:TI|X)?\s*\//.test(productTitle)) review.push('model_ambiguous');
  else if (identity.models[0] !== target.model) reject.push('model_mismatch');
  if (target.category === 'CPU' && target.packaging && !(target.packaging === 'boxed' ? /盒装/ : /散片/).test(title)) review.push('packaging_mismatch');
  if (target.category === 'GPU') {
    if (!target.capacityGB) review.push('target_memory_missing');
    if (identity.capacities.length !== 1) review.push('memory_ambiguous');
    else if (target.capacityGB && identity.capacities[0] !== target.capacityGB) reject.push('memory_mismatch');
  }
  if (evidence.conditional || /登录|券后|优惠券|会员|PLUS|补贴|国补|定金|订金|预售|分期|以旧换新|起售|首发价|划线价|到手价.*起|价格.*起|低至/.test(text)) review.push('conditional_price');
  let priceCents = money(evidence.price);
  const mentions = priceMentions(evidence.excerpt ?? '');
  if (priceCents === null && mentions.length === 1 && evidence.priceScope !== 'recommendations') priceCents = mentions[0];
  if (priceCents === null) review.push('price_missing');
  if (mentions.length > 1 && evidence.method !== 'jsonld') review.push('price_ambiguous');
  if (priceCents !== null) {
    const [min, max] = target.category === 'CPU' ? [15000, 2000000] : [50000, 6000000];
    if (priceCents < min || priceCents > max) review.push('price_sanity');
  }
  if (evidence.currency !== 'CNY') review.push('currency_unknown');
  if (evidence.method === 'search-snippet') review.push('snippet_only');
  if (evidence.method === 'manual-web-observation') review.push('manual_observation');
  if (evidence.pageState === 'blocked') review.push('page_blocked');
  if (evidence.pageState === 'fetch-failed') review.push('page_fetch_failed');
  if (evidence.priceScope === 'recommendations') review.push('recommendation_prices');
  if (evidence.method !== 'jsonld') review.push('unstructured_page');
  if (!evidence.sku || evidence.method !== 'jsonld') review.push('sku_unverified');
  if (evidence.availability !== 'in-stock') review.push('stock_unknown');
  if (evidence.condition !== 'new') review.push('condition_unknown');
  const observed = Date.parse(evidence.observedAt);
  if (!Number.isFinite(observed) || observed > now + 60000 || now - observed > ttlMs) review.push('stale');
  if (evidence.priceValidUntil != null) {
    const expiry = Date.parse(evidence.priceValidUntil);
    if (!Number.isFinite(expiry) || expiry < now) review.push('stale');
  }
  const reasonCodes = [...new Set([...reject, ...review])];
  const status = reject.length ? 'rejected' : review.length ? 'review' : 'accepted';
  return {
    title, url: url ?? String(evidence.url ?? ''), category: target.category,
    model: identity.models.length === 1 ? identity.models[0] : null,
    capacityGB: identity.capacities.length === 1 ? identity.capacities[0] : null,
    priceCents, currency: evidence.currency ?? null,
    observedAt: evidence.observedAt ?? null, method: evidence.method,
    sku: evidence.sku ?? null, status, autoEligible: status === 'accepted',
    reasonCodes, reasons: reasonCodes.map(code => REASONS[code]),
    evidence,
  };
}
