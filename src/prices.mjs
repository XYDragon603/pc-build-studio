// 价格记录：与硬件规格分开存放的动态价格。
//
// 来源：
//   - 目录参考价：中关村在线列表页（catalog 里的 referencePriceCents，抓取时间 priceObservedAt；变价历史在 zol-price-history.jsonl）
//   - 用户记录：本文件管理，存 .runtime/prices.json（手动录入、CSV / JSON 导入）
// 没有合法可用的实时报价接口，这里不抓电商、不伪造实时价；以后接入经授权的数据源时，按同样的记录格式写入即可。
//
// 价格模式：
//   estimate  参考估算（默认）：用目录估算价
//   manual    优先我的价格：配件有有效的用户记录时用最新一条，否则用目录估算价
// 过期：目录参考价超过 14 天、用户记录超过 30 天未更新标记为过期（仍可使用，界面提示）。
import { randomUUID } from 'node:crypto';
import { invalid } from './api-error.mjs';

export const CONDITIONS = ['new', 'used', 'refurbished', 'old-stock', 'oem'];
export const STOCK = ['in_stock', 'out_of_stock', 'unknown'];
export const PRICE_TYPES = ['reference', 'verified', 'manual', 'estimate'];
export const CONDITION_LABELS = { new: '全新', used: '二手', refurbished: '翻新', 'old-stock': '库存旧货', oem: 'OEM / 拆机' };
export const TYPE_LABELS = { reference: '商品参考价', verified: '已核实商城报价', manual: '手动输入', estimate: '历史估算' };
export const STALE_DAYS = { catalog: 14, user: 30 };
const FILE = 'prices.json';
const DAY = 24 * 3600 * 1000;

/** 校验并规范一条价格记录（导入、新增都走这里） */
export function normalizeRecord(input, now = new Date()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('价格记录必须为对象');
  const componentId = String(input.componentId ?? '').trim();
  if (!/^[a-z0-9-]{1,120}$/.test(componentId)) throw invalid('componentId 无效');
  const priceCents = Number(input.priceCents);
  if (!Number.isSafeInteger(priceCents) || priceCents <= 0 || priceCents > 100000000) throw invalid('priceCents 需为 1–100000000 的整数（分）');
  const currency = String(input.currency ?? 'CNY').toUpperCase();
  if (currency !== 'CNY') throw invalid('目前只支持人民币（CNY）');
  const condition = input.condition ?? 'new';
  if (!CONDITIONS.includes(condition)) throw invalid(`condition 只能是 ${CONDITIONS.join('、')}`);
  const stockStatus = input.stockStatus ?? 'unknown';
  if (!STOCK.includes(stockStatus)) throw invalid(`stockStatus 只能是 ${STOCK.join('、')}`);
  const priceType = input.priceType ?? 'manual';
  if (!PRICE_TYPES.includes(priceType)) throw invalid(`priceType 只能是 ${PRICE_TYPES.join('、')}`);
  const sourceName = String(input.sourceName ?? '').trim().slice(0, 80) || (priceType === 'manual' ? '手动输入' : '');
  if (!sourceName) throw invalid('sourceName 不能为空');
  let sourceUrl = null;
  if (input.sourceUrl) {
    try {
      const u = new URL(String(input.sourceUrl));
      if (u.protocol !== 'https:' || u.username || u.password) throw new Error();
      sourceUrl = u.href.slice(0, 2048);
    } catch { throw invalid('sourceUrl 必须为 HTTPS 链接'); }
  }
  // 已核实商城报价必须带来源链接，才能复核
  if (priceType === 'verified' && !sourceUrl) throw invalid('已核实报价需要填写来源链接');
  const observedAt = input.observedAt ? new Date(input.observedAt) : now;
  if (Number.isNaN(observedAt.getTime()) || observedAt > now) throw invalid('价格观察时间无效或晚于当前时间');
  const quotedAt = input.quotedAt ? new Date(input.quotedAt) : null;
  if (quotedAt && (priceType !== 'verified' || Number.isNaN(quotedAt.getTime()) || quotedAt > observedAt)) {
    throw invalid('实际报价时间仅用于已核实报价，且须早于或等于观察时间');
  }
  const shippingCents = input.shippingCents == null || input.shippingCents === '' ? 0 : Number(input.shippingCents);
  if (!Number.isSafeInteger(shippingCents) || shippingCents < 0 || shippingCents > 1000000) throw invalid('shippingCents 无效');
  const confidence = input.confidence ?? (priceType === 'verified' ? 'high' : priceType === 'manual' ? 'medium' : 'low');
  if (!['high', 'medium', 'low'].includes(confidence)) throw invalid('confidence 只能是 high、medium、low');
  return {
    id: typeof input.id === 'string' && /^[a-z0-9-]{8,64}$/.test(input.id) ? input.id : randomUUID(),
    componentId, sku: input.sku ? String(input.sku).slice(0, 80) : null, priceCents, currency, sourceName, sourceUrl,
    observedAt: observedAt.toISOString(), recordedAt: now.toISOString(),
    quotedAt: quotedAt?.toISOString() ?? null,
    condition, stockStatus, shippingCents, priceType, confidence,
    note: input.note ? String(input.note).slice(0, 200) : '',
  };
}

/** 是否过期 */
export const isStale = (observedAt, kind, now = Date.now()) => !observedAt || now - new Date(observedAt).getTime() > STALE_DAYS[kind] * DAY;

export class PriceStore {
  constructor(store) { this.store = store; }
  async list() { return (await this.store.read(FILE, { records: [] })).records; }
  async add(input) {
    const record = normalizeRecord(input);
    return this.store.withLock('prices.lock', async () => {
      const records = await this.list();
      await this.store.write(FILE, { records: [...records.filter(r => r.id !== record.id), record] });
      return record;
    });
  }
  async remove(id) {
    return this.store.withLock('prices.lock', async () => {
      const records = await this.list();
      if (!records.some(r => r.id === id)) return false;
      await this.store.write(FILE, { records: records.filter(r => r.id !== id) });
      return true;
    });
  }
  /** 批量导入：逐行校验，有错误的行报告原因、不写入；合法的行一次写入 */
  async importRecords(rows, knownIds) {
    const ok = []; const errors = [];
    rows.forEach((row, index) => {
      try {
        const r = normalizeRecord(row);
        if (knownIds && !knownIds.has(r.componentId)) throw invalid(`配件库里没有 ${r.componentId}`);
        ok.push(r);
      } catch (error) { errors.push({ row: index + 1, message: error.message }); }
    });
    if (ok.length) {
      await this.store.withLock('prices.lock', async () => {
        const records = await this.list();
        const ids = new Set(ok.map(r => r.id));
        await this.store.write(FILE, { records: [...records.filter(r => !ids.has(r.id)), ...ok] });
      });
    }
    return { imported: ok.length, errors };
  }
}

// ---------- CSV ----------

export const CSV_COLUMNS = ['componentId', 'priceCents', 'currency', 'sourceName', 'sourceUrl', 'observedAt', 'condition', 'stockStatus', 'shippingCents', 'priceType', 'confidence', 'sku', 'note', 'quotedAt'];

const csvCell = v => {
  const s = v == null ? '' : String(v);
  // 防公式注入：以 = + - @ 开头的文本加单引号
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
};

export function toCsv(records) {
  return [CSV_COLUMNS.join(','), ...records.map(r => CSV_COLUMNS.map(c => csvCell(r[c])).join(','))].join('\n') + '\n';
}

export function parseCsv(text) {
  const rows = [];
  let row = []; let cell = ''; let quoted = false;
  const src = String(text).replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); cell = ''; if (row.some(c => c !== '')) rows.push(row); row = [];
    } else cell += ch;
  }
  row.push(cell); if (row.some(c => c !== '')) rows.push(row);
  if (!rows.length) return [];
  const header = rows[0].map(h => h.trim());
  if (!header.includes('componentId') || !header.includes('priceCents')) throw invalid('CSV 第一行需要表头，至少包含 componentId、priceCents');
  return rows.slice(1).map(cells => Object.fromEntries(header.map((h, i) => [h, (cells[i] ?? '').replace(/^'(?=[=+\-@])/, '')]).filter(([, v]) => v !== '')));
}

// ---------- 价格模式 ----------

/**
 * 按价格模式给配件定价：manual 模式下有有效用户记录的用最新一条（含运费），否则用目录估算价。
 * allowUsed=false 时忽略二手 / 翻新 / 拆机记录；preferInStock 时忽略明确无货的记录。
 * 返回新对象，附 priceSource（catalog / user）、priceRecord、priceStale。
 */
export function applyPriceMode(items, records, { mode = 'estimate', allowUsed = false, preferInStock = true, now = Date.now() } = {}) {
  const usable = records.filter(r => (allowUsed || ['new', 'old-stock'].includes(r.condition)) && !(preferInStock && r.stockStatus === 'out_of_stock'));
  const latest = new Map();
  for (const r of usable) {
    const prev = latest.get(r.componentId);
    if (!prev || r.observedAt > prev.observedAt) latest.set(r.componentId, r);
  }
  return items.map(item => {
    const record = mode === 'manual' ? latest.get(item.id) : null;
    if (record) {
      return { ...item, estimatedPriceCents: record.priceCents + record.shippingCents, estimateBasis: record.priceType === 'verified' ? 'verified' : 'manual',
        priceConfidence: record.confidence, possiblyStale: false, priceSource: 'user', priceRecord: record, priceStale: isStale(record.observedAt, 'user', now) };
    }
    return item.estimatedPriceCents > 0 ? { ...item, priceSource: 'catalog', priceStale: isStale(item.priceObservedAt, 'catalog', now) } : item;
  });
}
