import { readFileSync } from 'node:fs';
import { boardFormat, hardwareDetails } from './hardware-specs.mjs';
import { normalizeBuild, buildTemplate } from './builds.mjs';
import { fieldProvenance } from './spec-provenance.mjs';
const corrections = JSON.parse(readFileSync(new URL('../data/hardware-corrections.json', import.meta.url), 'utf8'));
const byId = new Map(corrections.records.map(record => [record.id, record]));
// 2.2.1：同时按厂商料号（manufacturer SKU / mpn）关联。2.2.0 只按目录 ID 匹配，
// A21 机箱、5060 Ti WINDFORCE 两条修正的 ID 在运行时目录中不存在，修正从未生效。
const byMpn = new Map(corrections.records.flatMap(record => (record.mpn ?? []).map(sku => [sku.toUpperCase(), record])));
/**
 * 2.2.2：同一认证型号可能有多个硬件版本（如长城 GW-ATX1300BL 旧版与 G13MG ATX3.1、技嘉 PG5 Rev 1.0 / 2.0），
 * 接口规格不同。修正记录带 requiresRevision（版本标识，如 "G13MG"、料号 "5194268"、"REV 2.0"）时，
 * 只有目录条目的名称 / 料号中能找到其中之一才应用；否则不合并，记入 skippedCorrections。
 */
export function revisionMatches(record, item) {
  if (!record?.requiresRevision?.length) return true;
  const text = [item.name, item.mpn, ...(item.partNumbers ?? []), ...(item.aliases ?? []), item.specs?.hardwareRevision].filter(Boolean).join(' ').toUpperCase().replace(/s+/g, ' ');
  return record.requiresRevision.some(token => text.includes(String(token).toUpperCase()));
}
export function correctHardware(item, overrides = {}) {
  const candidate = byId.get(item.id) ?? byId.get(item.zolId) ?? (item.mpn ? byMpn.get(String(item.mpn).toUpperCase()) : undefined);
  const correction = candidate && revisionMatches(candidate, item) ? candidate : undefined;
  const skipped = candidate && !correction ? [{ id: candidate.id, reason: `修正记录要求硬件版本 ${candidate.requiresRevision.join(' / ')}，目录条目无法确认是同一版本，不合并规格` }] : null;
  let specs = { ...item.specs, ...correction?.specs, ...overrides[item.id]?.specs };
  // Platform ceiling is a general rule, not a model-specific recommendation.
  if (item.category === 'MOTHERBOARD' && /^(?:AMD\s*)?A520$/i.test(specs.chipset ?? '')) {
    specs.pcieGen = 3;
    if (specs.gpuPcieLink) specs.gpuPcieLink = { ...specs.gpuPcieLink, gen: Math.min(specs.gpuPcieLink.gen, 3) };
    if (specs.m2Links) specs.m2Links = specs.m2Links.map(l => ({ ...l, gen: Math.min(l.gen, 3) }));
  }
  const evidence = [...(specs.specEvidence ?? []), ...(correction ? [{ sourceUrl: correction.sourceUrl, verifiedOn: corrections.verifiedOn, kind: 'manufacturer-spec', note: correction.reason }] : []), ...(overrides[item.id] ? [{ sourceUrl: overrides[item.id].sourceUrl, kind: 'manual', note: overrides[item.id].note, verifiedOn: overrides[item.id].updatedAt }] : [])];
  if (evidence.length) specs.specEvidence = evidence;
  const summary = item.category === 'CASE' ? [specs.supportedBoardFormats?.join('/'), `显卡限长 ${specs.maxGpuLengthMm ?? '?'}mm`, `散热限高 ${specs.maxCoolerHeightMm ?? '?'}mm`, `冷排 ≤${specs.maxRadiatorMm ?? '?'}mm`].filter(Boolean).join(' · ')
    : item.category === 'MOTHERBOARD' ? [specs.socket, specs.chipset, specs.memoryType, boardFormat(specs.formFactor), specs.pcieGen ? `PCIe ${specs.pcieGen}.0` : null].filter(Boolean).join(' · ') : item.summary;
  const provenance = correction || overrides[item.id]
    ? fieldProvenance({ ...item, specs }, correction, overrides[item.id], corrections.verifiedOn).filter(p => ['verified', 'user-recorded'].includes(p.verification_status))
    : undefined;
  return { ...item, specs, summary, ...(correction ? { specCorrection: correction } : {}), ...(skipped ? { skippedCorrections: skipped } : {}), ...(provenance ? { fieldProvenance: provenance } : {}) };
}
export function normalizeSpecOverride(input) {
  if (!input?.specs || typeof input.specs !== 'object' || Array.isArray(input.specs)) throw new Error('specs 必须是对象');
  const sourceUrl = new URL(input.sourceUrl);
  if (sourceUrl.protocol !== 'https:' || sourceUrl.username || sourceUrl.password) throw new Error('修正规格必须带 HTTPS 来源链接');
  const allowed = new Set([...Object.keys(hardwareDetails(input.specs)), 'formFactor', 'maxBoardFormFactor', 'pcieGen', 'maxGpuLengthMm', 'maxCoolerHeightMm', 'maxRadiatorMm', 'sockets', 'socket', 'memoryType', 'chipset', 'ratedWatts', 'maxPowerWatts', 'm2Slots']);
  for (const key of Object.keys(input.specs)) if (!allowed.has(key)) throw new Error(`不支持修正字段 ${key}`);
  const template = buildTemplate();
  template.slots[0].part = { model: '规格校验', priceCents: 0, specs: input.specs };
  const validated = normalizeBuild(template).slots[0].part.specs;
  return { specs: validated, sourceUrl: sourceUrl.href, note: String(input.note ?? '').slice(0, 1000), updatedAt: new Date().toISOString() };
}
