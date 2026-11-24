import { Folder, LayoutGrid, Layers, Monitor, PencilLine } from 'lucide-react';
import { useEffect, useReducer, useRef, useState } from 'react';
import { api, ApiError, type CatalogItem, type PlanResult } from '../api/client';
import { fromApi, sameContent, toApiInput } from '../api/mapping';
import type { PlanSummary } from '../components/PlansDialog';
import { PriceDialog, type PriceRequest } from '../components/PriceDialog';
import { buildReducer } from '../domain/build';
import { catalogToCandidate } from '../domain/catalog';
import { buildMarkdown, downloadText } from '../domain/exportList';
import { emptyBuild, INTEGRATED_GPU_NAME, isIntegratedGpu, planToBuild } from '../domain/plan';
import { SLOT_IDS, slotDef } from '../domain/slots';
import type { Build, Candidate, SlotId } from '../domain/types';
import { Editor } from './Editor';
import { Home, type PlanGeneration, type Purpose } from './Home';
import { PartPicker } from './PartPicker';
import { SavedPlans } from './SavedPlans';
import { useDraft } from './useDraft';
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

type View = 'home' | 'editor' | 'plans' | 'catalog';
const NAV = [
  { view: 'home', icon: Layers, label: '方案推荐' },
  { view: 'editor', icon: PencilLine, label: '配置编辑' },
  { view: 'plans', icon: Folder, label: '我的方案' },
  { view: 'catalog', icon: LayoutGrid, label: '配件库' },
] as const;

export default function NextApp() {
  const [view, setView] = useState<View>('home');
  const [budgetYuan, setBudgetYuan] = useState(6000);
  const [purpose, setPurpose] = useState<Purpose>('game');
  const [quiet, setQuiet] = useState(false);
  const [generation, setGeneration] = useState<PlanGeneration | null>(null);
  const [build, dispatch] = useReducer(buildReducer, undefined, () => emptyBuild(600000, ['2k'], '新方案'));
  const { draft, draftStatus } = useDraft(view === 'editor', build);
  const activeBuildId = useRef(build.id);
  const editorOpened = useRef(false);
  const [saved, setSaved] = useState<Build | null>(null);
  const [saving, setSaving] = useState(false);
  const [pickerSlot, setPickerSlot] = useState<SlotId | null>(null);
  const [priceReq, setPriceReq] = useState<PriceRequest | null>(null);
  const [catalogSlot, setCatalogSlot] = useState<SlotId>('gpu');
  const [planList, setPlanList] = useState<{ items: PlanSummary[] | null; versions: Record<string, number>; error: string | null }>({ items: null, versions: {}, error: null });
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 3000);
    return () => window.clearTimeout(id);
  }, [toast]);

  const openBuild = (b: Build, snapshot: Build | null) => {
    editorOpened.current = true;
    activeBuildId.current = b.id;
    dispatch({ type: 'load', build: b });
    setSaved(snapshot);
    setPickerSlot(null);
    setView('editor');
  };

  const choosePlan = (plan: PlanResult, request: PlanGeneration) => {
    openBuild(planToBuild(plan, request.budgetCents, request.scenarios), null);
    setPickerSlot('gpu');
    setToast(`已选 ${plan.label}，可以逐件替换或改成实付价`);
  };

  const pickItem = (slot: SlotId, item: CatalogItem, target = build) => {
    if (target.slots[slot].locked || target.slots[slot].part?.catalogId === item.id) return;
    const priceCents = item.estimatedPriceCents ?? null;
    dispatch({ type: 'addCandidate', candidate: catalogToCandidate(item, slot), priceCents, priceSource: priceCents === null ? 'manual' : 'estimate' });
    setPickerSlot(null);
    if (slot === 'cpu' && isIntegratedGpu(target.slots.gpu.part) && !cpuHasIgpu(item)) {
      setToast('这颗 CPU 没有核显，需要再配一张独立显卡');
    } else {
      setToast(priceCents === null ? `已选择 ${item.name}，请填写实付价` : `已换成 ${item.name}`);
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
      if (activeBuildId.current === build.id) {
        activeBuildId.current = r.id;
        setSaved(fromApi(r));
        dispatch({ type: 'markSaved', serverId: r.id, version: r.version, updatedAt: r.updatedAt });
      }
      setToast('方案已保存');
    } catch (e) {
      setToast(e instanceof ApiError && e.code === 'VERSION_CONFLICT' ? '这份方案在别处被改过，请从“我的方案”重新打开' : e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const refreshPlans = async () => {
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
      void refreshPlans();
    } catch (e) {
      setToast(e instanceof Error ? e.message : '删除失败');
    }
  };

  const exportList = () => {
    downloadText(`装机清单-${build.name || '未命名方案'}.md`, buildMarkdown(build, false));
    setToast('清单已导出');
  };

  const backupPlans = async () => {
    try {
      const backup = await api.backupBuilds();
      downloadText('装机方案备份.json', JSON.stringify(backup, null, 2), 'application/json');
      setToast(`已导出 ${backup.builds.length} 份方案`);
    } catch (e) {
      setToast(e instanceof Error ? e.message : '导出备份失败');
    }
  };

  const restorePlans = async (file: File) => {
    try {
      if (file.size > 16 * 1024 ** 2) throw new Error('备份文件不能超过 16 MB');
      const result = await api.restoreBuilds(JSON.parse(await file.text()));
      setToast(`已恢复 ${result.restored} 份方案，跳过 ${result.skipped} 份已有方案`);
      await refreshPlans();
    } catch (e) {
      setToast(e instanceof SyntaxError ? '备份文件不是有效的 JSON' : e instanceof Error ? e.message : '恢复失败');
    }
  };

  const navigate = (to: View) => {
    if (to === 'editor' && !editorOpened.current && draft) {
      openBuild(draft, null);
      return;
    }
    if (to === 'editor') editorOpened.current = true;
    if (to === 'plans') void refreshPlans();
    if (to !== 'editor') setPickerSlot(null);
    setView(to);
  };

  const resume = () => { if (draft) openBuild(draft, null); };
  const catalogBuild = !editorOpened.current && draft ? draft : build;

  return (
    <div className="nx-app">
      <aside className="nx-nav">
        <div className="nx-brand"><span className="nx-brand-icon"><Monitor size={24} /></span><span><strong>装机工作台</strong><small>PC Build Studio</small></span></div>
        <nav aria-label="工作台导航">
          {NAV.map(({ view: to, icon: Icon, label }) => (
            <button type="button" key={to} className={to === view ? 'on' : ''} aria-current={to === view ? 'page' : undefined} onClick={() => navigate(to)}><Icon size={20} aria-hidden />{label}</button>
          ))}
        </nav>
      </aside>

      <main className="nx-main">
        {view === 'home' && (
          <Home
            budgetYuan={budgetYuan}
            purpose={purpose}
            quiet={quiet}
            onBudget={setBudgetYuan}
            onPurpose={setPurpose}
            onQuiet={setQuiet}
            generation={generation}
            onPlans={setGeneration}
            onChoose={choosePlan}
            draft={draft}
            onResume={resume}
          />
        )}
        {view === 'editor' && (
          <Editor
            build={build}
            dispatch={dispatch}
            activeSlot={pickerSlot}
            picker={pickerSlot && <PartPicker
              key={pickerSlot}
              slot={pickerSlot}
              build={build}
              onClose={() => setPickerSlot(null)}
              onPick={item => pickItem(pickerSlot, item)}
              onIntegrated={pickerSlot === 'gpu' && !build.slots.gpu.locked ? () => {
                dispatch({ type: 'addCandidate', candidate: integratedGpuCandidate, priceCents: 0, priceSource: 'manual', note: '核显方案' });
                setPickerSlot(null);
                setToast('已改为使用 CPU 核显');
              } : undefined}
            />}
            onClosePicker={() => setPickerSlot(null)}
            onPick={setPickerSlot}
            onEditPrice={editPrice}
            onSave={save}
            saving={saving}
            saveText={saveText}
            draftStatus={draftStatus}
            onExport={exportList}
          />
        )}
        {view === 'plans' && <SavedPlans
          plans={planList.items} error={planList.error} currentId={build.id} draft={draft}
          onLoad={loadPlan} onDelete={removePlan} onResume={resume} onNew={() => navigate('home')}
          onBackup={backupPlans} onRestore={restorePlans}
        />}
        {view === 'catalog' && (
          <div className="nx-page nx-catalog">
            <header className="nx-page-head"><h1>配件库</h1><p className="nx-muted">筛选型号、比较规格和估算价</p></header>
            <PartPicker key={catalogSlot} slot={catalogSlot} build={catalogBuild} onCategory={setCatalogSlot} onPick={item => {
              if (catalogBuild !== build) openBuild(catalogBuild, null);
              editorOpened.current = true;
              pickItem(catalogSlot, item, catalogBuild);
              setView('editor');
            }} />
          </div>
        )}
      </main>

      <PriceDialog request={priceReq} jdEnabled={false} onClose={() => setPriceReq(null)} />
      <div className="toast-region" role="status" aria-live="polite">{toast && <div className="toast">{toast}</div>}</div>
    </div>
  );
}
