import { Download, Loader2, Plus, Tags, Trash2, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, type CatalogItem, type PriceCondition, type PriceRecord } from '../api/client';
import { SLOT_TO_API } from '../api/mapping';
import { downloadText } from '../domain/exportList';
import { formatYuan } from '../domain/money';
import { ALL_SLOTS } from '../domain/slots';
import type { SlotId } from '../domain/types';
import { SearchSuggest } from './SearchSuggest';
import { useCatalogItems } from './data';
import { SpecCorrection } from './SpecCorrection';

const CONDITIONS: Record<PriceCondition, string> = { new: '全新', 'old-stock': '库存新品', used: '二手', refurbished: '翻新', oem: 'OEM / 拆机' };
const TYPES = { manual: '手动输入', verified: '已核实商城报价', reference: '商品参考价', estimate: '历史估算' } as const;
const STOCK = { unknown: '库存未知', in_stock: '有货', out_of_stock: '无货' } as const;
const DAY = 86400000;

const daysAgo = (iso: string) => Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / DAY));
const yuanToCents = (text: string) => {
  const n = Number(text.replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
};

interface Draft { sku: string; price: string; shipping: string; sourceName: string; sourceUrl: string; condition: PriceCondition; stockStatus: keyof typeof STOCK; priceType: 'manual' | 'verified'; observedAt: string; quotedAt: string; note: string }
const today = () => {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};
const emptyDraft = (): Draft => ({ sku: '', price: '', shipping: '', sourceName: '', sourceUrl: '', condition: 'new', stockStatus: 'unknown', priceType: 'manual', observedAt: today(), quotedAt: '', note: '' });

/**
 * 价格管理：你自己录入的价格（与配件规格分开存放）。
 * 方案推荐里选“优先我的价格”时，有记录的配件用最新一条（含运费），其余仍用中关村参考价估算。
 * 这里不抓取电商实时价；手动录入超过 30 天标为过期。
 */
export function PriceManager({ onToast }: { onToast: (text: string) => void }) {
  const [records, setRecords] = useState<PriceRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [slot, setSlot] = useState<SlotId>('ram');
  const [query, setQuery] = useState('');
  const [part, setPart] = useState<CatalogItem | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [busy, setBusy] = useState(false);
  const [importErrors, setImportErrors] = useState<{ row: number; message: string }[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const names = useCatalogItems(records?.map(r => r.componentId) ?? []);

  const load = async () => {
    try { setRecords(await api.prices()); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : '读取价格记录失败'); setRecords([]); }
  };
  useEffect(() => { void load(); }, []);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft(d => ({ ...d, [key]: value }));

  const add = async () => {
    const priceCents = yuanToCents(draft.price);
    if (!part) return onToast('先搜索并选择配件');
    if (priceCents == null) return onToast('请填写价格');
    setBusy(true);
    try {
      await api.addPrice({
        componentId: part.id, priceCents, shippingCents: yuanToCents(draft.shipping) ?? 0,
        sourceName: draft.sourceName.trim() || '手动输入', sourceUrl: draft.sourceUrl.trim() || null,
        condition: draft.condition, stockStatus: draft.stockStatus, priceType: draft.priceType,
        sku: draft.sku.trim() || null, observedAt: draft.observedAt === today() ? new Date().toISOString() : new Date(draft.observedAt + 'T00:00:00').toISOString(), note: draft.note.trim(),
        quotedAt: draft.priceType === 'verified' && draft.quotedAt ? new Date(`${draft.quotedAt}T00:00:00`).toISOString() : null,
      });
      onToast(`已记录 ${part.name} ${formatYuan(priceCents)}`);
      setDraft(d => ({ ...emptyDraft(), sourceName: d.sourceName }));
      await load();
    } catch (e) {
      onToast(e instanceof Error ? e.message : '保存失败');
    } finally { setBusy(false); }
  };

  const remove = async (id: string) => {
    try { await api.deletePrice(id); await load(); onToast('已删除这条价格'); }
    catch (e) { onToast(e instanceof Error ? e.message : '删除失败'); }
  };

  const importFile = async (file: File) => {
    if (file.size > 4 * 1024 ** 2) return onToast('文件不能超过 4 MB');
    const format = /\.json$/i.test(file.name) ? 'json' : 'csv';
    setBusy(true);
    try {
      const result = await api.importPrices(format, await file.text());
      setImportErrors(result.errors);
      onToast(`导入 ${result.imported} 条${result.errors.length ? `，${result.errors.length} 行有错误未导入` : ''}`);
      await load();
    } catch (e) {
      onToast(e instanceof Error ? e.message : '导入失败');
    } finally { setBusy(false); }
  };

  const exportAs = async (format: 'csv' | 'json') => {
    try {
      if (format === 'csv') downloadText('我的配件价格.csv', await api.exportPricesCsv(), 'text/csv;charset=utf-8');
      else downloadText('我的配件价格.json', JSON.stringify(await api.exportPricesJson(), null, 2), 'application/json');
    } catch (e) { onToast(e instanceof Error ? e.message : '导出失败'); }
  };

  const sorted = [...(records ?? [])].sort((a, b) => b.observedAt.localeCompare(a.observedAt));

  return (
    <div className="nx-page nx-prices">
      <header className="nx-page-head">
        <h1>价格管理</h1>
        <p className="nx-muted">记录你在商城、线下或二手平台看到的价格。方案推荐选“优先我的价格”时使用；不会联网抓取实时价。</p>
      </header>

      <section className="nx-panel" aria-labelledby="nx-price-add">
        <h2 id="nx-price-add"><Tags size={20} /> 录入价格</h2>
        <div className="nx-price-form">
          <label>配件类别
            <select value={slot} onChange={e => { setSlot(e.target.value as SlotId); setPart(null); setQuery(''); }}>
              {ALL_SLOTS.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </label>
          <div className="wide">
            <SearchSuggest category={SLOT_TO_API[slot]} market="cn" slot={slot} value={query} onChange={v => { setQuery(v); setPart(null); }}
              onSubmit={() => undefined} onChoose={item => { setPart(item); setQuery(item.name); }} />
            <small className="nx-muted">{part ? `已选：${part.name}${part.estimatedPriceCents ? ` · 参考价 ${formatYuan(part.estimatedPriceCents)}` : ''}` : '输入型号后从联想列表里选'}</small>
          </div>
          <label>价格（元）<input inputMode="decimal" value={draft.price} onChange={e => set('price', e.target.value)} placeholder="到手价" /></label>
          <label>运费（元）<input inputMode="decimal" value={draft.shipping} onChange={e => set('shipping', e.target.value)} placeholder="0" /></label>
          <label>状况
            <select value={draft.condition} onChange={e => set('condition', e.target.value as PriceCondition)}>
              {Object.entries(CONDITIONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <label>库存
            <select value={draft.stockStatus} onChange={e => set('stockStatus', e.target.value as Draft['stockStatus'])}>
              {Object.entries(STOCK).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <label>来源<input value={draft.sourceName} onChange={e => set('sourceName', e.target.value)} placeholder="如 京东自营、闲鱼、线下店" maxLength={80} /></label>
          <label className="wide">来源链接（可选，HTTPS）<input value={draft.sourceUrl} onChange={e => set('sourceUrl', e.target.value)} placeholder="https://…" /></label>
          <label>类型
            <select value={draft.priceType} onChange={e => set('priceType', e.target.value as Draft['priceType'])} title="已核实商城报价需要填写来源链接">
              <option value="manual">手动输入</option>
              <option value="verified">已核实商城报价</option>
            </select>
          </label>
          <label>商品 SKU<input value={draft.sku} onChange={e => set('sku', e.target.value)} maxLength={80} /></label>
          <label>看到的日期<input type="date" value={draft.observedAt} max={today()} onChange={e => set('observedAt', e.target.value)} /></label>
          {draft.priceType === 'verified' && <label>实际报价日期（可选）<input type="date" value={draft.quotedAt} max={draft.observedAt || today()} onChange={e => set('quotedAt', e.target.value)} /></label>}
          <label className="wide">备注<input value={draft.note} onChange={e => set('note', e.target.value)} maxLength={200} /></label>
          <button type="button" className="nx-btn nx-btn-primary" onClick={() => void add()} disabled={busy || !part}>{busy ? <Loader2 className="spin" /> : <Plus size={17} />}保存</button>
        </div>
      </section>

      {part && <SpecCorrection key={part.id} part={part} onSaved={onToast} />}
      <section className="nx-panel">
        <h2>配件数据质量</h2>
        <p className="nx-muted">检查价格倒挂、老型号库存、估算价时间和缺失规格，保留原始价格与来源供复核。</p>
        <button type="button" className="nx-btn nx-btn-outline" onClick={() => { void api.qualityReport().then(report => { downloadText('配件数据质量报告.json', JSON.stringify(report, null, 2), 'application/json'); onToast(`已导出 ${report.itemCount} 件配件的数据质量报告`); }).catch(e => onToast(e instanceof Error ? e.message : '读取失败')); }}>导出数据质量报告</button>
      </section>

      <section className="nx-panel" aria-labelledby="nx-price-list">
        <header className="nx-section-head">
          <h2 id="nx-price-list">我的价格 {records ? <span className="nx-muted">{records.length} 条</span> : null}</h2>
          <div className="nx-prices-tools">
            <button type="button" className="nx-btn nx-btn-outline" onClick={() => fileRef.current?.click()} disabled={busy} title="CSV 表头至少包含 componentId、priceCents（分）；也可导入本页导出的 JSON"><Upload size={16} />导入 CSV / JSON</button>
            <input ref={fileRef} type="file" accept=".csv,.json,text/csv,application/json" hidden onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void importFile(f); }} />
            <button type="button" className="nx-btn nx-btn-outline" onClick={() => void exportAs('csv')}><Download size={16} />导出 CSV</button>
            <button type="button" className="nx-btn nx-btn-outline" onClick={() => void exportAs('json')}><Download size={16} />导出 JSON</button>
          </div>
        </header>
        {importErrors.length > 0 && <ul className="nx-prices-errors" aria-label="导入错误">{importErrors.map(e => <li key={e.row}>第 {e.row} 行：{e.message}</li>)}</ul>}
        {error && <p className="nx-error" role="alert">{error}</p>}
        {records == null ? <Loader2 className="spin" /> : !records.length ? <p className="nx-muted">还没有记录。录入后，在方案推荐里把价格模式改成“优先我的价格”即可使用。</p> : (
          <div className="nx-table-scroll">
            <table className="nx-prices-table">
              <thead><tr><th>配件</th><th>价格</th><th>状况</th><th>来源</th><th>日期</th><th><span className="sr-only">操作</span></th></tr></thead>
              <tbody>
                {sorted.map(r => {
                  const item = names[r.componentId];
                  const age = daysAgo(r.observedAt);
                  const reference = item?.estimatedPriceCents;
                  return (
                    <tr key={r.id}>
                      <td>{item?.name ?? r.componentId}{r.sku && <div className="nx-muted small">SKU {r.sku}</div>}{r.note && <div className="nx-muted small">{r.note}</div>}</td>
                      <td className="nx-amount" title={reference ? `参考价 ${formatYuan(reference)}` : undefined}>
                        {formatYuan(r.priceCents)}{r.shippingCents > 0 && <div className="nx-muted small">+运费 {formatYuan(r.shippingCents)}</div>}
                      </td>
                      <td>{CONDITIONS[r.condition]}{r.stockStatus !== 'unknown' && ` · ${STOCK[r.stockStatus]}`}</td>
                      <td>{r.sourceUrl ? <a href={r.sourceUrl} target="_blank" rel="noreferrer noopener">{r.sourceName}</a> : r.sourceName}<div className="nx-muted small">{TYPES[r.priceType]}</div></td>
                      <td>{new Date(r.observedAt).toLocaleDateString('zh-CN')}{r.quotedAt && <div className="nx-muted small">报价 {new Date(r.quotedAt).toLocaleDateString('zh-CN')}</div>}{age > 30 && <div className="nx-stale small">已过期（{age} 天前）</div>}</td>
                      <td><button type="button" className="nx-icon-btn nx-remove" aria-label={`删除 ${item?.name ?? r.componentId} 的价格`} onClick={() => void remove(r.id)}><Trash2 size={15} /></button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
