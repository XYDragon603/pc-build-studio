import { FileClock, Gamepad2, Loader2, MonitorPlay, Sparkles, VolumeX, Wallet } from 'lucide-react';
import { useState } from 'react';
import { api, type PlanResult } from '../api/client';
import { formatYuan } from '../domain/money';
import { PURPOSES, purposeScenario, type Purpose } from '../domain/purposes';
import type { Build } from '../domain/types';
import { PlanCard } from './PlanCard';

const MIN = 2000;
const MAX = 30000;

export type { Purpose };

export interface PlanGeneration {
  budgetCents: number;
  scenarios: string[];
  /** 这次是否顺带配了外设（显示器、键盘、鼠标） */
  peripherals?: boolean;
  plans: PlanResult[];
}

interface Props {
  budgetYuan: number;
  purpose: Purpose;
  quiet: boolean;
  onBudget: (yuan: number) => void;
  onPurpose: (p: Purpose) => void;
  onQuiet: (q: boolean) => void;
  generation: PlanGeneration | null;
  onPlans: (generation: PlanGeneration) => void;
  onChoose: (plan: PlanResult, generation: PlanGeneration) => void;
  draft: Build | null;
  onResume: () => void;
}

export function scenariosOf(purpose: Purpose, quiet: boolean): string[] {
  return [purposeScenario(purpose), ...(quiet ? ['quiet'] : [])];
}

export function Home({ budgetYuan, purpose, quiet, onBudget, onPurpose, onQuiet, generation, onPlans, onChoose, draft, onResume }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState(String(budgetYuan));
  const [withPeripherals, setWithPeripherals] = useState(generation?.peripherals ?? false);

  const textBudget = (value: string) => {
    const n = Math.round(Number(value.replace(/[^\d]/g, '')));
    return Number.isFinite(n) && n > 0 ? Math.min(MAX, Math.max(MIN, n)) : budgetYuan;
  };
  const commitText = (value: string) => {
    const v = textBudget(value);
    onBudget(v);
    setText(String(v));
    return v;
  };

  const scenarios = scenariosOf(purpose, quiet);
  const current = generation?.budgetCents === textBudget(text) * 100 && generation.scenarios.join(',') === scenarios.join(',')
    && !!generation.peripherals === withPeripherals ? generation : null;
  const fullPlans = current?.plans.filter(p => p.picks.length + Number(p.igpu) + Number(p.stockCooler) === 8) ?? [];
  const lowest = fullPlans.length ? Math.min(...fullPlans.map(p => p.totalCents)) : null;

  const generate = async () => {
    const budgetCents = commitText(text) * 100;
    setLoading(true);
    setError(null);
    try {
      const plans = await api.plans({ budgetCents, scenarios, peripherals: withPeripherals ? ['MONITOR', 'KEYBOARD', 'MOUSE'] : [] });
      onPlans({ budgetCents, scenarios, peripherals: withPeripherals, plans });
    } catch (e) {
      setError(e instanceof Error ? e.message : '生成方案失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="nx-page nx-home">
      <header className="nx-page-head">
        <h1>方案推荐</h1>
        <p className="nx-muted">按预算、使用场景和偏好生成装机方案</p>
      </header>
      <form className="nx-panel nx-ask" onSubmit={e => { e.preventDefault(); void generate(); }}>
        <div className="nx-ask-field">
          <Wallet size={22} aria-hidden />
          <label htmlFor="nx-budget">
            <span>整机预算</span>
            <span className="nx-money">¥ <input id="nx-budget" inputMode="numeric" value={text} onChange={e => setText(e.target.value.replace(/[^\d]/g, ''))} onBlur={e => commitText(e.target.value)} /></span>
          </label>
        </div>
        <div className="nx-ask-field">
          <Gamepad2 size={22} aria-hidden />
          <label htmlFor="nx-purpose">
            <span>使用场景</span>
            <select id="nx-purpose" value={purpose} title={PURPOSES.find(p => p.id === purpose)?.hint} onChange={e => onPurpose(e.target.value as Purpose)}>
              {PURPOSES.map(p => <option key={p.id} value={p.id} title={p.hint}>{p.label}</option>)}
            </select>
          </label>
        </div>
        <label className="nx-toggle nx-quiet">
          <VolumeX size={18} aria-hidden /> 安静优先
          <input type="checkbox" role="switch" checked={quiet} onChange={e => onQuiet(e.target.checked)} />
        </label>
        <label className="nx-toggle nx-quiet" title="显示器、键盘、鼠标单独计价，不占主机预算">
          <MonitorPlay size={18} aria-hidden /> 顺带配外设
          <input type="checkbox" role="switch" checked={withPeripherals} onChange={e => setWithPeripherals(e.target.checked)} />
        </label>
        <div className="nx-ask-actions">
          {draft && <button type="button" className="nx-btn nx-btn-outline" onClick={onResume} title={draft.name}><FileClock size={17} /> 继续草稿</button>}
          <button type="submit" className="nx-btn nx-btn-primary" disabled={loading}>
            {loading ? <Loader2 className="spin" /> : <Sparkles />} 生成方案
          </button>
        </div>
      </form>
      {error && <p className="nx-error" role="alert">{error}</p>}

      <section className="nx-plans">
        {current && !loading ? (
          <>
            <div className="nx-plans-head">
              <h2>方案对比</h2>
              {lowest !== null && lowest > current.budgetCents && <p className="nx-warning" role="status">本次最低的完整方案约 {formatYuan(lowest)}，超预算 {formatYuan(lowest - current.budgetCents)}。</p>}
            </div>
            <div className={`nx-plan-grid n${current.plans.length}`}>
              {current.plans.map(p => <PlanCard key={p.id} plan={p} budgetCents={current.budgetCents} scenarios={current.scenarios} onChoose={() => onChoose(p, current)} />)}
            </div>
          </>
        ) : (
          <div className="nx-plans-empty">
            {loading ? <Loader2 className="spin" size={36} /> : <Sparkles size={36} />}
            <strong>{loading ? '正在挑配件…' : generation ? '预算、用途或外设选项已变更，请重新出方案' : '填好预算和用途，点“出方案”'}</strong>
          </div>
        )}
      </section>
    </div>
  );
}
