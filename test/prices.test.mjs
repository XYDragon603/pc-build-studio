import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApiServer } from '../src/api.mjs';
import { BraveSearch } from '../src/search.mjs';
import { applyPriceMode, isStale, normalizeRecord, parseCsv, toCsv } from '../src/prices.mjs';

const NOW = new Date('2026-11-25T00:00:00Z');

test('价格记录校验：金额、来源、状况、时间', () => {
  const ok = normalizeRecord({ componentId: 'zol-cpu-1', priceCents: 129900 }, NOW);
  assert.equal(ok.priceType, 'manual');
  assert.equal(ok.sourceName, '手动输入');
  assert.equal(ok.condition, 'new');
  assert.equal(ok.confidence, 'medium');
  for (const bad of [
    { componentId: 'x', priceCents: 0 },
    { componentId: 'x', priceCents: 1.5 },
    { componentId: 'X Y', priceCents: 100 },
    { componentId: 'x', priceCents: 100, condition: 'broken' },
    { componentId: 'x', priceCents: 100, currency: 'USD' },
    { componentId: 'x', priceCents: 100, sourceUrl: 'http://example.com' },
    { componentId: 'x', priceCents: 100, priceType: 'verified' },
    { componentId: 'x', priceCents: 100, observedAt: '2030-01-01' },
  ]) assert.throws(() => normalizeRecord(bad, NOW), undefined, JSON.stringify(bad));
  assert.equal(normalizeRecord({ componentId: 'x', priceCents: 100, priceType: 'verified', sourceUrl: 'https://item.jd.com/1.html', sourceName: '京东' }, NOW).confidence, 'high');
});

test('CSV 往返：引号、逗号、换行，防公式注入', () => {
  const records = [normalizeRecord({ componentId: 'a-1', priceCents: 100, sourceName: '店, "A"', note: '=HYPERLINK("x")\n第二行' }, NOW)];
  const csv = toCsv(records);
  assert.match(csv, /'=HYPERLINK/);
  const [row] = parseCsv('﻿' + csv);
  assert.equal(row.sourceName, '店, "A"');
  assert.equal(row.note, '=HYPERLINK("x")\n第二行');
  assert.equal(normalizeRecord(row, NOW).priceCents, 100);
  assert.throws(() => parseCsv('name,price\nx,1'));
});

test('价格模式：优先我的价格用最新有效记录，二手、无货默认不用，过期标记', () => {
  const items = [{ id: 'a', estimatedPriceCents: 100000, priceObservedAt: '2026-11-01T00:00:00Z' }, { id: 'b', estimatedPriceCents: 50000, priceObservedAt: '2026-11-24T00:00:00Z' }];
  const rec = (componentId, priceCents, extra = {}) => normalizeRecord({ componentId, priceCents, observedAt: '2026-11-20T00:00:00Z', ...extra }, NOW);
  const records = [rec('a', 90000), rec('a', 85000, { observedAt: '2026-11-22T00:00:00Z', shippingCents: 1000 }), rec('b', 30000, { condition: 'used' }), rec('b', 31000, { stockStatus: 'out_of_stock' })];
  const now = NOW.getTime();
  const [a, b] = applyPriceMode(items, records, { mode: 'manual', now });
  assert.deepEqual([a.estimatedPriceCents, a.priceSource, a.estimateBasis, a.priceStale], [86000, 'user', 'manual', false]);
  assert.deepEqual([b.estimatedPriceCents, b.priceSource, b.priceStale], [50000, 'catalog', false]);
  assert.equal(applyPriceMode(items, records, { mode: 'manual', allowUsed: true, now })[1].estimatedPriceCents, 30000);
  // 参考估算模式不用用户记录；目录价 24 天前抓取 → 过期
  const [ea] = applyPriceMode(items, records, { mode: 'estimate', now });
  assert.deepEqual([ea.estimatedPriceCents, ea.priceSource, ea.priceStale], [100000, 'catalog', true]);
  assert.equal(isStale('2026-10-20T00:00:00Z', 'user', now), true);
  assert.equal(isStale('2026-11-01T00:00:00Z', 'user', now), false);
});

test('价格 API：新增、导入逐行报错、导出、删除、目录按模式显示', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pc-prices-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const common = { manufacturer: 'Test', mpn: null, partNumbers: [], aliases: [], summary: '', imageUrl: null, sourceUrl: 'https://example.com/p', dataSource: 'zol' };
  await writeFile(join(directory, 'zol-catalog.json'), JSON.stringify({ items: [
    { ...common, id: 'zol-cpu-a', name: 'Intel Core i5 14600K', category: 'CPU', referencePriceCents: 139900, specs: {} },
  ] }));
  const server = createApiServer({ directory, provider: new BraveSearch({ directory, apiKey: '' }) });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port + '/api/v1';
  const call = async (path, method = 'GET', body) => {
    const response = await fetch(base + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const text = await response.text();
    return { status: response.status, type: response.headers.get('content-type'), text, data: text && response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : undefined };
  };

  assert.equal((await call('/prices', 'POST', { componentId: 'zol-not-here', priceCents: 100 })).status, 400);
  const added = await call('/prices', 'POST', { componentId: 'zol-cpu-a', priceCents: 119900, sourceName: '线下店' });
  assert.equal(added.status, 201);

  const csv = 'componentId,priceCents,condition\nzol-cpu-a,118000,new\nzol-cpu-a,-5,new\nzol-missing,100,new\n';
  const imported = await call('/prices/import', 'POST', { format: 'csv', content: csv });
  assert.equal(imported.data.imported, 1);
  assert.deepEqual(imported.data.errors.map(e => e.row), [2, 3]);
  assert.equal((await call('/prices/import', 'POST', { format: 'xml', content: 'x' })).status, 400);

  const listed = await call('/prices?componentId=zol-cpu-a');
  assert.equal(listed.data.records.length, 2);
  const exported = await call('/prices/export?format=csv');
  assert.match(exported.type, /text\/csv/);
  assert.equal(parseCsv(exported.text).length, 2);
  assert.equal((await call('/prices/export')).data.records.length, 2);

  const estimate = await call('/catalog?q=14600K');
  assert.notEqual(estimate.data.items[0].priceSource, 'user');
  const manual = await call('/catalog?q=14600K&priceMode=manual');
  assert.equal(manual.data.items[0].priceSource, 'user');
  assert.equal(manual.data.items[0].estimatedPriceCents, 118000);

  assert.equal((await call('/plans', 'POST', { budgetCents: 500000, priceMode: 'live' })).status, 400);
  assert.equal((await call('/prices/' + added.data.id, 'DELETE')).status, 204);
  assert.equal((await call('/prices/' + added.data.id, 'DELETE')).status, 404);
});
