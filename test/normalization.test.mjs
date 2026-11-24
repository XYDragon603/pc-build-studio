import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTarget, identify, evaluate, merchantUrl } from '../src/normalization.mjs';

const now = Date.parse('2026-11-23T14:10:30Z');
const target = parseTarget('GPU', 'RTX 5060 Ti 16GB');
const valid = { title: '影驰 GeForce RTX5060Ti 金属大师 OC16G 显卡',
  url: 'https://item.jd.com/100123456789.html', method: 'jsonld', observedAt: new Date(now).toISOString(),
  sku: '100123456789', currency: 'CNY', price: '3999.00', availability: 'in-stock', condition: 'new' };
const check = changes => evaluate(target, { ...valid, ...changes }, { now });

test('保留Ti、Super、X3D和显存变体，防止近似型号误配', () => {
  assert.deepEqual(identify('华硕 RTX4070Ti SUPER O16G', 'GPU'), { models: ['RTX 4070 TI SUPER'], capacities: [16] });
  assert.equal(parseTarget('CPU', 'AMD R7-9700X3D').model, 'RYZEN 9700X3D');
  assert.equal(parseTarget('CPU', 'Intel Core Ultra 5 245KF').model, 'CORE ULTRA 5 245KF');
  assert.equal(parseTarget('CPU', 'i5-14600KF').model, 'CORE I5-14600KF');
  assert.throws(() => parseTarget('GPU', 'RTX 5060 Ti 8G/16G'));
});

test('明确新品SKU报价才可以自动入槽，金额按分保存', () => {
  const r = check({});
  assert.equal(r.autoEligible, true); assert.equal(r.priceCents, 399900);
});

for (const [title, reason] of [
  ['RTX5060Ti 16GB 显卡支架', 'accessory'],
  ['RTX5060Ti 16GB 原装包装盒', 'accessory'],
  ['RTX5060Ti 16GB 维修服务', 'accessory'],
  ['RTX5060Ti 16GB PCIe延长线', 'accessory'],
  ['RTX5060Ti 16GB 二手拆机显卡', 'used'],
  ['RTX5060Ti 16GB 主机套餐', 'bundle'],
  ['RTX5060 16GB 显卡', 'model_mismatch'],
  ['RTX5060Ti 8GB 显卡', 'memory_mismatch'],
]) test(`拦截错误商品：${title}`, () => {
  const r = check({ title });
  assert.equal(r.status, 'rejected'); assert.ok(r.reasonCodes.includes(reason));
});

for (const [changes, reason] of [
  [{ title: 'RTX5060Ti 8G/16G 显卡' }, 'memory_ambiguous'],
  [{ title: 'RTX5060/5070 16GB 显卡' }, 'model_ambiguous'],
  [{ excerpt: 'PLUS会员券后价3999元' }, 'conditional_price'],
  [{ price: '19.9' }, 'price_sanity'],
  [{ price: null }, 'price_missing'],
  [{ price: 0 }, 'price_missing'],
  [{ price: 'NaN' }, 'price_missing'],
  [{ currency: 'USD' }, 'currency_unknown'],
  [{ sku: null }, 'sku_unverified'],
  [{ condition: 'unknown' }, 'condition_unknown'],
  [{ availability: 'unknown' }, 'stock_unknown'],
  [{ observedAt: '2020-01-01' }, 'stale'],
  [{ observedAt: 'invalid' }, 'stale'],
  [{ observedAt: '2030-01-01' }, 'stale'],
  [{ priceValidUntil: '2026-11-22' }, 'stale'],
]) test(`需要人工核实：${reason} ${JSON.stringify(changes)}`, () => {
  const r = check(changes); assert.equal(r.autoEligible, false); assert.ok(r.reasonCodes.includes(reason));
});

test('推荐区的廉价商品不能填充当前商品价格', () => {
  const r = check({ method: 'page-unverified', price: null, priceScope: 'recommendations', excerpt: '推荐商品 ¥6.90' });
  assert.equal(r.priceCents, null); assert.equal(r.autoEligible, false);
});

test('单一搜索摘要价格仍需验证，多个价格不能取最低值', () => {
  const one = check({ method: 'search-snippet', price: null, excerpt: '价格 ¥3,999.00' });
  assert.equal(one.priceCents, 399900); assert.equal(one.autoEligible, false);
  const multi = check({ method: 'search-snippet', price: null, excerpt: '¥3999.00 推荐 ¥6.90' });
  assert.equal(multi.priceCents, null); assert.ok(multi.reasonCodes.includes('price_ambiguous'));
});

test('盒装与散片要求不能被型号匹配覆盖', () => {
  const cpu = parseTarget('CPU', '9700X 盒装');
  const r = evaluate(cpu, { ...valid, title: 'AMD 9700X 散片', price: '1800' }, { now });
  assert.ok(r.reasonCodes.includes('packaging_mismatch')); assert.equal(r.autoEligible, false);
});

test('标题不含支架与非矿卡不误判为配件或二手', () => {
  assert.equal(check({ title: 'RTX5060Ti 16GB 显卡 非矿卡 不含支架' }).status, 'accepted');
});

test('URL限制协议、主机、路径，并去掉跟踪参数', () => {
  assert.equal(merchantUrl('https://item.jd.com/123.html?tracking=x'), 'https://item.jd.com/123.html');
  for (const url of ['http://item.jd.com/123.html', 'https://item.jd.com.evil.test/123.html',
    'https://item.jd.com@127.0.0.1/123.html', 'https://127.0.0.1/123.html', 'file:///etc/passwd',
    'https://item.jd.com:444/123.html', 'https://item.jd.com/redirect?url=anything']) assert.equal(merchantUrl(url), null);
});
