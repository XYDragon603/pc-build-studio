import { FileClock, Gamepad2, Loader2, MonitorPlay, Recycle, ShieldAlert, ShieldCheck, Sparkles, Tags, VolumeX, Wallet } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, type PlanResult, type PriceMode, type RecommendationStrategy } from '../api/client';
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
  /** 严格预算：每档不得超过本档目标预算，放不下就说明无解 */
  strict?: boolean;
  /** 价格模式：参考估算 / 优先我的价格；是否接受二手、翻新、拆机价 */
  priceMode?: PriceMode;
  allowUsed?: boolean;
  allowModified?: boolean;
  strategy?: RecommendationStrategy;
  workload?: { task?: string; game?: string; targetFps?: number; material?: string; quality?: string; minVramGB?: number; minSsdGB?: number; model?: string; benchmarkId?: string };
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
  const [strict, setStrict] = useState(generation?.strict ?? false);
  const [priceMode, setPriceMode] = useState<PriceMode>(generation?.priceMode ?? 'estimate');
  const [allowUsed, setAllowUsed] = useState(generation?.allowUsed ?? false);
  const [strategy, setStrategy] = useState<RecommendationStrategy>(generation?.strategy ?? 'balanced');
  const [minVram, setMinVram] = useState(String(generation?.workload?.minVramGB ?? ''));
  const [minSsd, setMinSsd] = useState(String(generation?.workload?.minSsdGB ?? ''));
  const [allowModified, setAllowModified] = useState(generation?.allowModified ?? false);
  const [model, setModel] = useState(generation?.workload?.model ?? '');
  const [benchmarkId, setBenchmarkId] = useState(generation?.workload?.benchmarkId ?? '');
  const [benchmarks, setBenchmarks] = useState<Awaited<ReturnType<typeof api.scenarioBenchmarks>>>([]);
  useEffect(() => {
    let active = true;
    void api.scenarioBenchmarks().then(rows => { if (active) setBenchmarks(rows); }).catch(() => undefined);
    return () => { active = false; };
  }, []);
  const [task, setTask] = useState(generation?.workload?.task ?? '');
  const [game, setGame] = useState(generation?.workload?.game ?? '');
  const [fps, setFps] = useState(String(generation?.workload?.targetFps ?? ''));
  const [material, setMaterial] = useState(generation?.workload?.material ?? '4K');
  const [quality, setQuality] = useState(generation?.workload?.quality ?? '中等');
  const tasks: Record<string, [string, string][]> = { '1080p': [['esports', '指定游戏电竞']], game: [['raster', '2K 光栅']], '4k': [['raster4k', '4K 光栅'], ['rayTracing', '4K 光追'], ['native4k', '原生渲染'], ['upscaling', '超分辨率'], ['frameGeneration', '帧生成']], creator: [['premiere', 'Premiere Pro'], ['resolve', '达芬奇'], ['capcut', '剪映'], ['blender', 'Blender 渲染']], ai: [['llm', 'LLM 推理'], ['comfyui', 'ComfyUI'], ['aiImage', 'AI 图像生成'], ['aiVideo', 'AI 视频生成'], ['videoEnhancement', 'AI 视频增强'], ['training', '训练'], ['finetuning', '微调']], office: [['office', '办公学习']] };
  const selectedTask = tasks[purpose].some(([id]) => id === task) ? task : tasks[purpose][0][0];
  const matchingBenchmarks = benchmarks.filter(b => b.task === selectedTask);
  const selectedBenchmark = matchingBenchmarks.find(b => b.id === benchmarkId);
  const workload = { task: selectedTask, ...(selectedBenchmark ? { benchmarkId: selectedBenchmark.id } : {}), ...(purpose === '1080p' ? { game: selectedBenchmark?.game ?? game, quality: selectedBenchmark?.quality ?? quality, ...(Number(fps) > 0 ? { targetFps: Number(fps) } : {}) } : {}), ...(purpose === 'creator' ? { material } : {}), ...(purpose === 'ai' ? { model: selectedBenchmark?.model ?? model, ...(Number(minVram) > 0 ? { minVramGB: Number(minVram) } : {}) } : {}), ...(Number(minSsd) > 0 ? { minSsdGB: Number(minSsd) } : {}) };

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
    && !!generation.peripherals === withPeripherals && !!generation.strict === strict
    && (generation.priceMode ?? 'estimate') === priceMode && !!generation.allowUsed === (priceMode === 'manual' && allowUsed)
    && (generation.strategy ?? 'balanced') === strategy && !!generation.allowModified === allowModified && (!generation.workload || JSON.stringify(generation.workload) === JSON.stringify(workload)) ? generation : null;
  const fullPlans = current?.plans.filter(p => !p.infeasible && p.picks.length + Number(p.igpu) + Number(p.stockCooler) === 8) ?? [];
  const lowest = fullPlans.length ? Math.min(...fullPlans.map(p => p.totalCents)) : null;

  const generate = async () => {
    const budgetCents = commitText(text) * 100;
    setLoading(true);
    setError(null);
    try {
      const used = priceMode === 'manual' && allowUsed;
      const plans = await api.plans({ budgetCents, scenarios, peripherals: withPeripherals ? ['MONITOR', 'KEYBOARD', 'MOUSE'] : [], maxOverPercent: strict ? 0 : null, priceMode, allowUsed: used, allowModified, strategy, workload });
      onPlans({ budgetCents, scenarios, peripherals: withPeripherals, strict, priceMode, allowUsed: used, allowModified, plans, strategy, workload });
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
        <div className="nx-ask-field"><label>细分任务<select value={selectedTask} onChange={e => setTask(e.target.value)}>{tasks[purpose].map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label></div>
        {purpose === '1080p' && <>
          <div className="nx-ask-field"><label>具体游戏<input value={selectedBenchmark?.game ?? game} readOnly={Boolean(selectedBenchmark?.game)} onChange={e => setGame(e.target.value)} maxLength={100} placeholder="例如 CS2" /></label></div>
          <div className="nx-ask-field"><label>目标帧率<input type="number" min={1} max={1000} value={fps} onChange={e => setFps(e.target.value)} placeholder="例如 144" /></label></div>
          <div className="nx-ask-field"><label>画质<select value={selectedBenchmark?.quality ?? quality} disabled={Boolean(selectedBenchmark?.quality)} onChange={e => setQuality(e.target.value)}>{['低', '中等', '高', '最高'].map(v => <option key={v}>{v}</option>)}</select></label></div>
        </>}
        <div className="nx-ask-field"><label>推荐策略<select value={strategy} onChange={e => setStrategy(e.target.value as RecommendationStrategy)}><option value="value">性价比优先</option><option value="balanced">均衡推荐</option><option value="performance">预算内性能优先</option></select></label></div>
        {matchingBenchmarks.length > 0 && <div className="nx-ask-field"><label>对照实测<select value={selectedBenchmark?.id ?? ''} onChange={e => setBenchmarkId(e.target.value)}>
          <option value="">通用性能参考</option>
          {matchingBenchmarks.map(b => <option key={b.id} value={b.id}>{b.title ?? b.game ?? b.id}</option>)}
        </select></label></div>}
        {purpose === 'ai' && <>
          <div className="nx-ask-field"><label>模型<input value={selectedBenchmark?.model ?? model} readOnly={Boolean(selectedBenchmark?.model)} maxLength={100} onChange={e => setModel(e.target.value)} /></label></div>
          <div className="nx-ask-field"><label>最低显存 GB<input type="number" min={1} max={512} value={minVram} onChange={e => setMinVram(e.target.value)} /></label></div>
        </>}
        <div className="nx-ask-field" title="默认按用途：办公 / 1080p 512GB，2K / 4K / 剪辑 / AI 1TB；预算够时会考虑更大容量。容量不足的方案会明确标出。"><label>最低硬盘<select value={minSsd} onChange={e => setMinSsd(e.target.value)}>
          <option value="">按用途默认</option>{[['512', '512GB'], ['1000', '1TB'], ['2000', '2TB'], ['4000', '4TB']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select></label></div>
        {purpose === 'creator' && <div className="nx-ask-field"><label>素材规格<select value={material} onChange={e => setMaterial(e.target.value)}>{['1080p', '4K', '8K'].map(v => <option key={v}>{v}</option>)}</select></label></div>}
        <label className="nx-toggle nx-quiet">
          <VolumeX size={18} aria-hidden /> 安静优先
          <input type="checkbox" role="switch" checked={quiet} onChange={e => onQuiet(e.target.checked)} />
        </label>
        <label className="nx-toggle nx-quiet" title="显示器、键盘、鼠标计入整机总预算">
          <MonitorPlay size={18} aria-hidden /> 顺带配外设
          <input type="checkbox" role="switch" checked={withPeripherals} onChange={e => setWithPeripherals(e.target.checked)} />
        </label>
        <label className="nx-toggle nx-quiet" title="每一档都不超过本档目标预算；放不下时说明原因和最低可行预算，而不是给一个超支的方案">
          <ShieldCheck size={18} aria-hidden /> 严格预算
          <input type="checkbox" role="switch" checked={strict} onChange={e => setStrict(e.target.checked)} />
        </label>
        <div className="nx-ask-field nx-ask-price">
          <Tags size={22} aria-hidden />
          <label htmlFor="nx-price-mode" title="参考估算：用中关村参考价和估算价（非实时）。优先我的价格：配件有你在“价格管理”里录入的价格时用你的，没有的仍用参考估算。">
            <span>价格模式</span>
            <select id="nx-price-mode" value={priceMode} onChange={e => setPriceMode(e.target.value as PriceMode)}>
              <option value="estimate">参考估算</option>
              <option value="manual">优先我的价格</option>
            </select>
          </label>
        </div>
        {priceMode === 'manual' && (
          <label className="nx-toggle nx-quiet" title="把你录入的二手、翻新、拆机价也纳入；默认只用全新和库存新品">
            <Recycle size={18} aria-hidden /> 接受二手价
            <input type="checkbox" role="switch" checked={allowUsed} onChange={e => setAllowUsed(e.target.checked)} />
          </label>
        )}
        <label className="nx-toggle nx-quiet" title="允许非原厂改装（如 4090 48GB 涡轮）和工程样品参与推荐。这类商品没有原厂保修，稳定性、功耗与规格需要自行核实。默认关闭。">
          <ShieldAlert size={18} aria-hidden /> 允许改装商品
          <input type="checkbox" role="switch" checked={allowModified} onChange={e => setAllowModified(e.target.checked)} />
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
              {current.plans.map(p => <PlanCard key={p.id} plan={p} budgetCents={current.budgetCents} scenarios={current.scenarios} onChoose={selected => onChoose(selected, current)} />)}
            </div>
          </>
        ) : (
          <div className="nx-plans-empty">
            {loading ? <Loader2 className="spin" size={36} /> : <Sparkles size={36} />}
            <strong>{loading ? '正在挑配件…' : generation ? '预算、用途或选项已变更，请重新出方案' : '填好预算和用途，点“出方案”'}</strong>
          </div>
        )}
      </section>
    </div>
  );
}
