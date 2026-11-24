import { Monitor } from 'lucide-react';
import { useEffect, useReducer, useState } from 'react';
import { api, ApiError, type CatalogItem, type PlanResult } from '../api/client';
import { fromApi, sameContent, toApiInput } from '../api/mapping';
import { PlansDialog, type PlanSummary } from '../components/PlansDialog';
import { PriceDialog, type PriceRequest } from '../components/PriceDialog';
import { buildReducer } from '../domain/build';
import { catalogToCandidate } from '../domain/catalog';
import { buildMarkdown, downloadText } from '../domain/exportList';
import { formatYuan } from '../domain/money';
import { emptyBuild, INTEGRATED_GPU_NAME, isIntegratedGpu, planToBuild } from '../domain/plan';
import { SLOT_IDS, slotDef } from '../domain/slots';
import { loadDraft, saveDraft } from '../domain/storage';
import type { Build, Candidate, SlotId } from '../domain/types';
import { Editor } from './Editor';
import { Home, scenariosOf, type Purpose } from './Home';
import { PartPicker } from './PartPicker';
import './next.css';

/** 带核显的 CPU（与服务端规则一致）：标注了集成显卡，或 AMD G 系列 / Intel 非 F 型号 */
function cpuHasIgpu(item: CatalogItem): boolean {
  const name = item.name.toUpperCase();
  if (item.specs?.integratedGraphics) return true;
  if (/RYZEN.*\d{4}G(T|E)?\b/.test(name)) return true;
  return /INTEL|酷睿|CORE/.test(name) && !/\d{3,5}K?F\b|KF\b/.test(name);
}

const integratedGpuCandidate: Candidate = {
  id: 'igpu', slot: 'gpu', source: 'catalog', name: INTEGRATED_GPU_NAME, spec: '不配独立显卡', summarySpec: '不配独立显卡',
  store: 'other', storeLabel: '', condition: 'new', priceCents: 0, state: 'confirmed', url: null, specs: {},
};

export default function NextApp() {
  const [view, setView] = useState<'home' | 'editor'>('home');
  const [budgetYuan, setBudgetYuan] = useState(6000);
  const [purpose, setPurpose] = useState<Purpose>('game');
  const [quiet, setQuiet] = useState(false);
  const [plans, setPlans] = useState<PlanResult[] | null>(null);
  const [draft, setDraft] = useState<Build | null>(() => loadDraft());
  const [build, dispatch] = useReducer(buildReducer, undefined, () => emptyBuild(600000, ['2k'], '新方案'));
  const [saved, setSaved] = useState<Build | null>(null);
  const [saving, setSaving] = useState(false);
  const [pickerSlot, setPickerSlot] = useState<SlotId | null>(null);
  const [priceReq, setPriceReq] = useState<PriceRequest | null>(null);
  const [plansOpen, setPlansOpen] = useState(false);
  const [planList, setPlanList] = useState<{ items: PlanSummary[] | null; versions: Record<string, number>; error: string | null }>({ items: null, versions: {}, error: null });
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => { if (view === 'editor') { saveDraft(build); setDraft(build); } }, [build, view]);
  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 3000);
    return () => window.clearTimeout(id);
  }, [toast]);

  const openBuild = (b: Build, snapshot: Build | null) => {
    dispatch({ type: 'load', build: b });
    setSaved(snapshot);
    setView('editor');
  };

  const choosePlan = (plan: PlanResult) => {
    openBuild(planToBuild(plan, budgetYuan * 100, scenariosOf(purpose, quiet)), null);
    setToast(`已选 ${plan.label}，可以逐件替换或改成实付价`);
  };

  const pickItem = (item: CatalogItem) => {
    const slot = pickerSlot!;
    if (!item.estimatedPriceCents) return;
    dispatch({ type: 'addCandidate', candidate: catalogToCandidate(item, slot), priceCents: item.estimatedPriceCents, priceSource: 'estimate', note: '手动选择，价格为参考价' });
    if (slot === 'cpu' && isIntegratedGpu(build.slots.gpu.part) && !cpuHasIgpu(item)) {
      setToast('这颗 CPU 没有核显，需要再配一张独立显卡');
    } else {
      setToast(`已换成 ${item.name}`);
    }
  };

  const editPrice = (slot: SlotId) => {
    const part = build.slots[slot].part;
    if (!part) return;
    setPriceReq({
      title: '改成实付价',
      subject: `${slotDef(slot).label} · ${part.name}`,
      hint: '填你在商城看到的到手价，合计会自动更新。填 0 表示已有这个配件。',
      initialCents: part.priceCents,
      allowUnknown: true,
      onConfirm: cents => dispatch({ type: 'setPartPrice', slot, priceCents: cents }),
    });
  };

  const dirty = !saved || !sameContent(build, saved);
  const saveText = !build.serverId ? '还没保存' : dirty ? '有未保存的修改' : '已保存';

  const save = async () => {
    setSaving(true);
    try {
      const input = toApiInput(build);
      const r = build.serverId ? await api.updateBuild(build.serverId, { ...input, version: build.version! }) : await api.createBuild(input);
      const next = fromApi(r);
      setSaved(next);
      dispatch({ type: 'markSaved', serverId: r.id, version: r.version, updatedAt: r.updatedAt });
      setToast('方案已保存');
    } catch (e) {
      setToast(e instanceof ApiError && e.code === 'VERSION_CONFLICT' ? '这份方案在别处被改过，请从“我的方案”重新打开' : e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const openPlans = async () => {
    setPlansOpen(true);
    setPlanList(p => ({ ...p, items: null, error: null }));
    try {
      const items = await api.listBuilds();
      setPlanList({
        items: items.map(i => ({ id: i.id, name: i.name, filled: i.totals.filledStandardSlots, slotCount: SLOT_IDS.length, totalCents: i.totals.totalCents, budgetCents: i.budgetCents, updatedAt: i.updatedAt })),
        versions: Object.fromEntries(items.map(i => [i.id, i.version])),
        error: null,
      });
    } catch (e) {
      setPlanList({ items: [], versions: {}, error: e instanceof Error ? e.message : '读取失败' });
    }
  };

  const loadPlan = async (id: string) => {
    try {
      const b = fromApi(await api.getBuild(id));
      openBuild(b, b);
      setToast(`已打开：${b.name}`);
    } catch (e) {
      setToast(e instanceof Error ? e.message : '打开失败');
    }
  };

  const removePlan = async (id: string) => {
    try {
      await api.deleteBuild(id, planList.versions[id]);
      setToast('方案已删除');
      openPlans();
    } catch (e) {
      setToast(e instanceof Error ? e.message : '删除失败');
    }
  };

  const exportList = () => {
    downloadText(`装机清单-${build.name || '未命名方案'}.md`, buildMarkdown(build, false));
    setToast('清单已导出');
  };

  return (
    <div className="nx-app">
      <header className="nx-top">
        <span className="nx-brand"><Monitor size={22} /> 装机工作台</span>
        {view === 'editor' && <span className="nx-muted">预算 {formatYuan(build.budgetCents)}</span>}
        <button type="button" className="nx-btn nx-btn-ghost" onClick={openPlans}>我的方案</button>
      </header>

      <main className="nx-main">
        {view === 'home' ? (
          <Home
            budgetYuan={budgetYuan}
            purpose={purpose}
            quiet={quiet}
            onBudget={setBudgetYuan}
            onPurpose={p => { setPurpose(p); setPlans(null); }}
            onQuiet={q => { setQuiet(q); setPlans(null); }}
            plans={plans}
            onPlans={setPlans}
            onChoose={choosePlan}
            draft={draft}
            onResume={() => draft && openBuild(draft, null)}
          />
        ) : (
          <Editor
            build={build}
            dispatch={dispatch}
            onBack={() => setView('home')}
            onPick={setPickerSlot}
            onEditPrice={editPrice}
            onSave={save}
            saving={saving}
            saveText={saveText}
            onExport={exportList}
            onOpenPlans={openPlans}
          />
        )}
      </main>

      <PartPicker
        slot={pickerSlot}
        build={build}
        onClose={() => setPickerSlot(null)}
        onPick={pickItem}
        onIntegrated={() => { dispatch({ type: 'addCandidate', candidate: integratedGpuCandidate, priceCents: 0, priceSource: 'manual', note: '核显方案' }); setToast('已改为使用 CPU 核显'); }}
      />
      <PriceDialog request={priceReq} jdEnabled={false} onClose={() => setPriceReq(null)} />
      <PlansDialog
        open={plansOpen}
        plans={planList.items}
        error={planList.error}
        storageLabel="保存在本机。"
        currentId={build.id}
        onClose={() => setPlansOpen(false)}
        onLoad={loadPlan}
        onDelete={removePlan}
        onNew={() => setView('home')}
      />
      <div className="toast-region" role="status" aria-live="polite">{toast && <div className="toast">{toast}</div>}</div>
    </div>
  );
}
