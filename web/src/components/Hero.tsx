import { ChevronDown, ChevronUp, Gamepad2, Sparkles, VolumeX } from 'lucide-react';
import { useEffect, useState } from 'react';
import { BUDGET_MAX, BUDGET_MIN } from '../domain/build';
import { SCENARIOS } from '../domain/scenarios';
import type { Build } from '../domain/types';

const SCENARIO_ICONS = { '2k': Gamepad2, quiet: VolumeX } as const;
const STEP = 50000;

interface Props {
  build: Build;
  title: string;
  onBudget: (cents: number) => void;
  onRename: (name: string) => void;
  onScenario: (key: string) => void;
  /** 按预算自动配（需要连接本地服务） */
  onAutoBuild?: () => void;
}

export function Hero({ build, title, onBudget, onRename, onScenario, onAutoBuild }: Props) {
  const [text, setText] = useState(String(build.budgetCents / 100));
  const [focused, setFocused] = useState(false);
  useEffect(() => setText(String(build.budgetCents / 100)), [build.budgetCents]);

  const commit = () => {
    const n = Number(text);
    if (Number.isFinite(n) && n > 0) onBudget(Math.round(n) * 100);
    else setText(String(build.budgetCents / 100));
  };
  const nudge = (d: number) => onBudget(build.budgetCents + d);
  const pct = ((build.budgetCents - BUDGET_MIN) / (BUDGET_MAX - BUDGET_MIN)) * 100;

  return (
    <section className="hero">
      <div className="hero-title">
        <h1>{title}</h1>
        <input
          className="plan-name"
          value={build.name}
          onChange={e => onRename(e.target.value)}
          aria-label="方案名称"
          placeholder="未命名方案"
          maxLength={40}
        />
      </div>

      <div className="hero-budget">
        <label htmlFor="budget" className="eyebrow">预算</label>
        <div className="budget-row">
          <div className="budget-input">
            <span>¥</span>
            <input
              id="budget"
              inputMode="numeric"
              value={focused ? text : (build.budgetCents / 100).toLocaleString('zh-CN')}
              onChange={e => setText(e.target.value.replace(/[^\d]/g, ''))}
              onFocus={() => setFocused(true)}
              onBlur={() => { setFocused(false); commit(); }}
              onKeyDown={e => {
                if (e.key === 'Enter') commit();
                if (e.key === 'ArrowUp') { e.preventDefault(); nudge(STEP); }
                if (e.key === 'ArrowDown') { e.preventDefault(); nudge(-STEP); }
              }}
            />
            <span className="stepper">
              <button type="button" aria-label="预算增加 500 元" onClick={() => nudge(STEP)}><ChevronUp size={14} /></button>
              <button type="button" aria-label="预算减少 500 元" onClick={() => nudge(-STEP)}><ChevronDown size={14} /></button>
            </span>
          </div>
          <input
            type="range"
            className="slider"
            min={BUDGET_MIN}
            max={BUDGET_MAX}
            step={STEP}
            value={build.budgetCents}
            onChange={e => onBudget(Number(e.target.value))}
            style={{ ['--pct' as string]: `${pct}%` }}
            aria-label="预算滑块"
          />
        </div>
      </div>

      {onAutoBuild && (
        <button type="button" className="btn btn-outline auto-build" onClick={onAutoBuild} title="按预算和用途从型号目录挑一套兼容配置">
          <Sparkles size={18} /> 按预算自动配
        </button>
      )}

      <div className="hero-scenarios">
        <span className="eyebrow" id="scenario-label">使用场景</span>
        <div className="chips" role="group" aria-labelledby="scenario-label">
          {SCENARIOS.map(s => {
            const Icon = SCENARIO_ICONS[s.key];
            const on = build.scenarios.includes(s.key);
            return (
              <button key={s.key} type="button" className={`scenario${on ? ' is-on' : ''}`} aria-pressed={on} onClick={() => onScenario(s.key)}>
                <Icon size={18} /> {s.label}
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
