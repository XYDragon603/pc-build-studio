import { ChevronRight, Info, Loader2, Lock, LockOpen, RefreshCw, Save, X } from 'lucide-react';
import type { BuildTotals } from '../domain/build';
import { formatYuan } from '../domain/money';
import { SLOTS } from '../domain/slots';
import type { Build, SlotId } from '../domain/types';
import { SLOT_ICONS } from './icons';

interface Props {
  build: Build;
  totals: BuildTotals;
  active: SlotId;
  onSelect: (id: SlotId) => void;
  onToggleLock: (id: SlotId) => void;
  onEditPrice: (id: SlotId) => void;
  onRemoveCustom: (id: string) => void;
  onSave: () => void;
  saving: boolean;
  /** 保存状态说明，例如“已保存到本地服务 · 第 3 版” */
  saveStatus: { text: string; dirty: boolean };
  /** 空槽位下方的小字，例如当前正在找的型号 */
  emptyHint: (id: SlotId) => string | undefined;
  /** 刷新估算价（在线且有估算价时显示） */
  onRefreshEstimates?: () => void;
  refreshing?: boolean;
  /** 价格提醒：已选配件的目录参考价与方案里的价格不同 */
  alerts?: PriceAlert[];
}

export interface PriceAlert {
  slot: SlotId;
  label: string;
  /** estimate：估算价可刷新；cheaper：手动价高于当前参考价 */
  kind: 'estimate' | 'cheaper';
  fromCents: number;
  toCents: number;
}

const priceText = (c: number | null) => (c == null ? '未知' : formatYuan(c));

export function Summary({ build, totals: t, active, onSelect, onToggleLock, onEditPrice, onRemoveCustom, onSave, saving, saveStatus, emptyHint, onRefreshEstimates, refreshing, alerts = [] }: Props) {
  const over = t.remainingCents < 0;
  const priceLabel = t.estimateCount > 0 ? `含 ${t.estimateCount} 件估算` : t.demoPriceCount > 0 ? '含演示价' : '手动价';
  return (
    <aside className="card summary" aria-labelledby="summary-title">
      <header className="summary-head">
        <h2 id="summary-title">我的配置 · {t.filled}/{t.slotCount}</h2>
        <span className="muted small" title={t.demoPriceCount > 0 ? `${t.demoPriceCount} 件配件仍是演示价格，点击价格可改为手动价` : '已选配件的价格均由你确认或手动填写'}>
          <Info size={14} /> {t.demoPriceCount > 0 ? `${t.demoPriceCount} 件为演示价` : '已选配件为手动价'}
        </span>
      </header>

      <ul className="summary-list">
        {SLOTS.map(({ id, label }) => {
          const s = build.slots[id];
          const Icon = SLOT_ICONS[id];
          const isActive = id === active;
          return (
            <li key={id} className={`srow${isActive ? ' is-active' : ''}`}>
              <button type="button" className="srow-main" onClick={() => onSelect(id)} aria-current={isActive ? 'true' : undefined}>
                <Icon size={20} strokeWidth={1.5} className="srow-icon" />
                <span className="srow-label">{label}</span>
                <span className="srow-part">
                  <span className="srow-name">{s.part ? s.part.name : `待选择${label}`}</span>
                  {(s.part ? s.part.spec : emptyHint(id)) && <span className="srow-spec">{s.part ? s.part.spec : emptyHint(id)}</span>}
                </span>
              </button>
              {s.part ? (
                <>
                  <button
                    type="button"
                    className={`icon-btn lock${s.locked ? ' is-locked' : ''}`}
                    aria-pressed={s.locked}
                    aria-label={s.locked ? `解锁${label}` : `锁定${label}`}
                    title={s.locked ? '已锁定：重新查价或替换不会改动它' : '锁定后不会被替换'}
                    onClick={() => onToggleLock(id)}
                  >
                    {s.locked ? <Lock size={18} /> : <LockOpen size={18} />}
                  </button>
                  <button
                    type="button"
                    className="srow-price"
                    disabled={s.locked}
                    onClick={() => onEditPrice(id)}
                    aria-label={`${label}价格 ${priceText(s.part.priceCents)}${s.locked ? '' : '，点击修改'}`}
                    title={s.locked ? '解锁后可修改价格' : '修改手动价'}
                  >
                    {s.part.priceSource === 'estimate' && s.part.priceCents != null ? <span className="est" title={s.part.note || '按参考价估算'}>约 {priceText(s.part.priceCents)}</span> : priceText(s.part.priceCents)}
                  </button>
                </>
              ) : (
                <>
                  <span className="srow-dash" aria-hidden="true">—</span>
                  <ChevronRight size={18} className="srow-chev" aria-hidden="true" />
                </>
              )}
            </li>
          );
        })}
        {build.custom.map(c => (
          <li key={c.id} className="srow custom">
            <div className="srow-main static">
              <span className="tag">自定义</span>
              <span className="srow-part">
                <span className="srow-name">{c.name}</span>
                {c.spec && <span className="srow-spec">{c.spec}</span>}
              </span>
            </div>
            <button type="button" className="icon-btn" aria-label={`移除 ${c.name}`} onClick={() => onRemoveCustom(c.id)}><X size={16} /></button>
            <span className="srow-price static">{priceText(c.priceCents)}</span>
          </li>
        ))}
      </ul>

      {alerts.length > 0 && (
        <div className="price-alerts" role="status">
          <strong>价格提醒</strong>
          <ul>
            {alerts.map(a => (
              <li key={a.slot}>
                <button type="button" className="link-btn" onClick={() => onSelect(a.slot)}>{a.label}</button>
                {a.kind === 'estimate'
                  ? <> 参考价 {a.toCents < a.fromCents ? '降' : '涨'}了 {formatYuan(Math.abs(a.toCents - a.fromCents))}（{formatYuan(a.fromCents)} → {formatYuan(a.toCents)}）</>
                  : <> 参考价 {formatYuan(a.toCents)}，比你填的低 {formatYuan(a.fromCents - a.toCents)}</>}
              </li>
            ))}
          </ul>
          {alerts.some(a => a.kind === 'estimate') && onRefreshEstimates && (
            <button type="button" className="btn btn-link btn-sm" onClick={onRefreshEstimates} disabled={refreshing}>
              {refreshing ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />} 按最新参考价更新估算
            </button>
          )}
        </div>
      )}

      <div className="totals">
        <div className="total-line">
          <span>已选合计 <span className="tag">{priceLabel}</span></span>
          <strong className="total-big">{formatYuan(t.totalCents)}</strong>
        </div>
        <div className="total-line">
          <span>{over ? '超出预算' : '剩余预算'}</span>
          <strong className={`total-mid${over ? ' over' : ''}`}>{formatYuan(Math.abs(t.remainingCents))}</strong>
        </div>
        <div
          className={`budget-bar${over ? ' over' : ''}`}
          role="progressbar"
          aria-label="预算使用"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(Math.min(1, t.ratio) * 100)}
        >
          <span style={{ width: `${Math.min(1, t.ratio) * 100}%` }} />
        </div>
        <div className="total-foot muted small">
          <span>{formatYuan(t.totalCents)} / {formatYuan(build.budgetCents)}</span>
          <span>预算 {formatYuan(build.budgetCents)}</span>
        </div>
        {t.unknownPriceCount > 0 && <p className="muted small">另有 {t.unknownPriceCount} 项价格未知，未计入合计。</p>}
        {t.estimateCount > 0 && (
          <div className="estimate-note">
            <span className="muted small">{t.estimateCount} 件为参考价估算，点价格可改成实付价。</span>
            {onRefreshEstimates && (
              <button type="button" className="btn btn-link btn-sm" onClick={onRefreshEstimates} disabled={refreshing}>
                {refreshing ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />} 刷新估算价
              </button>
            )}
          </div>
        )}
      </div>

      <button type="button" className="btn btn-outline btn-block btn-lg" onClick={onSave} disabled={saving}>
        {saving ? <Loader2 size={18} className="spin" /> : <Save size={18} />} {saving ? '正在保存…' : '保存方案'}
      </button>
      <p className={`save-status${saveStatus.dirty ? ' dirty' : ''}`} role="status">{saveStatus.text}</p>
    </aside>
  );
}
