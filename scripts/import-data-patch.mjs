// 导入硬件数据补丁到运行时覆盖层（2.2.3）。不修改目录文件与内置修正，只写 data/hardware-patches.json，可回滚。
// 用法：
//   node scripts/import-data-patch.mjs <补丁.json> [--dry-run] [--overlay <路径>]
//   node scripts/import-data-patch.mjs --rollback <补丁ID> [--overlay <路径>]
//   node scripts/import-data-patch.mjs --list [--overlay <路径>]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createCatalog } from '../src/catalog.mjs';
import { applyPatch, loadOverlay, rollbackPatch } from '../src/data-patches.mjs';

const args = process.argv.slice(2);
const opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const overlayPath = opt('--overlay') ?? fileURLToPath(new URL('../data/hardware-patches.json', import.meta.url));
if (args.includes('--list')) {
  console.log(JSON.stringify(loadOverlay(overlayPath).patches.map(p => ({ id: p.id, appliedAt: p.appliedAt, records: p.applied.length, unresolved: p.unresolved?.length ?? 0 })), null, 2));
} else if (opt('--rollback')) {
  console.log(JSON.stringify(rollbackPatch(opt('--rollback'), { overlayPath }), null, 2));
} else {
  const file = args.find(a => !a.startsWith('--') && a !== opt('--overlay'));
  if (!file) { console.error('需要补丁文件路径'); process.exit(2); }
  const patch = JSON.parse(readFileSync(file, 'utf8'));
  const catalogItems = createCatalog(fileURLToPath(new URL('../.runtime', import.meta.url)), undefined, { patchOverlay: overlayPath }).all();
  const r = applyPatch(patch, { catalogItems, overlayPath, dryRun: args.includes('--dry-run') });
  console.log(JSON.stringify({ patchId: r.patchId, dryRun: args.includes('--dry-run'), applied: r.applied.length, conflicts: r.conflicts, unresolved: r.unresolved.length, rejected: r.rejected }, null, 2));
  if (r.rejected.length || r.conflicts.length) process.exitCode = 1;
}
