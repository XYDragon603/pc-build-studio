export const formatCents = cents => (cents == null ? '未知' : `¥${(cents / 100).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`);
