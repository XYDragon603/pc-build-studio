import { BookOpen, Check, CircleAlert, CircleCheck, CirclePlus, ExternalLink, Lock, Pencil, ShieldCheck } from 'lucide-react';
import { formatYuan } from '../domain/money';
import type { Candidate } from '../domain/types';
import { PartArt } from './PartArt';

interface Props {
  candidate: Candidate;
  /** 用户手动核实后的价格（覆盖未知或待核实价格） */
  verifiedCents: number | undefined;
  inBuild: boolean;
  slotLocked: boolean;
  slotFilled: boolean;
  onAdd: (priceCents: number) => void;
  /** 按目录估算价加入 */
  onAddEstimate?: () => void;
  onRemove: () => void;
  onVerify: () => void;
}

export const formatObserved = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';

function sourceLine(c: Candidate) {
  if (c.source === 'demo') return `${c.storeLabel} · 演示报价`;
  if (c.source === 'catalog') return `${c.storeLabel} · 型号参数，无报价`;
  const when = formatObserved(c.observedAt);
  return `${c.storeLabel} · ${c.source === 'replay' ? '回放记录' : '实时检索'}${when ? ` · ${when} 观察` : ''}`;
}

/** 比上次变价多少、是否高于记录到的最低价 */
function TrendLine({ current, trend }: { current: number; trend: NonNullable<Candidate['priceTrend']> }) {
  const diff = trend.previousCents != null ? current - trend.previousCents : 0;
  if (!diff && trend.lowestCents >= current) return null;
  return (
    <p className="trend-line">
      {diff !== 0 && (
        <span className={diff < 0 ? 'down' : 'up'} title={`上次 ${formatYuan(trend.previousCents!)}${trend.changedAt ? `，${formatObserved(trend.changedAt)} 变价` : ''}`}>
          {diff < 0 ? '↓' : '↑'} {formatYuan(Math.abs(diff))} 较上次
        </span>
      )}
      {trend.lowestCents < current && <span className="muted">记录最低 {formatYuan(trend.lowestCents)}</span>}
    </p>
  );
}

export function CandidateCard({ candidate: c, verifiedCents, inBuild, slotLocked, slotFilled, onAdd, onAddEstimate, onRemove, onVerify }: Props) {
  const price = verifiedCents ?? (c.state === 'confirmed' ? c.priceCents : null);
  const confirmed = price != null;
  const variant = confirmed ? 'confirmed' : c.state;
  const badge = verifiedCents != null || (confirmed && !c.verified) ? '手动已确认' : '报价已校验';

  return (
    <article className={`card cand cand-${variant}${inBuild ? ' is-in-build' : ''}`} aria-label={c.name}>
      <div className="cand-badge-row">
        {confirmed ? (
          <span className="badge badge-ok"><CircleCheck size={16} /> {badge}</span>
        ) : c.source === 'catalog' ? (
          <span className="badge badge-neutral"><BookOpen size={16} /> 型号目录</span>
        ) : c.state === 'review' || c.source !== 'demo' ? (
          <span className="badge badge-warn"><CircleAlert size={16} /> {c.reviewNote ?? '待核实'}</span>
        ) : null}
      </div>
      <div className="cand-art"><PartArt candidate={c} /></div>
      <div className="cand-body">
        <h3 title={c.name}>{c.name}</h3>
        <p className="muted">{c.spec}</p>
        <p className="muted small">{sourceLine(c)}</p>
        <p className={`cand-price ${variant}`}>
          {confirmed ? formatYuan(price) : c.state === 'review' ? '待核实' : '价格未获取'}
        </p>
        {!confirmed && c.estimate && (
          <p className="estimate-line">
            {c.estimate.basis === 'reference'
              ? <>ZOL 参考价 约 {formatYuan(c.estimate.cents)}{c.estimate.observedAt ? ` · ${formatObserved(c.estimate.observedAt)}` : ''}</>
              : <>同芯片 {c.estimate.samples} 款中位价 约 {formatYuan(c.estimate.cents)}</>}
          </p>
        )}
        {!confirmed && c.estimate?.basis === 'reference' && c.priceTrend && <TrendLine current={c.estimate.cents} trend={c.priceTrend} />}
        {!confirmed && c.referenceCents != null && (
          <p className="muted small">{c.source === 'catalog' ? 'ZOL 参考价' : '页面标价'} {formatYuan(c.referenceCents)} · 未计入</p>
        )}
        {!confirmed && c.reasons && c.reasons.length > 0 && (
          <details className="reasons">
            <summary>为什么待核实（{c.reasons.length}）</summary>
            <ul>{c.reasons.map(r => <li key={r}>{r}</li>)}</ul>
          </details>
        )}
      </div>
      <div className="cand-actions">
        {confirmed ? (
          inBuild ? (
            <button type="button" className="btn btn-soft btn-block" onClick={onRemove} disabled={slotLocked} title={slotLocked ? '已锁定，解锁后才能移出' : undefined}>
              {slotLocked ? <Lock size={18} /> : <Check size={18} />} {slotLocked ? '已在配置中 · 已锁定' : '已加入 · 点击移出'}
            </button>
          ) : (
            <button type="button" className="btn btn-primary btn-block" onClick={() => onAdd(price)} disabled={slotLocked} title={slotLocked ? '当前部件已锁定' : undefined}>
              {slotLocked ? <Lock size={18} /> : <CirclePlus size={18} />} {slotLocked ? '部件已锁定' : slotFilled ? '替换当前配件' : '加入配置'}
            </button>
          )
        ) : c.state === 'review' ? (
          <button type="button" className="btn btn-outline btn-block" onClick={onVerify}><ShieldCheck size={18} /> 核实报价</button>
        ) : c.estimate && onAddEstimate && !inBuild ? (
          <>
            <button type="button" className="btn btn-primary btn-block" onClick={onAddEstimate} disabled={slotLocked} title={slotLocked ? '当前部件已锁定' : '按参考价估算加入，之后可改成实付价'}>
              {slotLocked ? <Lock size={18} /> : <CirclePlus size={18} />} {slotLocked ? '部件已锁定' : slotFilled ? '按估算价替换' : '按估算价加入'}
            </button>
            <button type="button" className="btn btn-text btn-block btn-sm" onClick={onVerify}><Pencil size={16} /> 手动填价</button>
          </>
        ) : inBuild && c.source === 'catalog' ? (
          <button type="button" className="btn btn-soft btn-block" onClick={onRemove} disabled={slotLocked}>
            {slotLocked ? <Lock size={18} /> : <Check size={18} />} {slotLocked ? '已在配置中 · 已锁定' : '已加入 · 点击移出'}
          </button>
        ) : (
          <button type="button" className="btn btn-outline btn-block" onClick={onVerify}><Pencil size={18} /> 手动填价</button>
        )}
        {c.url && (
          <a className="link center" href={c.url} target="_blank" rel="noreferrer noopener">
            查看来源 <ExternalLink size={14} />
          </a>
        )}
      </div>
    </article>
  );
}
