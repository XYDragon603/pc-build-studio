import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JdUnion, extractSku, jdSign, jdTimestamp, parsePromotionResponse } from '../src/jdunion.mjs';

test('签名：除 sign 外按参数名排序拼接 key+value，前后加 secret，MD5 大写', () => {
  const expected = createHash('md5').update('S' + 'a1' + 'b2' + 'S').digest('hex').toUpperCase();
  assert.equal(jdSign({ b: '2', a: '1', sign: 'x' }, 'S'), expected);
});

test('时间戳为 GMT+8 的 yyyy-MM-dd HH:mm:ss', () => {
  assert.equal(jdTimestamp(new Date('2026-01-01T00:00:00Z')), '2026-01-01 08:00:00');
});

test('从链接或编号取 SKU，拒绝非京东链接', () => {
  assert.equal(extractSku('100012345678'), '100012345678');
  assert.equal(extractSku('https://item.jd.com/100012345678.html?spm=x'), '100012345678');
  assert.equal(extractSku('https://item.m.jd.com/product/100012345678.html'), '100012345678');
  assert.equal(extractSku('https://item.m.jd.com/ware/view.action?wareId=100012345678'), '100012345678');
  assert.equal(extractSku('https://example.com/100012345678.html'), null);
  assert.equal(extractSku('RTX 5060'), null);
});

const goods = { skuId: 100012345678, goodsName: '示例显卡', unitPrice: '3999', wlUnitPrice: '-1', isJdSale: '1',
  imgUrl: 'http://img14.360buyimg.com/n1/x.jpg' };

test('解析响应：queryResult 为对象或 JSON 字符串都可以；-1 价格为未知', () => {
  const asObject = { jd_union_open_goods_promotiongoodsinfo_query_responce: { queryResult: { code: '200', data: { promotionGoodsResp: goods } } } };
  const asString = { jd_union_open_goods_promotiongoodsinfo_query_response: { queryResult: JSON.stringify({ code: 200, data: [goods] }) } };
  for (const json of [asObject, asString]) {
    const [item] = parsePromotionResponse(json, '2026-11-24T00:00:00.000Z');
    assert.equal(item.skuId, '100012345678');
    assert.equal(item.unitPriceCents, 399900);
    assert.equal(item.mobilePriceCents, null);
    assert.equal(item.imageUrl, 'https://img14.360buyimg.com/n1/x.jpg');
    assert.equal(item.url, 'https://item.jd.com/100012345678.html');
  }
});

test('解析响应：权限、验证、网关错误分别给出可读的原因', () => {
  const wrap = result => ({ jd_union_open_goods_promotiongoodsinfo_query_responce: { queryResult: result } });
  assert.throws(() => parsePromotionResponse(wrap({ code: 2003103 })), { code: 'JD_UNION_FORBIDDEN' });
  assert.throws(() => parsePromotionResponse(wrap({ code: 401 })), { code: 'JD_UNION_AUTH' });
  assert.throws(() => parsePromotionResponse({ error_response: { code: '19', zh_desc: '签名无效' } }), /签名无效/);
  assert.throws(() => parsePromotionResponse({ unexpected: true }), { code: 'JD_UNION_INVALID_RESPONSE' });
});

test('查询：密钥不随请求发送；未返回的 SKU 列为 missing；30 分钟内命中缓存', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'jd-union-'));
  t.after(async () => { for (const f of await readdir(directory)) await unlink(join(directory, f)); await rmdir(directory); });
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, body: init.body });
    return { status: 200, json: async () => ({ jd_union_open_goods_promotiongoodsinfo_query_responce: { queryResult: { code: 200, data: [goods] } } }) };
  };
  const jd = new JdUnion({ appKey: 'KEY', appSecret: 'TOP-SECRET', directory, fetchFn });
  const first = await jd.lookup(['https://item.jd.com/100012345678.html', '200000000001']);
  assert.equal(first.items[0].unitPriceCents, 399900);
  assert.deepEqual(first.missing, ['200000000001']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.jd.com/routerjson');
  const body = new URLSearchParams(calls[0].body);
  assert.equal(body.get('method'), 'jd.union.open.goods.promotiongoodsinfo.query');
  assert.equal(body.get('360buy_param_json'), JSON.stringify({ skuIds: '100012345678,200000000001' }));
  assert.match(body.get('sign'), /^[0-9A-F]{32}$/);
  assert.ok(!calls[0].body.includes('TOP-SECRET'));

  const second = await jd.lookup(['200000000001', '100012345678']);
  assert.equal(second.cached, true);
  assert.equal(calls.length, 1);
});

test('未配置密钥时返回 503，并拒绝无法识别的输入', async () => {
  await assert.rejects(new JdUnion({ appKey: '', appSecret: '' }).lookup(['100012345678']), { code: 'JD_UNION_NOT_CONFIGURED' });
  await assert.rejects(new JdUnion({ appKey: 'k', appSecret: 's' }).lookup(['RTX 5060']), { code: 'INVALID_INPUT' });
});
