import { useEffect, useMemo, useReducer, useState } from 'react';
import { api, ApiError } from './api/client';
import { fromApi, sameContent, toApiInput } from './api/mapping';
import { AddCustomButton, CandidatePanel, type SourceMode } from './components/CandidatePanel';
import { CompatStrip } from './components/CompatStrip';
import { CustomPartDialog } from './components/CustomPartDialog';
import { Hero } from './components/Hero';
import { PlansDialog, type PlanSummary } from './components/PlansDialog';
import { PriceDialog, type PriceOrigin, type PriceRequest } from './components/PriceDialog';
import { StepNav } from './components/StepNav';
import { Summary, type PriceAlert } from './components/Summary';
import { TopBar, type Connection } from './components/TopBar';
import { buildReducer, totals } from './domain/build';
import { parseQuery, type Filters } from './domain/candidates';
import { compatibility } from './domain/compat';
import { DEFAULT_QUERY, demoBuild } from './domain/demoData';
import { buildMarkdown, downloadText } from './domain/exportList';
import { formatYuan } from './domain/money';
import { SLOT_IDS, slotDef } from './domain/slots';
import { deletePlan, listPlans, loadDraft, saveDraft, savePlan } from './domain/storage';
import type { Build, Candidate, SlotId } from './domain/types';

const initialFilters = (): Record<SlotId, Filters> =>
  Object.fromEntries(
    SLOT_IDS.map(id => [id, { query: DEFAULT_QUERY[id], condition: 'new', store: 'jd', capacity: id === 'gpu' ? 16 : 'all' } satisfies Filters]),
  ) as Record<SlotId, Filters>;

function headline(missing: SlotId[]): string {
  if (missing.length === 0) return '配置齐了，检查一下再保存';
  if (missing.length === 1) return `还差${slotDef(missing[0]).missingPhrase}，配置就齐了`;
  return `还差 ${missing.length} 件配件，慢慢挑`;
}

const detached = (b: Build): Build => ({ ...b, id: `draft-${Date.now().toString(36)}`, serverId: undefined, version: undefined });

const errorText = (e: unknown) => (e instanceof ApiError ? e.message : '操作失败，请稍后重试');

export default function App() {
  const [build, dispatch] = useReducer(buildReducer, undefined, () => loadDraft() ?? demoBuild());
  const t = useMemo(() => totals(build), [build]);
  const checks = useMemo(() => compatibility(build), [build]);
  const [active, setActive] = useState<SlotId>(() => t.missing[0] ?? 'cpu');
  const [filters, setFilters] = useState(initialFilters);
  const [verified, setVerified] = useState<Record<string, number>>({});
  const [priceReq, setPriceReq] = useState<PriceRequest | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // 本地服务连接与保存状态
  const [conn, setConn] = useState<Connection>('checking');
  const [liveConfigured, setLiveConfigured] = useState(false);
  const [jdConfigured, setJdConfigured] = useState(false);
  /** 价格出处（京东联盟取价时记录链接与时间），写进配置备注 */
  const [priceOrigins, setPriceOrigins] = useState<Record<string, PriceOrigin>>({});
  const [quoteMode, setQuoteMode] = useState<SourceMode>('replay');
  /** 服务端上次确认保存的内容，用于判断是否有未保存修改 */
  const [saved, setSaved] = useState<Build | null>(null);
  const [saving, setSaving] = useState(false);
  const [plansOpen, setPlansOpen] = useState(false);
  const [plans, setPlans] = useState<{ items: PlanSummary[] | null; versions: Record<string, number>; error: string | null }>({ items: null, versions: {}, error: null });

  const online = conn === 'online';

  useEffect(() => { saveDraft(build); }, [build]);
  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 2800);
    return () => window.clearTimeout(id);
  }, [toast]);

  // 启动时连接本地服务；若草稿对应服务端方案，核对版本
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const h = await api.health();
        if (!alive) return;
        setLiveConfigured(h.quotes.liveConfigured);
        setJdConfigured(!!h.quotes.jdUnionConfigured);
        setConn('online');
      } catch {
        if (alive) setConn('offline');
        return;
      }
      if (!build.serverId) return;
      try {
        const remote = fromApi(await api.getBuild(build.serverId));
        if (!alive) return;
        setSaved(remote);
        if (remote.version !== build.version) {
          dispatch({ type: 'load', build: remote });
          setToast('已载入本地服务上的最新版本');
        }
      } catch (e) {
        if (!alive) return;
        if (e instanceof ApiError && e.code === 'BUILD_NOT_FOUND') {
          dispatch({ type: 'load', build: detached(build) });
          setToast('服务上已没有这份方案，当前内容尚未保存');
        }
      }
    })();
    return () => { alive = false; };
    // 只在启动时执行一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dirty = !saved || !sameContent(build, saved);
  const saveStatus = !online
    ? { text: conn === 'checking' ? '正在连接本地服务…' : '本地服务未连接 · 方案保存在此浏览器', dirty: false }
    : !build.serverId
      ? { text: '尚未保存到本地服务', dirty: true }
      : dirty
        ? { text: '有未保存的修改', dirty: true }
        : { text: `已保存到本地服务 · 第 ${build.version} 版`, dirty: false };

  const handleApiError = (e: unknown, fallback: string) => {
    if (e instanceof ApiError && e.code === 'NETWORK') {
      setConn('offline');
      setToast('无法连接本地服务，修改仍保留在浏览器');
    } else if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') {
      setToast('这份方案已在别处更新，请在「我的方案」中重新打开');
    } else {
      setToast(e instanceof ApiError ? e.message : fallback);
    }
  };

  const applySaved = (next: Build) => {
    setSaved(next);
    dispatch({ type: 'markSaved', serverId: next.serverId!, version: next.version!, updatedAt: next.updatedAt });
  };

  const save = async () => {
    if (!online) {
      setToast(savePlan(build) ? '方案已保存到此浏览器' : '保存失败：浏览器存储不可用');
      return;
    }
    setSaving(true);
    try {
      const input = toApiInput(build);
      const r = build.serverId
        ? await api.updateBuild(build.serverId, { ...input, version: build.version! })
        : await api.createBuild(input);
      applySaved(fromApi(r));
      setToast(`方案已保存 · 第 ${r.version} 版`);
    } catch (e) {
      handleApiError(e, '保存失败');
    } finally {
      setSaving(false);
    }
  };

  /** 服务端要求“先单独解锁、再修改”：解锁已保存的锁定槽位时立即提交这一项变化 */
  const toggleLock = async (slot: SlotId) => {
    const s = build.slots[slot];
    if (s.locked && online && build.serverId && saved?.slots[slot].locked) {
      const base: Build = { ...saved, slots: { ...saved.slots, [slot]: { ...saved.slots[slot], locked: false } } };
      try {
        const r = await api.updateBuild(build.serverId, { ...toApiInput(base), version: saved.version! });
        applySaved(fromApi(r));
      } catch (e) {
        handleApiError(e, '解锁失败');
        return;
      }
    }
    dispatch({ type: 'toggleLock', slot });
  };

  const openPlans = async () => {
    setPlansOpen(true);
    if (!online) {
      const local = listPlans().map(p => { const x = totals(p); return { id: p.id, name: p.name, filled: x.filled, slotCount: x.slotCount, totalCents: x.totalCents, budgetCents: p.budgetCents, updatedAt: p.updatedAt }; });
      setPlans({ items: local, versions: {}, error: null });
      return;
    }
    setPlans(p => ({ ...p, items: null, error: null }));
    try {
      const items = await api.listBuilds();
      setPlans({
        items: items.map(i => ({ id: i.id, name: i.name, filled: i.totals.filledStandardSlots, slotCount: SLOT_IDS.length, totalCents: i.totals.totalCents, budgetCents: i.budgetCents, updatedAt: i.updatedAt })),
        versions: Object.fromEntries(items.map(i => [i.id, i.version])),
        error: null,
      });
    } catch (e) {
      setPlans({ items: [], versions: {}, error: errorText(e) });
    }
  };

  const confirmDiscard = () => !dirty || !online || window.confirm('当前方案有未保存的修改，确定离开吗？');

  const loadPlan = async (id: string) => {
    if (id === build.id || !confirmDiscard()) return;
    if (!online) {
      const p = listPlans().find(x => x.id === id);
      if (p) { dispatch({ type: 'load', build: p }); setToast(`已打开方案：${p.name}`); }
      return;
    }
    try {
      const b = fromApi(await api.getBuild(id));
      dispatch({ type: 'load', build: b });
      setSaved(b);
      setToast(`已打开方案：${b.name}`);
    } catch (e) {
      handleApiError(e, '打开方案失败');
    }
  };

  const removePlan = async (id: string) => {
    if (!online) {
      deletePlan(id);
      openPlans();
      return;
    }
    try {
      await api.deleteBuild(id, plans.versions[id]);
      if (id === build.serverId) {
        dispatch({ type: 'load', build: detached(build) });
        setSaved(null);
      }
      setToast('方案已删除');
      openPlans();
    } catch (e) {
      handleApiError(e, '删除失败');
    }
  };

  const newPlan = async () => {
    if (!confirmDiscard()) return;
    if (!online) {
      dispatch({ type: 'load', build: { ...demoBuild(), id: `plan-${Date.now().toString(36)}`, name: '新方案' } });
      return;
    }
    try {
      dispatch({ type: 'load', build: fromApi(await api.template()) });
      setSaved(null);
    } catch (e) {
      handleApiError(e, '新建失败');
    }
  };

  const emptyHint = (id: SlotId) => {
    const f = filters[id];
    const { tokens, capacityGB } = parseQuery(f.query);
    const cap = f.capacity !== 'all' && !online ? f.capacity : capacityGB;
    const model = tokens.length ? f.query.replace(/\b\d{1,2}\s*G(?:B)?\b/gi, '').trim() : '';
    return [model, cap ? `${cap}GB` : ''].filter(Boolean).join(' · ') || undefined;
  };

  const verify = (c: Candidate) =>
    setPriceReq({
      title: c.state === 'review' ? '核实报价' : '手动填价',
      subject: c.name,
      hint: c.state === 'review'
        ? `页面价格带有条件或未通过校验（${c.reviewNote ?? '待核实'}${c.referenceCents != null ? `，页面标价 ${formatYuan(c.referenceCents)}` : ''}）。请打开来源页，按实际到手价填写；确认后才能加入配置。`
        : c.source === 'catalog'
          ? `型号目录不含报价${c.referenceCents != null ? `（ZOL 参考价 ${formatYuan(c.referenceCents)}，非实时）` : ''}。填写你在商城确认过的价格后即可加入配置。`
          : '没有可归属到这件商品的价格。填写你确认过的价格后即可加入配置。',
      initialCents: verified[c.id] ?? null,
      sourceUrl: c.url ?? undefined,
      jdLink: c.url && /^https:\/\/item(\.m)?\.jd\.com\//.test(c.url) ? c.url : undefined,
      onConfirm: (cents, origin) => {
        if (cents == null) return;
        setVerified(v => ({ ...v, [c.id]: cents }));
        setPriceOrigins(o => ({ ...o, [c.id]: origin }));
        setToast(`已记录 ${formatYuan(cents)}，可以加入配置`);
      },
    });

  const editPartPrice = (id: SlotId) => {
    const part = build.slots[id].part;
    if (!part) return;
    setPriceReq({
      title: '修改手动价',
      subject: `${slotDef(id).label} · ${part.name}`,
      hint: '手动价格只会由你在这里修改，重新查价不会覆盖它。填 0 表示已有配件，留空表示价格未知。',
      initialCents: part.priceCents,
      allowUnknown: true,
      onConfirm: cents => dispatch({ type: 'setPartPrice', slot: id, priceCents: cents }),
    });
  };

  const addCandidate = (c: Candidate, price: number, asEstimate = false) => {
    if (asEstimate && c.estimate) {
      const e = c.estimate;
      const note = e.basis === 'reference'
        ? `按 ZOL 参考价估算${e.observedAt ? `（${new Date(e.observedAt).toLocaleDateString('zh-CN')}）` : ''}`
        : `按同芯片同显存 ${e.samples} 款参考价中位数估算`;
      dispatch({ type: 'addCandidate', candidate: c, priceCents: price, priceSource: 'estimate', note });
      setToast('已按估算价加入，点右侧价格可改成实付价');
      return;
    }
    const userVerified = verified[c.id] != null;
    const priceSource = c.source === 'demo' && !userVerified ? 'demo' : 'manual';
    const origin = priceOrigins[c.id];
    const jdNote = origin?.kind === 'jd'
      ? `京东联盟京东价（未含优惠），查询于 ${new Date(origin.observedAt!).toLocaleString('zh-CN')}，${origin.jdUrl}`
      : null;
    const note = jdNote ?? (c.source === 'catalog'
      ? `型号来自${c.storeLabel}目录，价格为手动填写`
      : userVerified
      ? '用户核对来源页后手动填价'
      : c.verified ? `查价校验通过（${c.source === 'live' ? '实时' : '回放'}，观察于 ${c.observedAt ?? '未知时间'}）` : '');
    dispatch({ type: 'addCandidate', candidate: c, priceCents: price, priceSource, note });
    const next = SLOT_IDS.find(id => id !== c.slot && !build.slots[id].part);
    setToast(`已加入配置${next ? `，下一步：${slotDef(next).label}` : ''}`);
  };

  const [refreshing, setRefreshing] = useState(false);
  const [alerts, setAlerts] = useState<PriceAlert[]>([]);

  // 价格提醒：已选配件对应的目录参考价有变化时提示（估算价可一键刷新；手动价只提示，不改）
  const catalogKey = SLOT_IDS.map(id => {
    const p = build.slots[id].part;
    return p?.catalogId ? `${id}:${p.catalogId}:${p.priceCents}:${p.priceSource}:${build.slots[id].locked}` : '';
  }).join('|');
  useEffect(() => {
    if (!online) { setAlerts([]); return; }
    const targets = SLOT_IDS.filter(id => {
      const p = build.slots[id].part;
      return p?.catalogId && p.priceCents != null && p.priceSource !== 'demo';
    });
    if (!targets.length) { setAlerts([]); return; }
    let alive = true;
    (async () => {
      const found: PriceAlert[] = [];
      for (const id of targets) {
        const part = build.slots[id].part!;
        try {
          const item = await api.catalogItem(part.catalogId!);
          const now = item.estimatedPriceCents;
          if (!now || now === part.priceCents) continue;
          if (part.priceSource === 'estimate' && !build.slots[id].locked) found.push({ slot: id, label: slotDef(id).label, kind: 'estimate', fromCents: part.priceCents!, toCents: now });
          else if (part.priceSource === 'manual' && now < part.priceCents!) found.push({ slot: id, label: slotDef(id).label, kind: 'cheaper', fromCents: part.priceCents!, toCents: now });
        } catch { /* 目录读不到时不提醒 */ }
      }
      if (alive) setAlerts(found);
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online, catalogKey]);
  /** 按目录最新参考价刷新估算价：手动价、锁定的配件不会被改 */
  const refreshEstimates = async () => {
    const targets = SLOT_IDS.filter(id => {
      const s = build.slots[id];
      return !s.locked && s.part?.priceSource === 'estimate' && s.part.catalogId;
    });
    if (!targets.length) { setToast('没有可刷新的估算价（锁定的配件不会刷新）'); return; }
    setRefreshing(true);
    let changed = 0;
    let failed = 0;
    for (const id of targets) {
      try {
        const item = await api.catalogItem(build.slots[id].part!.catalogId!);
        if (item.estimatedPriceCents && item.estimatedPriceCents !== build.slots[id].part!.priceCents) {
          const note = item.estimateBasis === 'reference'
            ? `按 ZOL 参考价估算${item.priceObservedAt ? `（${new Date(item.priceObservedAt).toLocaleDateString('zh-CN')}）` : ''}`
            : `按同芯片同显存 ${item.estimateSamples} 款参考价中位数估算`;
          dispatch({ type: 'setEstimate', slot: id, priceCents: item.estimatedPriceCents, note });
          changed++;
        }
      } catch {
        failed++;
      }
    }
    setRefreshing(false);
    setToast(changed ? `已更新 ${changed} 件估算价${failed ? `，${failed} 件读取失败` : ''}` : failed ? '读取目录失败，请确认本地服务已启动' : '估算价没有变化');
  };

  const exportList = () => {
    downloadText(`装机清单-${build.name || '未命名方案'}.md`, buildMarkdown(build, t.demoPriceCount > 0));
    setToast('清单已导出为 Markdown 文件');
  };

  return (
    <>
      <TopBar connection={conn} onPlans={openPlans} onExport={exportList} />
      <main className="page">
        <Hero
          build={build}
          title={headline(t.missing)}
          onBudget={cents => dispatch({ type: 'setBudget', cents })}
          onRename={name => dispatch({ type: 'rename', name })}
          onScenario={key => dispatch({ type: 'toggleScenario', key })}
        />
        <div className="layout">
          <div className="main-col">
            <StepNav build={build} active={active} onSelect={setActive} />
            <CandidatePanel
              key={`${active}-${conn}`}
              slot={active}
              build={build}
              filters={filters[active]}
              onFilters={f => setFilters(all => ({ ...all, [active]: f }))}
              verified={verified}
              onAdd={addCandidate}
              onRemove={() => dispatch({ type: 'removePart', slot: active })}
              onVerify={verify}
              backend={{ online, liveConfigured, mode: quoteMode, onMode: setQuoteMode }}
              footer={<CompatStrip checks={checks} action={<AddCustomButton onClick={() => setCustomOpen(true)} />} />}
            />
          </div>
          <div className="side-col">
            <Summary
              build={build}
              totals={t}
              active={active}
              onSelect={setActive}
              onToggleLock={toggleLock}
              onEditPrice={editPartPrice}
              onRemoveCustom={id => dispatch({ type: 'removeCustom', id })}
              onSave={save}
              saving={saving}
              saveStatus={saveStatus}
              emptyHint={emptyHint}
              onRefreshEstimates={online ? refreshEstimates : undefined}
              refreshing={refreshing}
              alerts={alerts}
            />
          </div>
        </div>
      </main>

      <PriceDialog request={priceReq} jdEnabled={online && jdConfigured} onClose={() => setPriceReq(null)} />
      <CustomPartDialog open={customOpen} onClose={() => setCustomOpen(false)} onAdd={part => dispatch({ type: 'addCustom', part })} />
      <PlansDialog
        open={plansOpen}
        plans={plans.items}
        error={plans.error}
        storageLabel={online ? '方案保存在本地服务（.runtime/builds.json）。' : '本地服务未连接，下面是保存在此浏览器里的方案。'}
        currentId={build.id}
        onClose={() => setPlansOpen(false)}
        onLoad={loadPlan}
        onDelete={removePlan}
        onNew={newPlan}
      />
      <div className="toast-region" role="status" aria-live="polite">
        {toast && <div className="toast">{toast}</div>}
      </div>
    </>
  );
}
