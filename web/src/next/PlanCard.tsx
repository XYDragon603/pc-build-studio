import { AlertTriangle, CheckCircle2, ChevronDown, XCircle } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { PlanResult } from '../api/client';
import { API_TO_SLOT } from '../api/mapping';
import { formatYuan } from '../domain/money';
import { buildChecks, compatSummary, gpuTier, planToBuild } from '../domain/plan';
import { SLOTS } from '../domain/slots';
import { Thumb } from './Thumb';

const TAGLINE: Record<string, string> = { save: '够用就好', balanced: '最推荐', plus: '多花一点，更好一档' };

export function PlanCard({ plan, budgetCents, scenarios, onChoose }: { plan: PlanResult; budgetCents: number; scenarios: string[]; onChoose: () => void }) {
  const [showNotes, setShowNotes] = useState(false);
  const bySlot = new Map(plan.picks.map(p => [API_TO_SLOT[p.slot], p]));
  const gpu = bySlot.get('gpu')?.item;
  const cpu = bySlot.get('cpu')?.item;
  const hero = plan.igpu ? cpu : gpu;
  const summary = useMemo(() => compatSummary(buildChecks(planToBuild(plan, budgetCents, scenarios))), [plan, budgetCents, scenarios]);
  const diff = budgetCents - plan.totalCents;
  const notes = plan.notes.filter(n => !n.startsWith('价格为参考价估算'));
  const StatusIcon = summary.level === 'ok' ? CheckCircle2 : summary.level === 'warn' ? AlertTriangle : XCircle;

  return (
    <article className={`nx-plan${plan.id === 'balanced' ? ' featured' : ''}`}>
      <header className="nx-plan-head">
        <div>
          <h3>{plan.label}</h3>
          <span className="nx-muted">{TAGLINE[plan.id]}</span>
        </div>
        {plan.id === 'balanced' && <span className="nx-badge">推荐</span>}
      </header>

      <div className="nx-plan-hero">
        <Thumb src={hero?.imageUrl} slot={plan.igpu ? 'cpu' : 'gpu'} size="xl" />
      </div>

      <div className="nx-plan-price">
        <strong>约 {formatYuan(plan.totalCents)}</strong>
        {/* 进阶版本来就是“多花一点”，超出预算用中性语气 */}
        <span className={diff >= 0 ? 'nx-ok' : plan.id === 'plus' ? 'nx-muted' : 'nx-over'}>
          {diff >= 0 ? `比预算省 ${formatYuan(diff)}` : `比预算多 ${formatYuan(-diff)}`}
        </span>
      </div>

      <div className="nx-plan-perf">
        <span className="nx-tier">{gpuTier(gpu?.performance?.gaming?.index, plan.igpu)}</span>
        {!plan.igpu && gpu?.performance?.gaming && <span className="nx-muted">显卡 2K 性能 {gpu.performance.gaming.index}%</span>}
        {cpu?.performance?.gaming && <span className="nx-muted">CPU 游戏 {cpu.performance.gaming.index}%</span>}
      </div>

      <ul className="nx-plan-parts">
        {SLOTS.map(({ id, label }) => {
          const pick = bySlot.get(id);
          if (id === 'gpu' && plan.igpu) return <li key={id}><Thumb slot="gpu" size="sm" /><span className="nx-slot">{label}</span><span className="nx-part-name">使用 CPU 核显</span><span className="nx-price">—</span></li>;
          if (id === 'cooler' && plan.stockCooler) return <li key={id}><Thumb slot="cooler" size="sm" /><span className="nx-slot">{label}</span><span className="nx-part-name">CPU 原装散热器</span><span className="nx-price">—</span></li>;
          if (!pick) return <li key={id} className="missing"><Thumb slot={id} size="sm" /><span className="nx-slot">{label}</span><span className="nx-part-name">没有合适的型号</span><span className="nx-price" /></li>;
          return (
            <li key={id} title={pick.reason}>
              <Thumb src={pick.item.imageUrl} slot={id} size="sm" />
              <span className="nx-slot">{label}</span>
              <span className="nx-part-name">{pick.item.name}</span>
              <span className="nx-price">{formatYuan(pick.item.estimatedPriceCents ?? 0)}</span>
            </li>
          );
        })}
      </ul>

      <p className={`nx-compat ${summary.level}`}><StatusIcon size={16} /> {summary.text}</p>

      {notes.length > 0 && (
        <div className="nx-notes">
          <button type="button" className="nx-link" onClick={() => setShowNotes(v => !v)}>
            <ChevronDown size={14} className={showNotes ? 'rot' : ''} /> 说明（{notes.length}）
          </button>
          {showNotes && <ul>{notes.map(n => <li key={n}>{n}</li>)}</ul>}
        </div>
      )}

      <button type="button" className={`nx-btn ${plan.id === 'balanced' ? 'nx-btn-primary' : 'nx-btn-outline'} nx-btn-block`} onClick={onChoose}>
        选这套，逐件调整
      </button>
    </article>
  );
}
