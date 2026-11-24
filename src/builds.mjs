import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { ApiError, invalid } from './api-error.mjs';

export const slotTypes = [
  { id: 'CPU', label: '处理器' }, { id: 'GPU', label: '显卡' },
  { id: 'MOTHERBOARD', label: '主板' }, { id: 'RAM', label: '内存' },
  { id: 'SSD', label: '固态硬盘' }, { id: 'PSU', label: '电源' },
  { id: 'CASE', label: '机箱' }, { id: 'COOLER', label: '散热器' },
];

const examples = {
  CPU: ['AMD Ryzen 7 9700X', 145000, { socket: 'AM5' }, 'AM5 · 盒装'],
  MOTHERBOARD: ['B650M WIFI', 79900, { socket: 'AM5', memoryType: 'DDR5' }, 'AM5 · DDR5'],
  RAM: ['DDR5 6000 32GB', 49900, { memoryType: 'DDR5' }, '16GB × 2'],
  SSD: ['NVMe SSD 1TB', 39900],
  PSU: ['650W 金牌全模组', 39900, { ratedWatts: 650 }],
  CASE: ['mATX 静音机箱', 24900],
  COOLER: ['双塔风冷散热器', 14900],
};

export function buildTemplate(preset) {
  const demo = preset === 'demo';
  return {
    name: demo ? '2K 游戏主机' : '新建装机方案',
    budgetCents: demo ? 800000 : 0,
    scenarios: demo ? ['2k', 'quiet'] : [],
    slots: slotTypes.map(({ id, label }) => {
      const sample = demo ? examples[id] : null;
      return { id, label, locked: demo && id === 'CPU', part: sample ? {
        model: sample[0], spec: sample[3] ?? '', priceCents: sample[1], quantity: 1, priceSource: 'demo',
        note: '', url: null, specs: sample[2] ?? {},
      } : null };
    }),
  };
}

function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(field + ' 必须为对象');
  return value;
}

function string(value, field, max, optional = false) {
  if (typeof value !== 'string' || value.length > max || (!optional && !value.trim())) {
    throw invalid(field + ' 必须为长度符合要求的字符串');
  }
  return value.trim();
}

function integer(value, field, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw invalid(field + ' 必须为 ' + min + ' 到 ' + max + ' 之间的整数');
  }
  return value;
}

function partUrl(value) {
  if (value == null || value === '') return null;
  try {
    const url = new URL(string(value, 'part.url', 2048));
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error();
    return url.href;
  } catch {
    throw invalid('part.url 必须为 HTTPS 商品链接');
  }
}

function normalizePart(value) {
  if (value === null) return null;
  const part = object(value, 'part');
  const inputSpecs = object(part.specs ?? {}, 'part.specs');
  const specs = {};
  // 板型（主板 formFactor、机箱 maxBoardFormFactor）与显卡供电口按大写保存
  for (const field of ['socket', 'memoryType', 'formFactor', 'maxBoardFormFactor', 'gpuPowerConnector']) {
    if (inputSpecs[field] != null) specs[field] = string(inputSpecs[field], 'part.specs.' + field, 32).toUpperCase();
  }
  if (inputSpecs.native16Pin != null) {
    if (typeof inputSpecs.native16Pin !== 'boolean') throw invalid('part.specs.native16Pin 必须为布尔值');
    specs.native16Pin = inputSpecs.native16Pin;
  }
  // 尺寸为整数毫米：显卡长度、散热器高度，以及机箱的显卡限长、散热器限高
  for (const field of ['maxPowerWatts', 'ratedWatts', 'recommendedPsuWatts', 'lengthMm', 'heightMm', 'maxGpuLengthMm', 'maxCoolerHeightMm', 'radiatorSizeMm', 'maxRadiatorMm']) {
    if (inputSpecs[field] != null) specs[field] = integer(inputSpecs[field], 'part.specs.' + field, 1, 5000);
  }
  const priceSource = part.priceSource ?? 'manual';
  // estimate：按目录参考价估算，计入合计但界面单独标注
  if (!['manual', 'demo', 'estimate'].includes(priceSource)) throw invalid('part.priceSource 必须为 manual、demo 或 estimate');
  const catalogId = part.catalogId == null || part.catalogId === '' ? null : string(part.catalogId, 'part.catalogId', 120);
  if (catalogId && !/^[a-z0-9-]+$/.test(catalogId)) throw invalid('part.catalogId 格式无效');
  return {
    model: string(part.model, 'part.model', 160),
    // 展示用的简短规格，例如“AM5 · 盒装”；不参与兼容性计算
    spec: string(part.spec ?? '', 'part.spec', 120, true),
    priceCents: part.priceCents == null ? null : integer(part.priceCents, 'part.priceCents', 0, 100000000),
    quantity: integer(part.quantity ?? 1, 'part.quantity', 1, 99),
    priceSource,
    catalogId,
    note: string(part.note ?? '', 'part.note', 1000, true),
    url: partUrl(part.url),
    specs,
  };
}

export function normalizeBuild(input) {
  object(input, '配置');
  if (!Array.isArray(input.slots) || input.slots.length < 8 || input.slots.length > 40) {
    throw invalid('slots 必须包含 8 个标准槽位，最多 40 个槽位');
  }
  const slots = input.slots.map(value => {
    const slot = object(value, 'slot');
    const id = string(slot.id, 'slot.id', 64);
    const standard = slotTypes.find(type => type.id === id);
    if (!standard && !/^custom-[a-z0-9][a-z0-9-]{0,56}$/.test(id)) {
      throw invalid('自定义槽位 ID 必须以 custom- 开头，并仅使用小写字母、数字和连字符');
    }
    if (typeof slot.locked !== 'boolean') throw invalid('slot.locked 必须为布尔值');
    const part = normalizePart(slot.part);
    if (slot.locked && !part) throw invalid('空槽位不能锁定');
    return { id, label: standard?.label ?? string(slot.label, 'slot.label', 50), locked: slot.locked, part };
  });
  const ids = new Set(slots.map(slot => slot.id));
  if (ids.size !== slots.length || !slotTypes.every(type => ids.has(type.id))) {
    throw invalid('标准槽位必须各出现一次，其他槽位 ID 不能重复');
  }
  const scenarios = input.scenarios ?? [];
  if (!Array.isArray(scenarios) || scenarios.length > 8
    || !scenarios.every(key => typeof key === 'string' && /^[a-z0-9][a-z0-9-]{0,31}$/.test(key))
    || new Set(scenarios).size !== scenarios.length) {
    throw invalid('scenarios 必须为最多 8 个不重复的小写标识');
  }
  return { name: string(input.name, 'name', 80),
    budgetCents: integer(input.budgetCents, 'budgetCents', 0, 100000000), scenarios, slots };
}

/** 配件尺寸与机箱限值比较；任一缺失为 unknown */
const BOARD_RANK = { 'MINI-ITX': 1, 'MICRO ATX': 2, ATX: 3, EATX: 4 };

/** 主板板型不大于机箱支持的最大板型即可安装；无法识别的板型为 unknown */
function boardFit(board, maxBoard) {
  const size = BOARD_RANK[board];
  const limit = BOARD_RANK[maxBoard];
  if (!size || !limit) return { status: 'unknown', formFactor: board ?? null, maxFormFactor: maxBoard ?? null };
  return { status: size <= limit ? 'pass' : 'conflict', formFactor: board, maxFormFactor: maxBoard };
}

/** 16pin 显卡：电源有原生 16pin 为 pass，未标注时提示核对或使用转接线；非 16pin 显卡不检查 */
function gpuPowerConnector(connector, native16Pin) {
  if (!connector || !/16\s*PIN/.test(connector)) return { status: 'unknown', required: connector ?? null };
  return { status: native16Pin ? 'pass' : 'warning', required: connector };
}

function clearance(sizeMm, limitMm) {
  if (!sizeMm || !limitMm) return { status: 'unknown', sizeMm: sizeMm ?? null, limitMm: limitMm ?? null };
  return { status: sizeMm <= limitMm ? 'pass' : 'conflict', sizeMm, limitMm };
}

function compareSpecs(first, second) {
  if (!first || !second) return 'unknown';
  return first === second ? 'pass' : 'conflict';
}

export function calculateBuild(build) {
  const parts = build.slots.filter(slot => slot.part).map(slot => slot.part);
  const totalCents = parts.reduce((sum, part) => sum + (part.priceCents ?? 0) * part.quantity, 0);
  const lookup = Object.fromEntries(build.slots.map(slot => [slot.id, slot.part]));
  const cpu = lookup.CPU?.specs;
  const board = lookup.MOTHERBOARD?.specs;
  const gpu = lookup.GPU?.specs;
  const ram = lookup.RAM?.specs;
  const psu = lookup.PSU?.specs;
  const estimatedLoadWatts = cpu?.maxPowerWatts && gpu?.maxPowerWatts
    ? cpu.maxPowerWatts * lookup.CPU.quantity + gpu.maxPowerWatts * lookup.GPU.quantity + 75 : null;
  // 估算值与显卡厂商的建议电源都有时取较大者；只有其一时用其一
  const gpuRecommendedWatts = gpu?.recommendedPsuWatts ?? null;
  const candidates = [estimatedLoadWatts === null ? null : Math.ceil(estimatedLoadWatts * 1.25), gpuRecommendedWatts].filter(v => v !== null);
  const recommendedWatts = candidates.length ? Math.max(...candidates) : null;
  const ratedWatts = psu?.ratedWatts ?? null;
  let powerStatus = 'unknown';
  if (recommendedWatts !== null && ratedWatts !== null) {
    powerStatus = ratedWatts >= recommendedWatts ? 'pass' : 'warning';
  }
  return {
    ...build,
    totals: { totalCents, remainingCents: build.budgetCents - totalCents,
      unknownPriceCount: parts.filter(part => part.priceCents === null).length,
      filledStandardSlots: slotTypes.filter(type => lookup[type.id]).length },
    compatibility: {
      cpuSocket: compareSpecs(cpu?.socket, board?.socket),
      memoryType: compareSpecs(board?.memoryType, ram?.memoryType),
      bios: 'unknown',
      power: { status: powerStatus, estimatedLoadWatts, recommendedWatts, ratedWatts, gpuRecommendedWatts },
      gpuClearance: clearance(gpu?.lengthMm, lookup.CASE?.specs?.maxGpuLengthMm),
      coolerClearance: clearance(lookup.COOLER?.specs?.heightMm, lookup.CASE?.specs?.maxCoolerHeightMm),
      radiatorClearance: clearance(lookup.COOLER?.specs?.radiatorSizeMm, lookup.CASE?.specs?.maxRadiatorMm),
      boardFit: boardFit(board?.formFactor, lookup.CASE?.specs?.maxBoardFormFactor),
      gpuPowerConnector: gpuPowerConnector(gpu?.gpuPowerConnector, psu?.native16Pin),
    },
  };
}

function assertVersion(build, version) {
  integer(version, 'version', 1, Number.MAX_SAFE_INTEGER);
  if (build.version !== version) throw new ApiError(409, 'VERSION_CONFLICT', '配置已更新，请重新载入后保存');
}

export class BuildRepository {
  constructor(store) {
    this.store = store;
    this.pending = Promise.resolve();
  }

  read() {
    return this.store.read('builds.json', {});
  }

  mutate(change) {
    const operation = this.pending.then(async () => {
      const builds = await this.read();
      const result = change(builds);
      await this.store.write('builds.json', builds);
      return result;
    });
    this.pending = operation.catch(() => {});
    return operation;
  }

  async list() {
    const builds = Object.values(await this.read());
    return builds.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(build => {
      const { id, name, version, createdAt, updatedAt, budgetCents, totals } = calculateBuild(build);
      return { id, name, version, createdAt, updatedAt, budgetCents, totals };
    });
  }

  async get(id) {
    return calculateBuild(this.find(await this.read(), id));
  }

  find(builds, id) {
    if (!Object.hasOwn(builds, id)) throw new ApiError(404, 'BUILD_NOT_FOUND', '没有找到这份配置');
    return builds[id];
  }

  create(input) {
    object(input, '配置');
    const { preset = 'empty' } = input;
    if (!['empty', 'demo'].includes(preset)) throw invalid('preset 必须为 empty 或 demo');
    const defaults = buildTemplate(preset);
    const normalized = normalizeBuild({ ...defaults, ...input });
    return this.mutate(builds => {
      if (Object.keys(builds).length >= 200) throw new ApiError(409, 'BUILD_LIMIT', '本机最多保存 200 份配置');
      const id = randomUUID();
      const date = new Date().toISOString();
      const build = { ...normalized, id, version: 1, createdAt: date, updatedAt: date };
      builds[id] = build;
      return calculateBuild(build);
    });
  }

  replace(id, input) {
    const next = normalizeBuild(input);
    return this.mutate(builds => {
      const previous = this.find(builds, id);
      assertVersion(previous, input.version);
      const slots = new Map(next.slots.map(slot => [slot.id, slot]));
      for (const slot of previous.slots.filter(slot => slot.locked)) {
        const replacement = slots.get(slot.id);
        if (!replacement || slot.label !== replacement.label || !isDeepStrictEqual(normalizePart(slot.part), replacement.part)) {
          throw new ApiError(409, 'SLOT_LOCKED', '请先解锁槽位 ' + slot.label + ' 再编辑或移除');
        }
      }
      const build = { ...previous, ...next, version: previous.version + 1, updatedAt: new Date().toISOString() };
      builds[id] = build;
      return calculateBuild(build);
    });
  }

  remove(id, version) {
    return this.mutate(builds => {
      const build = this.find(builds, id);
      assertVersion(build, version);
      delete builds[id];
    });
  }
}
