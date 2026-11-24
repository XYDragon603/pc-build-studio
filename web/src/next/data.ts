// 新界面用的目录查询：支持排序、筛选与国内 / 海外分组；按 ID 取条目并缓存（配件图片、性能都从这里来）。
import { useEffect, useState } from 'react';
import type { CatalogItem } from '../api/client';

const BASE = '/api/v1';

export type SortKey = 'value' | 'price' | '-price' | 'perf';
export type Market = 'cn' | 'global';

export interface CatalogQuery {
  category: string;
  q?: string;
  sort?: SortKey;
  market?: Market;
  limit?: number;
}

export async function queryCatalog({ category, q = '', sort = 'value', market = 'cn', limit = 60 }: CatalogQuery): Promise<{ items: CatalogItem[]; total: number }> {
  const params = new URLSearchParams({ category, q: q.trim().slice(0, 120), sort, market, hasPrice: '1', limit: String(limit) });
  const res = await fetch(`${BASE}/catalog?${params}`, { signal: AbortSignal.timeout(15000) });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error?.message ?? `读取目录失败（HTTP ${res.status}）`);
  return { items: data.items, total: data.total };
}

const itemCache = new Map<string, Promise<CatalogItem | null>>();

export function getCatalogItem(id: string): Promise<CatalogItem | null> {
  if (!itemCache.has(id)) {
    itemCache.set(id, fetch(`${BASE}/catalog/${encodeURIComponent(id)}`).then(r => (r.ok ? r.json() : null)).catch(() => null));
  }
  return itemCache.get(id)!;
}

/** 按目录 ID 批量取条目（缺图、无 ID 的返回 undefined） */
export function useCatalogItems(ids: (string | null | undefined)[]): Record<string, CatalogItem | null> {
  const key = ids.filter(Boolean).join('|');
  const [items, setItems] = useState<Record<string, CatalogItem | null>>({});
  useEffect(() => {
    let alive = true;
    const list = ids.filter((id): id is string => !!id);
    Promise.all(list.map(async id => [id, await getCatalogItem(id)] as const)).then(pairs => {
      if (alive) setItems(Object.fromEntries(pairs));
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return items;
}
