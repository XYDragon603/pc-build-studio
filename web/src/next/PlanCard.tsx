import { AlertTriangle, CheckCircle2, ChevronDown, Copy, Crown, Leaf, Pencil, Rocket, SearchX, XCircle } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { PlanResult } from '../api/client';
import { API_TO_SLOT } from '../api/mapping';
import { formatYuan } from '../domain/money';
import { vramHint } from '../domain/purposes';
import { buildChecks, compatSummary, gpuTier, planToBuild } from '../domain/plan';
import { SLOTS, slotDef } from '../domain/slots';
import { SLOT_ICONS } from '../components/icons';
import { Thumb } from './Thumb';

const PLAN_ICONS = { save: Leaf, balanced: Crown, plus: Rocket };
const COMPARISON_SLOTS = ['gpu', 'cpu', 'ram', 'ssd'] as const;
const COMPARISON_IDS = new Set<string>(COMPARISON_SLOTS);

const TIER_NAMES = { save: '省钱版', balanced: '推荐版', plus: '进阶版' } as const;

export function PlanCard(props: { plan: PlanResult; budgetCents: number; scenarios: string[]; onChoose: () => void }) {
  return props.plan.infeasible ? <InfeasibleCard {...props} /> : <FeasibleCard {...props} />;
}

/** 本档目标预算与差额：“目标 ¥4,800（预算的 80%）· 比目标省 ¥132” */
function BudgetLine({ plan, budgetCents, totalCents }: { plan: PlanResult; budgetCents: number; totalCents: number }) {
  const target = plan.targetCents;
  const delta = totalCents - target;
  const ratio = Math.round((target / budgetCents) * 100);
  return (
    <p className="nx-plan-budget">
      目标 {formatYuan(target)}{ratio !== 100 ? `（预算的 ${ratio}%）` : ''} · {delta > 0 ? <strong className="nx-over">超出 {formatYuan(delta)}</strong> : `比目标省 ${formatYuan(-delta)}`}
      {ratio !== 100 && <> · 比输入预算{totalCents > budgetCents ? `多 ${formatYuan(totalCents - budgetCents)}` : `少 ${formatYuan(budgetCents - totalCents)}`}</>}
    </p>
  );
}

/** 这一档找不到可行方案：说明原因、最低可行预算和可以怎么调 */
function InfeasibleCard({ plan, budgetCents }: { plan: PlanResult; budgetCents: number }) {
  const PlanIcon = PLAN_ICONS[plan.id];
  return (
    <article className="nx-plan nx-plan-infeasible">
      <header className="nx-plan-head">
        <div><h3><PlanIcon size={21} />{plan.label}</h3><span className="nx-muted">目标 {formatYuan(plan.targetCents)}</span></div>
        <span className="nx-tag error"><SearchX size={14} />未找到方案</span>
      </header>
      <ul className="nx-plan-reasons">{plan.reasons?.map(r => <li key={r}>{r}</li>)}</ul>
      {plan.minFeasibleCents ? <p className="nx-plan-budget">能找到的最低完整配置约 <strong>{formatYuan(plan.minFeasibleCents)}</strong>（输入预算 {formatYuan(budgetCents)}）</p> : null}
      {plan.suggestions?.length ? <div className="nx-plan-suggest"><span>可以这样调整：</span><ul>{plan.suggestions.map(s => <li key={s}>{s}</li>)}</ul></div> : null}
    </article>
  );
}

function FeasibleCard({ plan, budgetCents, scenarios, onChoose }: { plan: PlanResult; budgetCents: number; scenarios: string[]; onChoose: () => void }) {
  const [showNotes, setShowNotes] = useState(false);
  const PlanIcon = PLAN_ICONS[plan.id];
  const bySlot = new Map(plan.picks.map(p => [API_TO_SLOT[p.slot], p]));
  const gpu = bySlot.get('gpu')?.item;
  const cpu = bySlot.get('cpu')?.item;
  const hero = plan.igpu ? cpu : gpu;
  const summary = useMemo(() => compatSummary(buildChecks(planToBuild(plan, budgetCents, scenarios))), [plan, budgetCents, scenarios]);
  const diff = plan.targetCents - plan.totalCents;
  const notes = plan.notes.filter(n => !n.startsWith('价格为参考价估算'));
  const StatusIcon = summary.level === 'ok' ? CheckCircle2 : summary.level === 'warn' ? AlertTriangle : XCircle;

  return (
    <article className={`nx-plan${plan.id === 'balanced' ? ' featured' : ''}`}>
      <header className="nx-plan-head">
        <div>
          <h3><PlanIcon size={21} />{plan.label}</h3>
          <span className="nx-muted" title={scenarios.includes('ai') && !plan.igpu ? vramHint(Number(gpu?.specs.capacityGB)) ?? undefined : undefined}>
            {scenarios.includes('ai') && !plan.igpu && gpu ? `显存 ${gpu.specs.capacityGB}GB${/RTX|GTX/i.test(String(gpu.specs.chipset)) ? ' · CUDA' : ''}` : gpuTier(gpu?.performance?.gaming?.index, plan.igpu)}
          </span>
        </div>
        {plan.sameAs ? <span className="nx-tag" title={plan.notes[0]}><Copy size={14} />与{TIER_NAMES[plan.sameAs]}相同</span>
          : diff < 0 && <span className="nx-tag warn"><AlertTriangle size={14} />超目标 {formatYuan(-diff)}</span>}
      </header>

      <div className="nx-plan-hero">
        <div className="nx-plan-price"><span>预计总价</span><strong>{formatYuan(plan.totalCents)}</strong><BudgetLine plan={plan} budgetCents={budgetCents} totalCents={plan.totalCents} /></div>
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

      {plan.peripherals && plan.peripherals.picks.length > 0 && (
        <div className="nx-plan-peripherals" title={plan.peripherals.picks.map(p => `${p.item.name}：${p.reason}`).join('\n')}>
          <span>外设 <strong>+{formatYuan(plan.peripherals.totalCents)}</strong><small>不占主机预算</small></span>
          <ul>
            {plan.peripherals.picks.map(pick => {
              const id = API_TO_SLOT[pick.slot];
              const Icon = SLOT_ICONS[id];
              return <li key={pick.slot}><Icon size={14} aria-hidden /><span className="nx-part-name">{pick.item.name}</span></li>;
            })}
          </ul>
        </div>
      )}

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
