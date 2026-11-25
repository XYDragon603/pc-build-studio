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

test('外设是可选槽位：可以保存，单独计价，不占主机预算', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pc-api-test-'));
  const request = await listen(t, directory);
  t.after(async () => {
    for (const name of await readdir(directory)) await unlink(join(directory, name));
    await rmdir(directory);
  });
  const demo = (await request('/builds', 'POST', { preset: 'demo' })).data;
  const input = { name: demo.name, budgetCents: demo.budgetCents, scenarios: demo.scenarios, slots: [
    ...demo.slots,
    { id: 'MONITOR', label: '显示器', locked: false, part: { model: 'AOC Q27G40E', priceCents: 109900, priceSource: 'estimate', specs: {} } },
    { id: 'MOUSE', label: '鼠标', locked: false, part: { model: '罗技 G304', priceCents: 22900, priceSource: 'estimate', specs: {} } },
  ] };
  const saved = (await request('/builds/' + demo.id, 'PUT', { ...input, version: demo.version })).data;
  assert.equal(saved.slots.find(slot => slot.id === 'MONITOR').label, '显示器');
  assert.deepEqual([saved.totals.totalCents, saved.totals.peripheralCents, saved.totals.grandTotalCents, saved.totals.remainingCents],
    [394400, 132800, 527200, 405600]);
  assert.equal(saved.totals.filledStandardSlots, demo.totals.filledStandardSlots);
  // 外设类目没有兼容条件：配件库照常带 fit={} 查询，不报错；带了条件才报错
  assert.equal((await request('/catalog?category=MONITOR&fit=%7B%7D')).status, 200);
  assert.equal((await request('/catalog?category=MOUSE&fit=' + encodeURIComponent('{"socket":"AM5"}'))).status, 400);
  // 不带外设的旧方案照样能保存
  assert.equal((await request('/builds', 'POST', { ...input, slots: demo.slots })).status, 201);
  // 外设 ID 也不能重复
  assert.equal((await request('/builds', 'POST', { ...input, slots: [...input.slots, input.slots.at(-1)] })).status, 400);
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
  // 细分组凑不齐样本的，退到同类粗估（同容量内存、同功率电源、同容量固态）
  for (const id of ['single', 'unknown-psu', 'sata', 'unknown-ssd']) {
    assert.equal((await request('/catalog/buildcores-' + id)).data.estimateBasis, 'class-median');
  }
  // 同规格 4 个样本里低于中位价 60% 的参考价视为旧价：保留原参考价，估算价改用同规格中位价
  const { data: stale } = await request('/catalog/zol-ram-0');
  assert.deepEqual([stale.referencePriceCents, stale.estimatedPriceCents, stale.estimateBasis, stale.possiblyStale], [10000, 46000, 'spec-median', true]);
  assert.equal((await request('/catalog/zol-ram-1')).data.possiblyStale, undefined);
});

test('同类粗估：主板按芯片组、机箱按尺寸、显卡按芯片（忽略显存），系列起价不进自动方案', async t => {
  const part = (id, category, specs, extra = {}) => ({ id, name: id, category, specs, ...extra });
  const board = (formFactor, p, i) => part('zol-b650-' + i, 'MOTHERBOARD', { chipset: 'AMD B650', formFactor, socket: 'AM5' }, { referencePriceCents: p });
  const request = await estimateFixture(t, [
    board('Micro ATX', 80000, 1), board('Micro-ATX', 90000, 2), board('Micro ATX', 100000, 3), board('ATX', 150000, 4),
    ...[20000, 30000, 40000].map((p, i) => part('zol-case-' + i, 'CASE', { maxBoardFormFactor: 'ATX' }, { referencePriceCents: p })),
    part('zol-3080', 'GPU', { chipset: 'GeForce RTX 3080', capacityGB: 10 }, { referencePriceCents: 350000 }),
    part('zol-ssd-series', 'SSD', { capacityGB: 960, interface: 'SATA' }, { priceRangeCents: [36900, 200900] }),
  ], [
    part('buildcores-b650m', 'MOTHERBOARD', { chipset: 'AMD B650', formFactor: 'Micro ATX' }),
    part('buildcores-b650-itx', 'MOTHERBOARD', { chipset: 'AMD B650', formFactor: 'Mini ITX' }),
    part('buildcores-case', 'CASE', { formFactor: 'ATX Mid Tower' }),
    part('buildcores-3080', 'GPU', { chipset: 'GeForce RTX 3080 10 GB', capacityGB: 10 }),
  ]);
  const basis = async id => { const { data } = await request('/catalog/' + id); return [data.estimatedPriceCents, data.estimateBasis]; };
  assert.deepEqual(await basis('buildcores-b650m'), [90000, 'spec-median']);
  assert.deepEqual(await basis('buildcores-b650-itx'), [95000, 'class-median']);
  assert.deepEqual(await basis('buildcores-case'), [30000, 'class-median']);
  assert.deepEqual(await basis('buildcores-3080'), [350000, 'chip-median']);
  assert.deepEqual(await basis('zol-ssd-series'), [36900, 'series-low']);
  const plans = await request('/plans', 'POST', { budgetCents: 800000, scenarios: ['2k'] });
  assert.ok(plans.data.plans.flatMap(plan => plan.picks).every(pick => !['series-low', 'class-median'].includes(pick.item.estimateBasis)));
});

test('缺功耗时估算：显卡取同芯片 TDP 中位数，AMD 按 PPT，Intel 按同 TDP 中位数，并注明估算', async t => {
  const part = (id, name, category, specs) => ({ id, name, category, specs });
  const request = await estimateFixture(t, [
    part('zol-1650', '七彩虹 GTX 1650 4G', 'GPU', { chipset: 'GeForce GTX 1650', recommendedPsuWatts: 300 }),
    part('zol-4100', 'AMD Ryzen 3 4100', 'CPU', { tdpWatts: 65 }),
    part('zol-12400', 'Intel 酷睿 i5 12400', 'CPU', { tdpWatts: 65 }),
    part('zol-own', 'AMD Ryzen 5 7600', 'CPU', { tdpWatts: 65, maxPowerWatts: 88 }),
  ], [
    part('buildcores-1650a', 'GTX 1650 A', 'GPU', { chipset: 'GeForce GTX 1650 4 GB', tdpWatts: 75 }),
    part('buildcores-1650b', 'GTX 1650 B', 'GPU', { chipset: 'GeForce GTX 1650', tdpWatts: 75 }),
    part('buildcores-1650c', 'GTX 1650 C', 'GPU', { chipset: 'GeForce GTX 1650', tdpWatts: 90 }),
    part('buildcores-i5a', 'Intel Core i5-13400', 'CPU', { tdpWatts: 65, maxPowerWatts: 148 }),
    part('buildcores-i5b', 'Intel Core i5-14400', 'CPU', { tdpWatts: 65, maxPowerWatts: 148 }),
    part('buildcores-i5c', 'Intel Core i5-12500', 'CPU', { tdpWatts: 65, maxPowerWatts: 117 }),
  ]);
  const get = async id => (await request('/catalog/' + id)).data;
  assert.deepEqual([(await get('zol-1650')).specs.tdpWatts, (await get('zol-1650')).estimatedSpecs], [75, ['tdpWatts']]);
  assert.deepEqual([(await get('zol-4100')).specs.maxPowerWatts, (await get('zol-4100')).estimatedSpecs], [88, ['maxPowerWatts']]);
  assert.equal((await get('zol-12400')).specs.maxPowerWatts, 148);
  const own = await get('zol-own');
  assert.deepEqual([own.specs.maxPowerWatts, own.estimatedSpecs], [88, undefined]);
});

test('笔记本 CPU、手机存储芯片不进目录；服务器 / 工作站 CPU 标注出来', async t => {
  const cpu = (id, name) => ({ id, name, category: 'CPU', specs: {}, referencePriceCents: 100000 });
  const request = await estimateFixture(t, [
    cpu('zol-h', 'Intel 酷睿 i7 13700H'), cpu('zol-hx', 'Intel 酷睿 i5 14500HX'), cpu('zol-p', 'Intel 酷睿 i7 1360P'),
    cpu('zol-u', 'Intel 酷睿 i5 1334U'), cpu('zol-amd-h', 'AMD Ryzen 7 7735H'), cpu('zol-ultra-h', 'Intel Core Ultra 7 155H'),
    cpu('zol-desk', 'Intel 酷睿 i7 13700'), cpu('zol-old-p', 'Intel Core i5 6402P'), cpu('zol-ks', 'Intel 酷睿 i9 13900KS'),
    cpu('zol-tr', 'AMD Ryzen Threadripper 7980X'),
    { id: 'zol-ufs', name: '长江存储UC341', category: 'SSD', specs: { interface: 'UFS3.1', capacityGB: 256 }, referencePriceCents: 20000 },
  ], []);
  const ids = async category => (await request(`/catalog?category=${category}&limit=100`)).data.items.map(i => i.id).filter(id => id.startsWith('zol-')).sort();
  assert.deepEqual(await ids('CPU'), ['zol-desk', 'zol-ks', 'zol-old-p', 'zol-tr']);
  assert.deepEqual(await ids('SSD'), []);
  assert.equal((await request('/catalog/zol-tr')).data.workstation, true);
  assert.equal((await request('/catalog/zol-desk')).data.workstation, undefined);
});

test('内存按频率档分组：DDR5 4800 不和 6000 比价，不会被误判为旧价', async t => {
  const kit = (id, speedMTs, price) => ({ id, name: id, category: 'RAM', specs: { memoryType: 'DDR5', capacityGB: 32, modules: 2, speedMTs }, referencePriceCents: price });
  const request = await estimateFixture(t, [
    kit('zol-4800-a', 4800, 48000), kit('zol-4800-b', 4800, 50000), kit('zol-4800-c', 4800, 52000), kit('zol-4800-d', 4800, 51000),
    kit('zol-6000-a', 6000, 85000), kit('zol-6000-b', 6000, 90000), kit('zol-6000-c', 6000, 92000), kit('zol-6000-d', 6000, 88000),
    kit('zol-6000-old', 6000, 47900),
  ], [kit('buildcores-6400', 6400, undefined)]);
  const get = async id => (await request('/catalog/' + id)).data;
  // 混在一起时中位价约 ¥850，¥480 的 4800 套条会被当成旧价；分档后不会
  assert.equal((await get('zol-4800-a')).possiblyStale, undefined);
  assert.equal((await get('zol-6000-old')).possiblyStale, true);
  // 6000–6400 同档估价
  assert.deepEqual([(await get('buildcores-6400')).estimatedPriceCents, (await get('buildcores-6400')).estimateBasis], [89000, 'spec-median']);
});

test('输入联想：模糊匹配型号、中英文品牌互通，按匹配度排序', async t => {
  const part = (id, name, extra = {}) => ({ id, name, category: 'GPU', specs: {}, referencePriceCents: 300000, ...extra });
  const request = await estimateFixture(t, [
    part('zol-a', '华硕 DUAL GeForce RTX 5060 Ti 16G', { manufacturer: '华硕' }),
    part('zol-b', '七彩虹 战斧 GeForce RTX 5060 8G'),
    part('zol-c', 'MSI GeForce RTX 5070 Ventus'),
  ], []);
  const names = async q => (await request('/catalog/suggest?category=GPU&q=' + encodeURIComponent(q))).data.items.map(i => i.id);
  assert.equal((await names('5060ti'))[0], 'zol-a');
  assert.ok((await names('asus 5060')).includes('zol-a'));
  assert.ok((await names('微星')).includes('zol-c'));
  assert.ok((await names('5060七彩虹')).includes('zol-b'));
  // 漏字也能找到：rtx5o7 → 按顺序出现的字符
  assert.ok((await names('rtx507ven')).includes('zol-c'));
  assert.deepEqual(await names('   '), []);
  assert.equal((await request('/catalog/suggest?category=XX&q=a')).status, 400);
  assert.equal((await request('/catalog/suggest?q=a', 'POST', {})).status, 405);
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
