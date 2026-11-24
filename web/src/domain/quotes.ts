import type { Quote, QuoteMode } from '../api/client';
import type { Candidate, PartSpecs, SlotId } from './types';

/** 支持后端查价的槽位 */
export const QUOTE_CATEGORY: Partial<Record<SlotId, 'CPU' | 'GPU'>> = { cpu: 'CPU', gpu: 'GPU' };

/** 卡片上的一句话状态，按优先级取最能说明问题的原因 */
const NOTE_PRIORITY: [string, string][] = [
  ['page_blocked', '页面访问受限'],
  ['conditional_price', '需登录确认'],
  ['price_ambiguous', '价格不唯一'],
  ['memory_ambiguous', '显存不明确'],
  ['model_ambiguous', '型号不明确'],
  ['packaging_mismatch', '包装待确认'],
  ['recommendation_prices', '仅推荐区价格'],
  ['price_sanity', '价格异常'],
  ['stale', '报价已过期'],
  ['price_missing', '缺少价格'],
];

export function reviewNote(codes: string[]): string {
  return NOTE_PRIORITY.find(([code]) => codes.includes(code))?.[1] ?? '需人工核实';
}

/** 由型号推断插槽：只覆盖规则明确的系列，推断不了就留空 */
export function inferCpuSocket(model: string | null): string | undefined {
  if (!model) return undefined;
  if (/^RYZEN [79]\d{3}/.test(model)) return 'AM5';
  if (/^CORE I[3579]-1[234]\d{3}/.test(model)) return 'LGA1700';
  if (/^CORE ULTRA [579] 2\d{2}/.test(model)) return 'LGA1851';
  return undefined;
}

function prettyModel(model: string | null): string {
  if (!model) return '型号未识别';
  return model.replace(/\bTI\b/, 'Ti').replace(/\bSUPER\b/, 'Super').replace(/^RYZEN/, 'Ryzen').replace(/^CORE ULTRA/, 'Core Ultra').replace(/^CORE/, 'Core');
}

export interface MappedQuotes {
  shown: Candidate[];
  filtered: { candidate: Candidate; reason: string }[];
}

export function quotesToCandidates(slot: SlotId, mode: QuoteMode, results: Quote[]): MappedQuotes {
  const shown: Candidate[] = [];
  const filtered: MappedQuotes['filtered'] = [];
  results.forEach((q, i) => {
    const specs: PartSpecs = {};
    const socket = slot === 'cpu' ? inferCpuSocket(q.model) : undefined;
    if (socket) specs.socket = socket;
    const accepted = q.status === 'accepted' && q.priceCents != null;
    const specParts = [prettyModel(q.model), q.capacityGB ? `${q.capacityGB}GB` : socket].filter(Boolean);
    const c: Candidate = {
      id: q.url ?? `${q.title}#${i}`,
      slot,
      source: mode,
      name: q.title,
      spec: specParts.join(' · '),
      summarySpec: specParts.join(' · '),
      store: 'jd',
      storeLabel: '京东',
      condition: 'new',
      capacityGB: q.capacityGB ?? undefined,
      priceCents: accepted ? q.priceCents : null,
      referenceCents: accepted ? undefined : q.priceCents,
      state: accepted ? 'confirmed' : q.priceCents != null ? 'review' : 'missing',
      verified: accepted,
      reviewNote: accepted ? undefined : reviewNote(q.reasonCodes),
      reasons: q.reasons,
      observedAt: q.observedAt,
      url: q.url,
      specs,
    };
    if (q.status === 'rejected') filtered.push({ candidate: c, reason: q.reasons[0] ?? '不符合检索条件' });
    else shown.push(c);
  });
  return { shown, filtered };
}
