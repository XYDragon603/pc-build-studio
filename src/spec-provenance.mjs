const units = field => /Mm$/.test(field) ? 'mm' : /Watts$/.test(field) ? 'W' : /MTs$/.test(field) ? 'MT/s'
  : /Cents$/.test(field) ? 'CNY-cent' : /GB$/.test(field) ? 'GB' : field === 'slotWidth' ? 'slot' : null;

export const KEY_FIELDS = {
  CPU: ['maxPowerWatts', 'cpuMemoryMaxMTs', 'pcieLink', 'storagePcieLink', 'stockCoolerRetailSkus'],
  GPU: ['boardPowerWatts', 'lengthMm', 'heightMm', 'thicknessMm', 'slotWidth', 'powerPins', 'pcieLink'],
  MOTHERBOARD: ['formFactor', 'gpuPcieLink', 'm2Links', 'memoryQvl'],
  RAM: ['speedMTs', 'rank', 'jedecMTs'],
  SSD: ['interface', 'pcieLink'],
  PSU: ['ratedWatts', 'psuFormFactor', 'atxVersion', 'psuLengthMm', 'rail12vAmps'],
  CASE: ['supportedBoardFormats', 'frontIntake', 'fanMounts', 'includedFans', 'maxPsuLengthMm', 'gpuCableClearanceMm'],
  COOLER: ['sockets', 'vendorCoolingWatts', 'thermalTests'],
};

export function fieldProvenance(item, correction, override, verifiedAt) {
  return Object.entries(item.specs).flatMap(([field, value]) => {
    if (value == null || field === 'specEvidence') return [];
    const manual = override?.fieldSources?.[field] ?? (Object.hasOwn(override?.specs ?? {}, field) ? override : null);
    const official = Object.hasOwn(correction?.specs ?? {}, field);
    const estimated = item.estimatedSpecs?.includes(field);
    const sourceUrl = manual?.sourceUrl ?? (official ? correction.fieldSources?.[field] ?? correction.sourceUrl : estimated ? null : item.sourceUrl ?? null);
    return [{ component_id: item.id, manufacturer_sku: item.mpn ?? null, field_name: field, value, unit: units(field),
      source_url: sourceUrl, source_type: manual ? 'user-record' : official ? 'manufacturer-sku' : estimated ? 'inferred' : item.dataSource ?? 'catalog',
      observed_at: official || manual ? null : item.observedAt ?? null, verified_at: official && !manual ? verifiedAt : null,
      confidence: manual ? 'medium' : official ? 'high' : sourceUrl ? 'medium' : 'low',
      verification_status: manual ? 'user-recorded' : official ? 'verified' : estimated ? 'estimated' : sourceUrl ? 'imported' : 'unattributed' }];
  });
}

export function fieldCoverage(items) {
  return Object.fromEntries(Object.entries(KEY_FIELDS).map(([category, fields]) => {
    const list = items.filter(i => i.category === category);
    return [category, { count: list.length, fields: Object.fromEntries(fields.map(field => {
      const complete = list.filter(i => i.specs[field] != null && (!Array.isArray(i.specs[field]) || i.specs[field].length)).length;
      return [field, { complete, missing: list.length - complete, percent: list.length ? Math.round(10000 * complete / list.length) / 100 : null }];
    })) }];
  }));
}
