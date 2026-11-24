import { Briefcase, Gamepad2, Loader2, RotateCcw, Sparkles, VolumeX } from 'lucide-react';
import { useState } from 'react';
import { api, type PlanResult } from '../api/client';
import { formatYuan } from '../domain/money';
import type { Build } from '../domain/types';
import { PlanCard } from './PlanCard';

const PRESETS = [2000, 3000, 4000, 5000, 6000, 8000, 10000, 15000];
const MIN = 2000;
const MAX = 30000;

export type Purpose = 'office' | 'game';

interface Props {
  budgetYuan: number;
  purpose: Purpose;
  quiet: boolean;
  onBudget: (yuan: number) => void;
  onPurpose: (p: Purpose) => void;
  onQuiet: (q: boolean) => void;
  plans: PlanResult[] | null;
  onPlans: (plans: PlanResult[] | null) => void;
  onChoose: (plan: PlanResult) => void;
  draft: Build | null;
  onResume: () => void;
}

export function scenariosOf(purpose: Purpose, quiet: boolean): string[] {
  return [purpose === 'office' ? 'office' : '2k', ...(quiet ? ['quiet'] : [])];
}

export function Home({ budgetYuan, purpose, quiet, onBudget, onPurpose, onQuiet, plans, onPlans, onChoose, draft, onResume }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState(String(budgetYuan));

  const commitText = (value: string) => {
    const n = Math.round(Number(value.replace(/[^\d]/g, '')));
    const v = Number.isFinite(n) && n > 0 ? Math.min(MAX, Math.max(MIN, n)) : budgetYuan;
    onBudget(v);
    setText(String(v));
  };

  const generate = async () => {
    setLoading(true);
    setError(null);
    try {
      onPlans(await api.plans({ budgetCents: budgetYuan * 100, scenarios: scenariosOf(purpose, quiet) }));
    } catch (e) {
      setError(e instanceof Error ? e.message : '生成方案失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="nx-home">
      <section className="nx-ask">
        <div className="nx-ask-row">
          <div className="nx-ask-budget">
            <label htmlFor="nx-budget">预算多少？</label>
            <div className="nx-money">
              <span>¥</span>
              <input
                id="nx-budget"
                inputMode="numeric"
                value={text}
                onChange={e => setText(e.target.value.replace(/[^\d]/g, ''))}
                onBlur={e => commitText(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { commitText((e.target as HTMLInputElement).value); } }}
              />
            </div>
            <input
              type="range"
              className="nx-range"
              min={MIN}
              max={MAX}
              step={500}
              value={budgetYuan}
              onChange={e => { onBudget(Number(e.target.value)); setText(e.target.value); }}
              aria-label="预算"
            />
            <div className="nx-presets">
              {PRESETS.map(p => (
                <button key={p} type="button" className={`nx-chip${p === budgetYuan ? ' on' : ''}`} onClick={() => { onBudget(p); setText(String(p)); }}>
                  {p >= 10000 ? `${p / 10000} 万` : p}
                </button>
              ))}
            </div>
          </div>

          <div className="nx-ask-purpose">
            <span className="nx-label">主要用来</span>
            <div className="nx-purposes">
              <button type="button" className={`nx-purpose${purpose === 'game' ? ' on' : ''}`} onClick={() => onPurpose('game')}>
                <Gamepad2 /> <strong>玩游戏</strong><small>按 2K 游戏性能挑显卡</small>
              </button>
              <button type="button" className={`nx-purpose${purpose === 'office' ? ' on' : ''}`} onClick={() => onPurpose('office')}>
                <Briefcase /> <strong>办公学习</strong><small>不配独立显卡，省钱</small>
              </button>
            </div>
            <label className="nx-toggle">
              <input type="checkbox" checked={quiet} onChange={e => onQuiet(e.target.checked)} />
              <VolumeX size={16} /> 安静优先（散热、电源多花一点）
            </label>
          </div>
        </div>

        <div className="nx-ask-actions">
          <button type="button" className="nx-btn nx-btn-primary nx-btn-lg" onClick={generate} disabled={loading}>
            {loading ? <Loader2 className="spin" /> : <Sparkles />} {plans ? '重新出方案' : '出方案'}
          </button>
          {draft && (
            <button type="button" className="nx-btn nx-btn-ghost" onClick={onResume}>
              <RotateCcw size={16} /> 继续上次的方案（{draft.name || '未命名'}）
            </button>
          )}
        </div>
        {error && <p className="nx-error" role="alert">{error}</p>}
      </section>

      <section className="nx-plans">
        {plans ? (
          <>
            <div className="nx-plans-head">
              <h2>给 {formatYuan(budgetYuan * 100)} 的 {plans.length} 套方案</h2>
              <p>价格为中关村在线参考价估算，通常略高于电商实际售价；选中后可以逐件替换、改成实付价。</p>
            </div>
            <div className={`nx-plan-grid n${plans.length}`}>
              {plans.map(p => <PlanCard key={p.id} plan={p} budgetCents={budgetYuan * 100} scenarios={scenariosOf(purpose, quiet)} onChoose={() => onChoose(p)} />)}
            </div>
          </>
        ) : (
          <div className="nx-plans-empty">
            {loading ? <Loader2 className="spin" size={36} /> : <Sparkles size={36} />}
            <strong>{loading ? '正在挑配件…' : '填好预算和用途，点“出方案”'}</strong>
            <span className="nx-muted">会给出省钱版、推荐版、进阶版三套，选一套后还能逐件调整。</span>
          </div>
        )}
      </section>
    </div>
  );
}
