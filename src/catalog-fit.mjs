import { invalid } from './api-error.mjs';
import { boardFit, clearance } from './builds.mjs';
import { boardCaseStatus } from './hardware-specs.mjs';

const categoryFields = {
  CPU: ['socket'],
  GPU: ['maxGpuLengthMm'],
  MOTHERBOARD: ['socket', 'memoryType', 'maxBoardFormFactor'],
  RAM: ['memoryType'],
  SSD: [],
  PSU: ['minPsuWatts'],
  CASE: ['gpuLengthMm', 'coolerHeightMm', 'radiatorSizeMm', 'boardFormFactor'],
  COOLER: ['maxCoolerHeightMm', 'maxRadiatorMm'],
};
const textFields = new Set(['socket', 'memoryType', 'maxBoardFormFactor', 'boardFormFactor']);

export function parseCatalogFit(value, category) {
  if (value === null) return null;
  let fit;
  try { fit = value.length <= 400 ? JSON.parse(value) : null; } catch { fit = null; }
  if (!fit || typeof fit !== 'object' || Array.isArray(fit)) throw invalid('fit 需为当前配件类目的兼容条件对象');
  // 外设（显示器、键盘、鼠标）没有兼容条件：空对象等于不筛选
  if (!Object.hasOwn(categoryFields, category)) {
    if (Object.keys(fit).length) throw invalid('fit 需为当前配件类目的兼容条件对象');
    return null;
  }
  for (const [field, expected] of Object.entries(fit)) {
    const valid = expected === null || (textFields.has(field)
      ? typeof expected === 'string' && expected.trim() && expected.length <= 32
      : Number.isInteger(expected) && expected > 0 && expected <= 10000);
    if (!categoryFields[category].includes(field) || !valid) throw invalid('fit 兼容条件无效：' + field);
  }
  return fit;
}

const upper = value => typeof value === 'string' ? value.trim().toUpperCase() : '';
const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
const same = (a, b) => upper(a) && upper(b) ? upper(a) === upper(b) ? 'pass' : 'conflict' : 'unknown';
const dimension = (size, limit) => clearance(positive(size), positive(limit)).status;

function formFactor(value) {
  const type = upper(value);
  if (/^(E-?ATX|EXTENDED ATX)/.test(type)) return 'EATX';
  if (/^(MICRO[ -]?ATX|MATX)/.test(type)) return 'MICRO ATX';
  if (/^(MINI[ -]?ITX|ITX)/.test(type)) return 'MINI-ITX';
  return type.startsWith('ATX') ? 'ATX' : undefined;
}

export function catalogFitStatus(specs, fit) {
  const checks = [];
  if ('socket' in fit) checks.push(same(specs.socket, fit.socket));
  if ('memoryType' in fit) checks.push(same(specs.memoryType, fit.memoryType));
  if ('maxBoardFormFactor' in fit) checks.push(boardFit(formFactor(specs.formFactor), formFactor(fit.maxBoardFormFactor)).status);
  if ('boardFormFactor' in fit) checks.push(({ PASS: 'pass', FAIL: 'conflict', UNKNOWN: 'unknown' })[boardCaseStatus({ formFactor: formFactor(fit.boardFormFactor) }, specs)]);
  if ('maxGpuLengthMm' in fit) checks.push(dimension(specs.lengthMm, fit.maxGpuLengthMm));
  if ('gpuLengthMm' in fit) checks.push(dimension(fit.gpuLengthMm, specs.maxGpuLengthMm));
  if ('coolerHeightMm' in fit) checks.push(dimension(fit.coolerHeightMm, specs.maxCoolerHeightMm));
  if ('radiatorSizeMm' in fit) checks.push(dimension(fit.radiatorSizeMm, specs.maxRadiatorMm));
  if ('minPsuWatts' in fit) checks.push(dimension(fit.minPsuWatts, specs.ratedWatts));
  if ('maxCoolerHeightMm' in fit && (positive(specs.heightMm) || !positive(specs.radiatorSizeMm))) {
    checks.push(dimension(specs.heightMm, fit.maxCoolerHeightMm));
  }
  if ('maxRadiatorMm' in fit && positive(specs.radiatorSizeMm)) {
    checks.push(dimension(specs.radiatorSizeMm, fit.maxRadiatorMm));
  }
  if (checks.includes('conflict')) return 'conflict';
  if (checks.includes('unknown')) return 'unknown';
  return checks.length ? 'pass' : undefined;
}
