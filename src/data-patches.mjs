// 硬件数据补丁（2.2.3）：与数据研究方（Codex）约定的独立记录格式 → 校验 → 冲突检测 → 写入运行时覆盖层 → 可回滚。
//
// 每条记录（见 docs/DATA_PATCH_SCHEMA.json）：
//   op（ADD / UPDATE / UNRESOLVED）、component_id、category、manufacturer_model、manufacturer_sku、hardware_revision、
//   field_path（如 specs.maxGpuHeightMm）、old_value、new_value、unit、source_url、source_type、observed_at、verified_at、
//   confidence、verification_status、notes
// 规则：
//   UPDATE      component_id 必须存在于目录（或能按 manufacturer_sku 唯一匹配）；old_value 与当前运行时值不一致 → 冲突，不写入
//   ADD         新配件（目录里不存在）；同一 manufacturer_model + sku 的多条 ADD 合并为一个新条目
//   UNRESOLVED  无法核实的字段：只记录，不写入任何值
//   修正记录要求硬件版本时，hardware_revision 必须能在目录名称 / 料号中找到（与 catalog-corrections 的 Rev 保护一致）
// 覆盖层文件 data/hardware-patches.json 保存每个已应用补丁及其应用前快照，可按补丁 ID 回滚。
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { hardwareDetails, HARDWARE_DETAIL_FIELDS } from './hardware-specs.mjs';

export const PATCH_OPS = ['ADD', 'UPDATE', 'UNRESOLVED'];
export const SOURCE_TYPES = ['manufacturer', 'retailer', 'third-party-test', 'manual-measurement', 'datasheet', 'other'];
export const CONFIDENCE = ['high', 'medium', 'low'];
export const VERIFICATION = ['verified', 'unverified', 'conflict', 'unresolved'];
export const CATEGORIES = ['CPU', 'GPU', 'MOTHERBOARD', 'RAM', 'SSD', 'PSU', 'CASE', 'COOLER'];
// 基础规格字段（目录已有）+ 扩展字段（HARDWARE_DETAIL_FIELDS）
const BASE_SPEC_FIELDS = ['socket', 'chipset', 'memoryType', 'formFactor', 'ratedWatts', 'maxPowerWatts', 'basePowerWatts', 'boardPowerWatts', 'lengthMm', 'heightMm', 'thicknessMm',
  'capacityGB', 'speedMTs', 'modules', 'm2Slots', 'memorySlots', 'maxMemoryGB', 'pcieGen', 'maxGpuLengthMm', 'maxCoolerHeightMm', 'maxRadiatorMm', 'radiatorSizeMm', 'sockets',
  'pcie8Count', 'pin16Count', 'native16Pin', 'atxVersion', 'efficiency', 'interface', 'nand', 'fanHeaders', 'vendorCoolingWatts', 'coolingEvidence', 'packaging', 'stockCoolerIncluded', 'supportedBoardFormats'];
export const PATCHABLE_FIELDS = new Set([...BASE_SPEC_FIELDS, ...HARDWARE_DETAIL_FIELDS]);

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const fieldOf = path => (String(path ?? '').startsWith('specs.') ? path.slice(6) : null);

/** 校验一条记录；返回错误列表（空表示通过） */
export function validateRecord(r) {
  const errors = [];
  if (!PATCH_OPS.includes(r.op)) errors.push(`op 必须是 ${PATCH_OPS.join(' / ')}`);
  if (!CATEGORIES.includes(r.category)) errors.push('category 无效');
  if (!r.component_id && !r.manufacturer_model) errors.push('component_id 为空时必须给出 manufacturer_model');
  const field = fieldOf(r.field_path);
  if (!field) errors.push('field_path 必须形如 specs.<字段>');
  else if (!PATCHABLE_FIELDS.has(field)) errors.push(`不支持的字段 ${field}`);
  if (r.op !== 'UNRESOLVED') {
    if (r.new_value === undefined || r.new_value === null) errors.push('ADD / UPDATE 必须有 new_value（无法核实请用 UNRESOLVED）');
    try { if (!/^https:\/\//.test(r.source_url ?? '')) throw new Error(); new URL(r.source_url); } catch { errors.push('source_url 必须是 HTTPS 链接'); }
    if (field && HARDWARE_DETAIL_FIELDS.includes(field) && r.new_value != null) { try { hardwareDetails({ [field]: r.new_value }); } catch (e) { errors.push(`new_value 无效：${e.message}`); } }
    if (field && /Mm$|Watts$|GB$|MTs$/.test(field) && typeof r.new_value !== 'number') errors.push(`${field} 必须是数值`);
  } else if (r.new_value != null) errors.push('UNRESOLVED 记录不能写 new_value');
  if (r.source_type != null && !SOURCE_TYPES.includes(r.source_type)) errors.push('source_type 无效');
  if (r.confidence != null && !CONFIDENCE.includes(r.confidence)) errors.push('confidence 无效');
  if (r.verification_status != null && !VERIFICATION.includes(r.verification_status)) errors.push('verification_status 无效');
  for (const k of ['observed_at', 'verified_at']) if (r[k] != null && Number.isNaN(Date.parse(r[k]))) errors.push(`${k} 不是有效时间`);
  if (r.verified_at && Date.parse(r.verified_at) > Date.now() + 86400000) errors.push('verified_at 不能是未来时间');
  return errors;
}

export function loadOverlay(path) {
  if (!existsSync(path)) return { version: 1, patches: [] };
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** 覆盖层合并结果：{ updates: Map<componentId, specs>, added: [items] } */
export function overlayView(overlay) {
  const updates = new Map(); const added = new Map();
  for (const p of overlay.patches ?? []) {
    for (const r of p.applied ?? []) {
      const field = fieldOf(r.field_path);
      if (r.op === 'UPDATE') updates.set(r.component_id, { ...(updates.get(r.component_id) ?? {}), [field]: r.new_value });
      if (r.op === 'ADD') {
        const id = r.component_id;
        const item = added.get(id) ?? { id, category: r.category, name: r.manufacturer_model, mpn: r.manufacturer_sku ?? null, dataSource: 'patch', market: 'cn', specs: {}, patchId: p.id };
        item.specs[field] = r.new_value; added.set(id, item);
      }
    }
  }
  return { updates, added: [...added.values()] };
}

const revisionOk = (r, item) => !r.hardware_revision || [item.name, item.mpn, ...(item.partNumbers ?? []), item.specs?.hardwareRevision].filter(Boolean).join(' ').toUpperCase().includes(String(r.hardware_revision).toUpperCase());

/**
 * 应用补丁（不修改目录文件，只写覆盖层）。catalogItems 为当前运行时目录（含已应用的覆盖层）。
 * 返回 { patchId, applied, conflicts, unresolved, rejected }；dryRun 时不写文件。
 */
export function applyPatch(patch, { catalogItems, overlayPath, dryRun = false, now = new Date() }) {
  const records = Array.isArray(patch) ? patch : patch.records;
  if (!Array.isArray(records) || !records.length) throw new Error('补丁没有记录');
  const overlay = loadOverlay(overlayPath);
  const view = overlayView(overlay);
  const byId = new Map(catalogItems.map(i => [i.id, i]));
  for (const a of view.added) byId.set(a.id, a);
  const bySku = new Map();
  for (const i of byId.values()) if (i.mpn) bySku.set(String(i.mpn).toUpperCase(), [...(bySku.get(String(i.mpn).toUpperCase()) ?? []), i]);
  const result = { patchId: patch.id ?? `patch-${createHash('sha256').update(JSON.stringify(records)).digest('hex').slice(0, 12)}`, applied: [], conflicts: [], unresolved: [], rejected: [] };
  if (overlay.patches.some(p => p.id === result.patchId)) throw new Error(`补丁 ${result.patchId} 已应用`);
  const pending = new Map(); // 本补丁内对同一字段的写入（检测补丁内部冲突）
  for (const [index, r] of records.entries()) {
    const errors = validateRecord(r);
    if (errors.length) { result.rejected.push({ index, record: r, errors }); continue; }
    if (r.op === 'UNRESOLVED') { result.unresolved.push({ index, record: r }); continue; }
    const field = fieldOf(r.field_path);
    let target = r.component_id ? byId.get(r.component_id) : null;
    if (!target && !r.component_id && r.manufacturer_sku) {
      const m = bySku.get(String(r.manufacturer_sku).toUpperCase()) ?? [];
      if (m.length === 1) target = m[0];
      else if (m.length > 1) { result.conflicts.push({ index, record: r, reason: `料号 ${r.manufacturer_sku} 匹配到 ${m.length} 个条目，需指定 component_id` }); continue; }
    }
    if (r.op === 'UPDATE') {
      if (!target) { result.conflicts.push({ index, record: r, reason: '目录中没有该配件（新配件请用 ADD）' }); continue; }
      if (target.category !== r.category) { result.conflicts.push({ index, record: r, reason: `类别不一致：目录为 ${target.category}` }); continue; }
      if (!revisionOk(r, target)) { result.conflicts.push({ index, record: r, reason: `硬件版本 ${r.hardware_revision} 无法在目录条目“${target.name}”中确认，不合并` }); continue; }
      const key = `${target.id}|${field}`;
      const current = pending.has(key) ? pending.get(key) : (view.updates.get(target.id)?.[field] ?? target.specs?.[field]);
      if (r.old_value !== undefined && !same(r.old_value, current)) { result.conflicts.push({ index, record: r, reason: `old_value 与当前值不一致（当前 ${JSON.stringify(current ?? null)}）` }); continue; }
      pending.set(key, r.new_value);
      result.applied.push({ ...r, component_id: target.id, previous_value: current ?? null });
    } else if (r.op === 'ADD') {
      if (target) { result.conflicts.push({ index, record: r, reason: `配件已存在（${target.id}），已有字段请用 UPDATE` }); continue; }
      const id = r.component_id ?? `patch-${createHash('sha256').update(`${r.category}|${r.manufacturer_model}|${r.manufacturer_sku ?? ''}|${r.hardware_revision ?? ''}`).digest('hex').slice(0, 12)}`;
      result.applied.push({ ...r, component_id: id });
    }
  }
  if (!dryRun && result.applied.length) {
    overlay.patches.push({ id: result.patchId, appliedAt: now.toISOString(), source: patch.source ?? null, applied: result.applied, unresolved: result.unresolved.map(u => u.record) });
    writeFileSync(overlayPath, JSON.stringify(overlay, null, 2) + '\n');
  }
  return result;
}

/** 回滚指定补丁：从覆盖层移除该补丁的全部写入（其后应用的补丁若依赖同一字段，同样报告） */
export function rollbackPatch(patchId, { overlayPath }) {
  const overlay = loadOverlay(overlayPath);
  const index = overlay.patches.findIndex(p => p.id === patchId);
  if (index < 0) throw new Error(`覆盖层中没有补丁 ${patchId}`);
  const removed = overlay.patches[index];
  const touched = new Set(removed.applied.map(r => `${r.component_id}|${r.field_path}`));
  const later = overlay.patches.slice(index + 1).filter(p => p.applied.some(r => touched.has(`${r.component_id}|${r.field_path}`))).map(p => p.id);
  overlay.patches.splice(index, 1);
  writeFileSync(overlayPath, JSON.stringify(overlay, null, 2) + '\n');
  return { removed: patchId, records: removed.applied.length, laterPatchesTouchingSameFields: later };
}
