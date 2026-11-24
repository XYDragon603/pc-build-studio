// CPU / 显卡型号的统一键，用于把目录条目与跑分数据对上。

/** CPU 型号键：RYZEN 9700X / RYZEN 5600 / I5-14600KF / ULTRA7-265K；识别不了返回 null */
export function cpuKey(name) {
  const t = String(name ?? '').normalize('NFKC').toUpperCase().replace(/\(R\)|\(TM\)|®|™/g, ' ').replace(/\s+/g, ' ');
  // 国内名称常写“锐龙 9 9950X3D2”
  let m = t.match(/(?:RYZEN|锐龙)\s*(?:THREADRIPPER\s*)?(?:[3579]\s*)?(?:PRO\s*)?(\d{4}[A-Z0-9]*)/);
  if (m) return `RYZEN ${m[1]}`;
  m = t.match(/ULTRA\s*([3579])\s*(?:PROCESSOR\s*)?(\d{3}[A-Z]*)/);
  if (m) return `ULTRA${m[1]}-${m[2]}`;
  m = t.match(/(?:^|[^A-Z0-9])I([3579])[\s-]*(\d{4,5}[A-Z]*)/);
  if (m) return `I${m[1]}-${m[2]}`;
  return null;
}

/** 显卡芯片键：RTX 5060 TI / RX 9070 XT / ARC B580；识别不了返回 null */
export function gpuKey(name) {
  const t = String(name ?? '').normalize('NFKC').toUpperCase().replace(/\(R\)|\(TM\)|®|™/g, ' ').replace(/\s+/g, ' ');
  let m = t.match(/\b(RTX|GTX)\s*(\d{4})\s*(TI SUPER|TI|SUPER|D)?\b/);
  if (m) return [m[1], m[2], m[3]].filter(Boolean).join(' ');
  m = t.match(/\bRX\s*(\d{4})\s*(XTX|XT|GRE)?\b/);
  if (m) return ['RX', m[1], m[2]].filter(Boolean).join(' ');
  m = t.match(/\bARC\s*(?:TM\s*)?([AB]\d{3})/);
  if (m) return `ARC ${m[1]}`;
  return null;
}
