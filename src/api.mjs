import { createServer } from 'node:http';
import { ApiError, invalid } from './api-error.mjs';
import { BuildRepository, buildTemplate, calculateBuild, normalizeDraft, slotTypes } from './builds.mjs';
import { merchantUrl, parseTarget } from './normalization.mjs';
import { replayQuotes, searchQuotes } from './quotes.mjs';
import { BraveSearch } from './search.mjs';
import { LocalStore } from './store.mjs';
import { createCatalog } from './catalog.mjs';
import { PERIPHERAL_SLOTS, recommendPeripherals } from './peripherals.mjs';
import { JdUnion } from './jdunion.mjs';
import { recommend, recommendPlans, SLOTS as RECOMMEND_SLOTS } from './recommend.mjs';
import { applyPriceMode, parseCsv, PriceStore, toCsv } from './prices.mjs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

const localHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);
const bodyLimit = 64 * 1024;
const methods = 'GET, POST, PUT, DELETE, OPTIONS';
const buildPath = /^\/api\/v1\/builds\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/;
const catalogPath = /^\/api\/v1\/catalog\/([a-z0-9-]{1,120})$/;
const pricePath = /^\/api\/v1\/prices\/([a-z0-9-]{8,64})$/;

/** 价格模式参数：estimate = 参考估算（默认），manual = 优先我的价格 */
function priceOptions({ priceMode = 'estimate', allowUsed = false }) {
  if (!['estimate', 'manual'].includes(priceMode)) throw invalid('priceMode 只能是 estimate 或 manual');
  if (typeof allowUsed !== 'boolean') throw invalid('allowUsed 必须为布尔值');
  return { mode: priceMode, allowUsed };
}

function localAddress(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && localHosts.has(url.hostname)
      && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash;
  } catch { return false; }
}

function json(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(data));
}

async function readJson(request, maxBytes = bodyLimit) {
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', '请求必须使用 application/json');
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      request.resume();
      throw new ApiError(413, 'BODY_TOO_LARGE', '请求体超过允许的大小');
    }
    chunks.push(chunk);
  }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw invalid('请求体不是有效的 JSON'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw invalid('请求体必须为 JSON 对象');
  return data;
}

function quoteForClient(result) {
  const { title, category, model, capacityGB, priceCents, currency, observedAt, sku,
    status, autoEligible, reasonCodes, reasons, method, url } = result;
  return { title, category, model, capacityGB, priceCents, currency, observedAt, sku,
    status, autoEligible, reasonCodes, reasons, method, url: merchantUrl(url) };
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2' };

/** 提供前端构建产物（web/dist）；找不到的路径回到 index.html。只允许读 staticDir 之内的文件 */
async function serveStatic(staticDir, pathname, response) {
  const safe = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  // 去掉结尾分隔符再比较，否则“dist/”会变成“dist\\”前缀，所有文件都回落成 index.html
  const root = normalize(staticDir).replace(/[\\/]+$/, '');
  let file = join(root, safe || 'index.html');
  if (!file.startsWith(root + sep)) file = join(root, 'index.html');
  let body;
  try { body = await readFile(file); }
  catch { file = join(root, 'index.html'); body = await readFile(file); }
  response.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'X-Content-Type-Options': 'nosniff',
    'Cache-Control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable' });
  response.end(body);
}

/** 锁定的配件（硬约束）：{ CPU: { priceCents, specs, name? } … } */
function parseLocked(locked) {
  if (!locked || typeof locked !== 'object' || Array.isArray(locked)) throw invalid('locked 必须为对象');
  const lockedParts = {};
  for (const [slot, part] of Object.entries(locked)) {
    if (!RECOMMEND_SLOTS.includes(slot)) throw invalid('locked 只能包含标准槽位');
    if (!part || typeof part !== 'object' || (part.priceCents != null && !Number.isSafeInteger(part.priceCents))) throw invalid('locked 配件格式无效');
    if (part.name != null && (typeof part.name !== 'string' || part.name.length > 160)) throw invalid('locked 配件名称无效');
    lockedParts[slot] = { priceCents: part.priceCents ?? 0, specs: part.specs && typeof part.specs === 'object' ? part.specs : {}, name: part.name ?? '' };
  }
  return lockedParts;
}

/** 自动配置只用较可靠的价格：系列起价、同类粗估、疑似旧价不参与；服务器 / 工作站 CPU 也不选 */
const forPlans = item => item.market === 'cn' && !item.possiblyStale && !item.workstation
  && item.estimateBasis !== 'series-low' && item.estimateBasis !== 'class-median';

export function createApiServer({ directory, catalogDirectory = directory, staticDir = null,
  provider = new BraveSearch(), inspect, jdUnion = new JdUnion({ directory }), onError = console.error } = {}) {
  const store = new LocalStore(directory);
  const builds = new BuildRepository(store);
  const catalog = createCatalog(catalogDirectory);
  const prices = new PriceStore(store);
  let knownIds = null;
  const catalogIds = () => (knownIds ??= new Set(catalog.all().map(item => item.id)));
  /** 按价格模式取自动配置用的配件（先套用户价格，再筛可靠价格） */
  const planItems = async options => applyPriceMode(catalog.all(), options.mode === 'manual' ? await prices.list() : [], options).filter(forPlans);
  let liveRequests = 0;

  const server = createServer({ requestTimeout: 30000, headersTimeout: 10000 }, async (request, response) => {
    try {
      if (!localAddress('http://' + request.headers.host)) {
        throw new ApiError(403, 'HOST_NOT_ALLOWED', '请使用本机地址访问');
      }
      const origin = request.headers.origin;
      if (origin && !localAddress(origin)) throw new ApiError(403, 'ORIGIN_NOT_ALLOWED', '仅接受本地前端请求');
      if (origin) {
        response.setHeader('Access-Control-Allow-Origin', origin);
        response.setHeader('Vary', 'Origin');
      }
      if (!request.url?.startsWith('/') || request.url.startsWith('//')) throw invalid('请求路径无效');
      const url = new URL(request.url, 'http://localhost');
      const { pathname } = url;
      const method = request.method;
      const singleBuild = buildPath.exec(pathname);
      const singleProduct = catalogPath.exec(pathname);

      if (method === 'OPTIONS' && pathname.startsWith('/api/v1/')) {
        response.writeHead(204, { 'Access-Control-Allow-Methods': methods, 'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '600' }).end();
        return;
      }
      if (pathname === '/api/v1/health' && method === 'GET') {
        const liveConfigured = Boolean(provider.apiKey?.trim());
        return json(response, 200, { status: 'ok', apiVersion: 'v1', currency: 'CNY',
          quotes: { liveConfigured, modes: ['replay', 'live'], categories: ['CPU', 'GPU'], jdUnionConfigured: jdUnion.configured } });
      }
      if (pathname === '/api/v1/slot-types' && method === 'GET') return json(response, 200, { items: slotTypes });
      if (pathname === '/api/v1/catalog' && method === 'GET') {
        const result = catalog.list(url.searchParams);
        if (url.searchParams.get('priceMode') !== 'manual') return json(response, 200, result);
        const options = priceOptions({ priceMode: 'manual', allowUsed: url.searchParams.get('allowUsed') === 'true' });
        return json(response, 200, { ...result, items: applyPriceMode(result.items, await prices.list(), options) });
      }
      // 价格记录（与规格分开存放）：列表、新增、删除、导入、导出
      if (pathname === '/api/v1/prices' && method === 'GET') {
        const records = await prices.list();
        const id = url.searchParams.get('componentId');
        return json(response, 200, { records: id ? records.filter(r => r.componentId === id) : records });
      }
      if (pathname === '/api/v1/prices' && method === 'POST') {
        const input = await readJson(request);
        if (!catalogIds().has(String(input.componentId ?? ''))) throw invalid('配件库里没有这个配件');
        return json(response, 201, await prices.add(input));
      }
      if (pathname === '/api/v1/prices/export' && method === 'GET') {
        const records = await prices.list();
        if (url.searchParams.get('format') === 'csv') {
          response.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
            'Content-Disposition': 'attachment; filename="prices.csv"' });
          response.end('﻿' + toCsv(records));
          return;
        }
        return json(response, 200, { version: 1, exportedAt: new Date().toISOString(), records });
      }
      if (pathname === '/api/v1/prices/import' && method === 'POST') {
        const { format, content } = await readJson(request, 4 * 1024 ** 2);
        if (typeof content !== 'string' || !content.trim()) throw invalid('content 不能为空');
        let rows;
        if (format === 'csv') rows = parseCsv(content);
        else if (format === 'json') {
          let data;
          try { data = JSON.parse(content); } catch { throw invalid('JSON 格式无效'); }
          rows = Array.isArray(data) ? data : data?.records;
          if (!Array.isArray(rows)) throw invalid('JSON 需为记录数组，或带 records 数组的对象');
        } else throw invalid('format 只能是 csv 或 json');
        if (rows.length > 5000) throw invalid('一次最多导入 5000 条');
        return json(response, 200, await prices.importRecords(rows, catalogIds()));
      }
      const singlePrice = pricePath.exec(pathname);
      if (singlePrice && method === 'DELETE') {
        if (!(await prices.remove(singlePrice[1]))) throw new ApiError(404, 'PRICE_NOT_FOUND', '没有这条价格记录');
        response.writeHead(204).end();
        return;
      }
      if (pathname === '/api/v1/catalog/suggest' && method === 'GET') return json(response, 200, catalog.suggest(url.searchParams));
      if (singleProduct && method === 'GET') return json(response, 200, catalog.get(singleProduct[1]));
      if (pathname === '/api/v1/templates/demo' && method === 'GET') return json(response, 200, calculateBuild(buildTemplate('demo')));
      if (pathname === '/api/v1/draft' && method === 'GET') return json(response, 200, { draft: await store.read('draft.json', null) });
      if (pathname === '/api/v1/draft' && method === 'PUT') {
        const draft = normalizeDraft(await readJson(request));
        await store.withLock('draft.lock', () => store.write('draft.json', draft));
        response.writeHead(204).end();
        return;
      }
      if (pathname === '/api/v1/builds/backup' && method === 'GET') return json(response, 200, await builds.backup());
      if (pathname === '/api/v1/builds/backup' && method === 'POST') {
        return json(response, 200, await builds.restore(await readJson(request, 16 * 1024 ** 2)));
      }
      if (pathname === '/api/v1/builds' && method === 'GET') return json(response, 200, { items: await builds.list() });
      if (pathname === '/api/v1/builds' && method === 'POST') {
        const build = await builds.create(await readJson(request));
        response.setHeader('Location', '/api/v1/builds/' + build.id);
        return json(response, 201, build);
      }
      if (singleBuild && method === 'GET') return json(response, 200, await builds.get(singleBuild[1]));
      if (singleBuild && method === 'PUT') return json(response, 200, await builds.replace(singleBuild[1], await readJson(request)));
      if (singleBuild && method === 'DELETE') {
        const { version } = await readJson(request);
        await builds.remove(singleBuild[1], version);
        response.writeHead(204).end();
        return;
      }
      if (pathname === '/api/v1/plans' && method === 'POST') {
        const { budgetCents, scenarios = [], peripherals = [], maxOverPercent = null, locked = {}, priceMode, allowUsed } = await readJson(request);
        const options = priceOptions({ priceMode, allowUsed });
        if (!Number.isSafeInteger(budgetCents) || budgetCents < 100000 || budgetCents > 100000000) throw invalid('budgetCents 需为 1000–1000000 元之间的整数分');
        if (!Array.isArray(scenarios) || scenarios.length > 8 || !scenarios.every(s => typeof s === 'string' && s.length <= 32)) throw invalid('scenarios 格式无效');
        if (!Array.isArray(peripherals) || !peripherals.every(slot => PERIPHERAL_SLOTS.includes(slot))) throw invalid('peripherals 只能包含 MONITOR、KEYBOARD、MOUSE');
        // null = 不限；0 = 严格预算；1–50 = 允许超出的百分比
        if (maxOverPercent !== null && (!Number.isInteger(maxOverPercent) || maxOverPercent < 0 || maxOverPercent > 50)) throw invalid('maxOverPercent 需为 0–50 的整数或 null');
        const items = await planItems(options);
        const plans = recommendPlans(items, { budgetCents, scenarios, maxOverPercent, locked: parseLocked(locked) });
        const priceMeta = { mode: options.mode, allowUsed: options.allowUsed, userPriced: items.filter(item => item.priceSource === 'user').length };
        if (!peripherals.length) return json(response, 200, { plans, priceMeta });
        // 外设不占主机预算：每套方案按自己的显卡和档位单独挑
        return json(response, 200, { plans: plans.map(plan => (plan.infeasible ? plan : { ...plan, peripherals: recommendPeripherals(items, {
          scenarios, tier: plan.id, igpu: plan.igpu, slots: peripherals,
          gpuIndex: plan.picks.find(pick => pick.slot === 'GPU')?.item.performance?.gaming?.index ?? null,
        }) })), priceMeta });
      }
      // data/images/ 下的本地商品图（data/part-images.json 引用）
      const imageMatch = /^\/api\/v1\/images\/([\w.-]+\.(?:jpe?g|png|webp|gif))$/i.exec(pathname);
      if (imageMatch && method === 'GET') {
        const file = new URL(`../data/images/${imageMatch[1]}`, import.meta.url);
        let body;
        try { body = await readFile(file); } catch { throw new ApiError(404, 'IMAGE_NOT_FOUND', '没有这张图片'); }
        const ext = extname(imageMatch[1]).toLowerCase();
        response.writeHead(200, { 'Content-Type': { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' }[ext],
          'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
        response.end(body);
        return;
      }
      if (staticDir && method === 'GET' && !pathname.startsWith('/api/')) {
        await serveStatic(staticDir, pathname, response);
        return;
      }
      if (pathname === '/api/v1/recommend' && method === 'POST') {
        const { budgetCents, scenarios = [], locked = {} } = await readJson(request);
        if (!Number.isSafeInteger(budgetCents) || budgetCents < 100000 || budgetCents > 100000000) throw invalid('budgetCents 需为 1000–1000000 元之间的整数分');
        if (!Array.isArray(scenarios) || scenarios.length > 8 || !scenarios.every(s => typeof s === 'string' && s.length <= 32)) throw invalid('scenarios 格式无效');
        return json(response, 200, recommend(catalog.all().filter(forPlans), { budgetCents, scenarios, locked: parseLocked(locked) }));
      }
      if (pathname === '/api/v1/quotes/jd' && method === 'POST') {
        const { skuIds } = await readJson(request);
        return json(response, 200, await jdUnion.lookup(skuIds));
      }
      if (pathname === '/api/v1/quotes/search' && method === 'POST') {
        const { category, query, mode = 'replay' } = await readJson(request);
        if (!['replay', 'live'].includes(mode)) throw invalid('mode 必须为 replay 或 live');
        let target;
        try { target = parseTarget(category, query); }
        catch (error) { throw invalid(error.message); }
        let report;
        if (mode === 'replay') report = await replayQuotes(target);
        else {
          if (liveRequests >= 2) throw new ApiError(429, 'SEARCH_BUSY', '已有查价任务正在处理，请稍后重试');
          liveRequests++;
          try { report = await searchQuotes(target, provider, inspect); }
          finally { liveRequests--; }
        }
        return json(response, 200, { ...report, target, results: report.results.map(quoteForClient) });
      }

      const allowed = singleBuild ? 'GET, PUT, DELETE' : pricePath.test(pathname) ? 'DELETE' : singleProduct && pathname !== '/api/v1/catalog/suggest' ? 'GET' : {
        '/api/v1/builds': 'GET, POST', '/api/v1/quotes/search': 'POST', '/api/v1/quotes/jd': 'POST', '/api/v1/recommend': 'POST', '/api/v1/plans': 'POST',
        '/api/v1/draft': 'GET, PUT', '/api/v1/builds/backup': 'GET, POST',
        '/api/v1/catalog': 'GET', '/api/v1/catalog/suggest': 'GET',
        '/api/v1/prices': 'GET, POST', '/api/v1/prices/export': 'GET', '/api/v1/prices/import': 'POST',
        '/api/v1/health': 'GET', '/api/v1/slot-types': 'GET', '/api/v1/templates/demo': 'GET',
      }[pathname];
      if (typeof allowed === 'string') {
        response.setHeader('Allow', allowed + ', OPTIONS');
        throw new ApiError(405, 'METHOD_NOT_ALLOWED', '此接口不支持该请求方法');
      }
      throw new ApiError(404, 'NOT_FOUND', '没有找到该接口');
    } catch (error) {
      if (response.destroyed || response.headersSent) return;
      if (error instanceof ApiError) return json(response, error.status, { error: { code: error.code, message: error.message } });
      onError(error);
      return json(response, 500, { error: { code: 'INTERNAL_ERROR', message: '服务处理请求失败' } });
    }
  });
  return server;
}
