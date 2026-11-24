import { Loader2, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { CatalogItem } from '../api/client';
import { SLOT_TO_API } from '../api/mapping';
import { Dialog } from '../components/Dialog';
import { catalogToCandidate } from '../domain/catalog';
import { formatYuan } from '../domain/money';
import { fitsBuild } from '../domain/plan';
import { slotDef } from '../domain/slots';
import type { Build, SlotId } from '../domain/types';
import { queryCatalog, type Market, type SortKey } from './data';
import { Thumb } from './Thumb';

interface Props {
  slot: SlotId | null;
  build: Build;
  onClose: () => void;
  onPick: (item: CatalogItem) => void;
  /** 显卡一栏可选“不用独立显卡” */
  onIntegrated?: () => void;
}

export function PartPicker({ slot, build, onClose, onPick, onIntegrated }: Props) {
  return (
    <Dialog open={!!slot} title={slot ? `选择${slotDef(slot).noun}` : ''} onClose={onClose} width={1080}>
      {slot && <Body key={slot} slot={slot} build={build} onClose={onClose} onPick={onPick} onIntegrated={onIntegrated} />}
    </Dialog>
  );
}

const SORTS: [SortKey, string][] = [['value', '性价比'], ['price', '价格从低到高'], ['-price', '价格从高到低'], ['perf', '性能最强']];

function Body({ slot, build, onClose, onPick, onIntegrated }: Props & { slot: SlotId }) {
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>(slot === 'cpu' || slot === 'gpu' ? 'value' : 'price');
  const [market, setMarket] = useState<Market>('cn');
  const [onlyFit, setOnlyFit] = useState(true);
  const [items, setItems] = useState<CatalogItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setItems(null);
    setError(null);
    queryCatalog({ category: SLOT_TO_API[slot], q: query, sort, market, limit: 90 })
      .then(r => { if (alive) { setItems(r.items); setTotal(r.total); } })
      .catch(e => { if (alive) setError(e instanceof Error ? e.message : '读取失败'); });
    return () => { alive = false; };
  }, [slot, query, sort, market]);

  const shown = useMemo(() => (items ?? []).filter(i => !onlyFit || fitsBuild(slot, catalogToCandidate(i, slot).specs ?? {}, build)), [items, onlyFit, slot, build]);
  const hidden = (items?.length ?? 0) - shown.length;
  const current = build.slots[slot].part?.catalogId;

  return (
    <div className="nx-picker">
      <form className="nx-picker-bar" onSubmit={e => { e.preventDefault(); setQuery(q); }}>
        <div className="nx-search">
          <Search size={18} />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="搜型号或品牌，例如 5060 Ti、七彩虹、B650M" autoFocus />
        </div>
        <button type="submit" className="nx-btn nx-btn-primary">搜索</button>
        <select value={sort} onChange={e => setSort(e.target.value as SortKey)} aria-label="排序">
          {SORTS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        </select>
        <div className="nx-seg" role="group" aria-label="型号范围">
          <button type="button" className={market === 'cn' ? 'on' : ''} onClick={() => setMarket('cn')}>国内常见</button>
          <button type="button" className={market === 'global' ? 'on' : ''} onClick={() => setMarket('global')}>海外型号</button>
        </div>
        <label className="nx-toggle"><input type="checkbox" checked={onlyFit} onChange={e => setOnlyFit(e.target.checked)} /> 只看兼容的</label>
      </form>

      <p className="nx-muted small">
        {items ? `共 ${total} 款，显示 ${shown.length} 款${hidden > 0 ? `（${hidden} 款与当前配置不兼容，已隐藏）` : ''}` : '正在读取…'}
        {market === 'global' && ' · 海外型号多数国内买不到，价格为同规格估算。'}
      </p>

      {slot === 'gpu' && onIntegrated && (
        <button type="button" className="nx-igpu" onClick={() => { onIntegrated(); onClose(); }}>
          不用独立显卡，使用 CPU 核显（办公、网课、轻度网游够用）
        </button>
      )}

      {error && <p className="nx-error">{error}</p>}
      {!items && !error && <p className="nx-empty"><Loader2 className="spin" /> 正在读取…</p>}
      {items && shown.length === 0 && <p className="nx-empty">没有找到合适的型号，换个关键词或取消“只看兼容的”。</p>}

      <div className="nx-pick-grid">
        {shown.map(item => (
          <button type="button" key={item.id} className={`nx-pick${item.id === current ? ' current' : ''}`} onClick={() => { onPick(item); onClose(); }}>
            <Thumb src={item.imageUrl} slot={slot} size="lg" />
            <strong title={item.name}>{item.name}</strong>
            <span className="nx-muted">{item.summary}</span>
            {item.performance?.gaming && (
              <span className="nx-perf">{slot === 'gpu' ? `2K 游戏 ${item.performance.gaming.index}%` : `游戏 ${item.performance.gaming.index}%`}</span>
            )}
            <span className="nx-pick-price">{item.estimatedPriceCents ? `约 ${formatYuan(item.estimatedPriceCents)}` : '暂无价格'}</span>
            {item.id === current && <span className="nx-badge">当前</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
