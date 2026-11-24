import type { Build } from './types';

// v2：配件字段与后端对齐（specs / quantity / priceSource / url），旧格式不再读取
const DRAFT_KEY = 'pc-builder.draft.v2';
const PLANS_KEY = 'pc-builder.plans.v2';

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

const isBuild = (b: unknown): b is Build =>
  !!b && typeof b === 'object' && typeof (b as Build).id === 'string' && typeof (b as Build).slots === 'object';

export const loadDraft = (): Build | null => {
  const b = read<unknown>(DRAFT_KEY);
  return isBuild(b) ? b : null;
};
export const saveDraft = (b: Build) => write(DRAFT_KEY, b);

export const listPlans = (): Build[] => (read<unknown[]>(PLANS_KEY) ?? []).filter(isBuild);

export function savePlan(b: Build): boolean {
  const plans = listPlans().filter(p => p.id !== b.id);
  return write(PLANS_KEY, [b, ...plans]);
}

export function deletePlan(id: string): boolean {
  return write(PLANS_KEY, listPlans().filter(p => p.id !== id));
}
