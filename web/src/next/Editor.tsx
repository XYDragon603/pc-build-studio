import { AlertTriangle, BadgeCheck, RefreshCw, WandSparkles, CheckCircle2, CircleDollarSign, Download, Gamepad2, Loader2, Lock, LockOpen, Pencil, PieChart, Repeat, Save, Trash2, VolumeX, Wallet, XCircle } from 'lucide-react';
import { useEffect, useMemo, type Dispatch, type ReactNode } from 'react';
import { SLOT_ICONS } from '../components/icons';
import { totals, type BuildAction } from '../domain/build';
import { estimatePower, type Check } from '../domain/compat';
import { formatYuan } from '../domain/money';
import { purposeOfScenarios } from '../domain/purposes';
import { buildChecks, compatSummary, INTEGRATED_GPU_NAME, STOCK_COOLER_NAME } from '../domain/plan';
import { ALL_SLOTS, isPeripheral, PERIPHERALS, SLOTS } from '../domain/slots';
import type { Build, SlotId } from '../domain/types';
import { ESTIMATE_LABELS, PRICE_NOTE, priceChanges, STALE_NOTE, staleSpecs, useCatalogItems } from './data';
import { Thumb } from './Thumb';

interface Props {
  build: Build;
  dispatch: Dispatch<BuildAction>;
  activeSlot: SlotId | null;
  picker: ReactNode;
  onPick: (slot: SlotId) => void;
  onClosePicker: () => void;
  onEditPrice: (slot: SlotId) => void;
  onSave: () => void;
  saving: boolean;
  saveText: string;
  draftStatus: string;
  onExport: () => void;
  /** 保留锁定的配件，其余重新优化 */
  onReoptimize: () => void;
  reoptimizing: boolean;
}

const CHECK_ICONS = { ok: CheckCircle2, warn: AlertTriangle, error: XCircle };

function CheckRow({ check }: { check: Check }) {
  const Icon = CHECK_ICONS[check.level];
  return (
    <li className={check.level}>
      <Icon size={17} aria-hidden />
      <div><strong>{check.label}</strong><p>{check.detail}</p></div>
    </li>
  );
}

export function Editor({ build, dispatch, activeSlot, picker, onPick, onClosePicker, onEditPrice, onSave, saving, saveText, draftStatus, onExport, onReoptimize, reoptimizing }: Props) {
  const t = totals(build);
  const checks = useMemo(() => buildChecks(build), [build]);
  const summary = compatSummary(checks);
  const bios = checks.find(c => c.id === 'bios');
  const items = useCatalogItems(ALL_SLOTS.map(s => build.slots[s.id]?.part?.catalogId));
  const power = estimatePower(build);
  const purpose = purposeOfScenarios(build.scenarios);
  // 打开方案时自动用配件库最新规格补全（规格不是用户填的，直接更新；价格要用户确认，见下）
  useEffect(() => {
    for (const { slot, specs } of staleSpecs(build, items)) dispatch({ type: 'refreshSpecs', slot, specs });
  }, [build, items, dispatch]);
  // 参考价有更新的配件（只看按参考价记的，手填实付价不动）
  const changes = priceChanges(build, items);
  const changeTotal = changes.reduce((sum, c) => sum + (c.toCents - c.fromCents) * (build.slots[c.slot].part?.quantity ?? 1), 0);
  const applyChanges = () => changes.forEach(c => dispatch({ type: 'setEstimate', slot: c.slot, priceCents: c.toCents, note: '按最新参考价更新' }));
  // CPU / 显卡的功耗有一项是按同类估算的，就在功耗旁注明
  const powerEstimated = (['cpu', 'gpu'] as const).some(id => {
    const catalogId = build.slots[id].part?.catalogId;
    return catalogId ? items[catalogId]?.estimatedSpecs?.some(f => f === 'tdpWatts' || f === 'maxPowerWatts') : false;
  });
  const over = t.remainingCents < 0;
  const lockedCount = SLOTS.filter(s => build.slots[s.id].locked).length;
  const status = summary.level === 'ok' && bios ? 'warn' : summary.level;
  const StatusIcon = CHECK_ICONS[status];

  const renderRow = (id: SlotId, label: string) => {
    const { part, locked } = build.slots[id];
    const item = part?.catalogId ? items[part.catalogId] : null;
    const placeholder = part?.name === INTEGRATED_GPU_NAME || part?.name === STOCK_COOLER_NAME;
    const reference = part?.priceSource === 'estimate' || part?.priceSource === 'demo' ? part.priceCents : item?.estimatedPriceCents;
    const actual = part?.priceSource === 'manual' ? part.priceCents : null;
    const basis = part?.priceSource === 'demo' ? '演示价' : item?.estimateBasis && item.estimatedPriceCents === reference
      ? ESTIMATE_LABELS[item.estimateBasis] : '保存时的估算价';
    const Icon = SLOT_ICONS[id];
    return (
      <tr key={id} className={activeSlot === id ? 'is-active' : ''}>
        <th scope="row"><span className="nx-slot-caption"><Icon size={19} aria-hidden />{label}</span></th>
        <td>
          <button type="button" className="nx-row-product" onClick={() => onPick(id)} disabled={locked} aria-label={part ? `更换${label}：${part.name}` : `选择${label}`}>
            <Thumb src={item?.imageUrl} slot={id} size="md" />
            <span className="nx-row-body">
              <strong title={part?.name}>{part?.name ?? '选择配件'}</strong>
              {part && <span title={item?.summary || part.spec}>{item?.summary || part.spec}</span>}
            </span>
          </button>
        </td>
        <td className="nx-amount" title={reference == null || placeholder ? undefined : [basis, item?.priceObservedAt && `采集于 ${item.priceObservedAt.slice(0, 10)}`, item?.possiblyStale && STALE_NOTE].filter(Boolean).join(' · ')}>
          {reference == null || placeholder ? '—' : formatYuan(reference)}
          {item?.possiblyStale && !placeholder && <small className="nx-stale">可能是旧价</small>}
        </td>
        <td className="nx-amount">
          {part && !placeholder
            ? <button type="button" className={`nx-price-edit${actual == null ? ' is-unset' : ''}`} onClick={() => onEditPrice(id)} disabled={locked} aria-label={`编辑${label}实付价`}>{actual == null ? '填写' : formatYuan(actual)}</button>
            : '—'}
        </td>
        <td>
          <span className="nx-row-actions">
            {locked
              ? <button type="button" className="nx-icon-btn" title="解锁" aria-label={`解锁${label}`} onClick={() => dispatch({ type: 'toggleLock', slot: id })}><Lock size={15} /></button>
              : <button type="button" className="nx-icon-btn" title={part ? '更换' : '选择'} aria-label={`${part ? '更换' : '选择'}${label}`} onClick={() => onPick(id)}><Repeat size={15} /></button>}
            {part && !locked && !isPeripheral(id) && <button type="button" className="nx-icon-btn" title="锁定：重新优化时保留这件" aria-label={`锁定${label}`} onClick={() => dispatch({ type: 'toggleLock', slot: id })}><LockOpen size={15} /></button>}
            {part && !locked && <button type="button" className="nx-icon-btn nx-remove" aria-label={`移除${label}`} title="移除" onClick={() => dispatch({ type: 'removePart', slot: id })}><Trash2 size={15} /></button>}
          </span>
        </td>
      </tr>
    );
  };

  return (
    <div className="nx-page nx-editor">
      <header className="nx-page-head nx-editor-head">
        <div className="nx-name-field">
          <input className="nx-name" value={build.name} onChange={e => dispatch({ type: 'rename', name: e.target.value })} aria-label="方案名称" size={Math.min(Math.max(build.name.length, 7), 25)} maxLength={40} />
          <Pencil size={17} aria-hidden />
        </div>
        {purpose && <span className="nx-tag" title={purpose.hint}>{['game', '4k', '1080p'].includes(purpose.id) && <Gamepad2 size={17} />}{purpose.label}</span>}
        {build.scenarios.includes('quiet') && <span className="nx-tag"><VolumeX size={17} />安静优先</span>}
        <span className="nx-editor-state" role="status">{draftStatus || saveText}</span>
      </header>

      <div className="nx-editor-content">
        <section className="nx-panel nx-build-panel" aria-labelledby="nx-build-heading">
          <header className="nx-section-head"><h2 id="nx-build-heading">配置清单</h2><span className="nx-muted">已选 {t.filled} / {t.slotCount} 项</span></header>
          {changes.length > 0 && (
            <div className="nx-price-changes" role="status">
              <RefreshCw size={16} aria-hidden />
              <span>
                <strong>{changes.length} 件参考价有变动</strong>（合计 {changeTotal > 0 ? '+' : '−'}{formatYuan(Math.abs(changeTotal))}）：
                {changes.map(c => `${c.label} ${formatYuan(c.fromCents)} → ${formatYuan(c.toCents)}`).join('、')}
              </span>
              <button type="button" className="nx-btn nx-btn-outline" onClick={applyChanges}>全部更新</button>
            </div>
          )}
          <div className="nx-table-scroll">
            <table className="nx-build-table" aria-label="当前方案配件">
              <thead><tr><th scope="col">配件</th><th scope="col">产品与规格</th><th scope="col" title={PRICE_NOTE}>参考价</th><th scope="col">实付价</th><th scope="col"><span className="sr-only">操作</span></th></tr></thead>
              <tbody>
                {SLOTS.map(({ id, label }) => renderRow(id, label))}
                {build.custom.map(part => <tr key={part.id}><th scope="row"><span className="nx-slot-caption">自定义</span></th><td><strong>{part.name}</strong><div className="nx-muted small">{part.spec}</div></td><td>—</td><td className="nx-amount">{part.priceCents == null ? '—' : formatYuan(part.priceCents)}</td><td><button type="button" className="nx-icon-btn nx-remove" aria-label={`移除${part.name}`} onClick={() => dispatch({ type: 'removeCustom', id: part.id })}><Trash2 size={15} /></button></td></tr>)}
                <tr className="nx-group-row">
                  <th scope="rowgroup" colSpan={5}>外设<small>可选，计入整机总预算{t.peripheralCount > 0 ? ` · 小计 ${formatYuan(t.peripheralCents)}` : ''}</small></th>
                </tr>
                {PERIPHERALS.map(({ id, label }) => renderRow(id, label))}
              </tbody>
            </table>
          </div>
          <p className="nx-price-note">{PRICE_NOTE}</p>
        </section>
        {activeSlot ? picker : (
          <aside className="nx-panel nx-build-inspector">
            <header className="nx-section-head"><h2><BadgeCheck size={22} />兼容性检查</h2></header>
            <div className="nx-inspector-scroll">
              <div className={`nx-check-summary nx-tag ${status}`}><StatusIcon size={17} />{summary.level === 'ok' && bios ? bios.label : summary.text}</div>
              <ul className="nx-check-list">{checks.map(check => <CheckRow key={check.id} check={check} />)}</ul>
              <div className="nx-power"><span>预估满载功耗</span><strong title={powerEstimated ? '部分功耗按同芯片 / 同规格型号估算' : undefined}>{power.estimatedLoadWatts == null ? '待补充规格' : `${powerEstimated ? '约 ' : ''}${power.estimatedLoadWatts} W`}</strong></div>
            </div>
          </aside>
        )}
      </div>

      <footer className="nx-editor-footer">
        <div className="nx-footer-metrics">
          <span><Wallet size={18} />预算 <strong>{formatYuan(build.budgetCents)}</strong></span>
          <span title={`包含 ${t.estimateCount} 项估算价，${t.unknownPriceCount} 项待填价`}><CircleDollarSign size={18} />预计总价 <strong>{formatYuan(t.grandTotalCents)}</strong></span>
          <span><PieChart size={18} />{over ? '超出预算' : '剩余预算'} <strong className={over ? 'nx-over' : ''}>{formatYuan(Math.abs(t.remainingCents))}</strong></span>
          {t.peripheralCount > 0 && <span title="外设计入整机总预算">外设 <strong>{formatYuan(t.peripheralCents)}</strong> · 合计 <strong>{formatYuan(t.grandTotalCents)}</strong></span>}
        </div>
        {status !== 'ok' && <button type="button" className={`nx-tag ${status}`} title={summary.text} onClick={onClosePicker}><StatusIcon size={17} />{summary.level === 'ok' && bios ? bios.label : '兼容性待核对'}</button>}
        <div className="nx-footer-actions">
          {lockedCount > 0 && lockedCount < SLOTS.length && <button type="button" className="nx-btn nx-btn-outline" onClick={onReoptimize} disabled={reoptimizing}
            title={`保留已锁定的 ${lockedCount} 件，其余按预算 ${formatYuan(build.budgetCents)} 和当前用途重新挑选（锁定的配件作为硬约束）`}>
            {reoptimizing ? <Loader2 className="spin" /> : <WandSparkles size={17} />}重新优化其余</button>}
          <button type="button" className="nx-btn nx-btn-outline" onClick={onExport}><Download size={17} />导出清单</button>
          <button type="button" className="nx-btn nx-btn-primary" onClick={onSave} disabled={saving}>{saving ? <Loader2 className="spin" /> : <Save size={17} />}保存方案</button>
        </div>
      </footer>
    </div>
  );
}
