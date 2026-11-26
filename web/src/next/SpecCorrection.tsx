import { useState } from 'react';
import { api, type CatalogItem } from '../api/client';

const FORMATS = ['MINI-ITX', 'MICRO ATX', 'ATX', 'EATX'];
const FIELDS: Record<string, [string, string][]> = {
  CPU: [['basePowerWatts', '基础功耗 W'], ['maxPowerWatts', '最大功耗 W'], ['sustainedPowerWatts', '持续多核功耗 W']],
  MOTHERBOARD: [['pcieGen', '显卡插槽 PCIe 版本'], ['cpuPowerLimitWatts', '实际 CPU 持续功耗限制 W']],
  CASE: [['maxGpuLengthMm', '显卡最大长度 mm'], ['maxGpuHeightMm', '显卡最大高度 mm'], ['maxGpuThicknessMm', '显卡最大厚度 mm'], ['expansionSlots', '扩展槽数'], ['maxPsuLengthMm', '电源最大长度 mm'], ['maxCoolerHeightMm', '散热器最大高度 mm'], ['includedFans', '预装风扇数量'], ['requiredFanCostCents', '另购风扇成本（分）']],
  COOLER: [['heightMm', '风冷高度 mm'], ['vendorCoolingWatts', '厂商标称散热 W（不能替代温度实测）']],
};
export function SpecCorrection({ part, onSaved }: { part: CatalogItem; onSaved: (text: string) => void }) {
  const [sourceUrl, setSource] = useState('');
  const [note, setNote] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [formats, setFormats] = useState<string[]>([]);
  const [format, setFormat] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const specs: Record<string, unknown> = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== '').map(([k, v]) => [k, Number(v)]));
    if (part.category === 'CASE' && formats.length) specs.supportedBoardFormats = formats;
    if (part.category === 'MOTHERBOARD' && format) specs.formFactor = format;
    if (!Object.keys(specs).length) return onSaved('先填写需要修正的规格');
    setBusy(true);
    try { await api.correctSpecs(part.id, { specs, sourceUrl, note }); onSaved('规格修正已保存，下次生成方案立即使用；已保存方案保留原始快照'); }
    catch (e) { onSaved(e instanceof Error ? e.message : '修正失败'); }
    finally { setBusy(false); }
  };
  return <details className="nx-panel"><summary>修正 {part.name} 的规格</summary>
    <p className="nx-muted">填写有资料依据的字段。厂商标称散热不等同于持续温度测试；未填字段保留原值。</p>
    <div className="nx-price-form">
      {part.category === 'MOTHERBOARD' && <label>主板板型<select value={format} onChange={e => setFormat(e.target.value)}><option value="">不修改</option>{FORMATS.map(f => <option key={f}>{f}</option>)}</select></label>}
      {part.category === 'CASE' && <fieldset><legend>明确支持的主板规格</legend>{FORMATS.map(f => <label key={f}><input type="checkbox" checked={formats.includes(f)} onChange={e => setFormats(a => e.target.checked ? [...a, f] : a.filter(v => v !== f))} />{f}</label>)}</fieldset>}
      {(FIELDS[part.category] ?? []).map(([key, label]) => <label key={key}>{label}<input inputMode="decimal" value={values[key] ?? ''} placeholder={part.specs[key] == null ? '未知' : String(part.specs[key])} onChange={e => setValues(a => ({ ...a, [key]: e.target.value }))} /></label>)}
      <label className="wide">官方资料或测试来源链接（必填）<input type="url" value={sourceUrl} onChange={e => setSource(e.target.value)} placeholder="https://…" /></label>
      <label className="wide">修正依据<input value={note} onChange={e => setNote(e.target.value)} maxLength={1000} /></label>
      <button type="button" className="nx-btn nx-btn-outline" disabled={busy || !sourceUrl} onClick={() => void save()}>保存规格修正</button>
    </div>
  </details>;
}
