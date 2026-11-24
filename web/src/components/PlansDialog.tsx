import { Download, FilePlus2, Loader2, Trash2, Upload } from 'lucide-react';
import { useRef } from 'react';
import { formatYuan } from '../domain/money';
import { Dialog } from './Dialog';

export interface PlanSummary {
  id: string;
  name: string;
  filled: number;
  slotCount: number;
  totalCents: number;
  budgetCents: number;
  updatedAt: string;
}

interface Props {
  open: boolean;
  plans: PlanSummary[] | null;
  error: string | null;
  storageLabel: string;
  currentId: string;
  onClose: () => void;
  onLoad: (id: string) => void;
  onDelete: (id: string) => void;
  onNew: () => void;
  newLabel?: string;
  onBackup?: () => void;
  onRestore?: (file: File) => void;
}

export function PlansDialog({ open, plans, error, storageLabel, currentId, onClose, onLoad, onDelete, onNew, newLabel = '从演示方案新建', onBackup, onRestore }: Props) {
  const file = useRef<HTMLInputElement>(null);
  return (
    <Dialog open={open} title="我的方案" onClose={onClose} width={540}>
      <div className="dialog-body">
        <p className="muted small">{storageLabel}</p>
        {error ? (
          <p className="field-error" role="alert">{error}</p>
        ) : plans === null ? (
          <p className="empty-note"><Loader2 size={16} className="spin" /> 正在读取…</p>
        ) : plans.length === 0 ? (
          <p className="empty-note">还没有保存的方案。点击右侧“保存方案”后会出现在这里。</p>
        ) : (
          <ul className="plan-list">
            {plans.map(p => (
              <li key={p.id} className={p.id === currentId ? 'is-current' : ''}>
                <button type="button" className="plan-main" onClick={() => { onLoad(p.id); onClose(); }}>
                  <strong>{p.name || '未命名方案'}</strong>
                  <span className="muted small">
                    {p.filled}/{p.slotCount} 件 · 合计 {formatYuan(p.totalCents)} · 预算 {formatYuan(p.budgetCents)} · {new Date(p.updatedAt).toLocaleString('zh-CN')}
                  </span>
                </button>
                {p.id === currentId && <span className="tag">当前</span>}
                <button type="button" className="icon-btn" aria-label={`删除方案 ${p.name}`} onClick={() => onDelete(p.id)}>
                  <Trash2 size={16} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <footer className="dialog-actions">
          {onBackup && <button type="button" className="btn btn-ghost" onClick={onBackup}><Download size={16} /> 导出备份</button>}
          {onRestore && (
            <>
              <input ref={file} type="file" accept=".json,application/json" hidden onChange={e => {
                const selected = e.target.files?.[0];
                e.target.value = '';
                if (selected) onRestore(selected);
              }} />
              <button type="button" className="btn btn-ghost" onClick={() => file.current?.click()}><Upload size={16} /> 恢复备份</button>
            </>
          )}
          <button type="button" className="btn btn-ghost" onClick={() => { onNew(); onClose(); }}>
            <FilePlus2 size={16} /> {newLabel}
          </button>
        </footer>
      </div>
    </Dialog>
  );
}
