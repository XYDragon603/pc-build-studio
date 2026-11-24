import { readFile } from 'node:fs/promises';
import { evaluate, merchantUrl, parseTarget } from './normalization.mjs';
import { inspectRetailer } from './retailer.mjs';
import { summarize } from './report.mjs';

export async function searchQuotes(target, provider, inspect = inspectRetailer) {
  const search = await provider.search(target);
  const seen = new Set();
  const options = { ttlMs: provider.ttlMs };
  let productPageRequests = 0;
  const results = [];
  for (const snippet of search.results) {
    const canonical = merchantUrl(snippet.url);
    const key = canonical ?? snippet.url;
    if (seen.has(key)) continue;
    seen.add(key);
    const preliminary = evaluate(target, snippet, options);
    if (preliminary.status === 'rejected' || !canonical) {
      results.push({ ...preliminary, target: target.query });
      continue;
    }
    productPageRequests++;
    const evidence = await inspect(snippet);
    results.push({
      ...evaluate(target, evidence, options), target: target.query, discovery: snippet,
    });
  }
  return { mode: 'live', generatedAt: new Date().toISOString(), summary: summarize(results), results,
    cost: { projectSearchRequests: search.attemptedRequests, productPageRequests,
      cacheHits: Number(search.cached), estimatedGrossUsd: search.estimatedGrossUsd },
  };
}

export async function replayQuotes(target) {
  const { capturedAt, samples } = JSON.parse(await readFile(new URL('../data/observations.json', import.meta.url), 'utf8'));
  const results = samples.filter(sample => {
    if (sample.category !== target.category) return false;
    const sampleTarget = parseTarget(sample.category, sample.query);
    return sampleTarget.model === target.model
      && (!target.capacityGB || target.capacityGB === sampleTarget.capacityGB)
      && (!target.packaging || target.packaging === sampleTarget.packaging);
  }).map(sample => ({
    ...evaluate(target, { ...sample.evidence, observedAt: capturedAt }),
    target: target.query,
  }));
  return { mode: 'replay', generatedAt: new Date().toISOString(), evidenceAsOf: capturedAt,
    summary: summarize(results), results,
    cost: { projectSearchRequests: 0, productPageRequests: 0, cacheHits: 0, estimatedGrossUsd: 0 },
  };
}
