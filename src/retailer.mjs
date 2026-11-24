import { merchantUrl } from './normalization.mjs';

function flatten(value) {
  if (Array.isArray(value)) return value.flatMap(flatten);
  if (!value || typeof value !== 'object') return [];
  return [value, ...flatten(value['@graph'])];
}

// Only JSON-LD Product -> one Offer with an exact SKU binding is machine verified.
// Prices from reviews, related-products blocks, AggregateOffer, or arbitrary HTML are never bound.
export function extractRetailerEvidence(html, result, observedAt = new Date().toISOString()) {
  const base = { title: String(result.title ?? ''), url: result.url, excerpt: '', observedAt,
    method: 'page-unverified', pageState: 'readable', currency: null, price: null };
  if (/高版本浏览器|验证码|访问过于频繁|验证后继续访问/.test(html) && html.length < 10000) return { ...base, pageState: 'blocked' };
  const products = [];
  for (const script of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      products.push(...flatten(JSON.parse(script[1])).filter(x => [].concat(x['@type'] ?? []).includes('Product')));
    } catch { /* Malformed merchant markup is not evidence. */ }
  }
  if (products.length !== 1) return base;
  const product = products[0];
  const offers = [].concat(product.offers ?? []);
  if (offers.length !== 1) return { ...base, title: String(product.name ?? base.title) };
  const offer = offers[0];
  if (!offer || typeof offer !== 'object' || Array.isArray(offer)) return base;
  const sku = product.sku;
  const bound = (typeof sku === 'string' || typeof sku === 'number') && String(sku).length > 0
    && String(offer.sku ?? '') === String(sku)
    && merchantUrl(offer.url) === merchantUrl(result.url)
    && [].concat(offer['@type'] ?? []).includes('Offer');
  if (!bound || !product.name) return { ...base, title: String(product.name ?? base.title) };
  return { ...base, title: String(product.name), method: 'jsonld', sku: String(sku),
    price: offer.price, currency: offer.priceCurrency,
    availability: /^https?:\/\/schema\.org\/InStock$/.test(offer.availability ?? '') ? 'in-stock' : 'unknown',
    condition: /^https?:\/\/schema\.org\/NewCondition$/.test(offer.itemCondition ?? '') ? 'new' : 'unknown',
    conditional: Boolean(offer.eligibleCustomerType || offer.priceSpecification)
      || /登录查看到手价|券后价|会员专享|补贴后|定金|订金/.test(html),
    // Conditional language in product name / the offer description is retained.
    excerpt: String(offer.description ?? ''), priceScope: 'primary-product',
    priceValidUntil: offer.priceValidUntil ?? null };
}

export async function inspectRetailer(result, { fetchFn = fetch, now = () => new Date().toISOString() } = {}) {
  const url = merchantUrl(result.url);
  if (!url) throw new Error('不支持的商品URL');
  const observedAt = now();
  try {
    const response = await fetchFn(url, { redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { Accept: 'text/html', 'User-Agent': 'PCPricingValidation/0.1' } });
    if (!response.ok) throw Object.assign(new Error('HTTP error'), { code: `HTTP_${response.status}` });
    const type = response.headers.get('content-type') ?? '';
    if (!type.includes('text/html')) throw Object.assign(new Error('页面不是HTML'), { code: 'NOT_HTML' });
    const chunks = []; let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) throw Object.assign(new Error('商品页超过2MB限制'), { code: 'PAGE_TOO_LARGE' });
      chunks.push(Buffer.from(chunk));
    }
    const body = Buffer.concat(chunks);
    const declaredEncoding = type.match(/charset\s*=\s*["']?([\w-]+)/i)?.[1]
      ?? body.subarray(0, 4096).toString('ascii').match(/charset\s*=\s*["']?([\w-]+)/i)?.[1] ?? 'utf-8';
    const encoding = /^(gbk|gb2312|gb18030)$/i.test(declaredEncoding) ? 'gb18030' : 'utf-8';
    const evidence = extractRetailerEvidence(new TextDecoder(encoding).decode(body), result, observedAt);
    return { ...evidence, acquisition: { httpStatus: response.status, bytes, encoding } };
  } catch (error) {
    const code = String(error.cause?.code ?? error.code ?? error.name ?? 'UNKNOWN');
    return { title: result.title, url, excerpt: '', price: null, currency: null,
      observedAt, method: 'page-unverified', acquisitionError: code,
      pageState: /HTTP_(?:403|429)/.test(code) ? 'blocked' : 'fetch-failed' };
  }
}
