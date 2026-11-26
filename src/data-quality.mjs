export function dataQualityReport(items, now = new Date()) {
  const issues = [];
  const add = (item, code, detail, peers = []) => issues.push({ componentId: item.id, name: item.name, code, detail, priceCents: item.estimatedPriceCents ?? null, priceType: item.priceRecord?.priceType ?? 'estimate', sourceUrl: item.priceRecord?.sourceUrl ?? item.sourceUrl ?? null, observedAt: item.priceRecord?.observedAt ?? item.priceObservedAt ?? null, stockStatus: item.priceRecord?.stockStatus ?? 'unknown', condition: item.priceRecord?.condition ?? 'unknown', peers });
  const skus = new Map();
  for (const item of items.filter(i => ['GPU', 'RAM', 'SSD'].includes(i.category) && i.mpn)) {
    const k = `${item.category}|${item.manufacturer}|${item.mpn}`.toUpperCase();
    if (!skus.has(k)) skus.set(k, []); skus.get(k).push(item);
  }
  for (const list of skus.values()) if (new Set(list.map(i => `${i.specs.capacityGB}|${i.specs.memoryType}|${i.specs.modules}`)).size > 1) {
    for (const i of list) add(i, 'sku-spec-conflict', '同一厂商料号关联了不同容量 / 条数 / 代际，需核对是否系列名冒充具体 SKU；保留各条独立记录，不自动合并', list.filter(p => p !== i).map(p => ({ id: p.id, capacityGB: p.specs.capacityGB })));
  }
  for (const list of skus.values()) if (list.length > 1) for (const i of list) {
    add(i, 'duplicate-sku', '相同厂商料号有多个目录记录，需核对市场、修订版及来源。', list.filter(p => p !== i).map(p => ({ id: p.id })));
  }
  for (const item of items) {
    if (!item.estimatedPriceCents) add(item, 'missing-price', '没有可用价格');
    if (item.priceRecord?.stockStatus !== 'in_stock' && /legacy/.test(item.priceFlags?.join(' ') ?? '')) add(item, 'legacy-stock-unverified', '老型号库存、商品状态与参考价需复核，不能从目录记录推断仍可买到新品');
    if (item.priceStale) add(item, 'stale-price', '价格已超过有效期');
    if (item.specCorrection) add(item, 'spec-corrected', item.specCorrection.reason);
    if (item.category === 'CASE' && !item.specs.thermalTests?.length) add(item, 'thermal-evidence-missing', '缺少整机风道、持续温度及噪音实测数据');
    if (item.category === 'COOLER' && !item.specs.thermalTests?.length) add(item, 'cooling-evidence-missing', '没有持续负载温度实测，厂商标称不能替代实测');
    if (item.category === 'RAM' && item.estimatedPriceCents && item.specs.capacityGB) {
      const peers = items.filter(p => p.category === 'RAM' && p.specs.memoryType === item.specs.memoryType && p.specs.modules === item.specs.modules && p.specs.capacityGB > item.specs.capacityGB && p.estimatedPriceCents > 0 && p.estimatedPriceCents < item.estimatedPriceCents);
      if (peers.length) add(item, 'capacity-price-inversion', '同代际、条数的更大容量更便宜；可能是品牌、频率、SKU 或库存差异，保留原价待核实', peers.slice(0, 8).map(p => ({ id: p.id, capacityGB: p.specs.capacityGB, speedMTs: p.specs.speedMTs, priceCents: p.estimatedPriceCents, sourceUrl: p.sourceUrl, condition: p.priceRecord?.condition ?? 'unknown' })));
    }
    if (item.priceObservedAt && Date.parse(item.priceObservedAt) > now.getTime()) add(item, 'future-price-date', '价格观察时间晚于当前时间，不作为已完成更新');
  }
  const coverage = fieldCoverage(items);
  const gaps = Object.entries(coverage).flatMap(([category, value]) => Object.entries(value.fields)
    .map(([field, stats]) => ({ category, field, ...stats }))).sort((a, b) => b.missing - a.missing);
  const evidence = items.filter(i => i.market === 'cn').flatMap(item => {
    const verified = new Map((item.fieldProvenance ?? []).map(row => [row.field_name, row]));
    return fieldProvenance(item).filter(row => KEY_FIELDS[item.category]?.includes(row.field_name) || verified.has(row.field_name))
      .map(row => verified.get(row.field_name) ?? row);
  });
  const priorityQueue = items.filter(i => i.market === 'cn' && i.estimatedPriceCents && !i.possiblyStale && KEY_FIELDS[i.category])
    .map(i => ({ id: i.id, name: i.name, category: i.category, missing: KEY_FIELDS[i.category].filter(f => i.specs[f] == null),
      sourceUrl: i.sourceUrl, lastVerifiedAt: i.fieldProvenance?.map(row => row.verified_at).filter(Boolean).sort().at(-1) ?? null }))
    .filter(i => i.missing.length).sort((a, b) => b.missing.length - a.missing.length).slice(0, 150);
  return { generatedAt: now.toISOString(), itemCount: items.length, issueCount: issues.length, counts: Object.fromEntries([...new Set(issues.map(i => i.code))].map(c => [c, issues.filter(i => i.code === c).length])),
    coverage, domesticCoverage: fieldCoverage(items.filter(i => i.market === 'cn')), gaps, evidence, priorityQueue,
    unattributedCount: evidence.filter(e => !e.source_url).length, issues };
}
import { KEY_FIELDS, fieldCoverage, fieldProvenance } from './spec-provenance.mjs';

