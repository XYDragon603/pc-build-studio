import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function loadScenarioPerformance(directory) {
  const builtIn = JSON.parse(readFileSync(new URL('../data/scenario-performance.json', import.meta.url), 'utf8'));
  let local = { cohorts: [] };
  if (directory) {
    try { local = JSON.parse(readFileSync(join(directory, 'scenario-performance.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const cohorts = new Map();
  for (const set of [builtIn, local]) for (const row of set.cohorts ?? []) {
    if (!row.id || !row.task || !row.unit || !row.conditions || !/^https:\/\//.test(row.sourceUrl) ||
      !Number.isFinite(Date.parse(row.publishedAt)) || Date.parse(row.publishedAt) > Date.now() ||
      (row.reference != null && (!Number.isFinite(row.reference) || row.reference <= 0)) ||
      !row.results || !Object.keys(row.results).length || !Object.values(row.results).every(value => Number.isFinite(value) && value > 0)) {
      throw new Error(`Invalid scenario benchmark cohort: ${row.id ?? '(missing ID)'}`);
    }
    cohorts.set(row.id, row);
  }
  return {
    metadata: [...cohorts.values()].map(({ results: _results, ...details }) => details),
    forGpu: (key, capacityGB) => [...cohorts.values()].flatMap(({ results, ...details }) => {
      const variant = `${key} ${capacityGB}GB`;
      const value = Object.hasOwn(results, variant) ? results[variant] : Object.hasOwn(results, key) ? results[key] : null;
      return value == null ? [] : [{ ...details, value, scope: 'chip-model benchmark' }];
    }),
  };
}

export function matchingBenchmark(item, workload) {
  if (!workload.benchmarkId) return null;
  const normalize = value => value?.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  return item?.performance?.benchmarks?.find(b => b.id === workload.benchmarkId && b.task === workload.task &&
    (!workload.game || [b.game, ...(b.gameAliases ?? [])].some(game => normalize(game) === normalize(workload.game))) &&
    (!workload.quality || normalize(b.quality) === normalize(workload.quality)) &&
    (!workload.model || normalize(b.model) === normalize(workload.model))) ?? null;
}
