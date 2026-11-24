import { ArrowDownUp, Check, ChevronDown, Circle, Loader2, Plus, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CatalogItem } from '../api/client';
import { SLOT_TO_API } from '../api/mapping';
import { buildReducer, totals } from '../domain/build';
import { catalogToCandidate } from '../domain/catalog';
import { formatYuan } from '../domain/money';
import { SLOTS, slotDef } from '../domain/slots';
import type { Build, SlotId } from '../domain/types';
import { ESTIMATE_LABELS, estimateText, fitForSlot, STALE_NOTE, queryCatalog, type Market, type SortKey } from './data';
import { SearchSuggest } from './SearchSuggest';
import { Thumb } from './Thumb';

interface Props {
  slot: SlotId;
  build: Build;
  onClose?: () => void;
  onPick: (item: CatalogItem) => void;
  onIntegrated?: () => void;
  onCategory?: (slot: SlotId) => void;
}

const SORTS: [SortKey, string][] = [['value', '性价比'], ['price', '价格从低到高'], ['-price', '价格从高到低'], ['perf', '性能最强']];
const priceText = (item: CatalogItem) => estimateText(item, formatYuan);

export function PartPicker({ slot, build, onClose, onPick, onIntegrated, onCategory }: Props) {
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>(slot === 'cpu' || slot === 'gpu' ? 'value' : 'price');
  const [market, setMarket] = useState<Market>('cn');
  const [onlyFit, setOnlyFit] = useState(!onCategory);
  const [items, setItems] = useState<CatalogItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<CatalogItem | null>(null);
  const [compare, setCompare] = useState<CatalogItem[]>([]);
  const pending = useRef<AbortController | null>(null);
  const fit = useMemo(() => fitForSlot(slot, build), [slot, build]);

  // 停止输入 350ms 后自动按关键词筛选列表，不用点“搜索”
  useEffect(() => {
    const id = window.setTimeout(() => setQuery(q.trim()), 350);
    return () => window.clearTimeout(id);
  }, [q]);

  const load = useCallback((offset: number) => {
    pending.current?.abort();
    const request = new AbortController();
    pending.current = request;
    setLoading(true);
    setError(null);
    queryCatalog({ category: SLOT_TO_API[slot], q: query, sort, market, offset, fit, onlyFit }, request.signal)
      .then(r => {
        if (request.signal.aborted) return;
        setItems(previous => offset ? [...(previous ?? []), ...r.items] : r.items);
        setTotal(r.total);
      })
      .catch(e => { if (!request.signal.aborted) setError(e instanceof Error ? e.message : '读取失败'); })
      .finally(() => { if (!request.signal.aborted) setLoading(false); });
  }, [slot, query, sort, market, fit, onlyFit]);

  useEffect(() => {
    setItems(null);
    setSelected(null);
    load(0);
    return () => pending.current?.abort();
  }, [load]);

  const slotState = build.slots[slot];
  const current = slotState.part?.catalogId;
  const previewPrice = selected?.estimatedPriceCents ?? null;
  const previewBuild = selected ? buildReducer(build, {
    type: 'addCandidate', candidate: catalogToCandidate(selected, slot),
    priceCents: previewPrice, priceSource: previewPrice == null ? 'manual' : 'estimate',
  }) : null;
  const previewTotal = previewBuild ? totals(previewBuild) : null;
  const delta = previewTotal && previewPrice != null && (!slotState.part || slotState.part.priceCents != null)
    ? previewTotal.totalCents - totals(build).totalCents : null;
  const heading = `更换${slotDef(slot).noun}`;

  const switchCompare = (item: CatalogItem) => setCompare(previous =>
    previous.some(entry => entry.id === item.id) ? previous.filter(entry => entry.id !== item.id) : [...previous, item].slice(0, 3));

  return (
    <div className={onCategory ? 'nx-catalog-content' : 'nx-picker-wrap'}>
      <section className="nx-panel nx-picker">
        {!onCategory && <header className="nx-section-head"><h2>{heading}</h2><button type="button" className="nx-icon-btn" aria-label="关闭换件" onClick={onClose}><X size={19} /></button></header>}
        {onCategory && (
          <div className="nx-category-tabs" role="group" aria-label="配件分类">
            {SLOTS.map(({ id, label }) => <button type="button" key={id} className={id === slot ? 'on' : ''} aria-pressed={id === slot} onClick={() => onCategory(id)}>{label}</button>)}
          </div>
        )}
        <form className="nx-picker-controls" onSubmit={e => { e.preventDefault(); setQuery(q); }}>
          <div className="nx-picker-options">
            <div className="nx-seg" role="group" aria-label="型号范围">
              <button type="button" className={market === 'cn' ? 'on' : ''} aria-pressed={market === 'cn'} onClick={() => setMarket('cn')}>国内型号</button>
              <button type="button" className={market === 'global' ? 'on' : ''} aria-pressed={market === 'global'} onClick={() => setMarket('global')}>海外型号</button>
            </div>
            <label className="nx-toggle nx-fit-toggle"><input type="checkbox" role="switch" checked={onlyFit} onChange={e => setOnlyFit(e.target.checked)} />隐藏不兼容</label>
          </div>
          <div className="nx-picker-options">
            <SearchSuggest
              category={SLOT_TO_API[slot]}
              market={market}
              slot={slot}
              value={q}
              onChange={setQ}
              onSubmit={() => setQuery(q.trim())}
              onChoose={item => {
                setQ(item.name);
                setQuery(item.name);
                if (onCategory) { if (!compare.some(entry => entry.id === item.id)) switchCompare(item); } else setSelected(item);
              }}
            />
            <label className="nx-sort" title="排序"><ArrowDownUp size={15} aria-hidden /><select value={sort} onChange={e => setSort(e.target.value as SortKey)} aria-label="排序">{SORTS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}</select></label>
          </div>
        </form>

        <div className="nx-pick-list">
          {error && <p className="nx-error" role="alert">{error} <button type="button" className="nx-link" onClick={() => load(items?.length ?? 0)}>重试</button></p>}
          {!items && loading && <p className="nx-empty"><Loader2 className="spin" /> 正在读取…</p>}
          {items?.length === 0 && <p className="nx-empty">没有找到匹配型号</p>}
          {items?.map(item => {
            const isCurrent = item.id === current;
            const active = selected?.id === item.id;
            const compared = compare.some(entry => entry.id === item.id);
            const change = item.estimatedPriceCents != null && slotState.part?.priceCents != null
              ? item.estimatedPriceCents - slotState.part.priceCents * slotState.part.quantity : null;
            return (
              <div key={item.id} className={`nx-pick${active ? ' chosen' : ''}${isCurrent ? ' current' : ''}`}>
                <button type="button" className="nx-pick-main" onClick={() => onCategory ? switchCompare(item) : setSelected(item)} aria-pressed={onCategory ? compared : active}>
                  {active || (onCategory ? compared : isCurrent) ? <Check size={16} className="nx-pick-mark" /> : <Circle size={16} className="nx-muted" />}
                  <Thumb src={item.imageUrl} slot={slot} size="sm" />
                  <span className="nx-pick-name"><strong title={item.name}>{item.name}</strong><small title={item.summary}>{item.summary}</small></span>
                  <span className="nx-pick-value">
                    <strong title={item.estimateBasis ? ESTIMATE_LABELS[item.estimateBasis] : undefined}>{priceText(item)}</strong>
                    {isCurrent ? <small className="nx-tag">当前选择</small> : change ? <small className={`nx-tag ${change > 0 ? 'warn' : 'ok'}`}>{change > 0 ? '+ ' : '省 '}{formatYuan(Math.abs(change))}</small> : null}
                    {item.possiblyStale && <small className="nx-tag warn" title={`${STALE_NOTE}（ZOL 参考价 ${item.referencePriceCents ? formatYuan(item.referencePriceCents) : '—'}）`}>可能是旧价</small>}
                    {item.compatibility === 'unknown' && <small className="nx-tag warn">规格待核对</small>}
                    {item.compatibility === 'conflict' && <small className="nx-tag error">规格冲突</small>}
                  </span>
                </button>
                {onCategory && <button className="nx-icon-btn" type="button" title="加入方案" aria-label={`加入方案：${item.name}`} disabled={slotState.locked || isCurrent} onClick={() => onPick(item)}><Plus size={17} /></button>}
              </div>
            );
          })}
          {items && items.length < total && <button type="button" className="nx-btn nx-btn-outline nx-pick-more" disabled={loading} onClick={() => load(items.length)}>{loading ? '正在读取…' : '继续加载'}<ChevronDown size={15} /></button>}
        </div>
        {!onCategory && (
          <div className="nx-picker-footer">
            {selected && previewTotal ?
              <div className="nx-pick-preview">
                <div><span>更换后预计总价</span><strong>{formatYuan(previewTotal.totalCents)}</strong></div>
                <div><span>{previewTotal.remainingCents < 0 ? '超出预算' : '剩余预算'}</span><strong className={previewTotal.remainingCents < 0 ? 'nx-over' : ''}>{formatYuan(Math.abs(previewTotal.remainingCents))}</strong></div>
                <button type="button" className="nx-btn nx-btn-primary" disabled={selected.id === current || slotState.locked} onClick={() => onPick(selected)}>确认替换</button>
                <p className="nx-muted small">{[delta == null ? '价格待填写' : `差价 ${delta > 0 ? '+' : ''}${formatYuan(delta)}`, selected.compatibility === 'conflict' ? '与现有配件规格冲突' : selected.compatibility === 'pass' ? '当前筛选的规格匹配' : '兼容规格待核对'].join(' · ')}</p>
              </div>
              : <span className="nx-muted small">{items?.length ? `共 ${total} 款 · 选择一款预览差价` : ''}</span>}
            {onIntegrated && <button type="button" className="nx-link" onClick={onIntegrated}>使用 CPU 核显</button>}
          </div>
        )}
      </section>
      {onCategory && <CatalogComparison slot={slot} items={compare} onRemove={switchCompare} onClear={() => setCompare([])} />}
    </div>
  );
}

function CatalogComparison({ slot, items, onRemove, onClear }: { slot: SlotId; items: CatalogItem[]; onRemove: (item: CatalogItem) => void; onClear: () => void }) {
  return (
    <aside className="nx-panel nx-comparison">
      <header className="nx-section-head"><h2>配件对比</h2>{items.length > 0 && <button type="button" className="nx-btn nx-btn-ghost" onClick={onClear}>清空</button>}</header>
      {items.length === 0 ? <p className="nx-empty">选择最多三款同类配件进行比较</p> : (
        <div className="nx-comparison-scroll">
          <table>
            <thead><tr><th scope="col">对比项</th>{items.map(item => <th scope="col" key={item.id}>
              <button type="button" className="nx-icon-btn" aria-label={`移除对比：${item.name}`} onClick={() => onRemove(item)}><X size={16} /></button>
              <Thumb src={item.imageUrl} slot={slot} size="md" /><strong>{item.name}</strong>
            </th>)}</tr></thead>
            <tbody>
              <tr><th scope="row">估算价</th>{items.map(i => <td key={i.id}>{priceText(i)}</td>)}</tr>
              <tr><th scope="row">关键规格</th>{items.map(i => <td key={i.id}>{i.summary || '待核对'}</td>)}</tr>
              <tr><th scope="row">当前配置</th>{items.map(i => <td key={i.id}>{i.compatibility === 'pass' ? '规格匹配' : i.compatibility === 'conflict' ? '规格冲突' : '待核对'}</td>)}</tr>
              {items.some(i => i.performance?.gaming) && <tr><th scope="row">游戏指数</th>{items.map(i => <td key={i.id} title={i.performance?.gaming?.label ?? undefined}>{i.performance?.gaming ? `${i.performance.gaming.index}%` : '—'}</td>)}</tr>}
              {items.some(i => i.priceTrend) && <tr><th scope="row">历史最低参考价</th>{items.map(i => <td key={i.id}>{i.priceTrend ? formatYuan(i.priceTrend.lowestCents) : '—'}</td>)}</tr>}
            </tbody>
          </table>
        </div>
      )}
    </aside>
  );
}
