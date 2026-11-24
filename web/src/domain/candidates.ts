import type { Candidate } from './types';

export interface Filters {
  query: string;
  condition: 'new' | 'all';
  store: 'jd' | 'all';
  capacity: number | 'all';
}

export interface FilterResult {
  shown: Candidate[];
  /** 明确不符合检索条件的候选，只进折叠区，不做成大卡片 */
  filtered: { candidate: Candidate; reason: string }[];
}

const squash = (t: string) => t.normalize('NFKC').toUpperCase().replace(/\s+/g, '');

/**
 * 与 CLI 原型一致：查询中的容量（如 16GB）被解析为规格约束，而不是普通关键词，
 * 因此容量不符的商品会出现在“已过滤 · 显存不符”里，而不是静默消失。
 */
export function parseQuery(query: string): { tokens: string[]; capacityGB: number | null } {
  const tokens: string[] = [];
  let capacityGB: number | null = null;
  for (const raw of query.normalize('NFKC').trim().split(/\s+/).filter(Boolean)) {
    const m = /^(\d{1,2})G(?:B)?$/i.exec(raw);
    if (m) capacityGB = Number(m[1]);
    else tokens.push(squash(raw));
  }
  return { tokens, capacityGB };
}

export function applyFilters(list: Candidate[], f: Filters): FilterResult {
  const { tokens, capacityGB } = parseQuery(f.query);
  const capacity = f.capacity !== 'all' ? f.capacity : capacityGB;
  const shown: Candidate[] = [];
  const filtered: FilterResult['filtered'] = [];
  for (const c of list) {
    const hay = squash(`${c.name} ${c.spec}`);
    if (!tokens.every(t => hay.includes(t))) continue; // 与关键词无关：不展示
    if (f.condition === 'new' && c.condition !== 'new') filtered.push({ candidate: c, reason: '非新品' });
    else if (f.store === 'jd' && c.store !== 'jd') filtered.push({ candidate: c, reason: '来源不符' });
    else if (capacity != null && c.capacityGB != null && c.capacityGB !== capacity) filtered.push({ candidate: c, reason: '显存不符' });
    else shown.push(c);
  }
  return { shown, filtered };
}

export function summarizeReasons(filtered: FilterResult['filtered']): string {
  return [...new Set(filtered.map(f => f.reason))].join('、');
}
