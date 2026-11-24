/** 金额一律以整数分存储，只在展示时换算成元。 */
export function formatYuan(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const value = Math.abs(cents) / 100;
  return `${sign}¥${value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`;
}

/** 解析用户输入的元金额。允许 0（已有配件），非法输入返回 null。 */
export function parseYuan(text: string): number | null {
  const t = text.trim().replace(/[,，¥￥\s]/g, '');
  if (!/^\d+(?:\.\d{1,2})?$/.test(t)) return null;
  const cents = Math.round(Number(t) * 100);
  return Number.isSafeInteger(cents) ? cents : null;
}
