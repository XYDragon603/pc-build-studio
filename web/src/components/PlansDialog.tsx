import { FilePlus2, Loader2, Trash2 } from 'lucide-react';
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
}

export function PlansDialog({ open, plans, error, storageLabel, currentId, onClose, onLoad, onDelete, onNew }: Props) {
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
          <button type="button" className="btn btn-ghost" onClick={() => { onNew(); onClose(); }}>
            <FilePlus2 size={16} /> 从演示方案新建
          </button>
        </footer>
      </div>
    </Dialog>
  );
}
