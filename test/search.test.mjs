import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, unlink, rmdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BraveSearch } from '../src/search.mjs';
import { parseTarget } from '../src/normalization.mjs';

async function temporary(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pc-pricing-test-'));
  t.after(async () => {
    // Only unlink files inside this freshly created test directory; no recursive delete.
    for (const name of await readdir(directory)) await unlink(path.join(directory, name));
    await rmdir(directory);
  });
  return directory;
}
const target = parseTarget('CPU', '9700X 盒装');
const result = () => new Response(JSON.stringify({ web: { results: [{ title: 'AMD 9700X 盒装', url: 'https://item.jd.com/123.html', description: '¥1729' }] } }));

test('缓存命中不调用API，过期后重新请求；密钥不写入磁盘', async t => {
  const directory = await temporary(t); let calls = 0, now = Date.now();
  const search = new BraveSearch({ directory, apiKey: 'synthetic-test-key', now: () => now,
    unitCost: 0.005, fetchFn: async (url, options) => {
      calls++; assert.equal(url.hostname, 'api.search.brave.com');
      assert.equal(options.headers['X-Subscription-Token'], 'synthetic-test-key'); return result();
    } });
  const first = await search.search(target); assert.equal(first.attemptedRequests, 1);
  const second = await search.search(target); assert.equal(second.cached, true); assert.equal(second.attemptedRequests, 0);
  assert.equal(calls, 1); now += 61 * 60000;
  await search.search(target); assert.equal(calls, 2);
  for (const name of await readdir(directory)) assert.equal((await readFile(path.join(directory, name), 'utf8')).includes('synthetic-test-key'), false);
});

test('相同并发查询合并为一次请求', async t => {
  const directory = await temporary(t); let calls = 0;
  const search = new BraveSearch({ directory, apiKey: 'test', fetchFn: async () => { calls++; return result(); } });
  await Promise.all([search.search(target), search.search(target), search.search(target)]);
  assert.equal(calls, 1);
});

test('失败尝试计入限额，达到上限后不再发送网络请求', async t => {
  const directory = await temporary(t); let calls = 0;
  const search = new BraveSearch({ directory, apiKey: 'test', dailyLimit: 1,
    fetchFn: async () => { calls++; return new Response('', { status: 429 }); } });
  await assert.rejects(search.search(target), /429/);
  await assert.rejects(search.search(target), /上限/);
  assert.equal(calls, 1);
});

test('未知单价不伪造零成本，地区与规格不同不复用搜索缓存', async t => {
  const directory = await temporary(t); let calls = 0;
  const search = new BraveSearch({ directory, apiKey: 'test', unitCost: null, fetchFn: async () => { calls++; return result(); } });
  const first = await search.search(target); assert.equal(first.estimatedGrossUsd, null);
  await search.search(parseTarget('CPU', '9700X 散片')); assert.equal(calls, 2);
});

test('独立客户端共享限额，跨进程锁保护预留计数', async t => {
  const directory = await temporary(t); let calls = 0;
  const options = { directory, apiKey: 'test', dailyLimit: 1, fetchFn: async () => { calls++; return result(); } };
  const a = new BraveSearch(options), b = new BraveSearch(options);
  const outcomes = await Promise.allSettled([a.search(target), b.search(parseTarget('CPU', '9600X'))]);
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1); assert.equal(calls, 1);
});

test('没有密钥时不发送请求，不扣额度；错误配置立即报错', async t => {
  const directory = await temporary(t);
  const search = new BraveSearch({ directory, apiKey: '', fetchFn: async () => { assert.fail('不应联网'); } });
  await assert.rejects(search.search(target), /BRAVE_SEARCH_API_KEY/);
  assert.deepEqual(await readdir(directory), []);
  for (const options of [{ ttlMinutes: 0 }, { dailyLimit: NaN }, { unitCost: -1 }]) assert.throws(() => new BraveSearch(options));
});
