import { AlertTriangle, CheckCircle2, ChevronDown, Copy, Crown, Gauge, Leaf, Pencil, Rocket, SearchX, XCircle } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { PlanResult, ScorePart } from '../api/client';
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

const SCORE_LABELS: Record<ScorePart, string> = { gpu: '显卡性能代理', cpu: 'CPU 性能代理', memory: '内存', storage: '硬盘', quality: '供电与散热依据', noise: '噪音实测依据', trust: '数据可信度', balance: 'CPU 与 GPU 匹配', upgrade: '升级潜力' };

/** 综合评分（0–100）与分项：分项是同一目录里候选之间的相对值，不代表实际帧数 */
function ScoreBlock({ score, office }: { score: NonNullable<PlanResult['score']>; office: boolean }) {
  const [open, setOpen] = useState(false);
  const parts = (Object.keys(SCORE_LABELS) as ScorePart[]).filter(k => score.parts[k] != null && !(office && k === 'gpu'));
  return (
    <div className="nx-plan-score">
      <button type="button" className="nx-link" aria-expanded={open} onClick={() => setOpen(v => !v)}
        title={`按用途加权的整机评分（评分配置 ${score.version}）。分项是同一配件库里候选之间的相对值，用来比较方案，不代表实际帧数或 AI 吞吐。`}>
        <Gauge size={15} aria-hidden /> 综合评分 <strong>{score.total.toFixed(1)}</strong><ChevronDown size={14} className={open ? 'rot' : ''} />
      </button>
      {open && <ul className="nx-score-parts">
        {score.performanceBasis && <li><span>{score.performanceBasis}；仅在同场景、同版本内比较</span></li>}
        {parts.map(k => (
          <li key={k}><span>{SCORE_LABELS[k]}</span><span className="nx-score-bar" aria-hidden><i style={{ width: `${score.parts[k]}%` }} /></span><span>{score.parts[k]}</span></li>
        ))}
        {score.bottleneck > 0 && <li className="warn"><span>CPU 拖后腿扣分</span><span /><span>−{score.bottleneck}</span></li>}
      </ul>}
    </div>
  );
}

export function PlanCard(props: { plan: PlanResult; budgetCents: number; scenarios: string[]; onChoose: (plan: PlanResult) => void }) {
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

function FeasibleCard({ plan, budgetCents, scenarios, onChoose }: { plan: PlanResult; budgetCents: number; scenarios: string[]; onChoose: (plan: PlanResult) => void }) {
  const [showNotes, setShowNotes] = useState(false);
  const PlanIcon = PLAN_ICONS[plan.id];
  const bySlot = new Map(plan.picks.map(p => [API_TO_SLOT[p.slot], p]));
  const gpu = bySlot.get('gpu')?.item;
  const cpu = bySlot.get('cpu')?.item;
  const hero = plan.igpu ? cpu : gpu;
  const summary = useMemo(() => compatSummary(buildChecks(planToBuild(plan, budgetCents, scenarios))), [plan, budgetCents, scenarios]);
  const diff = plan.targetCents - plan.totalCents;
  const notes = plan.notes.filter(n => !n.startsWith('价格为参考价估算'));
  const userPriced = plan.picks.filter(p => p.item.priceSource === 'user').length;
  const stalePriced = plan.picks.filter(p => p.item.priceStale).length;
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

      <p className={`nx-compat ${summary.level}`}><StatusIcon size={16} /> {plan.compatibility?.overall} · {summary.text}</p>
      {plan.picks.some(p => p.item.productStatus && p.item.productStatus !== 'new') && (
        <p className="nx-compat error" role="note">
          <AlertTriangle size={16} /> 含非全新 / 非原厂商品：{plan.picks.filter(p => p.item.productStatus && p.item.productStatus !== 'new')
            .map(p => `${p.item.name}（${({ new: '全新', used: '二手', refurbished: '翻新', modified: '改装', engineering_sample: '工程样品', unknown: '状态未知' } as const)[p.item.productStatus!]}：${p.item.productStatusReason ?? ''}）`).join('；')}。无原厂保修，稳定性、功耗与规格需自行核实。
        </p>
      )}
      {plan.recommendationStatus && <p className="nx-muted">{{ feasible: '已确认可行推荐', conditional: '条件通过，需满足指定条件', verification_required: '数据不足，待核实方案', degraded: '未达到最低使用需求的降级方案', over_budget_alternative: '超预算替代方案', infeasible: '无可行推荐' }[plan.recommendationStatus]}</p>}
      {(userPriced > 0 || stalePriced > 0) && <p className="nx-plan-budget" title="价格来源：我的价格来自“价格管理”里的记录，其余为中关村参考价或估算（非实时）">
        {userPriced > 0 && `${userPriced} 件用我的价格`}{userPriced > 0 && stalePriced > 0 && ' · '}{stalePriced > 0 && <span className="nx-stale">{stalePriced} 件价格超过有效期</span>}
      </p>}
      {plan.corePerformance?.benchmark && <p className="nx-muted"><a href={plan.corePerformance.benchmark.sourceUrl} target="_blank" rel="noreferrer">{plan.corePerformance.benchmark.title ?? plan.corePerformance.benchmark.game ?? plan.corePerformance.benchmark.id}</a> · {plan.corePerformance.benchmark.value} {plan.corePerformance.benchmark.unit}</p>}
      {plan.corePerformance?.proxy && plan.corePerformance.metric != null && <p className="nx-muted">{plan.corePerformance.proxy} {plan.corePerformance.metric} · 性能代理</p>}
      {plan.assessment && <ul className="nx-plan-reasons">
        <li>预算 {plan.assessment.budget === 'met' ? '满足' : '超出'} · 需求 {{ met: '满足', unmet: '未达到', unverified: '待核实' }[plan.assessment.requirements]}</li>
        <li>安装 {plan.assessment.physical} · 安全 {plan.assessment.safety}{plan.assessment.needsConfirmation ? ' · 需核对' : ''}</li>
        {plan.unmetRequirements?.length ? <li>未达到 {plan.unmetRequirements.join('、')}</li> : null}
      </ul>}
      {plan.upgrades?.length ? <details className="nx-notes"><summary>预算内升级选项</summary><ul>{plan.upgrades.map(option => (
        <li key={option.picks.map(p => p.item.id).join('|')}>
          {option.picks.find(p => p.slot === 'GPU')?.item.name ?? option.picks[0]?.item.name} · {formatYuan(option.totalCents)} · {option.compatibility?.overall}
          <p>{option.reason}</p>
          <button type="button" className="nx-link" onClick={() => onChoose({ ...option, budgetCents, lockedCents: 0, notes: [option.reason] })}>查看并编辑此配置</button>
        </li>
      ))}</ul></details> : null}
      {plan.score && <ScoreBlock score={plan.score} office={scenarios.includes('office')} />}

      {plan.peripherals && plan.peripherals.picks.length > 0 && (
        <div className="nx-plan-peripherals" title={plan.peripherals.picks.map(p => `${p.item.name}：${p.reason}`).join('\n')}>
          <span>外设 <strong>{formatYuan(plan.peripherals.totalCents)}</strong><small>已计入预计总价与预算</small></span>
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

      <button type="button" className={`nx-btn ${plan.id === 'balanced' ? 'nx-btn-primary' : 'nx-btn-outline'} nx-btn-block`} onClick={() => onChoose(plan)}>
        <Pencil size={16} /> 编辑这套
      </button>
    </article>
  );
}
