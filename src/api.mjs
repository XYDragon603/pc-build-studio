import { createServer } from 'node:http';
import { ApiError, invalid } from './api-error.mjs';
import { BuildRepository, buildTemplate, calculateBuild, slotTypes } from './builds.mjs';
import { merchantUrl, parseTarget } from './normalization.mjs';
import { replayQuotes, searchQuotes } from './quotes.mjs';
import { BraveSearch } from './search.mjs';
import { LocalStore } from './store.mjs';
import { createCatalog } from './catalog.mjs';
import { JdUnion } from './jdunion.mjs';
import { recommend, SLOTS as RECOMMEND_SLOTS } from './recommend.mjs';

const localHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);
const bodyLimit = 64 * 1024;
const methods = 'GET, POST, PUT, DELETE, OPTIONS';
const buildPath = /^\/api\/v1\/builds\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/;
const catalogPath = /^\/api\/v1\/catalog\/([a-z0-9-]{1,120})$/;

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

async function readJson(request) {
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', '请求必须使用 application/json');
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > bodyLimit) {
      request.resume();
      throw new ApiError(413, 'BODY_TOO_LARGE', '请求体不能超过 64 KB');
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

export function createApiServer({ directory, catalogDirectory = directory,
  provider = new BraveSearch(), inspect, jdUnion = new JdUnion({ directory }), onError = console.error } = {}) {
  const builds = new BuildRepository(new LocalStore(directory));
  const catalog = createCatalog(catalogDirectory);
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
      if (pathname === '/api/v1/catalog' && method === 'GET') return json(response, 200, catalog.list(url.searchParams));
      if (singleProduct && method === 'GET') return json(response, 200, catalog.get(singleProduct[1]));
      if (pathname === '/api/v1/templates/demo' && method === 'GET') return json(response, 200, calculateBuild(buildTemplate('demo')));
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
      if (pathname === '/api/v1/recommend' && method === 'POST') {
        const { budgetCents, scenarios = [], locked = {} } = await readJson(request);
        if (!Number.isSafeInteger(budgetCents) || budgetCents < 100000 || budgetCents > 100000000) throw invalid('budgetCents 需为 1000–1000000 元之间的整数分');
        if (!Array.isArray(scenarios) || scenarios.length > 8 || !scenarios.every(s => typeof s === 'string' && s.length <= 32)) throw invalid('scenarios 格式无效');
        if (!locked || typeof locked !== 'object' || Array.isArray(locked)) throw invalid('locked 必须为对象');
        const lockedParts = {};
        for (const [slot, part] of Object.entries(locked)) {
          if (!RECOMMEND_SLOTS.includes(slot)) throw invalid('locked 只能包含标准槽位');
          if (!part || typeof part !== 'object' || (part.priceCents != null && !Number.isSafeInteger(part.priceCents))) throw invalid('locked 配件格式无效');
          lockedParts[slot] = { priceCents: part.priceCents ?? 0, specs: part.specs && typeof part.specs === 'object' ? part.specs : {} };
        }
        return json(response, 200, recommend(catalog.all(), { budgetCents, scenarios, locked: lockedParts }));
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

      const allowed = singleBuild ? 'GET, PUT, DELETE' : singleProduct ? 'GET' : {
        '/api/v1/builds': 'GET, POST', '/api/v1/quotes/search': 'POST', '/api/v1/quotes/jd': 'POST', '/api/v1/recommend': 'POST',
        '/api/v1/catalog': 'GET',
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
