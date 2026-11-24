import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readdir, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApiServer } from '../src/api.mjs';
import { BraveSearch } from '../src/search.mjs';

async function listen(t, directory, options = {}) {
  const server = createApiServer({ directory, provider: new BraveSearch({ directory, apiKey: '' }), ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const base = 'http://127.0.0.1:' + server.address().port + '/api/v1';
  return async (path, method = 'GET', body, headers = {}) => {
    const response = await fetch(base + path, { method, headers: { ...headers,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    return { status: response.status, headers: response.headers,
      data: response.status === 204 ? undefined : await response.json() };
  };
}

test('配置 API 保存与重读整单，保护锁定槽位和并发编辑', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pc-api-test-'));
  const request = await listen(t, directory);
  t.after(async () => {
    for (const name of await readdir(directory)) await unlink(join(directory, name));
    await rmdir(directory);
  });

  const created = await request('/builds', 'POST', { preset: 'demo' });
  assert.equal(created.status, 201);
  const build = created.data;
  const path = '/builds/' + build.id;
  assert.equal(created.headers.get('location'), '/api/v1' + path);
  assert.equal(build.totals.totalCents, 394400);
  assert.equal(build.totals.remainingCents, 405600);
  assert.equal(build.compatibility.cpuSocket, 'pass');
  assert.deepEqual(build.scenarios, ['2k', 'quiet']);
  assert.equal(build.slots.find(slot => slot.id === 'CPU').part.spec, 'AM5 · 盒装');
  assert.equal((await request('/builds', 'POST', { scenarios: ['2K 游戏'] })).data.error.code, 'INVALID_INPUT');
  const cpu = build.slots.find(slot => slot.id === 'CPU');
  const gpu = build.slots.find(slot => slot.id === 'GPU');
  cpu.part.priceCents = 0;
  assert.equal((await request(path, 'PUT', build)).data.error.code, 'SLOT_LOCKED');
  cpu.part.priceCents = 145000;
  cpu.locked = false;
  gpu.part = { model: '演示显卡', priceCents: null };
  build.slots.push({ id: 'custom-fans', label: '已有机箱风扇', locked: false,
    part: { model: '120mm 风扇', priceCents: 0, quantity: 3 } });

  const saved = await request(path, 'PUT', build);
  assert.equal(saved.status, 200);
  assert.equal(saved.data.totals.totalCents, 394400);
  assert.equal(saved.data.totals.unknownPriceCount, 1);
  assert.equal(saved.data.totals.filledStandardSlots, 8);
  assert.equal(saved.data.slots.at(-1).part.priceCents, 0);
  assert.equal((await request(path, 'PUT', build)).data.error.code, 'VERSION_CONFLICT');

  const anotherServer = await listen(t, directory);
  assert.deepEqual((await anotherServer(path)).data, saved.data);
  assert.equal((await request('/builds')).data.items.length, 1);
  const update = { ...saved.data, budgetCents: 300000 };
  const concurrent = await Promise.all([request(path, 'PUT', update), request(path, 'PUT', update)]);
  assert.deepEqual(concurrent.map(result => result.status).sort(), [200, 409]);
  assert.equal(concurrent.find(result => result.status === 200).data.totals.remainingCents, -94400);
  assert.equal((await request(path, 'DELETE', { version: 3 })).status, 204);
  assert.equal((await request(path)).status, 404);
});

test('报价 API 回放真实记录，区分缺少密钥、输入无效和不允许的跨域来源', async t => {
  const request = await listen(t);
  const health = await request('/health');
  assert.equal(health.data.quotes.liveConfigured, false);
  const replay = await request('/quotes/search', 'POST', { category: 'GPU', query: 'RTX 5060 Ti 16GB' });
  assert.equal(replay.status, 200);
  assert.equal(replay.data.mode, 'replay');
  assert.equal(replay.data.summary.total, 5);
  assert.equal(replay.data.cost.projectSearchRequests, 0);
  assert.ok(replay.data.results.every(offer => !offer.autoEligible));
  const missing = await request('/quotes/search', 'POST', { category: 'GPU', query: 'RTX 5060 Ti 16GB', mode: 'live' });
  assert.equal(missing.status, 503);
  assert.equal(missing.data.error.code, 'SEARCH_NOT_CONFIGURED');
  assert.equal((await request('/quotes/search', 'POST', { category: 'SSD', query: '1TB' })).status, 400);
  assert.equal((await request('/health', 'GET', undefined, { Origin: 'https://example.com' })).status, 403);
  const preflight = await request('/builds', 'OPTIONS', undefined, { Origin: 'http://localhost:5173' });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  assert.equal((await request('/builds', 'POST', { name: 'a'.repeat(66000) })).status, 413);
});

test('商品目录按类目和型号变体筛选，图片与来源随具体料号返回', async t => {
  const request = await listen(t, undefined, { catalogDirectory: null });
  const { data: catalog } = await request('/catalog');
  assert.equal(new Set(catalog.items.map(item => item.category)).size, 8);
  const { data: gpu } = await request('/catalog?category=GPU&q=' + encodeURIComponent('华硕RTX5060Ti16GB'));
  assert.deepEqual(gpu.items.map(item => item.mpn), ['DUAL-RTX5060TI-O16G']);
  const { data: variant } = await request('/catalog/asus-dual-rtx5060ti-o8g');
  assert.equal(variant.specs.capacityGB, 8);
  assert.notEqual(variant.imageUrl, gpu.items[0].imageUrl);
  assert.equal(new URL(variant.sourceUrl).hostname, 'www.asus.com');
  const page = await request('/catalog?category=GPU&offset=1&limit=1');
  assert.equal(page.data.total, 2);
  assert.equal(page.data.items.length, 1);
  assert.equal((await request('/catalog?category=OTHER')).status, 400);
  assert.equal((await request('/catalog/nonexistent')).status, 404);
});

test('导入目录保留数据来源，只给唯一匹配的料号关联已核实图片', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pc-catalog-test-'));
  t.after(async () => {
    for (const file of await readdir(directory)) await unlink(join(directory, file));
    await rmdir(directory);
  });
  const source = { category: 'GPU', manufacturer: 'ASUS', aliases: [], summary: '', imageUrl: null,
    sourceUrl: 'https://example.com/product', datasetUrl: 'https://example.com/dataset', dataSource: 'buildcores' };
  const items = [
    { ...source, id: 'buildcores-a', name: 'ASUS RTX 5060 Ti 16GB', mpn: 'DUAL-RTX5060TI-O16G',
      partNumbers: ['DUAL-RTX5060TI-O16G'], specs: { capacityGB: 16, lengthMm: 229 } },
    ...['b', 'c'].map(id => ({ ...source, id: 'buildcores-' + id, name: 'ASUS RTX 5060 Ti 8GB',
      mpn: 'DUAL-RTX5060TI-O8G', partNumbers: ['DUAL-RTX5060TI-O8G'], specs: { capacityGB: 8 } })),
  ];
  await writeFile(join(directory, 'buildcores-catalog.json'),
    JSON.stringify({ items, attribution: { name: 'BuildCores OpenDB', license: 'CC BY-NC-SA 4.0' } }));
  const request = await listen(t, directory);
  const { data: merged } = await request('/catalog/asus-dual-rtx5060ti-o16g');
  assert.match(merged.imageUrl, /asus\.com/);
  assert.equal(merged.specs.lengthMm, 229);
  assert.equal(merged.attribution.license, 'CC BY-NC-SA 4.0');
  const { data: ambiguous } = await request('/catalog/buildcores-b');
  assert.equal(ambiguous.imageUrl, null);
  assert.equal(ambiguous.specs.capacityGB, 8);
});

test('中关村在线快照：料号唯一匹配时只补缺失字段，其余作为独立条目', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pc-catalog-zol-'));
  t.after(async () => {
    for (const file of await readdir(directory)) await unlink(join(directory, file));
    await rmdir(directory);
  });
  const buildcores = { id: 'buildcores-a', category: 'GPU', manufacturer: 'ASUS', name: 'ASUS RTX 5060 Ti 16GB',
    mpn: 'DUAL-RTX5060TI-O16G', partNumbers: ['DUAL-RTX5060TI-O16G'], aliases: [], summary: '', imageUrl: null,
    specs: { capacityGB: 16, lengthMm: 229 }, sourceUrl: 'https://example.com/p', dataSource: 'buildcores' };
  const zolBase = { category: 'GPU', summary: '', imageUrl: 'https://2d.zol-img.com.cn/x.png', dataSource: 'zol',
    sourceUrl: 'https://detail.zol.com.cn/1/1/param.shtml', rawParams: { 产品型号: 'x' } };
  const zolItems = [
    { ...zolBase, id: 'zol-1', name: '华硕DUAL RTX5060Ti O16G', manufacturer: 'ASUS', mpn: 'dual-rtx5060ti-o16g',
      partNumbers: [], aliases: ['ASUS DUAL'], specs: { lengthMm: 230, recommendedPsuWatts: 550 }, referencePriceCents: 329900 },
    { ...zolBase, id: 'zol-2', name: '七彩虹战斧 GeForce RTX 5060 DUO 8GB', manufacturer: 'Colorful', mpn: null,
      partNumbers: [], aliases: [], specs: { capacityGB: 8, lengthMm: 231 }, referencePriceCents: 269900 },
  ];
  await writeFile(join(directory, 'buildcores-catalog.json'), JSON.stringify({ items: [buildcores], attribution: { name: 'BuildCores OpenDB' } }));
  await writeFile(join(directory, 'zol-catalog.json'), JSON.stringify({ items: zolItems, attribution: { name: '中关村在线产品库' } }));
  const request = await listen(t, directory);

  // 官网样本先与 BuildCores 合并为 asus-dual-rtx5060ti-o16g，ZOL 再补充到这条记录上
  const { data: merged } = await request('/catalog/asus-dual-rtx5060ti-o16g');
  assert.match(merged.imageUrl, /asus\.com/);
  assert.equal(merged.specs.lengthMm, 229);
  assert.equal(merged.specs.recommendedPsuWatts, 550);
  assert.ok(merged.aliases.includes('华硕DUAL RTX5060Ti O16G'));
  assert.equal(merged.zolId, 'zol-1');
  assert.equal(merged.zolAttribution.name, '中关村在线产品库');
  assert.equal((await request('/catalog/zol-1')).status, 404);

  const { data: list } = await request('/catalog?category=GPU&q=' + encodeURIComponent('七彩虹'));
  assert.deepEqual(list.items.map(item => item.id), ['zol-2']);
  assert.equal(list.items[0].rawParams, undefined);
  assert.deepEqual(list.attributions.map(a => a.name), ['BuildCores OpenDB', '中关村在线产品库']);
  assert.deepEqual((await request('/catalog/zol-2')).data.rawParams, { 产品型号: 'x' });
});

test('估算价：有参考价用参考价，显卡缺价时用同芯片同显存中位数（至少 3 个样本）', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pc-catalog-estimate-'));
  t.after(async () => {
    for (const file of await readdir(directory)) await unlink(join(directory, file));
    await rmdir(directory);
  });
  const gpu = (id, cents, chipset = 'GeForce RTX 5060 Ti', capacityGB = 16) => ({ id, category: 'GPU', name: id, manufacturer: 'Colorful',
    mpn: null, partNumbers: [], summary: '', aliases: [], imageUrl: null, sourceUrl: 'https://detail.zol.com.cn/1/1/param.shtml',
    dataSource: 'zol', specs: { chipset, capacityGB }, referencePriceCents: cents, priceObservedAt: cents ? '2026-11-24T00:00:00.000Z' : null });
  const items = [gpu('zol-1', 400000), gpu('zol-2', 420000), gpu('zol-3', 460000), gpu('zol-4', null),
    gpu('zol-5', null, 'GeForce RTX 5090', 32), gpu('zol-6', 499900, 'GeForce RTX 5060 Ti', 8)];
  await writeFile(join(directory, 'zol-catalog.json'), JSON.stringify({ items, attribution: { name: '中关村在线产品库' } }));
  const request = await listen(t, directory);
  const get = async id => (await request('/catalog/' + id)).data;
  assert.deepEqual([(await get('zol-1')).estimatedPriceCents, (await get('zol-1')).estimateBasis], [400000, 'reference']);
  assert.deepEqual([(await get('zol-4')).estimatedPriceCents, (await get('zol-4')).estimateBasis, (await get('zol-4')).estimateSamples], [420000, 'chip-median', 3]);
  assert.equal((await get('zol-5')).estimatedPriceCents, undefined);

  const created = await request('/builds', 'POST', { preset: 'demo' });
  const build = created.data;
  build.slots.find(slot => slot.id === 'GPU').part = { model: 'zol-4', priceCents: 420000, priceSource: 'estimate', catalogId: 'zol-4' };
  const saved = await request('/builds/' + build.id, 'PUT', build);
  assert.equal(saved.status, 200);
  assert.equal(saved.data.totals.totalCents, 394400 + 420000);
  assert.equal(saved.data.slots.find(slot => slot.id === 'GPU').part.catalogId, 'zol-4');
  build.version = saved.data.version;
  build.slots.find(slot => slot.id === 'GPU').part.priceSource = 'guess';
  assert.equal((await request('/builds/' + build.id, 'PUT', build)).data.error.code, 'INVALID_INPUT');
});

test('价格走势：读取参考价历史，给出最近一次变价与最低价', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pc-catalog-trend-'));
  t.after(async () => {
    for (const file of await readdir(directory)) await unlink(join(directory, file));
    await rmdir(directory);
  });
  const item = { id: 'zol-9', category: 'GPU', name: 'x', manufacturer: 'Colorful', mpn: null, partNumbers: [], summary: '', aliases: [],
    imageUrl: null, sourceUrl: 'https://detail.zol.com.cn/1/9/param.shtml', dataSource: 'zol', specs: {}, referencePriceCents: 389900 };
  await writeFile(join(directory, 'zol-catalog.json'), JSON.stringify({ items: [item], attribution: { name: 'z' } }));
  await writeFile(join(directory, 'zol-price-history.jsonl'), [
    { id: 'zol-9', cents: 419900, previousCents: 419900, at: '2026-11-17T00:00:00.000Z' },
    { id: 'zol-9', cents: 379900, previousCents: 419900, at: '2026-11-20T00:00:00.000Z' },
    { id: 'zol-9', cents: 389900, previousCents: 379900, at: '2026-11-24T00:00:00.000Z' },
  ].map(e => JSON.stringify(e)).join('\n') + '\nnot json\n');
  const request = await listen(t, directory);
  const { data } = await request('/catalog/zol-9');
  assert.deepEqual(data.priceTrend, { previousCents: 379900, changedAt: '2026-11-24T00:00:00.000Z', lowestCents: 379900,
    since: '2026-11-17T00:00:00.000Z', points: 3 });
});
