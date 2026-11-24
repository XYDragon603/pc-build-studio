import { AlertTriangle, CheckCircle2, ChevronDown, Crown, Leaf, Pencil, Rocket, XCircle } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { PlanResult } from '../api/client';
import { API_TO_SLOT } from '../api/mapping';
import { formatYuan } from '../domain/money';
import { buildChecks, compatSummary, gpuTier, planToBuild } from '../domain/plan';
import { SLOTS, slotDef } from '../domain/slots';
import { SLOT_ICONS } from '../components/icons';
import { Thumb } from './Thumb';

const PLAN_ICONS = { save: Leaf, balanced: Crown, plus: Rocket };
const COMPARISON_SLOTS = ['gpu', 'cpu', 'ram', 'ssd'] as const;
const COMPARISON_IDS = new Set<string>(COMPARISON_SLOTS);

export function PlanCard({ plan, budgetCents, scenarios, onChoose }: { plan: PlanResult; budgetCents: number; scenarios: string[]; onChoose: () => void }) {
  const [showNotes, setShowNotes] = useState(false);
  const PlanIcon = PLAN_ICONS[plan.id];
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
          <h3><PlanIcon size={21} />{plan.label}</h3>
          <span className="nx-muted">{gpuTier(gpu?.performance?.gaming?.index, plan.igpu)}</span>
        </div>
        {diff < 0 && <span className="nx-tag warn"><AlertTriangle size={14} />超预算 {formatYuan(-diff)}</span>}
      </header>

      <div className="nx-plan-hero">
        <div className="nx-plan-price"><span>预计总价</span><strong>{formatYuan(plan.totalCents)}</strong></div>
        <Thumb src={hero?.imageUrl} slot={plan.igpu ? 'cpu' : 'gpu'} size="xl" />
      </div>

      <ul className="nx-plan-parts">
        {COMPARISON_SLOTS.map(slotDef).map(({ id, label }) => {
          const pick = bySlot.get(id);
          const Icon = SLOT_ICONS[id];
          const name = id === 'gpu' && plan.igpu ? '使用 CPU 核显' : (pick?.item.name ?? '暂无合适型号');
          return (
            <li key={id} title={name}>
              <Icon size={16} aria-hidden />
              <span className="nx-slot">{label}</span>
              <span className="nx-part-name">{name}</span>
            </li>
          );
        })}
      </ul>

      <p className={`nx-compat ${summary.level}`}><StatusIcon size={16} /> {summary.text}</p>

      <div className="nx-notes">
        <button type="button" className="nx-link" aria-expanded={showNotes} onClick={() => setShowNotes(v => !v)}>
          <ChevronDown size={14} className={showNotes ? 'rot' : ''} /> 查看其余配件
        </button>
        {showNotes && <ul>
          {SLOTS.filter(slot => !COMPARISON_IDS.has(slot.id)).map(({ id, label }) =>
            <li key={id}>{label} · {bySlot.get(id)?.item.name ?? (id === 'cooler' && plan.stockCooler ? 'CPU 原装散热器' : '暂无合适型号')}</li>)}
          {notes.map(note => <li key={note}>{note}</li>)}
        </ul>}
      </div>

      <button type="button" className={`nx-btn ${plan.id === 'balanced' ? 'nx-btn-primary' : 'nx-btn-outline'} nx-btn-block`} onClick={onChoose}>
        <Pencil size={16} /> 编辑这套
      </button>
    </article>
  );
}
