import { useState } from 'react';
import { SLOT_ICONS } from '../components/icons';
import type { SlotId } from '../domain/types';

/** 商品图；没有图或加载失败时显示配件类别图标 */
export function Thumb({ src, slot, size = 'md' }: { src?: string | null; slot: SlotId; size?: 'sm' | 'md' | 'lg' | 'xl' }) {
  const [failed, setFailed] = useState(false);
  if (src && !failed) {
    return <img className={`nx-thumb nx-thumb-${size}`} src={src} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
  }
  const Icon = SLOT_ICONS[slot];
  return <span className={`nx-thumb nx-thumb-${size} nx-thumb-icon`}><Icon strokeWidth={1.3} /></span>;
}
