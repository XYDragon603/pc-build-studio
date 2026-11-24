import { AlertTriangle, ArrowLeft, CheckCircle2, ChevronDown, Download, FolderOpen, Loader2, Repeat, Save, Trash2, XCircle } from 'lucide-react';
import { useMemo, useState, type Dispatch } from 'react';
import type { BuildAction } from '../domain/build';
import { totals } from '../domain/build';
import { formatYuan } from '../domain/money';
import { buildChecks, compatSummary, gpuTier, INTEGRATED_GPU_NAME, isIntegratedGpu, STOCK_COOLER_NAME } from '../domain/plan';
import { SLOTS } from '../domain/slots';
import type { Build, SlotId } from '../domain/types';
import { useCatalogItems } from './data';
import { Thumb } from './Thumb';

interface Props {
  build: Build;
  dispatch: Dispatch<BuildAction>;
  onBack: () => void;
  onPick: (slot: SlotId) => void;
  onEditPrice: (slot: SlotId) => void;
  onSave: () => void;
  saving: boolean;
  saveText: string;
  onExport: () => void;
  onOpenPlans: () => void;
}

export function Editor({ build, dispatch, onBack, onPick, onEditPrice, onSave, saving, saveText, onExport, onOpenPlans }: Props) {
  const t = totals(build);
  const checks = useMemo(() => buildChecks(build), [build]);
  const summary = compatSummary(checks);
  const [showChecks, setShowChecks] = useState(false);
  const items = useCatalogItems(SLOTS.map(s => build.slots[s.id].part?.catalogId));
  const over = t.remainingCents < 0;
  const gpuItem = build.slots.gpu.part?.catalogId ? items[build.slots.gpu.part.catalogId] : null;
  const StatusIcon = summary.level === 'ok' ? CheckCircle2 : summary.level === 'warn' ? AlertTriangle : XCircle;

  return (
    <div className="nx-editor">
      <div className="nx-editor-main">
        <div className="nx-editor-head">
          <button type="button" className="nx-btn nx-btn-ghost" onClick={onBack}><ArrowLeft size={16} /> 重新出方案</button>
          <input className="nx-name" value={build.name} onChange={e => dispatch({ type: 'rename', name: e.target.value })} aria-label="方案名称" maxLength={40} />
        </div>

        <ul className="nx-rows">
          {SLOTS.map(({ id, label }) => {
            const part = build.slots[id].part;
            const item = part?.catalogId ? items[part.catalogId] : null;
            const placeholder = part && (part.name === INTEGRATED_GPU_NAME || part.name === STOCK_COOLER_NAME);
            const perf = item?.performance;
            return (
              <li key={id} className={`nx-row${part ? '' : ' empty'}`}>
                <Thumb src={item?.imageUrl} slot={id} size="md" />
                <div className="nx-row-body">
                  <span className="nx-slot">{label}</span>
                  {part ? (
                    <>
                      <strong className="nx-row-name" title={part.name}>{part.name}</strong>
                      <span className="nx-muted">{item?.summary || part.spec}</span>
                      {perf?.gaming && <span className="nx-perf">{id === 'gpu' ? `2K 游戏性能 ${perf.gaming.index}%` : `游戏性能 ${perf.gaming.index}%（1080p）`}{perf.gaming.label ? ` · ${perf.gaming.label}` : ''}</span>}
                    </>
                  ) : (
                    <span className="nx-muted">还没选</span>
                  )}
                </div>
                {part && !placeholder && (
                  <button type="button" className="nx-row-price" onClick={() => onEditPrice(id)} title="点击修改为实付价">
                    {part.priceCents == null ? '填价格' : part.priceSource === 'estimate' ? `约 ${formatYuan(part.priceCents)}` : formatYuan(part.priceCents)}
                    <small>{part.priceSource === 'estimate' ? '参考价 · 点我改' : '已确认'}</small>
                  </button>
                )}
                {placeholder && <span className="nx-row-price static">—<small>{part!.spec}</small></span>}
                <div className="nx-row-actions">
                  <button type="button" className="nx-btn nx-btn-outline" onClick={() => onPick(id)}>
                    <Repeat size={16} /> {part ? '换一个' : '选一个'}
                  </button>
                  {part && (
                    <button type="button" className="nx-icon-btn" aria-label={`移除${label}`} title="移除" onClick={() => dispatch({ type: 'removePart', slot: id })}>
                      <Trash2 size={16} />
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      <aside className="nx-side">
        <div className="nx-total">
          <span className="nx-muted">合计{t.estimateCount ? `（含 ${t.estimateCount} 件参考价）` : ''}</span>
          <strong>{formatYuan(t.totalCents)}</strong>
          <div className={`nx-bar${over ? ' over' : ''}`}><span style={{ width: `${Math.min(1, t.ratio) * 100}%` }} /></div>
          <div className="nx-total-foot">
            <span>预算 {formatYuan(build.budgetCents)}</span>
            <span className={over ? 'nx-over' : 'nx-ok'}>{over ? `超出 ${formatYuan(-t.remainingCents)}` : `剩余 ${formatYuan(t.remainingCents)}`}</span>
          </div>
          {t.missing.length > 0 && <p className="nx-muted small">还差 {t.missing.length} 件：{t.missing.map(id => SLOTS.find(s => s.id === id)!.label).join('、')}</p>}
        </div>

        <div className="nx-level">
          <span className="nx-label">大致档次</span>
          <strong>{gpuTier(gpuItem?.performance?.gaming?.index, isIntegratedGpu(build.slots.gpu.part))}</strong>
        </div>

        <div className={`nx-compat-box ${summary.level}`}>
          <button type="button" onClick={() => setShowChecks(v => !v)}>
            <StatusIcon size={18} /> <span>{summary.text}</span> <ChevronDown size={16} className={showChecks ? 'rot' : ''} />
          </button>
          {showChecks && (
            <ul>
              {checks.map(c => <li key={c.id} className={c.level}><strong>{c.label}</strong><span>{c.detail}</span></li>)}
            </ul>
          )}
        </div>

        <div className="nx-side-actions">
          <button type="button" className="nx-btn nx-btn-primary nx-btn-block" onClick={onSave} disabled={saving}>
            {saving ? <Loader2 size={16} className="spin" /> : <Save size={16} />} 保存方案
          </button>
          <p className="nx-muted small center">{saveText}</p>
          <div className="nx-two">
            <button type="button" className="nx-btn nx-btn-ghost" onClick={onExport}><Download size={16} /> 导出清单</button>
            <button type="button" className="nx-btn nx-btn-ghost" onClick={onOpenPlans}><FolderOpen size={16} /> 我的方案</button>
          </div>
        </div>
        {t.estimateCount > 0 && <p className="nx-muted small">“约”表示中关村在线参考价，通常略高于电商实际售价。下单前点价格改成实付价，合计会自动更新。</p>}
      </aside>
    </div>
  );
}
