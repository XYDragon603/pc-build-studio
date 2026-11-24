import { Loader2, Search, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { CatalogItem } from '../api/client';
import { formatYuan } from '../domain/money';
import type { SlotId } from '../domain/types';
import { estimateText, suggestCatalog, type Market } from './data';
import { Thumb } from './Thumb';

interface Props {
  category: string;
  market: Market;
  slot: SlotId;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onChoose: (item: CatalogItem) => void;
}

/** 搜索框 + 输入联想：边打字边弹出模糊匹配的型号，方向键选择、回车确认、Esc 关闭 */
export function SearchSuggest({ category, market, slot, value, onChange, onSubmit, onChoose }: Props) {
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [loading, setLoading] = useState(false);
  const typed = useRef(false);
  const listId = useId();

  useEffect(() => {
    const q = value.trim();
    // 只在用户自己输入时联想；选中一项后把名称填回输入框，不再弹出
    if (!q || !typed.current) { setItems([]); setOpen(false); return; }
    const request = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      suggestCatalog({ category, q, market }, request.signal)
        .then(r => { setItems(r.items); setActive(-1); setOpen(true); })
        .catch(() => { if (!request.signal.aborted) setItems([]); })
        .finally(() => { if (!request.signal.aborted) setLoading(false); });
    }, 150);
    return () => { window.clearTimeout(timer); request.abort(); };
  }, [value, category, market]);

  const choose = (item: CatalogItem) => {
    typed.current = false;
    setOpen(false);
    onChoose(item);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' && items.length) { e.preventDefault(); setOpen(true); setActive(i => (i + 1) % items.length); }
    else if (e.key === 'ArrowUp' && items.length) { e.preventDefault(); setActive(i => (i <= 0 ? items.length - 1 : i - 1)); }
    else if (e.key === 'Escape') { setOpen(false); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (open && active >= 0 && items[active]) choose(items[active]);
      else { setOpen(false); onSubmit(); }
    }
  };

  const showList = open && value.trim().length > 0;

  return (
    <div className="nx-suggest">
      <label className="nx-search">
        <Search size={16} aria-hidden />
        <input
          value={value}
          onChange={e => { typed.current = true; onChange(e.target.value); }}
          onKeyDown={onKeyDown}
          onFocus={() => { if (items.length && typed.current) setOpen(true); }}
          onBlur={() => window.setTimeout(() => setOpen(false), 120)}
          placeholder="输入型号或品牌，如 5060ti、华硕 b650、990pro"
          aria-label="搜索型号或品牌"
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
          maxLength={120}
          autoComplete="off"
        />
        {loading && <Loader2 size={14} className="spin" aria-hidden />}
        {value && <button type="button" aria-label="清空搜索" onClick={() => { typed.current = false; onChange(''); setItems([]); }}><X size={14} /></button>}
      </label>
      {showList && (
        <ul className="nx-suggest-list" id={listId} role="listbox">
          {items.length === 0 && !loading && <li className="nx-suggest-empty">没有相近的型号</li>}
          {items.map((item, i) => (
            <li
              key={item.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'active' : ''}
              onMouseEnter={() => setActive(i)}
              // mousedown 先于输入框 blur，避免列表先被关掉
              onMouseDown={e => { e.preventDefault(); choose(item); }}
            >
              <Thumb src={item.imageUrl} slot={slot} size="sm" />
              <span className="nx-suggest-name"><strong>{item.name}</strong><small>{item.summary}</small></span>
              <span className="nx-suggest-price">{estimateText(item, formatYuan)}{item.possiblyStale && <small className="nx-stale">可能是旧价</small>}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
