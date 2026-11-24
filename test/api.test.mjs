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
  const concurrent = await Promise.all([request(path, 'PUT', update), anotherServer(path, 'PUT', update)]);
  assert.deepEqual(concurrent.map(result => result.status).sort(), [200, 409]);
  assert.equal(concurrent.find(result => result.status === 200).data.totals.remainingCents, -94400);
  assert.equal((await request(path, 'DELETE', { version: 3 })).status, 204);
  assert.equal((await request(path)).status, 404);
});

test('草稿跨服务恢复，两份服务同时保存不会覆盖，备份恢复跳过现有方案', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pc-draft-test-'));
  const request = await listen(t, directory);
  const another = await listen(t, directory);
  t.after(async () => {
    for (const name of await readdir(directory)) await unlink(join(directory, name));
    await rmdir(directory);
  });

  assert.equal((await request('/draft')).data.draft, null);
  const creations = await Promise.all([
    request('/builds', 'POST', { name: '桌面' }),
    another('/builds', 'POST', { name: '网页' }),
  ]);
  assert.deepEqual(creations.map(result => result.status), [201, 201]);
  assert.equal((await request('/builds')).data.items.length, 2);
  const [one, two] = creations.map(result => result.data);
  const draft = { build: { ...one, name: '待保存的修改' }, serverId: one.id, version: one.version };
  assert.equal((await request('/draft', 'PUT', draft)).status, 204);
  const reopened = await listen(t, directory);
  const restored = (await reopened('/draft')).data.draft;
  assert.equal(restored.build.name, '待保存的修改');
  assert.equal(restored.serverId, one.id);
  assert.equal(restored.version, one.version);
  assert.equal((await reopened('/builds/' + one.id)).data.name, '桌面');
  assert.equal((await reopened('/draft', 'PUT', { build: draft.build, serverId: 'bad', version: 1 })).status, 400);

  const backup = (await request('/builds/backup')).data;
  assert.equal(backup.builds.length, 2);
  assert.equal((await request('/builds/' + two.id, 'DELETE', { version: two.version })).status, 204);
  assert.deepEqual((await reopened('/builds/backup', 'POST', backup)).data, { restored: 1, skipped: 1 });
  assert.equal((await request('/builds/' + two.id)).data.name, '网页');
  assert.equal((await reopened('/builds/backup', 'POST', { format: 1, builds: [{ ...one, slots: [] }] })).status, 400);
  assert.equal((await request('/builds')).data.items.length, 2);
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

test('目录先过滤兼容性再分页，缺规格和无价格的型号仍可查询', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pc-fit-test-'));
  t.after(async () => {
    for (const name of await readdir(directory)) await unlink(join(directory, name));
    await rmdir(directory);
  });
  const records = [['conflict-a', 'AM4', 10], ['conflict-b', 'AM4', 20], ['pass-a', 'AM5', 30],
    ['unknown', null, 40], ['pass-unpriced', 'AM5', null]].map(([id, socket, price]) => ({
    id: 'zol-' + id, category: 'MOTHERBOARD', manufacturer: 'Test', mpn: id, name: id,
    aliases: [], specs: socket ? { socket } : {}, referencePriceCents: price === null ? null : price * 100, dataSource: 'zol',
  }));
  await writeFile(join(directory, 'zol-catalog.json'), JSON.stringify({ items: records }));
  const request = await listen(t, directory);
  const params = new URLSearchParams({ category: 'MOTHERBOARD', market: 'cn', sort: 'price',
    limit: '1', fit: JSON.stringify({ socket: 'AM5' }) });
  const page = await request('/catalog?' + params);
  assert.equal(page.status, 200);
  assert.equal(page.data.items[0].id, 'zol-pass-a');
  assert.equal(page.data.items[0].compatibility, 'pass');
  params.set('offset', '1');
  assert.equal((await request('/catalog?' + params)).data.items[0].compatibility, 'unknown');
  params.set('showConflicts', '1');
  assert.equal((await request('/catalog?' + params)).data.items[0].compatibility, 'conflict');
  params.set('q', 'pass-unpriced');
  params.set('offset', '0');
  const unpriced = (await request('/catalog?' + params)).data.items[0];
  assert.equal(unpriced.id, 'zol-pass-unpriced');
  assert.equal(unpriced.estimatedPriceCents, undefined);
  params.set('fit', JSON.stringify({ minPsuWatts: 500 }));
  assert.equal((await request('/catalog?' + params)).status, 400);
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

test('本地商品图：只提供 data/images 下合法文件名，非法路径 404', async t => {
  const request = await listen(t);
  assert.equal((await request('/images/not-exist.jpg')).status, 404);
  assert.equal((await request('/images/..%2Fcatalog.json')).status, 404);
});

async function estimateFixture(t, priced, unpriced) {
  const directory = await mkdtemp(join(tmpdir(), 'pc-catalog-filters-'));
  t.after(async () => {
    for (const file of await readdir(directory)) await unlink(join(directory, file));
    await rmdir(directory);
  });
  const common = { manufacturer: 'Test', mpn: null, partNumbers: [], aliases: [], summary: '',
    imageUrl: null, sourceUrl: 'https://example.com/product' };
  await Promise.all([
    writeFile(join(directory, 'zol-catalog.json'), JSON.stringify({
      items: priced.map(item => ({ ...common, ...item, dataSource: 'zol' })),
    })),
    writeFile(join(directory, 'buildcores-catalog.json'), JSON.stringify({
      items: unpriced.map(item => ({ ...common, ...item, dataSource: 'buildcores' })),
    })),
  ]);
  return listen(t, directory);
}

test('CPU 补价只用完全相同的型号键，未知型号和不同后缀不匹配', async t => {
  const cpu = (id, name, referencePriceCents) => ({ id, name, referencePriceCents, category: 'CPU', specs: {} });
  const request = await estimateFixture(t, [
    cpu('zol-exact', 'Intel Core i5 14600K', 139900),
    cpu('zol-unknown', 'Example Processor', 200000),
    cpu('zol-unknown-2', 'Example Processor B', 210000),
    cpu('zol-unknown-3', 'Example Processor C', 230000),
  ], [
    cpu('buildcores-same', 'Intel 酷睿 i5-14600K'),
    cpu('buildcores-kf', 'Intel Core i5-14600KF'),
    cpu('buildcores-unknown', 'Example Processor'),
  ]);
  const { data: matching } = await request('/catalog/buildcores-same');
  assert.deepEqual([matching.estimatedPriceCents, matching.estimateBasis, matching.estimateSamples], [139900, 'model', 1]);
  for (const id of ['buildcores-kf', 'buildcores-unknown']) {
    assert.equal((await request('/catalog/' + id)).data.estimatedPriceCents, undefined);
  }
});

test('同规格估价规范化容量和能效，过滤过低样本，至少保留三件', async t => {
  const part = (id, category, specs, referencePriceCents) => ({ id, name: id, category, specs, referencePriceCents });
  const ddr5 = { memoryType: 'DDR5', capacityGB: 32, modules: 2 };
  const ssd = (capacityGB, connection) => ({ capacityGB, interface: connection });
  const psu = (ratedWatts, efficiency) => ({ ratedWatts, efficiency });
  const request = await estimateFixture(t, [
    ...[10000, 39100, 45600, 51900].map((p, i) => part('zol-ram-' + i, 'RAM', ddr5, p)),
    ...[20000, 38900, 39900].map((p, i) => part('zol-ram-small-' + i, 'RAM', { ...ddr5, modules: 1 }, p)),
    part('zol-psu-1', 'PSU', psu(749, '金牌'), 45800),
    part('zol-psu-2', 'PSU', psu(750, '80+ Gold'), 50300),
    part('zol-psu-3', 'PSU', psu(760, '80 Plus Gold'), 58000),
    part('zol-ssd-1', 'SSD', ssd(1000, 'M.2 PCIe 4.0'), 46800),
    part('zol-ssd-2', 'SSD', ssd(1024, 'PCIe Gen 4 x4'), 52500),
    part('zol-ssd-3', 'SSD', ssd(1024, 'PCI-E 4.0'), 55000),
  ], [
    part('buildcores-ram', 'RAM', ddr5),
    part('buildcores-single', 'RAM', { ...ddr5, modules: 1 }),
    part('buildcores-psu', 'PSU', psu(751, '80+ Gold')),
    part('buildcores-unknown-psu', 'PSU', psu(750, undefined)),
    part('buildcores-ssd', 'SSD', ssd(1024, 'PCIe4.0 x4')),
    part('buildcores-sata', 'SSD', ssd(1024, 'SATA 6Gbps')),
    part('buildcores-unknown-ssd', 'SSD', ssd(1024, 'NVMe')),
  ]);
  for (const [id, price] of [['ram', 46000], ['psu', 50000], ['ssd', 53000]]) {
    const { data } = await request('/catalog/buildcores-' + id);
    assert.deepEqual([data.estimatedPriceCents, data.estimateBasis, data.estimateSamples], [price, 'spec-median', 3]);
  }
  for (const id of ['single', 'unknown-psu', 'sata', 'unknown-ssd']) {
    assert.equal((await request('/catalog/buildcores-' + id)).data.estimatedPriceCents, undefined);
  }
  assert.equal((await request('/catalog/zol-ram-0')).data.estimatedPriceCents, 10000);
});

test('目录按市场筛选，自动方案与推荐只使用国内条目', async t => {
  const cpu = { name: 'AMD Ryzen 5 7500F', category: 'CPU', specs: { socket: 'AM5' } };
  const request = await estimateFixture(t, [
    { ...cpu, id: 'zol-domestic', referencePriceCents: 110000 },
    { id: 'zol-merge', name: '海外条目合并 ZOL', category: 'RAM', specs: {}, mpn: 'MERGE-001' },
  ], [
    { ...cpu, id: 'buildcores-priced', partNumbers: [] },
    { id: 'buildcores-merge', name: 'BuildCores 内存', category: 'RAM', specs: {},
      mpn: 'MERGE-001', partNumbers: ['MERGE-001'] },
    { id: 'buildcores-official', name: '全球官网型号', category: 'GPU', specs: {},
      manufacturer: 'ASUS', partNumbers: ['DUAL-RTX5060TI-O16G'] },
  ]);
  const { data: domestic } = await request('/catalog?market=cn');
  const { data: global } = await request('/catalog?market=global');
  const { data: all } = await request('/catalog');
  assert.equal(domestic.total + global.total, all.total);
  assert.ok(domestic.items.every(item => item.market === 'cn'));
  assert.ok(domestic.items.some(item => item.id === 'amd-ryzen-7-9700x'));
  assert.equal(domestic.items.find(item => item.id === 'buildcores-merge').zolId, 'zol-merge');
  assert.equal(domestic.items.find(item => item.id === 'asus-dual-rtx5060ti-o16g').dataSource, 'buildcores');
  assert.deepEqual(global.items.map(item => [item.id, item.market, item.estimateBasis]),
    [['buildcores-priced', 'global', 'model']]);
  assert.equal((await request('/catalog?market=invalid')).status, 400);
  const input = { budgetCents: 800000, scenarios: ['2k'] };
  const plans = await request('/plans', 'POST', input);
  assert.equal(plans.status, 200);
  const planPicks = plans.data.plans.flatMap(plan => plan.picks);
  const recommendation = await request('/recommend', 'POST', input);
  for (const picks of [planPicks, recommendation.data.picks]) {
    assert.ok(picks.some(pick => pick.item.id === 'zol-domestic'));
    assert.ok(picks.every(pick => pick.item.market === 'cn'));
  }
});
