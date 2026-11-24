import { CheckCircle2, ChevronRight, Download, FileClock, FolderOpen, Loader2, Monitor, Plus, Search, Trash2, Upload, Zap } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { fromApi } from '../api/mapping';
import { SLOT_ICONS } from '../components/icons';
import type { PlanSummary } from '../components/PlansDialog';
import { totals } from '../domain/build';
import { estimatePower } from '../domain/compat';
import { formatYuan } from '../domain/money';
import { SLOTS } from '../domain/slots';
import type { Build } from '../domain/types';
import { useCatalogItems } from './data';
import { Thumb } from './Thumb';

interface Props {
  plans: PlanSummary[] | null;
  error: string | null;
  currentId: string;
  draft: Build | null;
  onLoad: (id: string) => void;
  onDelete: (id: string) => void;
  onResume: () => void;
  onNew: () => void;
  onBackup: () => void;
  onRestore: (file: File) => void;
}

export function SavedPlans({ plans, error, currentId, draft, onLoad, onDelete, onResume, onNew, onBackup, onRestore }: Props) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(currentId);
  const [details, setDetails] = useState<{ id: string; build: Build | null; error?: string } | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const shown = plans?.filter(plan => plan.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const previewId = shown?.find(plan => plan.id === selected)?.id ?? shown?.[0]?.id;

  useEffect(() => {
    if (!previewId) return;
    let active = true;
    api.getBuild(previewId).then(entry => {
      if (active) setDetails({ id: previewId, build: fromApi(entry) });
    }).catch(e => {
      if (active) setDetails({ id: previewId, build: null, error: e instanceof Error ? e.message : '读取方案失败' });
    });
    return () => { active = false; };
  }, [previewId]);

  return (
    <div className="nx-page nx-saved">
      <header className="nx-page-head nx-saved-head">
        <div><h1>我的方案</h1><p className="nx-muted">已保存方案与本机草稿</p></div>
        <div className="nx-footer-actions">
          <button type="button" className="nx-btn nx-btn-primary" onClick={onNew}><Plus size={17} />新建方案</button>
          <button type="button" className="nx-btn nx-btn-outline" onClick={() => file.current?.click()}><Upload size={17} />导入备份</button>
          <button type="button" className="nx-btn nx-btn-outline" onClick={onBackup}><Download size={17} />导出备份</button>
          <input ref={file} type="file" accept=".json,application/json" hidden onChange={e => {
            const backup = e.target.files?.[0];
            e.target.value = '';
            if (backup) onRestore(backup);
          }} />
        </div>
      </header>
      <div className="nx-saved-content">
        <section className="nx-panel nx-saved-list">
          <label className="nx-search"><Search size={17} /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索方案名称" aria-label="搜索方案名称" /></label>
          {draft && <button type="button" className="nx-saved-draft" onClick={onResume}><FileClock size={20} /><span><strong>继续草稿</strong><small>{draft.name || '未命名方案'}</small></span><ChevronRight size={18} /></button>}
          {error ? <p className="nx-error" role="alert">{error}</p> : plans === null ? <p className="nx-empty"><Loader2 className="spin" />正在读取</p> : shown?.length === 0 ? (
            <p className="nx-empty">{query.trim() ? '没有找到匹配的方案' : '还没有保存的方案'}</p>
          ) : <ul>
            {shown?.map(plan => (
              <li key={plan.id} className={plan.id === previewId ? 'is-active' : ''}>
                <button type="button" className="nx-saved-select" onClick={() => setSelected(plan.id)} aria-pressed={plan.id === previewId}>
                  <span className="nx-saved-icon"><Monitor size={26} /></span>
                  <span className="nx-saved-name"><strong>{plan.name}</strong><small>{plan.filled}/{plan.slotCount} 件 · {new Date(plan.updatedAt).toLocaleString('zh-CN')}</small></span>
                  <strong className="nx-saved-price">{formatYuan(plan.totalCents)}</strong>
                </button>
                <button type="button" className="nx-btn nx-btn-outline" onClick={() => onLoad(plan.id)}>继续编辑</button>
                <button type="button" className="nx-icon-btn nx-remove" aria-label={`删除${plan.name}`} onClick={() => {
                  if (window.confirm(`删除方案「${plan.name}」？`)) onDelete(plan.id);
                }}><Trash2 size={17} /></button>
              </li>
            ))}
          </ul>}
        </section>
        <aside className="nx-panel nx-saved-preview">
          {!previewId ? <p className="nx-empty"><FolderOpen size={22} />选择方案查看明细</p> :
            details?.id !== previewId ? <p className="nx-empty"><Loader2 className="spin" />读取方案明细</p> :
            details.build ? <SavedPreview build={details.build} /> : <p className="nx-error" role="alert">{details.error}</p>}
        </aside>
      </div>
    </div>
  );
}

function SavedPreview({ build }: { build: Build }) {
  const info = totals(build);
  const power = estimatePower(build);
  const items = useCatalogItems(SLOTS.map(s => build.slots[s.id].part?.catalogId));
  return (
    <>
      <header className="nx-section-head nx-saved-preview-head">
        <span className="nx-saved-icon"><Monitor size={26} /></span>
        <div><h2>{build.name}</h2><span className="nx-tag ok"><CheckCircle2 size={14} />已保存</span></div>
      </header>
      <ul>
        {SLOTS.flatMap(({ id, label }) => {
          const part = build.slots[id].part;
          if (!part) return [];
          const item = part.catalogId ? items[part.catalogId] : null;
          const Icon = SLOT_ICONS[id];
          return [<li key={id}><Icon size={17} aria-hidden /><span>{label}</span><Thumb slot={id} src={item?.imageUrl} size="sm" /><strong>{part.name}</strong></li>];
        })}
      </ul>
      <footer className="nx-saved-summary"><span>预计总价<strong>{formatYuan(info.totalCents)}</strong></span><span><Zap size={15} />预估满载功耗<strong>{power.estimatedLoadWatts == null ? '待补充规格' : `${power.estimatedLoadWatts} W`}</strong></span></footer>
    </>
  );
}
