import { BookOpen, ChevronDown, CirclePlus, Database, Loader2, Radio, RotateCw, Search, TriangleAlert, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, ApiError, type CatalogPage, type QuoteMode, type QuoteReport } from '../api/client';
import { SLOT_TO_API } from '../api/mapping';
import { catalogToCandidate } from '../domain/catalog';
import { applyFilters, parseQuery, summarizeReasons, type Filters } from '../domain/candidates';
import { DEMO_CANDIDATES } from '../domain/demoData';
import { formatYuan } from '../domain/money';
import { QUOTE_CATEGORY, quotesToCandidates } from '../domain/quotes';
import { slotDef } from '../domain/slots';
import type { Build, Candidate, SlotId } from '../domain/types';
import { CandidateCard, formatObserved } from './CandidateCard';

/** CPU / 显卡的候选来源：查价回放、实时查价，或型号目录 */
export type SourceMode = QuoteMode | 'catalog';

export interface QuoteBackend {
  online: boolean;
  liveConfigured: boolean;
  mode: SourceMode;
  onMode: (m: SourceMode) => void;
}

interface Props {
  slot: SlotId;
  build: Build;
  filters: Filters;
  onFilters: (f: Filters) => void;
  verified: Record<string, number>;
  onAdd: (c: Candidate, priceCents: number, asEstimate?: boolean) => void;
  onRemove: () => void;
  onVerify: (c: Candidate) => void;
  backend: QuoteBackend;
  footer: ReactNode;
}

/** 本次会话内的查价结果缓存：切换槽位时不重复请求，实时检索也不重复消耗额度 */
const reportCache = new Map<string, QuoteReport>();
const cacheKey = (slot: SlotId, mode: QuoteMode, query: string) => `${slot}|${mode}|${query.trim().toUpperCase()}`;

function withCapacity(query: string, cap: number | 'all') {
  const base = query.replace(/(^|\s)\d{1,2}\s*G(?:B)?(?=\s|$)/gi, ' ').replace(/\s+/g, ' ').trim();
  return cap === 'all' ? base : `${base} ${cap}GB`;
}

export function CandidatePanel({ slot, build, filters, onFilters, verified, onAdd, onRemove, onVerify, backend, footer }: Props) {
  const def = slotDef(slot);
  const state = build.slots[slot];
  const category = QUOTE_CATEGORY[slot];
  const mode = backend.mode;
  // 查价只覆盖 CPU / 显卡；其他配件在线时从型号目录选
  const useCatalog = backend.online && (!category || mode === 'catalog');
  const remote = backend.online && !!category && mode !== 'catalog';
  const quoteMode: QuoteMode = mode === 'live' ? 'live' : 'replay';
  const isGpu = slot === 'gpu';

  const [draft, setDraft] = useState(useCatalog ? '' : filters.query);
  const [catalog, setCatalog] = useState<CatalogPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [report, setReport] = useState<QuoteReport | null>(() => reportCache.get(cacheKey(slot, mode === 'live' ? 'live' : 'replay', filters.query)) ?? null);
  const [showFiltered, setShowFiltered] = useState(false);
  const requestId = useRef(0);

  const runRemote = async (query: string, m: QuoteMode) => {
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    onFilters({ ...filters, query });
    try {
      const r = await api.searchQuotes(category!, query, m);
      reportCache.set(cacheKey(slot, m, query), r);
      if (id === requestId.current) setReport(r);
    } catch (e) {
      if (id === requestId.current) {
        setReport(null);
        setError(e instanceof ApiError ? e : new ApiError(0, 'UNKNOWN', '查价失败'));
      }
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  };

  const runDemo = (query: string) => {
    // 演示数据只在本地过滤，模拟一次短暂的查价过程
    setLoading(true);
    window.setTimeout(() => { onFilters({ ...filters, query }); setLoading(false); }, 350);
  };

  const runCatalog = async (query: string) => {
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const page = await api.catalog(SLOT_TO_API[slot], query);
      if (id === requestId.current) setCatalog(page);
    } catch (e) {
      if (id === requestId.current) {
        setCatalog(null);
        setError(e instanceof ApiError ? e : new ApiError(0, 'UNKNOWN', '读取型号目录失败'));
      }
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  };

  const run = (query = draft) => (useCatalog ? runCatalog(query) : remote ? runRemote(query, quoteMode) : runDemo(query));

  // 进入目录模式时清空关键词并列出该类配件
  useEffect(() => {
    if (!useCatalog) return;
    setDraft('');
    setError(null);
    runCatalog('');
    return () => { requestId.current++; setLoading(false); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useCatalog]);

  // 回放不消耗额度：进入 CPU / 显卡时自动查；实时检索只在用户点击时发起
  useEffect(() => {
    if (!remote) return;
    setDraft(filters.query);
    const cached = reportCache.get(cacheKey(slot, quoteMode, filters.query));
    setReport(cached ?? null);
    setError(null);
    if (!cached && quoteMode === 'replay' && filters.query.trim()) runRemote(filters.query, 'replay');
    return () => { requestId.current++; setLoading(false); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remote, mode]);

  let shown: Candidate[];
  let filtered: { candidate: Candidate; reason: string }[];
  if (useCatalog) {
    shown = (catalog?.items ?? []).map(item => catalogToCandidate(item, slot));
    filtered = [];
  } else if (remote) {
    ({ shown, filtered } = report ? quotesToCandidates(slot, report.mode, report.results) : { shown: [], filtered: [] });
  } else {
    ({ shown, filtered } = applyFilters(DEMO_CANDIDATES.filter(c => c.slot === slot), filters));
  }
  const hasPending = !useCatalog && shown.some(c => c.state !== 'confirmed' && verified[c.id] == null);
  const capacity = remote ? (parseQuery(filters.query).capacityGB ?? 'all') : filters.capacity;
  const inBuild = (c: Candidate) =>
    !!state.part && (state.part.url ? state.part.url === c.url : state.part.name === c.name);

  return (
    <section className="card panel" aria-labelledby="panel-title">
      <div className="panel-head">
        <h2 id="panel-title" className="panel-title">为你的主机选择{def.noun}</h2>
        {backend.online && category && (
          <div className="segmented" role="group" aria-label="候选来源">
            <button type="button" aria-pressed={mode === 'replay'} onClick={() => backend.onMode('replay')}>
              <Database size={15} /> 回放
            </button>
            <button
              type="button"
              aria-pressed={mode === 'live'}
              disabled={!backend.liveConfigured}
              title={backend.liveConfigured ? '通过服务端搜索实时检索，消耗每日额度' : '服务端未配置 BRAVE_SEARCH_API_KEY'}
              onClick={() => backend.onMode('live')}
            >
              <Radio size={15} /> 实时
            </button>
            <button type="button" aria-pressed={mode === 'catalog'} title="按型号浏览规格，不含报价" onClick={() => backend.onMode('catalog')}>
              <BookOpen size={15} /> 目录
            </button>
          </div>
        )}
      </div>

      <form className="search-row" role="search" onSubmit={e => { e.preventDefault(); run(); }}>
        <div className="search-box">
          <Search size={20} aria-hidden="true" />
          <input value={draft} onChange={e => setDraft(e.target.value)} placeholder={`搜索${def.noun}型号，例如 ${isGpu ? 'RTX 5060 Ti 16GB' : '9700X 盒装'}`} aria-label={`搜索${def.noun}`} />
          {draft && (
            <button type="button" className="icon-btn" aria-label="清空搜索" onClick={() => { setDraft(''); if (useCatalog) runCatalog(''); else if (!remote) runDemo(''); }}>
              <X size={18} />
            </button>
          )}
        </div>
        <button type="submit" className="btn btn-primary btn-search" disabled={loading || (remote && !draft.trim())}>
          {loading ? <Loader2 size={18} className="spin" /> : null} {useCatalog ? '搜索型号' : '查找报价'}
        </button>
        {!useCatalog && <div className="filter-chips">
          {remote ? (
            <span className="chip-static" title="查价服务只保留京东新品">新品</span>
          ) : (
            <ChipSelect label="成色" value={filters.condition} onChange={v => onFilters({ ...filters, condition: v as Filters['condition'] })}
              options={[['new', '新品'], ['all', '全部成色']]} />
          )}
          {isGpu && (
            <ChipSelect
              label="显存"
              value={String(capacity)}
              onChange={v => {
                const cap = v === 'all' ? 'all' : Number(v);
                if (remote) { const q = withCapacity(filters.query, cap); setDraft(q); runRemote(q, quoteMode); }
                else onFilters({ ...filters, capacity: cap });
              }}
              options={[['16', '16GB'], ['8', '8GB'], ['all', '全部显存']]}
            />
          )}
          {remote ? (
            <span className="chip-static" title="目前只支持京东商品详情页">京东</span>
          ) : (
            <ChipSelect label="来源" value={filters.store} onChange={v => onFilters({ ...filters, store: v as Filters['store'] })}
              options={[['jd', '京东'], ['all', '全部来源']]} />
          )}
        </div>}
      </form>

      {useCatalog ? (
        <p className="source-note">
          {loading ? '正在读取型号目录…' : catalog ? `型号目录 · 共 ${catalog.total} 款${catalog.total > catalog.items.length ? `，显示前 ${catalog.items.length} 款，可输入型号缩小范围` : ''}。目录不含报价，加入前需手动填价。` : null}
        </p>
      ) : (
        <SourceNote remote={remote} online={backend.online} noun={def.noun} report={report} mode={quoteMode} loading={loading} />
      )}

      <div className={`cand-grid${loading ? ' is-loading' : ''}`} aria-busy={loading}>
        {shown.map(c => (
          <CandidateCard
            key={c.id}
            candidate={c}
            verifiedCents={verified[c.id]}
            inBuild={inBuild(c)}
            slotLocked={state.locked}
            slotFilled={!!state.part}
            onAdd={price => onAdd(c, price)}
            onAddEstimate={c.estimate ? () => onAdd(c, c.estimate!.cents, true) : undefined}
            onRemove={onRemove}
            onVerify={() => onVerify(c)}
          />
        ))}
        {!loading && error && (
          <div className="empty error-box" role="alert">
            <p><TriangleAlert size={18} /> {error.message}</p>
            {error.code === 'SEARCH_NOT_CONFIGURED' ? (
              <button type="button" className="btn btn-outline" onClick={() => backend.onMode('replay')}>改用回放数据</button>
            ) : error.status !== 400 ? (
              <button type="button" className="btn btn-outline" onClick={() => run(useCatalog ? draft : filters.query)}><RotateCw size={16} /> 重试</button>
            ) : null}
          </div>
        )}
        {!loading && !error && remote && !report && mode === 'live' && (
          <div className="empty">
            <p>实时检索会调用搜索服务并读取商品页，计入每日额度。</p>
            <button type="button" className="btn btn-primary" onClick={() => run()} disabled={!draft.trim()}>开始实时查价</button>
          </div>
        )}
        {!loading && !error && shown.length === 0 && (useCatalog ? !!catalog : !remote || report) && (
          <div className="empty">
            <p>{useCatalog ? `型号目录里没有找到“${draft}”。` : remote ? `没有找到“${filters.query}”的报价记录。` : `没有找到匹配“${filters.query}”的${def.noun}。`}</p>
            {remote && mode === 'replay' && (
              <p className="muted small">回放数据只覆盖少量已人工记录的型号{backend.liveConfigured ? '，可以切到实时查价。' : '。'}</p>
            )}
            {!remote && <button type="button" className="btn btn-outline" onClick={() => { setDraft(''); if (useCatalog) runCatalog(''); else runDemo(''); }}>清空关键词</button>}
          </div>
        )}
      </div>

      {filtered.length > 0 && (
        <div className="filtered">
          <button type="button" className="filtered-toggle" aria-expanded={showFiltered} onClick={() => setShowFiltered(v => !v)}>
            <ChevronDown size={16} className={showFiltered ? 'rot' : ''} /> 已过滤 {filtered.length} 项 · {summarizeReasons(filtered)}
          </button>
          {showFiltered && (
            <ul>
              {filtered.map(({ candidate: c, reason }) => (
                <li key={c.id}>
                  <span>{c.name}</span>
                  <span className="muted small">{c.spec}</span>
                  <span className="muted small">{c.priceCents != null ? formatYuan(c.priceCents) : c.referenceCents != null ? formatYuan(c.referenceCents) : '价格未获取'}</span>
                  <span className="tag tag-warn">{reason}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {hasPending && <p className="notice" role="note"><TriangleAlert size={18} /> 待核实报价不计入总价</p>}

      {footer}
    </section>
  );
}

function SourceNote({ remote, online, noun, report, mode, loading }: { remote: boolean; online: boolean; noun: string; report: QuoteReport | null; mode: QuoteMode; loading: boolean }) {
  if (!online) return null;
  if (!remote) return <p className="source-note">{noun}暂未接入查价，以下为演示数据。</p>;
  if (loading) return <p className="source-note"><Loader2 size={14} className="spin" /> {mode === 'live' ? '正在检索并逐个读取商品页，可能需要一分钟…' : '正在读取回放记录…'}</p>;
  if (!report) return null;
  const { summary: s, cost } = report;
  const counts = `共 ${s.total} 条，校验通过 ${s.accepted} 条、待核实 ${s.review} 条、已过滤 ${s.rejected} 条`;
  if (report.mode === 'replay') {
    return <p className="source-note">回放 {formatObserved(report.evidenceAsOf)} 的人工观察记录，不代表当前价格。{counts}。</p>;
  }
  return (
    <p className="source-note">
      实时检索 · {formatObserved(report.generatedAt)} · 搜索请求 {cost.projectSearchRequests} 次{cost.cacheHits ? '（命中缓存）' : ''} · 读取商品页 {cost.productPageRequests} 个。{counts}。
    </p>
  );
}

function ChipSelect({ label, value, options, onChange }: { label: string; value: string; options: [string, string][]; onChange: (v: string) => void }) {
  return (
    <label className="chip-select">
      <span className="sr-only">{label}</span>
      <select value={value} onChange={e => onChange(e.target.value)}>
        {options.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
      </select>
      <ChevronDown size={16} aria-hidden="true" />
    </label>
  );
}

export function AddCustomButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="btn btn-link" onClick={onClick}><CirclePlus size={18} /> 添加自定义配件</button>
  );
}
