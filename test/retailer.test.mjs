import test from 'node:test';
import assert from 'node:assert/strict';
import { extractRetailerEvidence, inspectRetailer } from '../src/retailer.mjs';
import { parseTarget, evaluate } from '../src/normalization.mjs';

const result = { title: 'RTX5060Ti 16GB', url: 'https://item.jd.com/123.html' };
const now = '2026-11-23T14:10:30Z';
const product = { '@type': 'Product', name: result.title, sku: '123', offers: {
  '@type': 'Offer', sku: '123', url: result.url, price: '3999', priceCurrency: 'CNY',
  availability: 'https://schema.org/InStock', itemCondition: 'https://schema.org/NewCondition' } };
const html = p => `<html><script type="application/ld+json">${JSON.stringify(p)}</script></html>`;
const eligible = evidence => evaluate(parseTarget('GPU', result.title), evidence, { now: Date.parse(now) }).autoEligible;

test('通过真实解析路径绑定Product、Offer、SKU和链接（合成控制样本）', () => {
  const evidence = extractRetailerEvidence(html(product), result, now);
  assert.equal(evidence.method, 'jsonld'); assert.equal(eligible(evidence), true);
});

test('推荐商品、多个报价和AggregateOffer不能冒充当前SKU报价', () => {
  const scenarios = [
    [product, { ...product, sku: '456' }],
    { ...product, offers: [product.offers, product.offers] },
    { ...product, offers: { ...product.offers, '@type': 'AggregateOffer' } },
    { ...product, offers: { ...product.offers, sku: 'wrong' } },
    { ...product, offers: { ...product.offers, url: 'https://item.jd.com/456.html' } },
    { ...product, offers: { ...product.offers, priceCurrency: 'USD' } },
  ];
  for (const p of scenarios) assert.equal(eligible(extractRetailerEvidence(html(p), result, now)), false);
});

test('不从商品页任意文本、评论、推荐区抓取价格', () => {
  const evidence = extractRetailerEvidence('<html>推荐 RTX5060Ti 16GB ¥6.90 评论:去年3999</html>', result, now);
  assert.equal(evidence.price, null); assert.equal(eligible(evidence), false);
});

test('损坏或不完整的商家标记进入待核实，不能中断整批验证', () => {
  for (const p of [{ ...product, offers: [null] }, { ...product, offers: ['bad'] }, { '@type': 'Product' }]) {
    assert.equal(eligible(extractRetailerEvidence(html(p), result, now)), false);
  }
  assert.equal(eligible(extractRetailerEvidence('<script type="application/ld+json">{broken</script>', result, now)), false);
});

test('即使存在结构化价格，登录条件仍阻止自动入槽', () => {
  assert.equal(eligible(extractRetailerEvidence(html(product) + '登录查看到手价', result, now)), false);
});

test('网络失败、访问限制、错误内容类型均保留未知价格', async () => {
  for (const fetchFn of [
    async () => { throw new Error('network failure'); },
    async () => new Response('blocked', { status: 403 }),
    async () => new Response('{}', { headers: { 'content-type': 'application/json' } }),
    async () => new Response('请您使用高版本浏览器', { headers: { 'content-type': 'text/html' } }),
  ]) {
    const evidence = await inspectRetailer(result, { fetchFn, now: () => now });
    assert.ok(['blocked', 'fetch-failed'].includes(evidence.pageState)); assert.equal(evidence.price, null);
  }
});

test('fetch读取后进入同一个解析与判定路径', async () => {
  const evidence = await inspectRetailer(result, { now: () => now,
    fetchFn: async (url, options) => {
      assert.equal(options.redirect, 'error');
      assert.equal(url, result.url);
      return new Response(html(product), { headers: { 'content-type': 'text/html; charset=utf-8' } });
    } });
  assert.equal(eligible(evidence), true);
});
