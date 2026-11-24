import { execFileSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { LocalStore } from '../src/store.mjs';

const repository = 'https://github.com/buildcores/buildcores-open-db';
const sourceDirectory = path.resolve(process.argv[2] ?? '.runtime/buildcores-open-db');
const revision = execFileSync('git', ['-C', sourceDirectory, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const dataDirectory = path.join(sourceDirectory, 'open-db');
const attribution = {
  name: 'BuildCores OpenDB', repository, revision, license: 'CC BY-NC-SA 4.0',
  licenseUrl: repository + '/blob/' + revision + '/LICENSE.txt',
  noticeUrl: repository + '/blob/' + revision + '/NOTICE.md',
  changes: 'Selected eight hardware categories, excluded non-SSD storage, and normalized fields for the local catalog.',
};

const sources = {
  CPU: ['CPU', record => ({
    socket: socket(record.socket), cores: number(record.cores?.total), threads: number(record.cores?.threads),
    tdpWatts: number(record.specifications?.tdp),
  })],
  GPU: ['GPU', record => ({
    chipset: clean(record.chipset), capacityGB: number(record.memory), memoryType: clean(record.memory_type),
    lengthMm: number(record.length), tdpWatts: number(record.tdp),
  })],
  Motherboard: ['MOTHERBOARD', record => ({
    socket: socket(record.socket), memoryType: clean(record.memory?.ram_type),
    chipset: clean(record.chipset), formFactor: clean(record.form_factor),
  })],
  RAM: ['RAM', record => ({
    memoryType: clean(record.ram_type), capacityGB: number(record.capacity),
    modules: number(record.modules?.quantity), speedMTs: number(record.speed),
  })],
  Storage: ['SSD', record => ({
    capacityGB: number(record.capacity), formFactor: clean(record.form_factor), interface: clean(record.interface),
  })],
  PSU: ['PSU', record => ({
    ratedWatts: number(record.wattage), formFactor: clean(record.form_factor),
    efficiency: clean(record.efficiency_rating),
  })],
  PCCase: ['CASE', record => ({
    formFactor: clean(record.form_factor), maxGpuLengthMm: number(record.max_video_card_length),
    maxCoolerHeightMm: number(record.max_cpu_cooler_height),
  })],
  CPUCooler: ['COOLER', record => ({
    fanSizeMm: number(record.fan_size), heightMm: number(record.height), radiatorSizeMm: number(record.radiator_size),
    sockets: Array.isArray(record.cpu_sockets) ? record.cpu_sockets.map(socket).filter(Boolean) : undefined,
  })],
};

function clean(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function number(value) {
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function socket(value) {
  return clean(value)?.toUpperCase().replace(/\s+/g, '');
}

function https(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

const units = {
  cores: ' 核', threads: ' 线程', capacityGB: 'GB', lengthMm: 'mm', modules: ' 条',
  speedMTs: ' MT/s', ratedWatts: 'W', fanSizeMm: 'mm', heightMm: 'mm',
  maxGpuLengthMm: 'mm 显卡限长', maxCoolerHeightMm: 'mm 散热限高', radiatorSizeMm: 'mm 冷排',
};

const items = [];
const counts = {};
const ids = new Set();
let skipped = 0;
for (const [folder, [category, readSpecs]] of Object.entries(sources)) {
  const directory = path.join(dataDirectory, folder);
  const files = (await readdir(directory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && /^[0-9a-f-]{36}\.json$/i.test(entry.name)).map(entry => entry.name).sort();
  counts[category] = 0;
  for (const file of files) {
    const record = JSON.parse(await readFile(path.join(directory, file), 'utf8'));
    const name = clean(record.metadata?.name);
    if (!name || (category === 'SSD' && clean(record.storage_type)?.toUpperCase() !== 'SSD')) {
      skipped++;
      continue;
    }
    const id = 'buildcores-' + file.slice(0, -5).toLowerCase();
    if (ids.has(id)) throw new Error('OpenDB ID 重复：' + id);
    ids.add(id);
    const manufacturer = clean(record.metadata?.manufacturer) ?? null;
    const metadataMpns = Array.isArray(record.metadata?.part_numbers) ? record.metadata.part_numbers : [];
    const identifiers = Array.isArray(record.identifiers?.identifiers) ? record.identifiers.identifiers : [];
    const partNumbers = [...new Set([...metadataMpns, ...identifiers.filter(item => item?.type === 'mpn')
      .map(item => item.value)].map(clean).filter(value => value && value !== name))];
    const specs = Object.fromEntries(Object.entries(readSpecs(record)).filter(([, value]) => value !== undefined));
    const summary = Object.entries(specs).filter(([key, value]) => typeof value === 'string' || Object.hasOwn(units, key))
      .slice(0, 4).map(([key, value]) => value + (units[key] ?? '')).join(' · ');
    const datasetUrl = repository + '/blob/' + revision + '/open-db/' + folder + '/' + file;
    items.push({ id, category, name, manufacturer, mpn: partNumbers[0] ?? null, partNumbers,
      summary, aliases: [], specs, imageUrl: null,
      sourceUrl: https(record.general_product_information?.manufacturer_url) ?? datasetUrl,
      datasetUrl, dataSource: 'buildcores',
    });
    counts[category]++;
  }
}

if (Object.values(counts).some(count => count === 0)) throw new Error('导入结果缺少标准配件类别');
await new LocalStore().write('buildcores-catalog.json', { attribution, items });
console.log(JSON.stringify({ revision, imported: items.length, skipped, counts }, null, 2));
